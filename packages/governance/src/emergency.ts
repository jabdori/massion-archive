import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { PermitStore } from "./permit.js";
import { GOVERNANCE_EMERGENCY_MIGRATION } from "./schema.js";

export interface EmergencyState {
  readonly organization_id: string;
  readonly active: boolean;
  readonly reason: string;
  readonly revision: number;
  readonly changed_by_user_id: string;
  readonly changed_at: unknown;
}

export interface EmergencyEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly created_at: unknown;
}

export interface ActivateEmergencyInput {
  readonly commandId: string;
  readonly reason: string;
}

export interface ReleaseEmergencyInput {
  readonly commandId: string;
  readonly approvalId: string;
  readonly requestHash: string;
  readonly policyVersionId: string;
  readonly resourceRevision: number;
  readonly reason: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class EmergencyControl {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly permits: PermitStore,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    permits: PermitStore,
  ): Promise<EmergencyControl> {
    await applyMigrations(database, [GOVERNANCE_EMERGENCY_MIGRATION]);
    return new EmergencyControl(database, organizations, permits);
  }

  public async activate(context: TenantContext, input: ActivateEmergencyInput): Promise<EmergencyState> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.state(tx, context.organizationId);
      const current = await this.optionalState(tx, context.organizationId);
      if (current?.active) throw new Error("긴급 중단이 이미 활성 상태입니다");
      const revision = (current?.revision ?? 0) + 1;
      if (current) {
        await tx.query(
          "UPDATE governance_emergency_state SET active = true, reason = $reason, revision = $revision, changed_by_user_id = $user_id, changed_at = time::now() WHERE organization_id = $organization_id;",
          {
            organization_id: context.organizationId,
            reason: input.reason,
            revision,
            user_id: context.userId,
          },
        );
      } else {
        await tx.query(
          "CREATE governance_emergency_state CONTENT { organization_id: $organization_id, active: true, reason: $reason, revision: 1, changed_by_user_id: $user_id, changed_at: time::now() };",
          { organization_id: context.organizationId, reason: input.reason, user_id: context.userId },
        );
      }
      await this.insertEvent(tx, context, input.commandId, revision, "emergency_stop_activated", requestJson, {
        reason: input.reason,
      });
      return await this.state(tx, context.organizationId);
    });
  }

  public async release(context: TenantContext, input: ReleaseEmergencyInput): Promise<EmergencyState> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const requestJson = canonicalJson(input);
    const existing = await this.repeated(this.database, context.organizationId, input.commandId, requestJson);
    if (existing) return await this.state(this.database, context.organizationId);
    await this.permits.consume(context, {
      commandId: input.commandId,
      approvalId: input.approvalId,
      requestHash: input.requestHash,
      policyVersionId: input.policyVersionId,
      resourceRevision: input.resourceRevision,
      executionId: `emergency-release:${context.organizationId}:${String(input.resourceRevision)}`,
      expectedAction: "emergency.stop.disable",
      expectedResourceType: "Organization",
      expectedResourceId: context.organizationId,
    });
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.state(tx, context.organizationId);
      const current = await this.state(tx, context.organizationId);
      if (!current.active) throw new Error("긴급 중단이 활성 상태가 아닙니다");
      if (current.revision !== input.resourceRevision)
        throw new Error("긴급 중단 resource revision precondition이 일치하지 않습니다");
      const revision = current.revision + 1;
      await tx.query(
        "UPDATE governance_emergency_state SET active = false, reason = $reason, revision = $revision, changed_by_user_id = $user_id, changed_at = time::now() WHERE organization_id = $organization_id;",
        {
          organization_id: context.organizationId,
          reason: input.reason,
          revision,
          user_id: context.userId,
        },
      );
      await this.insertEvent(tx, context, input.commandId, revision, "emergency_stop_released", requestJson, {
        reason: input.reason,
        approvalId: input.approvalId,
      });
      return await this.state(tx, context.organizationId);
    });
  }

  public async assertExecutionAllowed(context: TenantContext, executor: QueryExecutor = this.database): Promise<void> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const current = await this.optionalState(executor, context.organizationId);
    if (current?.active) throw new Error(`조직이 긴급 중단 상태입니다: ${current.reason}`);
  }

  public async get(context: TenantContext): Promise<EmergencyState | undefined> {
    await this.organizations.verifyTenantContext(context);
    return await this.optionalState(this.database, context.organizationId);
  }

  public async listEvents(context: TenantContext): Promise<EmergencyEvent[]> {
    await this.organizations.verifyTenantContext(context);
    const [events] = await this.database.query<[EmergencyEvent[]]>(
      "SELECT * OMIT id FROM governance_emergency_event WHERE organization_id = $organization_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId },
    );
    return events;
  }

  private async optionalState(executor: QueryExecutor, organizationId: string): Promise<EmergencyState | undefined> {
    const [records] = await executor.query<[EmergencyState[]]>(
      "SELECT * OMIT id FROM governance_emergency_state WHERE organization_id = $organization_id LIMIT 1;",
      { organization_id: organizationId },
    );
    return records[0];
  }

  private async state(executor: QueryExecutor, organizationId: string): Promise<EmergencyState> {
    const current = await this.optionalState(executor, organizationId);
    if (!current) throw new Error("긴급 중단 상태를 찾을 수 없습니다");
    return current;
  }

  private async repeated(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<EmergencyEvent | undefined> {
    const [events] = await executor.query<[EmergencyEvent[]]>(
      "SELECT * OMIT id FROM governance_emergency_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 긴급 중단 요청을 사용할 수 없습니다");
    return events[0];
  }

  private async insertEvent(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    sequence: number,
    eventType: string,
    requestJson: string,
    payload: unknown,
  ): Promise<void> {
    await executor.query(
      "CREATE governance_emergency_event CONTENT { event_id: $event_id, organization_id: $organization_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_json: $request_json, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        command_id: commandId,
        sequence,
        event_type: eventType,
        request_json: requestJson,
        payload_json: canonicalJson(payload),
      },
    );
  }
}
