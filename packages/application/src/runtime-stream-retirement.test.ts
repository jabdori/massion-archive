import { createHash } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { RuntimeExecutionStore, RuntimeRecovery, type RuntimeEvent } from "@massion/runtime";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationEventProjector } from "./event-projector.js";
import {
  APPLICATION_MIGRATIONS,
  APPLICATION_EVENT_LINEAGE_MIGRATION,
  APPLICATION_EVENT_MIGRATION,
  APPLICATION_OUTBOX_MIGRATION,
  APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
  APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
} from "./schema.js";
import { RuntimeStreamRetirementService } from "./runtime-stream-retirement.js";

const LEGACY_RUNTIME_STREAM_RETIREMENT_CHECKSUM = "07199ea58b87cc9a0a1c199dcc9f3e4d2d01b11895a9907b34bb988f4ec91866";

interface OutboxRecord {
  readonly outbox_id: string;
  readonly organization_id: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly state: "pending" | "projected";
  readonly public_event_id?: string;
  readonly updated_at: unknown;
}

interface PublicEventRecord {
  readonly event_id: string;
  readonly organization_id: string;
  readonly sequence: number;
  readonly source_kind: string;
  readonly source_id: string;
  readonly payload_json: string;
  readonly payload_hash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("과거 Runtime stream part retirement", () => {
  let database: MassionDatabase;
  let identities: IdentityService;
  let organizations: OrganizationService;
  let context: TenantContext;
  let runtime: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: `runtime-retirement-${crypto.randomUUID()}@example.com`,
      displayName: "Runtime retirement",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    runtime = await RuntimeExecutionStore.create(database, organizations);
    await applyMigrations(database, [
      APPLICATION_OUTBOX_MIGRATION,
      APPLICATION_EVENT_MIGRATION,
      APPLICATION_EVENT_LINEAGE_MIGRATION,
    ]);
  });

  afterEach(async () => {
    await database.close();
  });

  async function markLegacyRetirementApplied(): Promise<void> {
    await database.query(
      "CREATE system_migration CONTENT { migration_id: '0121-application-runtime-stream-retirement', checksum: $checksum, applied_at: time::now() };",
      { checksum: LEGACY_RUNTIME_STREAM_RETIREMENT_CHECKSUM },
    );
  }

  it("startup migration은 이력을 순회하지 않고 이전 0121 checksum을 호환한다", async () => {
    await markLegacyRetirementApplied();

    await expect(applyMigrations(database, [APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION])).resolves.toEqual([]);
    expect(APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.compatibleChecksums).toContain(
      LEGACY_RUNTIME_STREAM_RETIREMENT_CHECKSUM,
    );
    expect(APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.compatibleChecksums).toContain(
      "9e73a3f323a6bd86d7597355ce24f20743d82167de79f4e270b494023c453109",
    );
    expect(APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.compatibleChecksums).toContain(
      "8df5ff8b291967c01b682477304d2824c737f76173ef7f0d0b2cd32f09b06026",
    );
    expect(APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION.compatibleChecksums).toContain(
      "9e73a3f323a6bd86d7597355ce24f20743d82167de79f4e270b494023c453109",
    );
    expect(APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION.compatibleChecksums).toContain(
      "8df5ff8b291967c01b682477304d2824c737f76173ef7f0d0b2cd32f09b06026",
    );
    expect(APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.compatibleChecksums).toContain(
      "fa4436e9fc2570e0f2c0caf3dccec52796f2353fb32ca859ba5f9736a22b81e9",
    );
    expect(APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION.compatibleChecksums).toContain(
      "fa4436e9fc2570e0f2c0caf3dccec52796f2353fb32ca859ba5f9736a22b81e9",
    );
    expect(APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION.surql).toBe(
      APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.surql,
    );
    expect(APPLICATION_MIGRATIONS).toContain(APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION);
    expect(APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION.surql.trim()).toBe("RETURN NONE;");
  });

  it("Application Event Projector가 기존 0121 DB에 0122 reconciliation을 적용한다", async () => {
    await markLegacyRetirementApplied();

    await ApplicationEventProjector.create(database, organizations);

    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toContain(
      "0122-application-runtime-stream-reconciliation",
    );
  });

  it("직전 공개 0121·0122 checksum을 적용한 DB도 그대로 기동한다", async () => {
    await database.query(
      `CREATE system_migration CONTENT { migration_id: '0121-application-runtime-stream-retirement', checksum: $checksum, applied_at: time::now() };
       CREATE system_migration CONTENT { migration_id: '0122-application-runtime-stream-reconciliation', checksum: $checksum, applied_at: time::now() };`,
      { checksum: "9e73a3f323a6bd86d7597355ce24f20743d82167de79f4e270b494023c453109" },
    );

    await expect(
      applyMigrations(database, [
        APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
        APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
      ]),
    ).resolves.toEqual([]);
  });

  it("직전 batch tombstone checksum을 적용한 DB도 그대로 기동한다", async () => {
    await database.query(
      `CREATE system_migration CONTENT { migration_id: '0121-application-runtime-stream-retirement', checksum: $checksum, applied_at: time::now() };
       CREATE system_migration CONTENT { migration_id: '0122-application-runtime-stream-reconciliation', checksum: $checksum, applied_at: time::now() };`,
      { checksum: "8df5ff8b291967c01b682477304d2824c737f76173ef7f0d0b2cd32f09b06026" },
    );

    await expect(
      applyMigrations(database, [
        APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
        APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
      ]),
    ).resolves.toEqual([]);
  });

  it("직전 fast reconciliation checksum을 적용한 DB도 그대로 기동한다", async () => {
    await database.query(
      `CREATE system_migration CONTENT { migration_id: '0121-application-runtime-stream-retirement', checksum: $checksum, applied_at: time::now() };
       CREATE system_migration CONTENT { migration_id: '0122-application-runtime-stream-reconciliation', checksum: $checksum, applied_at: time::now() };`,
      { checksum: "fa4436e9fc2570e0f2c0caf3dccec52796f2353fb32ca859ba5f9736a22b81e9" },
    );

    await expect(
      applyMigrations(database, [
        APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
        APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
      ]),
    ).resolves.toEqual([]);
  });

  async function running(suffix: string) {
    const created = await runtime.createExecution(context, {
      commandId: `retirement-${suffix}-queued`,
      workId: `work-${suffix}`,
      taskId: `task-${suffix}`,
      agentHandle: "representative",
      modelRoute: "orchestration-balanced",
      correlationId: `correlation-${suffix}`,
      estimatedTokens: 10,
      estimatedCostMicros: 0,
      input: { prompt: `private-${suffix}` },
    });
    return await runtime.transition(context, {
      commandId: `retirement-${suffix}-running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
  }

  async function publicEvent(
    event: RuntimeEvent,
    sequence: number,
    eventId: string,
    organizationId = context.organizationId,
  ): Promise<void> {
    const payloadJson = JSON.stringify({ domainSequence: event.sequence });
    await database.query(
      `CREATE application_event CONTENT {
        event_id: $event_id,
        organization_id: $organization_id,
        sequence: $sequence,
        source_kind: 'runtime-event',
        source_id: $source_id,
        event_type: 'runtime.model-text-delta',
        author_kind: 'system',
        author_id: 'runtime',
        correlation_id: NONE,
        causation_id: NONE,
        resource_type: 'Execution',
        resource_id: $execution_id,
        resource_revision: $resource_revision,
        occurred_at: time::now(),
        payload_json: $payload_json,
        payload_hash: $payload_hash
      };`,
      {
        event_id: eventId,
        organization_id: organizationId,
        sequence,
        source_id: event.event_id,
        execution_id: event.execution_id,
        resource_revision: event.sequence,
        payload_json: payloadJson,
        payload_hash: sha256(payloadJson),
      },
    );
  }

  async function outbox(sourceId: string, organizationId = context.organizationId): Promise<OutboxRecord | undefined> {
    const [records] = await database.query<[OutboxRecord[]]>(
      "SELECT * OMIT id FROM application_outbox WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id = $source_id LIMIT 1;",
      { organization_id: organizationId, source_id: sourceId },
    );
    return records[0];
  }

  it("fresh database에서는 no-op이고 migration은 한 번만 기록한다", async () => {
    const before = await database.query("SELECT * FROM runtime_event; SELECT * FROM application_outbox;");

    await expect(applyMigrations(database, [APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION])).resolves.toEqual([
      "0121-application-runtime-stream-retirement",
    ]);
    expect(await database.query("SELECT * FROM runtime_event; SELECT * FROM application_outbox;")).toEqual(before);
    await expect(applyMigrations(database, [APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION])).resolves.toEqual([]);
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toContain(
      "0121-application-runtime-stream-retirement",
    );
  });

  it("다른 조직의 동일 source 식별자는 변경하지 않는다", async () => {
    let primary = await running("tenant-boundary");
    primary = await runtime.appendEvent(context, {
      commandId: "retirement-tenant-boundary-raw",
      executionId: primary.execution.execution_id,
      expectedVersion: primary.execution.version,
      eventType: "model_text_delta",
      payload: { type: "text-delta", text: "private-primary" },
    });
    const raw = primary.event;
    const shadowOwner = await identities.registerPersonalUser({
      email: `runtime-retirement-shadow-${crypto.randomUUID()}@example.com`,
      displayName: "Runtime retirement shadow",
    });
    const shadowContext = await organizations.resolveTenantContext(
      shadowOwner.user.user_id,
      shadowOwner.organization.organization_id,
    );
    await database.query(
      `CREATE application_outbox CONTENT {
        outbox_id: $outbox_id,
        organization_id: $organization_id,
        source_kind: 'runtime-event',
        source_id: $source_id,
        aggregate_id: $aggregate_id,
        correlation_id: NONE,
        causation_id: NONE,
        occurred_at: time::now(),
        state: 'pending',
        public_event_id: NONE,
        created_at: time::now(),
        updated_at: time::now()
      };`,
      {
        outbox_id: `shadow:${raw.event_id}`,
        organization_id: shadowContext.organizationId,
        source_id: raw.event_id,
        aggregate_id: raw.execution_id,
      },
    );
    await publicEvent(raw, 1, "public-runtime-shadow", shadowContext.organizationId);
    const shadowBefore = await outbox(raw.event_id, shadowContext.organizationId);
    const retirement = new RuntimeStreamRetirementService(database, { batchSize: 100 });
    await expect(retirement.retireNextBatch()).resolves.toBe(1);
    await retirement.close();

    expect(await outbox(raw.event_id)).toBeUndefined();
    expect(await outbox(raw.event_id, shadowContext.organizationId)).toEqual(shadowBefore);
  });

  it("기존 old-checksum DB의 0122와 bounded worker는 혼합 projection을 보존·정합화하고 recovery와 replay를 fail-closed로 유지한다", async () => {
    await markLegacyRetirementApplied();
    const migrations = [
      APPLICATION_RUNTIME_STREAM_RETIREMENT_MIGRATION,
      APPLICATION_RUNTIME_STREAM_RECONCILIATION_MIGRATION,
    ];
    let primary = await running("primary");
    primary = await runtime.appendEvent(context, {
      commandId: "retirement-primary-route",
      executionId: primary.execution.execution_id,
      expectedVersion: primary.execution.version,
      eventType: "model.route.selected",
      payload: { modelProfileId: "profile-safe" },
    });
    const durableRoute = primary.event;
    primary = await runtime.appendEvent(context, {
      commandId: "retirement-primary-raw-pending",
      executionId: primary.execution.execution_id,
      expectedVersion: primary.execution.version,
      eventType: "model_text_delta",
      payload: { type: "text-delta", text: "private-pending" },
    });
    const rawPending = primary.event;
    primary = await runtime.appendEvent(context, {
      commandId: "retirement-primary-raw-projected",
      executionId: primary.execution.execution_id,
      expectedVersion: primary.execution.version,
      eventType: "model_reasoning_delta",
      payload: { type: "reasoning-delta", text: "private-projected" },
    });
    const rawProjected = primary.event;
    primary = await runtime.appendEvent(context, {
      commandId: "retirement-primary-raw-corrupt",
      executionId: primary.execution.execution_id,
      expectedVersion: primary.execution.version,
      eventType: "model_tool_call",
      payload: { type: "tool-call", toolInput: "private-corrupt" },
    });
    const rawCorruptPending = primary.event;

    let recoverable = await running("recoverable");
    const historicalReplayInput = {
      commandId: "retirement-recoverable-raw-replay",
      executionId: recoverable.execution.execution_id,
      expectedVersion: recoverable.execution.version,
      eventType: "model_text_delta",
      payload: { type: "text-delta", text: "private-recovery" },
    } as const;
    recoverable = await runtime.appendEvent(context, historicalReplayInput);
    const rawRecoverable = recoverable.event;

    await database.query(
      "CREATE application_event_stream CONTENT { organization_id: $organization_id, current_sequence: 2, retention_floor: 0, updated_at: time::now() };",
      { organization_id: context.organizationId },
    );
    await publicEvent(rawProjected, 1, "public-runtime-raw-projected");
    await publicEvent(rawCorruptPending, 2, "public-runtime-raw-corrupt");
    await database.query(
      "UPDATE application_outbox SET state = 'projected', public_event_id = $public_event_id WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id = $source_id;",
      {
        organization_id: context.organizationId,
        source_id: rawProjected.event_id,
        public_event_id: "public-runtime-raw-projected",
      },
    );

    const [rawMetadataBefore] = await database.query<
      [{ event_id: string; event_type: string; sequence: number; created_at: unknown }[]]
    >(
      "SELECT event_id, event_type, sequence, created_at FROM runtime_event WHERE event_id IN $event_ids ORDER BY event_id ASC;",
      {
        event_ids: [rawPending.event_id, rawProjected.event_id, rawCorruptPending.event_id, rawRecoverable.event_id],
      },
    );
    const [publicEventsBefore] = await database.query<[PublicEventRecord[]]>(
      "SELECT * OMIT id FROM application_event WHERE organization_id = $organization_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId },
    );
    const [streamBefore] = await database.query<[{ current_sequence: number; retention_floor: number }[]]>(
      "SELECT current_sequence, retention_floor FROM application_event_stream WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const projectedOutboxBefore = await outbox(rawProjected.event_id);
    const [executionsBefore] = await database.query<
      [{ execution_id: string; version: number; event_sequence: number; status: string }[]]
    >(
      "SELECT execution_id, version, event_sequence, status FROM runtime_execution WHERE execution_id IN $execution_ids ORDER BY execution_id ASC;",
      { execution_ids: [primary.execution.execution_id, recoverable.execution.execution_id] },
    );

    await expect(applyMigrations(database, migrations)).resolves.toEqual([
      "0122-application-runtime-stream-reconciliation",
    ]);
    const retirement = new RuntimeStreamRetirementService(database, { batchSize: 100 });
    await expect(retirement.retireNextBatch()).resolves.toBe(4);
    await expect(retirement.retireNextBatch()).resolves.toBe(0);
    await retirement.close();

    const [rawAfter] = await database.query<
      [
        {
          event_id: string;
          event_type: string;
          sequence: number;
          created_at: unknown;
          request_json: string;
          payload_json: string;
          result_json: string;
        }[],
      ]
    >(
      "SELECT event_id, event_type, sequence, created_at, request_json, payload_json, result_json FROM runtime_event WHERE event_id IN $event_ids ORDER BY event_id ASC;",
      {
        event_ids: [rawPending.event_id, rawProjected.event_id, rawCorruptPending.event_id, rawRecoverable.event_id],
      },
    );
    expect(
      rawAfter.map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
        sequence: event.sequence,
        created_at: event.created_at,
      })),
    ).toEqual(rawMetadataBefore);
    expect(rawAfter.map((event) => [event.request_json, event.payload_json, event.result_json])).toEqual(
      Array.from({ length: 4 }, () => ["{}", "{}", "{}"]),
    );
    expect(await outbox(rawPending.event_id)).toBeUndefined();
    expect(await outbox(rawRecoverable.event_id)).toBeUndefined();
    expect(await outbox(rawProjected.event_id)).toEqual(projectedOutboxBefore);
    expect(await outbox(rawCorruptPending.event_id)).toMatchObject({
      state: "projected",
      public_event_id: "public-runtime-raw-corrupt",
    });
    expect(await outbox(durableRoute.event_id)).toMatchObject({ state: "pending" });

    const [publicEventsAfter] = await database.query<[PublicEventRecord[]]>(
      "SELECT * OMIT id FROM application_event WHERE organization_id = $organization_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId },
    );
    const [streamAfter] = await database.query<[{ current_sequence: number; retention_floor: number }[]]>(
      "SELECT current_sequence, retention_floor FROM application_event_stream WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const [executionsAfter] = await database.query<
      [{ execution_id: string; version: number; event_sequence: number; status: string }[]]
    >(
      "SELECT execution_id, version, event_sequence, status FROM runtime_execution WHERE execution_id IN $execution_ids ORDER BY execution_id ASC;",
      { execution_ids: [primary.execution.execution_id, recoverable.execution.execution_id] },
    );
    expect(publicEventsAfter).toEqual(publicEventsBefore);
    expect(streamAfter).toEqual(streamBefore);
    expect(executionsAfter).toEqual(executionsBefore);

    const eventCountBeforeReplay = (await runtime.listEvents(context, recoverable.execution.execution_id)).length;
    await expect(runtime.appendEvent(context, historicalReplayInput)).rejects.toThrow(
      "retired raw Runtime Event는 replay할 수 없습니다",
    );
    expect(await runtime.listEvents(context, recoverable.execution.execution_id)).toHaveLength(eventCountBeforeReplay);

    const recovery = new RuntimeRecovery(runtime, { getWorkflowState: async () => null });
    await expect(recovery.recover(context, recoverable.execution.execution_id)).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(recovery.recover(context, recoverable.execution.execution_id)).resolves.toMatchObject({
      status: "interrupted",
    });
    const recovered = await runtime.getRecovery(context, recoverable.execution.execution_id);
    expect(recovered.events.map((event) => [event.sequence, event.event_type])).toEqual([
      [1, "execution_queued"],
      [2, "execution_running"],
      [3, "model_text_delta"],
      [4, "execution_interrupted"],
    ]);
    expect(recovered.events[2]).toMatchObject({ request_json: "{}", payload_json: "{}", result_json: "{}" });
    expect(recovered.events.filter((event) => event.event_type === "execution_interrupted")).toHaveLength(1);
    await expect(applyMigrations(database, migrations)).resolves.toEqual([]);
  });
});
