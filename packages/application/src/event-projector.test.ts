import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { WorkService } from "@massion/work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import { ApplicationRunStore } from "./run-store.js";

describe("ApplicationEventProjector", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let works: WorkService;
  let runtime: RuntimeExecutionStore;
  let projector: ApplicationEventProjector;
  let events: ApplicationEventStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "projector@example.com", displayName: "Projector" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    works = await WorkService.create(database, organizations, graph);
    runtime = await RuntimeExecutionStore.create(database, organizations);
    projector = await ApplicationEventProjector.create(database, organizations);
    events = await ApplicationEventStore.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  async function pendingRawOutboxCount(): Promise<number> {
    const [outboxes] = await database.query<[unknown[]]>(
      "SELECT source_id FROM application_outbox WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND state = 'pending';",
      { organization_id: context.organizationId },
    );
    return outboxes.length;
  }

  it("public allowlist mapper로 조직별 연속 sequence를 만들고 replay는 중복하지 않는다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    await works.createWork(context, {
      commandId: "projector-create-work-0001",
      text: "공개 event projection",
      surface: "test",
      organizationVersionId: bootstrapped.version.version_id,
    });

    expect(await projector.projectPending(context, 10)).toBe(2);
    expect(await projector.projectPending(context, 10)).toBe(0);
    const projected = await events.read(context, { after: 0, limit: 10 });
    expect(projected.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "organization.version-created"],
      [2, "work.created"],
    ]);
    expect(JSON.stringify(projected)).not.toContain("request_json");
    expect(JSON.stringify(projected)).not.toContain("공개 event projection");
  });

  it.each([
    { label: "원문이 남은", tombstoned: false },
    { label: "이미 tombstone된", tombstoned: true },
  ])("$label raw model outbox를 공개 후보에서 제외하고 뒤의 durable event를 투영한다", async ({ tombstoned }) => {
    const created = await runtime.createExecution(context, {
      commandId: "projector-raw-stream-queued-0001",
      workId: "projector-raw-stream-work",
      agentHandle: "representative",
      modelRoute: "orchestration-balanced",
      correlationId: "projector-raw-stream-correlation-0001",
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { prompt: "private" },
    });
    const running = await runtime.transition(context, {
      commandId: "projector-raw-stream-running-0001",
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
    await projector.projectPending(context, 10);
    const before = await events.read(context, { after: 0, limit: 10 });
    const raw = await runtime.appendEvent(context, {
      commandId: "projector-raw-stream-delta-0001",
      executionId: running.execution.execution_id,
      expectedVersion: running.execution.version,
      eventType: "model_text_delta",
      payload: { text: "private stream text" },
    });
    if (tombstoned) {
      await database.query(
        "UPDATE runtime_event SET request_json = '{}', payload_json = '{}', result_json = '{}' WHERE organization_id = $organization_id AND event_id = $event_id;",
        { organization_id: context.organizationId, event_id: raw.event.event_id },
      );
    }
    await database.query(
      "UPDATE application_outbox SET occurred_at = d'2000-01-01T00:00:00Z' WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id = $source_id;",
      { organization_id: context.organizationId, source_id: raw.event.event_id },
    );
    const durable = await runtime.appendEvent(context, {
      commandId: "projector-raw-stream-route-0001",
      executionId: raw.execution.execution_id,
      expectedVersion: raw.execution.version,
      eventType: "model.route.selected",
      payload: { modelProfileId: "profile-safe" },
    });
    await expect(projector.projectPending(context, 10)).resolves.toBe(1);
    const projected = await events.read(context, { after: before.cursor, limit: 10 });
    expect(projected.events).toEqual([
      expect.objectContaining({
        type: "runtime.model-route-selected",
        resource: { type: "Execution", id: durable.execution.execution_id, revision: durable.event.sequence },
      }),
    ]);
    expect(projected.events.map((event) => event.type)).not.toContain("runtime.model-text-delta");
    const [outbox] = await database.query<[[]]>(
      "SELECT state FROM application_outbox WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id = $source_id LIMIT 1;",
      { organization_id: context.organizationId, source_id: raw.event.event_id },
    );
    expect(outbox).toEqual([{ state: "pending" }]);
  });

  it("raw model outbox backlog 뒤의 durable runtime event를 먼저 투영한다", async () => {
    const created = await runtime.createExecution(context, {
      commandId: "projector-priority-queued-0001",
      workId: "projector-priority-work",
      agentHandle: "representative",
      modelRoute: "orchestration-balanced",
      correlationId: "projector-priority-correlation-0001",
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { prompt: "private" },
    });
    const running = await runtime.transition(context, {
      commandId: "projector-priority-running-0001",
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
    await projector.projectPending(context, 10);
    const before = await events.read(context, { after: 0, limit: 10 });
    let execution = running.execution;
    const rawSourceIds: string[] = [];
    for (const index of [1, 2, 3]) {
      const appended = await runtime.appendEvent(context, {
        commandId: `projector-priority-delta-000${String(index)}`,
        executionId: execution.execution_id,
        expectedVersion: execution.version,
        eventType: "model_text_delta",
        payload: { text: `private-${String(index)}` },
      });
      execution = appended.execution;
      rawSourceIds.push(appended.event.event_id);
    }
    const durable = await runtime.appendEvent(context, {
      commandId: "projector-priority-route-0001",
      executionId: execution.execution_id,
      expectedVersion: execution.version,
      eventType: "model.route.selected",
      payload: { modelProfileId: "profile-safe" },
    });
    await database.query(
      "UPDATE application_outbox SET occurred_at = d'2000-01-01T00:00:00Z' WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id IN $source_ids;",
      { organization_id: context.organizationId, source_ids: rawSourceIds },
    );
    const [orderedBeforeProjection] = await database.query<[{ readonly source_id: string }[]]>(
      "SELECT source_id, occurred_at, outbox_id FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC;",
      { organization_id: context.organizationId },
    );
    expect(
      orderedBeforeProjection
        .slice(0, 3)
        .map((outbox) => outbox.source_id)
        .sort(),
    ).toEqual([...rawSourceIds].sort());

    await expect(projector.projectPending(context, 1)).resolves.toBe(1);
    const projected = await events.read(context, { after: before.cursor, limit: 10 });
    expect(projected.events).toEqual([
      expect.objectContaining({
        type: "runtime.model-route-selected",
        resource: { type: "Execution", id: durable.execution.execution_id, revision: durable.event.sequence },
      }),
    ]);
    const [pendingRaw] = await database.query<[{ readonly source_id: string }[]]>(
      "SELECT source_id FROM application_outbox WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND state = 'pending' ORDER BY source_id ASC;",
      { organization_id: context.organizationId },
    );
    expect(pendingRaw).toHaveLength(3);
    const transaction = vi.spyOn(database, "transaction");
    await expect(projector.projectPending(context, 1_000)).resolves.toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it("raw model outbox page 경계를 넘어 durable runtime event를 투영한다", async () => {
    const rawEvents = Array.from({ length: 101 }, (_, offset) => ({
      event_id: `projector-page-raw-${String(offset).padStart(4, "0")}`,
      organization_id: context.organizationId,
      execution_id: "projector-page-execution",
      command_id: `projector-page-command-${String(offset).padStart(4, "0")}`,
      sequence: offset + 1,
      event_type: "model_text_delta",
      request_json: "{}",
      payload_json: '{"text":"private"}',
      result_json: "{}",
      created_at: new Date("2000-01-01T00:00:00.000Z"),
    }));
    await database.query("FOR $event IN $events { CREATE runtime_event CONTENT $event RETURN NONE; };", {
      events: rawEvents,
    });
    await database.query("CREATE runtime_event CONTENT $event RETURN NONE;", {
      event: {
        event_id: "projector-page-durable",
        organization_id: context.organizationId,
        execution_id: "projector-page-execution",
        command_id: "projector-page-durable-command",
        sequence: 102,
        event_type: "model.route.selected",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
        created_at: new Date("2000-01-01T00:00:01.000Z"),
      },
    });
    await database.query("CREATE runtime_event CONTENT $event RETURN NONE;", {
      event: {
        event_id: "projector-page-durable-next",
        organization_id: context.organizationId,
        execution_id: "projector-page-execution",
        command_id: "projector-page-durable-next-command",
        sequence: 103,
        event_type: "execution_succeeded",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
        created_at: new Date("2000-01-01T00:00:02.000Z"),
      },
    });
    await database.query(
      "UPDATE application_outbox SET occurred_at = d'2000-01-01T00:00:00Z' WHERE organization_id = $organization_id AND source_kind = 'runtime-event' AND source_id IN $source_ids;",
      { organization_id: context.organizationId, source_ids: rawEvents.map((event) => event.event_id) },
    );
    const [ordered] = await database.query<[{ readonly source_id: string }[]]>(
      "SELECT source_id, occurred_at, outbox_id FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC;",
      { organization_id: context.organizationId },
    );
    expect(ordered.slice(0, 100).map((outbox) => outbox.source_id)).toEqual(
      rawEvents.slice(0, 100).map((event) => event.event_id),
    );
    const [page] = await database.query<[{ readonly source_id: string }[]]>(
      "SELECT source_id, occurred_at, outbox_id FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC LIMIT $limit;",
      { organization_id: context.organizationId, limit: 100 },
    );
    expect(page.map((outbox) => outbox.source_id)).toEqual(rawEvents.slice(0, 100).map((event) => event.event_id));
    const [types] = await database.query<[{ readonly event_id: string; readonly event_type: string }[]]>(
      "SELECT event_id, event_type FROM runtime_event WITH INDEX runtime_event_id WHERE event_id IN $event_ids;",
      { event_ids: rawEvents.slice(0, 100).map((event) => event.event_id) },
    );
    expect(types).toHaveLength(100);
    expect(types.every((event) => event.event_type === "model_text_delta")).toBe(true);

    const transaction = vi.spyOn(database, "transaction");
    await expect(projector.projectPendingSlice(context, 1_000)).resolves.toEqual({ projected: 0, more: true });
    await expect(projector.projectPendingSlice(context, 1_000)).resolves.toEqual({ projected: 2, more: false });
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction.mockRestore();
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual([
      expect.objectContaining({
        type: "runtime.model-route-selected",
        resource: { type: "Execution", id: "projector-page-execution", revision: 102 },
      }),
      expect.objectContaining({
        type: "runtime.execution-succeeded",
        resource: { type: "Execution", id: "projector-page-execution", revision: 103 },
      }),
    ]);
    expect(await pendingRawOutboxCount()).toBe(101);
  });

  it("event create 뒤 오류는 outbox와 sequence까지 rollback하고 다음 실행이 같은 source를 복구한다", async () => {
    await graph.bootstrap(context);
    const crashing = await ApplicationEventProjector.create(database, organizations, {
      afterEventCreated: () => {
        throw new Error("projection crash injection");
      },
    });
    await expect(crashing.projectPending(context, 1)).rejects.toThrow("projection crash injection");
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual([]);

    expect(await projector.projectPending(context, 10)).toBe(1);
    expect((await events.read(context, { after: 0, limit: 10 })).events[0]).toMatchObject({
      sequence: 1,
      type: "organization.version-created",
    });
  });

  it("두 projector가 동시에 실행돼도 source 중복과 sequence gap을 만들지 않는다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    await Promise.all(
      [1, 2, 3].map(
        async (index) =>
          await works.createWork(context, {
            commandId: `projector-concurrent-work-000${String(index)}`,
            text: `동시 Work ${String(index)}`,
            surface: "test",
            organizationVersionId: bootstrapped.version.version_id,
          }),
      ),
    );
    const other = await ApplicationEventProjector.create(database, organizations);
    await Promise.all([projector.projectPending(context, 10), other.projectPending(context, 10)]);
    const projected = (await events.read(context, { after: 0, limit: 10 })).events;
    expect(projected.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(projected.map((event) => event.eventId))).toHaveProperty("size", 4);
  });

  it("pending outbox가 없으면 transaction을 열지 않는다", async () => {
    let transactionCalls = 0;
    const database = {
      async query<R = unknown[]>(): Promise<R> {
        return [[]] as R;
      },
      async transaction(): Promise<never> {
        transactionCalls += 1;
        throw new Error("빈 outbox에서 transaction을 열면 안 됩니다");
      },
    } as unknown as MassionDatabase;
    const organizations = {
      async verifyTenantContext(): Promise<void> {},
    } as unknown as OrganizationService;
    const isolated = Reflect.construct(ApplicationEventProjector, [
      database,
      organizations,
    ]) as ApplicationEventProjector;
    const isolatedContext: TenantContext = {
      userId: "projector-idle-user",
      organizationId: "projector-idle-organization",
      membershipId: "projector-idle-membership",
      role: "owner",
    };

    await expect(isolated.projectPending(isolatedContext, 10)).resolves.toBe(0);
    expect(transactionCalls).toBe(0);
  });

  it("storage가 소유한 transaction 재시도를 projector에서 중첩하지 않는다", async () => {
    const failure = new Error("projection transaction failure");
    let transactionCalls = 0;
    const database = {
      async query<R = unknown[]>(): Promise<R> {
        return [[{ outbox_id: "projector-retry-outbox" }]] as R;
      },
      async transaction(): Promise<never> {
        transactionCalls += 1;
        throw failure;
      },
    } as unknown as MassionDatabase;
    const organizations = {
      async verifyTenantContext(): Promise<void> {},
    } as unknown as OrganizationService;
    const isolated = Reflect.construct(ApplicationEventProjector, [
      database,
      organizations,
    ]) as ApplicationEventProjector;
    const isolatedContext: TenantContext = {
      userId: "projector-retry-user",
      organizationId: "projector-retry-organization",
      membershipId: "projector-retry-membership",
      role: "owner",
    };

    await expect(isolated.projectPending(isolatedContext, 10)).rejects.toBe(failure);
    expect(transactionCalls).toBe(1);
  });

  it("같은 조직의 투영은 첫 transaction이 끝나기 전 두 번째 transaction에 진입하지 않는다", async () => {
    let transactionCalls = 0;
    let firstTransactionEntered!: () => void;
    let releaseFirstTransaction!: () => void;
    const firstTransaction = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      firstTransactionEntered = resolve;
    });
    const executor: QueryExecutor = {
      async query<R = unknown[]>(): Promise<R> {
        return [[]] as R;
      },
    };
    const database = {
      async query<R = unknown[]>(): Promise<R> {
        return [[{ outbox_id: "projector-serialization-outbox" }]] as R;
      },
      async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          firstTransactionEntered();
          await firstTransaction;
        }
        return await operation(executor);
      },
    } as unknown as MassionDatabase;
    const organizations = {
      async verifyTenantContext(): Promise<void> {},
    } as unknown as OrganizationService;
    const isolated = Reflect.construct(ApplicationEventProjector, [
      database,
      organizations,
    ]) as ApplicationEventProjector;
    const isolatedContext: TenantContext = {
      userId: "projector-serialization-user",
      organizationId: "projector-serialization-organization",
      membershipId: "projector-serialization-membership",
      role: "owner",
    };

    const first = isolated.projectPending(isolatedContext, 1);
    await entered;
    const second = isolated.projectPending(isolatedContext, 1);
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(transactionCalls).toBe(1);
    } finally {
      releaseFirstTransaction();
      await Promise.all([first, second]);
    }
  });

  it("Core run 상태를 correlation이 보존된 공개 event로 투영한다", async () => {
    const runs = await ApplicationRunStore.create(database, organizations);
    const run = await runs.start(context, {
      commandId: "projector-run-command-0001",
      correlationId: "projector-run-correlation-0001",
      request: {},
    });
    await projector.projectPending(context, 10);
    const projected = (await events.read(context, { after: 0, limit: 10 })).events;
    expect(projected.at(-1)).toMatchObject({
      type: "run.started",
      correlationId: "projector-run-correlation-0001",
      resource: { type: "ApplicationRun", id: run.runId, revision: 0 },
      payload: { stage: "intake" },
    });
  });

  it("140자 delivery 재시도 correlation을 projection과 store read에서 보존한다", async () => {
    const correlationId =
      "14000000-0000-4000-8000-000000000001:delivery:retry:14000000-0000-4000-8000-000000000002:task:14000000-0000-4000-8000-000000000003:completed";
    const runs = await ApplicationRunStore.create(database, organizations);
    await runs.start(context, {
      commandId: "projector-long-correlation-0001",
      correlationId,
      request: {},
    });

    expect(await projector.projectPending(context, 1)).toBe(1);
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual([
      expect.objectContaining({ correlationId }),
    ]);
  });

  it.each([
    ["257자", "a".repeat(257)],
    ["불법 문자", `${"a".repeat(127)}/`],
    ["선두 구두점", ":abcdefg"],
  ])("%s event correlation의 projection을 DB가 거절한다", async (_boundary, correlationId) => {
    const runs = await ApplicationRunStore.create(database, organizations);
    await runs.start(context, {
      commandId: `projector-invalid-correlation-${crypto.randomUUID()}`,
      correlationId,
      request: {},
    });

    await expect(projector.projectPending(context, 1)).rejects.toThrow();
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual([]);
  });

  it("Core run event는 투영 시점과 replay에 무관하게 발생 당시 Work 계보를 보존한다", async () => {
    const runs = await ApplicationRunStore.create(database, organizations);
    const run = await runs.start(context, {
      commandId: "projector-run-command-0002",
      correlationId: "projector-run-correlation-0002",
      request: {},
    });
    const firstClaim = await runs.claim(context, run.runId);
    if (firstClaim.outcome !== "claimed") throw new Error("첫 Core run claim이 필요합니다");
    await runs.advance(context, run.runId, firstClaim.leaseGeneration, {
      stage: "context-strategy",
      workId: "work-projection-first",
    });
    const secondClaim = await runs.claim(context, run.runId);
    if (secondClaim.outcome !== "claimed") throw new Error("두 번째 Core run claim이 필요합니다");
    await runs.advance(context, run.runId, secondClaim.leaseGeneration, {
      stage: "delivery",
      workId: "work-projection-second",
    });

    await projector.projectPending(context, 10);

    const firstProjection = (await events.read(context, { after: 0, limit: 10 })).events;
    const projected = (type: string, stage: string) =>
      firstProjection.find(
        (event) => event.type === type && (event.payload as { readonly stage?: string }).stage === stage,
      );
    expect(projected("run.started", "intake")?.payload).toEqual({ stage: "intake" });
    expect(projected("run.claimed", "intake")?.payload).toEqual({ stage: "intake" });
    expect(projected("run.advanced", "context-strategy")?.payload).toEqual({
      stage: "context-strategy",
      workId: "work-projection-first",
    });
    expect(projected("run.claimed", "context-strategy")?.payload).toEqual({
      stage: "context-strategy",
      workId: "work-projection-first",
    });
    expect(projected("run.advanced", "delivery")?.payload).toEqual({
      stage: "delivery",
      workId: "work-projection-second",
    });
    expect(await projector.projectPending(context, 10)).toBe(0);
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual(firstProjection);
  });
});
