import { randomUUID } from "node:crypto";

import type { MembershipRole, OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ApprovalRequirement } from "./contracts.js";
import { normalizeApprovalDisplayPreview, type ApprovalDisplayPreview } from "./approval-preview.js";
import { GovernanceService } from "./governance-service.js";
import {
  GOVERNANCE_APPROVAL_DISPLAY_PREVIEW_MIGRATION,
  GOVERNANCE_APPROVAL_MIGRATION,
  GOVERNANCE_APPROVAL_RESUME_TARGET_MIGRATION,
} from "./schema.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "consumed";

export interface ApprovalRecord {
  readonly approval_id: string;
  readonly organization_id: string;
  readonly decision_id: string;
  readonly request_hash: string;
  readonly policy_version_id: string;
  readonly resource_revision?: number;
  readonly requester_user_id: string;
  readonly work_id?: string;
  readonly execution_id?: string;
  readonly resume_target?: "runtime-subscription";
  readonly display_preview_json?: string;
  readonly status: ApprovalStatus;
  readonly requirement_json: string;
  readonly revision: number;
  readonly event_sequence: number;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ApprovalEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly approval_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly created_at: unknown;
}

export interface RequestApprovalInput {
  readonly commandId: string;
  readonly decisionId: string;
  readonly resourceRevision?: number;
  readonly workId?: string;
  readonly executionId?: string;
  readonly resumeTarget?: "runtime-subscription";
  readonly displayPreview?: ApprovalDisplayPreview;
}

export interface VoteApprovalInput {
  readonly commandId: string;
  readonly approvalId: string;
  readonly expectedRevision?: number;
  readonly vote: "approve" | "reject";
  readonly reason: string;
}

export interface CancelApprovalInput {
  readonly commandId: string;
  readonly approvalId: string;
  readonly reason: string;
}

export interface ApprovalClock {
  now(): Date;
}

interface VoteRecord {
  readonly vote: "approve" | "reject";
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

function instant(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

function approvalRequestIdentity(input: RequestApprovalInput): unknown {
  return {
    commandId: input.commandId,
    decisionId: input.decisionId,
    ...(input.resourceRevision === undefined ? {} : { resourceRevision: input.resourceRevision }),
    ...(input.workId === undefined ? {} : { workId: input.workId }),
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.resumeTarget === undefined ? {} : { resumeTarget: input.resumeTarget }),
  };
}

export class ApprovalStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly governance: GovernanceService,
    private readonly clock: ApprovalClock,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    governance: GovernanceService,
    clock: ApprovalClock = { now: () => new Date() },
  ): Promise<ApprovalStore> {
    await applyMigrations(database, [
      GOVERNANCE_APPROVAL_MIGRATION,
      GOVERNANCE_APPROVAL_RESUME_TARGET_MIGRATION,
      GOVERNANCE_APPROVAL_DISPLAY_PREVIEW_MIGRATION,
    ]);
    return new ApprovalStore(database, organizations, governance, clock);
  }

  public async request(context: TenantContext, input: RequestApprovalInput): Promise<ApprovalRecord> {
    await this.organizations.verifyTenantContext(context);
    const decision = await this.governance.getDecision(context, input.decisionId);
    if (decision.outcome !== "require_approval" || !decision.requirement || !decision.policyVersionId)
      throw new Error("승인이 필요한 Policy Decision만 Approval을 만들 수 있습니다");
    const requirement = decision.requirement;
    const policyVersionId = decision.policyVersionId;
    // 표시 미리보기는 재시도 때 다시 생성될 수 있으므로 기존 승인 명령의 identity에 포함하지 않습니다.
    const requestJson = canonicalJson(approvalRequestIdentity(input));
    const displayPreviewJson =
      input.displayPreview === undefined
        ? undefined
        : canonicalJson(normalizeApprovalDisplayPreview(input.displayPreview));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.find(tx, context.organizationId, repeated.approval_id);
      const approvalId = randomUUID();
      const expiresAt = new Date(this.clock.now().getTime() + requirement.expiresInSeconds * 1000);
      const [created] = await tx.query<[ApprovalRecord[]]>(
        "CREATE governance_approval CONTENT { approval_id: $approval_id, organization_id: $organization_id, decision_id: $decision_id, request_hash: $request_hash, policy_version_id: $policy_version_id, resource_revision: $resource_revision, requester_user_id: $requester_user_id, work_id: $work_id, execution_id: $execution_id, resume_target: $resume_target, display_preview_json: $display_preview_json, status: 'pending', requirement_json: $requirement_json, revision: 1, event_sequence: 1, expires_at: $expires_at, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          approval_id: approvalId,
          organization_id: context.organizationId,
          decision_id: decision.decisionId,
          request_hash: decision.requestHash,
          policy_version_id: policyVersionId,
          resource_revision: input.resourceRevision,
          requester_user_id: context.userId,
          work_id: input.workId,
          execution_id: input.executionId,
          resume_target: input.resumeTarget,
          display_preview_json: displayPreviewJson,
          requirement_json: canonicalJson(requirement),
          expires_at: expiresAt,
        },
      );
      if (!created[0]) throw new Error("Approval 생성 결과가 없습니다");
      await this.insertEvent(
        tx,
        context.organizationId,
        approvalId,
        input.commandId,
        1,
        "approval_requested",
        requestJson,
        {
          decisionId: decision.decisionId,
        },
      );
      return await this.find(tx, context.organizationId, approvalId);
    });
  }

  public async vote(context: TenantContext, input: VoteApprovalInput): Promise<ApprovalRecord> {
    await this.organizations.verifyTenantContext(context);
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    )
      throw new Error("승인 요청의 expectedRevision이 올바르지 않습니다");
    await this.expire(context, input.approvalId);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      const current = await this.find(tx, context.organizationId, input.approvalId);
      const requirement = JSON.parse(current.requirement_json) as ApprovalRequirement;
      await this.organizations.verifyTenantContext(context, requirement.approverRoles as readonly MembershipRole[], tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.find(tx, context.organizationId, repeated.approval_id);
      if (current.status === "expired") throw new Error("Approval이 만료됐습니다");
      const expectedRevision = input.expectedRevision ?? current.revision;
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
        throw new Error(
          `승인 요청의 revision 충돌입니다: 기대 ${String(input.expectedRevision)}, 현재 ${String(current.revision)}`,
        );
      if (current.status !== "pending") throw new Error(`pending Approval만 결정할 수 있습니다: ${current.status}`);
      if (instant(current.expires_at) <= this.clock.now().getTime()) throw new Error("Approval이 만료됐습니다");
      if (requirement.separationOfDuty && current.requester_user_id === context.userId)
        throw new Error("요청자와 승인자를 분리해야 합니다");
      const [existingVotes] = await tx.query<[VoteRecord[]]>(
        "SELECT vote, reason FROM governance_approval_vote WHERE organization_id = $organization_id AND approval_id = $approval_id AND approver_user_id = $approver_user_id LIMIT 1;",
        { organization_id: context.organizationId, approval_id: current.approval_id, approver_user_id: context.userId },
      );
      if (existingVotes[0]) {
        if (existingVotes[0].vote !== input.vote || existingVotes[0].reason !== input.reason)
          throw new Error("같은 승인자는 다른 표를 다시 제출할 수 없습니다");
        return current;
      }
      const [approvals] = await tx.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM governance_approval_vote WHERE organization_id = $organization_id AND approval_id = $approval_id AND vote = 'approve' GROUP ALL;",
        { organization_id: context.organizationId, approval_id: current.approval_id },
      );
      const approveCount = (approvals[0]?.count ?? 0) + (input.vote === "approve" ? 1 : 0);
      const status: ApprovalStatus =
        input.vote === "reject" ? "rejected" : approveCount >= requirement.quorum ? "approved" : "pending";
      const [updated] = await tx.query<[ApprovalRecord[]]>(
        "UPDATE governance_approval SET status = $status, revision += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND approval_id = $approval_id AND status = 'pending' AND revision = $expected_revision RETURN AFTER;",
        {
          organization_id: context.organizationId,
          approval_id: current.approval_id,
          expected_revision: expectedRevision,
          status,
        },
      );
      const result = updated[0];
      if (!result) throw new Error("승인 요청의 revision 충돌입니다");
      await tx.query(
        "CREATE governance_approval_vote CONTENT { vote_id: $vote_id, organization_id: $organization_id, approval_id: $approval_id, approver_user_id: $approver_user_id, approver_membership_id: $approver_membership_id, approver_role: $approver_role, vote: $vote, reason: $reason, created_at: time::now() };",
        {
          vote_id: randomUUID(),
          organization_id: context.organizationId,
          approval_id: current.approval_id,
          approver_user_id: context.userId,
          approver_membership_id: context.membershipId,
          approver_role: context.role,
          vote: input.vote,
          reason: input.reason,
        },
      );
      await this.insertEvent(
        tx,
        context.organizationId,
        current.approval_id,
        input.commandId,
        result.event_sequence,
        status === "pending" ? "approval_voted" : `approval_${status}`,
        requestJson,
        { approverUserId: context.userId, vote: input.vote, status },
      );
      return await this.find(tx, context.organizationId, current.approval_id);
    });
  }

  public async expire(context: TenantContext, approvalId: string): Promise<ApprovalRecord> {
    await this.organizations.verifyTenantContext(context);
    // ponytail: 네 번의 CAS 경합 뒤 최신 상태를 반환하고, 지속 경합이 관측되면 공통 재시도 정책으로 올립니다.
    for (let attempt = 0; ; attempt += 1) {
      const expired = await this.database.transaction(async (tx) => {
        const current = await this.find(tx, context.organizationId, approvalId);
        if (current.status !== "pending" || instant(current.expires_at) > this.clock.now().getTime()) return current;
        const commandId = `${approvalId}:expire`;
        const requestJson = canonicalJson({ approvalId });
        const repeated = await this.repeated(tx, context.organizationId, commandId, requestJson);
        if (repeated) return await this.find(tx, context.organizationId, approvalId);
        const [updated] = await tx.query<[ApprovalRecord[]]>(
          "UPDATE governance_approval SET status = 'expired', revision += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND approval_id = $approval_id AND status = 'pending' AND revision = $current_revision RETURN AFTER;",
          {
            organization_id: context.organizationId,
            approval_id: approvalId,
            current_revision: current.revision,
          },
        );
        const result = updated[0];
        if (!result) return undefined;
        await this.insertEvent(
          tx,
          context.organizationId,
          approvalId,
          commandId,
          result.event_sequence,
          "approval_expired",
          requestJson,
          { expiredAt: this.clock.now().toISOString() },
        );
        return await this.find(tx, context.organizationId, approvalId);
      });
      if (expired) return expired;
      const latest = await this.find(this.database, context.organizationId, approvalId);
      if (latest.status !== "pending" || instant(latest.expires_at) > this.clock.now().getTime()) return latest;
      if (attempt >= 3) throw new Error("Approval 만료 처리 동시성 충돌입니다");
    }
  }

  public async cancel(context: TenantContext, input: CancelApprovalInput): Promise<ApprovalRecord> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.find(tx, context.organizationId, repeated.approval_id);
      const current = await this.find(tx, context.organizationId, input.approvalId);
      if (current.requester_user_id !== context.userId)
        await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      if (current.status !== "pending" && current.status !== "approved") {
        throw new Error(`미소비 Approval만 취소할 수 있습니다: ${current.status}`);
      }
      const [updated] = await tx.query<[ApprovalRecord[]]>(
        "UPDATE governance_approval SET status = 'cancelled', revision += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND approval_id = $approval_id AND status IN ['pending', 'approved'] RETURN AFTER;",
        { organization_id: context.organizationId, approval_id: current.approval_id },
      );
      const result = updated[0];
      if (!result) throw new Error("Approval cancellation 결과가 없습니다");
      await this.insertEvent(
        tx,
        context.organizationId,
        current.approval_id,
        input.commandId,
        result.event_sequence,
        "approval_cancelled",
        requestJson,
        { cancelledBy: context.userId, reason: input.reason },
      );
      return await this.find(tx, context.organizationId, current.approval_id);
    });
  }

  public async get(
    context: TenantContext,
    approvalId: string,
    executor: QueryExecutor = this.database,
  ): Promise<ApprovalRecord> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    return await this.find(executor, context.organizationId, approvalId);
  }

  public async listEvents(context: TenantContext, approvalId: string): Promise<ApprovalEvent[]> {
    await this.organizations.verifyTenantContext(context);
    await this.find(this.database, context.organizationId, approvalId);
    const [events] = await this.database.query<[ApprovalEvent[]]>(
      "SELECT * OMIT id FROM governance_approval_event WHERE organization_id = $organization_id AND approval_id = $approval_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, approval_id: approvalId },
    );
    return events;
  }

  public async listPending(context: TenantContext): Promise<ApprovalRecord[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ApprovalRecord[]]>(
      "SELECT * OMIT id FROM governance_approval WHERE organization_id = $organization_id AND status = 'pending' ORDER BY created_at ASC, approval_id ASC;",
      { organization_id: context.organizationId },
    );
    return records;
  }

  private async find(executor: QueryExecutor, organizationId: string, approvalId: string): Promise<ApprovalRecord> {
    const [records] = await executor.query<[ApprovalRecord[]]>(
      "SELECT * OMIT id FROM governance_approval WHERE organization_id = $organization_id AND approval_id = $approval_id LIMIT 1;",
      { organization_id: organizationId, approval_id: approvalId },
    );
    if (!records[0]) throw new Error(`Approval을 찾을 수 없습니다: ${approvalId}`);
    return records[0];
  }

  private async repeated(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<ApprovalEvent | undefined> {
    const [events] = await executor.query<[ApprovalEvent[]]>(
      "SELECT * OMIT id FROM governance_approval_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Approval 요청을 사용할 수 없습니다");
    return events[0];
  }

  private async insertEvent(
    executor: QueryExecutor,
    organizationId: string,
    approvalId: string,
    commandId: string,
    sequence: number,
    eventType: string,
    requestJson: string,
    payload: unknown,
  ): Promise<void> {
    await executor.query(
      "CREATE governance_approval_event CONTENT { event_id: $event_id, organization_id: $organization_id, approval_id: $approval_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_json: $request_json, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        approval_id: approvalId,
        command_id: commandId,
        sequence,
        event_type: eventType,
        request_json: requestJson,
        payload_json: canonicalJson(payload),
      },
    );
  }
}
