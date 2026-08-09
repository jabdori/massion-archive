import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  APPLICATION_EVENT_LINEAGE_MIGRATION,
  APPLICATION_EVENT_MIGRATION,
  APPLICATION_OUTBOX_MIGRATION,
} from "./schema.js";

interface OutboxRecord {
  readonly outbox_id: string;
  readonly organization_id: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly aggregate_id?: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly occurred_at: unknown;
}

interface PublicProjection {
  readonly type: string;
  readonly authorKind: "user" | "agent" | "system";
  readonly authorId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly resource?: { readonly type: string; readonly id: string; readonly revision?: number };
  readonly occurredAt: unknown;
  readonly payload: unknown;
}

interface StreamRecord {
  readonly current_sequence: number;
}

class ProjectionHookError extends Error {
  public constructor(public readonly original: unknown) {
    super("Application event projection hook failed");
  }
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function eventType(prefix: string, value: string): string {
  const normalized = value.toLowerCase();
  const unprefixed = normalized.startsWith(`${prefix}_`) ? normalized.slice(prefix.length + 1) : normalized;
  const suffix = unprefixed.replaceAll("_", "-").replace(/[^a-z0-9-]/gu, "-");
  return `${prefix}.${suffix}`;
}

export interface ApplicationEventProjectorHooks {
  readonly afterEventCreated?: () => void | Promise<void>;
}

export class ApplicationEventProjector {
  private readonly organizationProjectionTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly hooks?: ApplicationEventProjectorHooks,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    hooks?: ApplicationEventProjectorHooks,
  ): Promise<ApplicationEventProjector> {
    await applyMigrations(database, [
      APPLICATION_OUTBOX_MIGRATION,
      APPLICATION_EVENT_MIGRATION,
      APPLICATION_EVENT_LINEAGE_MIGRATION,
    ]);
    return new ApplicationEventProjector(database, organizations, hooks);
  }

  public async projectPending(context: TenantContext, limit: number): Promise<number> {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Application projection limit이 유효하지 않습니다");
    return await this.projectForOrganization(context.organizationId, async () => {
      if (!(await this.hasPending(context.organizationId))) return 0;
      let projected = 0;
      while (projected < limit) {
        try {
          if (!(await this.projectOne(context))) break;
          projected += 1;
        } catch (error) {
          if (error instanceof ProjectionHookError) throw error.original;
          throw error;
        }
      }
      return projected;
    });
  }

  private async hasPending(organizationId: string): Promise<boolean> {
    return Boolean(
      await first<{ readonly outbox_id: string; readonly occurred_at: unknown }>(
        this.database,
        "SELECT outbox_id, occurred_at FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC LIMIT 1;",
        { organization_id: organizationId },
      ),
    );
  }

  private async projectForOrganization<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.organizationProjectionTails.get(organizationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.organizationProjectionTails.set(organizationId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.organizationProjectionTails.get(organizationId) === tail)
        this.organizationProjectionTails.delete(organizationId);
    }
  }

  private async projectOne(context: TenantContext): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const outbox = await first<OutboxRecord>(
        transaction,
        "SELECT * OMIT id FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC LIMIT 1;",
        { organization_id: context.organizationId },
      );
      if (!outbox) return false;
      const existing = await first<{ event_id: string }>(
        transaction,
        "SELECT event_id FROM application_event WHERE organization_id = $organization_id AND source_kind = $source_kind AND source_id = $source_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          source_kind: outbox.source_kind,
          source_id: outbox.source_id,
        },
      );
      if (existing) {
        await transaction.query(
          "UPDATE application_outbox SET state = 'projected', public_event_id = $event_id, updated_at = time::now() WHERE organization_id = $organization_id AND outbox_id = $outbox_id;",
          { organization_id: context.organizationId, outbox_id: outbox.outbox_id, event_id: existing.event_id },
        );
        return true;
      }
      const projection = await this.map(transaction, outbox);
      const current = await first<StreamRecord>(
        transaction,
        "SELECT current_sequence FROM application_event_stream WHERE organization_id = $organization_id LIMIT 1;",
        { organization_id: context.organizationId },
      );
      const sequence = (current?.current_sequence ?? 0) + 1;
      if (!current) {
        await transaction.query(
          "CREATE application_event_stream CONTENT { organization_id: $organization_id, current_sequence: $sequence, retention_floor: 0, updated_at: time::now() };",
          { organization_id: context.organizationId, sequence },
        );
      } else {
        await transaction.query(
          "UPDATE application_event_stream SET current_sequence = $sequence, updated_at = time::now() WHERE organization_id = $organization_id AND current_sequence = $previous_sequence;",
          {
            organization_id: context.organizationId,
            sequence,
            previous_sequence: current.current_sequence,
          },
        );
      }
      const eventId = randomUUID();
      const payloadJson = canonicalJson(projection.payload);
      await transaction.query(
        "CREATE application_event CONTENT { event_id: $event_id, organization_id: $organization_id, sequence: $sequence, source_kind: $source_kind, source_id: $source_id, event_type: $event_type, author_kind: $author_kind, author_id: $author_id, correlation_id: $correlation_id, causation_id: $causation_id, resource_type: $resource_type, resource_id: $resource_id, resource_revision: $resource_revision, occurred_at: $occurred_at, payload_json: $payload_json, payload_hash: $payload_hash };",
        {
          event_id: eventId,
          organization_id: context.organizationId,
          sequence,
          source_kind: outbox.source_kind,
          source_id: outbox.source_id,
          event_type: projection.type,
          author_kind: projection.authorKind,
          author_id: projection.authorId,
          correlation_id: projection.correlationId,
          causation_id: projection.causationId,
          resource_type: projection.resource?.type,
          resource_id: projection.resource?.id,
          resource_revision: projection.resource?.revision,
          occurred_at: projection.occurredAt,
          payload_json: payloadJson,
          payload_hash: sha256(payloadJson),
        },
      );
      try {
        await this.hooks?.afterEventCreated?.();
      } catch (error) {
        throw new ProjectionHookError(error);
      }
      await transaction.query(
        "UPDATE application_outbox SET state = 'projected', public_event_id = $event_id, updated_at = time::now() WHERE organization_id = $organization_id AND outbox_id = $outbox_id AND state = 'pending';",
        { organization_id: context.organizationId, outbox_id: outbox.outbox_id, event_id: eventId },
      );
      return true;
    });
  }

  private async map(executor: QueryExecutor, outbox: OutboxRecord): Promise<PublicProjection> {
    const common = {
      ...(outbox.correlation_id === undefined ? {} : { correlationId: outbox.correlation_id }),
      ...(outbox.causation_id === undefined ? {} : { causationId: outbox.causation_id }),
      occurredAt: outbox.occurred_at,
    };
    switch (outbox.source_kind) {
      case "organization-version": {
        const source = await this.source<{
          version: number;
          command_kind: string;
          actor_user_id: string;
        }>(executor, "organization_version", "version_id", outbox);
        return {
          ...common,
          type: "organization.version-created",
          authorKind: "user",
          authorId: source.actor_user_id,
          resource: { type: "Organization", id: outbox.organization_id, revision: source.version },
          payload: { commandKind: source.command_kind },
        };
      }
      case "work-event": {
        const source = await this.source<{
          work_id: string;
          sequence: number;
          event_type: string;
          actor_user_id: string;
        }>(executor, "work_event", "event_id", outbox);
        return {
          ...common,
          type: eventType("work", source.event_type),
          authorKind: "user",
          authorId: source.actor_user_id,
          resource: { type: "Work", id: source.work_id, revision: source.sequence },
          payload: { domainSequence: source.sequence },
        };
      }
      case "collaboration-message": {
        const source = await this.source<{
          message_id: string;
          work_id: string;
          room_id: string;
          sequence: number;
          message_type: string;
          author_kind: "user" | "agent" | "system";
          author_id: string;
          content: string;
        }>(executor, "collaboration_message", "message_id", outbox);
        return {
          ...common,
          type: "collaboration.message-posted",
          authorKind: source.author_kind,
          authorId: source.author_id,
          resource: { type: "Work", id: source.work_id },
          payload: {
            messageId: source.message_id,
            roomId: source.room_id,
            sequence: source.sequence,
            messageType: source.message_type,
            content: source.content,
          },
        };
      }
      case "runtime-event": {
        const source = await this.source<{ execution_id: string; sequence: number; event_type: string }>(
          executor,
          "runtime_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("runtime", source.event_type),
          authorKind: "system",
          authorId: "runtime",
          resource: { type: "Execution", id: source.execution_id, revision: source.sequence },
          payload: { domainSequence: source.sequence },
        };
      }
      case "approval-event": {
        const source = await this.source<{ approval_id: string; sequence: number; event_type: string }>(
          executor,
          "governance_approval_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("approval", source.event_type),
          authorKind: "system",
          authorId: "governance",
          resource: { type: "Approval", id: source.approval_id, revision: source.sequence },
          payload: { domainSequence: source.sequence },
        };
      }
      case "extension-event": {
        const source = await this.source<{ installation_id: string; event_type: string }>(
          executor,
          "extension_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("extension", source.event_type),
          authorKind: "system",
          authorId: "extension-host",
          resource: { type: "Extension", id: source.installation_id },
          payload: {},
        };
      }
      case "growth-event": {
        const source = await this.source<{ aggregate_type: string; aggregate_id: string; event_type: string }>(
          executor,
          "growth_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("growth", source.event_type),
          authorKind: "system",
          authorId: "growth",
          resource: { type: source.aggregate_type, id: source.aggregate_id },
          payload: {},
        };
      }
      case "token-event": {
        const source = await this.source<{ token_id: string; actor_user_id: string; event_type: string }>(
          executor,
          "application_token_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("token", source.event_type),
          authorKind: "user",
          authorId: source.actor_user_id,
          resource: { type: "AccessToken", id: source.token_id },
          payload: {},
        };
      }
      case "command-event": {
        const source = await this.source<{ command_record_id: string; lease_generation: number; event_type: string }>(
          executor,
          "application_command_event",
          "event_id",
          outbox,
        );
        return {
          ...common,
          type: eventType("command", source.event_type),
          authorKind: "system",
          authorId: "application",
          resource: { type: "ApplicationCommand", id: source.command_record_id, revision: source.lease_generation },
          payload: {},
        };
      }
      case "run-event": {
        const source = await this.source<{
          run_id: string;
          work_id?: string;
          lease_generation: number;
          stage: string;
          event_type: string;
        }>(executor, "application_run_event", "event_id", outbox);
        return {
          ...common,
          type: eventType("run", source.event_type),
          authorKind: "system",
          authorId: "application",
          resource: { type: "ApplicationRun", id: source.run_id, revision: source.lease_generation },
          payload: { stage: source.stage, ...(source.work_id === undefined ? {} : { workId: source.work_id }) },
        };
      }
      default:
        throw new Error(`허용되지 않은 Application outbox source입니다: ${outbox.source_kind}`);
    }
  }

  private async source<T>(executor: QueryExecutor, table: string, idField: string, outbox: OutboxRecord): Promise<T> {
    const allowed = new Set([
      "organization_version:version_id",
      "work_event:event_id",
      "collaboration_message:message_id",
      "runtime_event:event_id",
      "governance_approval_event:event_id",
      "extension_event:event_id",
      "growth_event:event_id",
      "application_token_event:event_id",
      "application_command_event:event_id",
      "application_run_event:event_id",
    ]);
    if (!allowed.has(`${table}:${idField}`)) throw new Error("Application source query allowlist 위반입니다");
    const source = await first<T>(
      executor,
      `SELECT * OMIT id FROM ${table} WHERE organization_id = $organization_id AND ${idField} = $source_id LIMIT 1;`,
      { organization_id: outbox.organization_id, source_id: outbox.source_id },
    );
    if (!source) throw new Error("Application outbox source를 찾을 수 없습니다");
    return source;
  }
}
