import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
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
    projector = await ApplicationEventProjector.create(database, organizations);
    events = await ApplicationEventStore.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  it("public allowlist mapper로 조직별 연속 sequence를 만들고 replay는 중복하지 않는다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    await works.createWork(context, {
      commandId: "projector-create-work-0001",
      text: "공개 event projection",
      surface: "test",
      organizationVersionId: bootstrapped.version.version_id,
    });

    const databaseQuery = vi.spyOn(database, "query");
    expect(await projector.projectPending(context, 10)).toBe(2);
    expect(databaseQuery.mock.calls.filter(([query]) => query.includes("FROM application_outbox")).length).toBe(1);
    databaseQuery.mockRestore();
    expect(await projector.projectPending(context, 10)).toBe(0);
    const projected = await events.read(context, { after: 0, limit: 10 });
    expect(projected.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "organization.version-created"],
      [2, "work.created"],
    ]);
    expect(JSON.stringify(projected)).not.toContain("request_json");
    expect(JSON.stringify(projected)).not.toContain("공개 event projection");
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
