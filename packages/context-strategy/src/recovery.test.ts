import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  STRATEGY_GENERATION_RECOVERY_MIGRATION,
  StrategyGenerator,
  StrategyRecovery,
  type ContextVersion,
  type StrategyPlan,
} from "./index.js";

const PLAN: StrategyPlan = {
  objective: "복구 가능한 계획",
  summary: "투영 상태를 조정한다",
  scopeIn: ["recovery"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-recovered",
      statement: "계획이 한 번만 투영된다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "recover",
      title: "복구",
      objective: "생성 상태를 조정한다",
      criterionKeys: ["criterion-recovered"],
      dependencyKeys: [],
      requiredCapabilities: ["delivery-coordination"],
      recommendedAgentHandles: ["delivery-coordination"],
      parallelizable: false,
      reasoningDifficulty: "medium",
      taskAxis: "summary-records",
    },
  ],
  evidenceRequests: [],
};

describe("Strategy generation crash recovery", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let works: WorkService;
  let contexts: ContextStore;
  let generator: StrategyGenerator;
  let workId: string;
  let version: ContextVersion;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    works = await WorkService.create(database, organizations);
    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "복구할 계획",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    contexts = await ContextStore.create(database, organizations, works);
    const content = "복구할 계획";
    version = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "복구",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-recovery",
          revision: "1",
          contentHash: hashContextContent(content),
          observedAt: "2026-07-10T00:00:00.000Z",
          classification: "internal",
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
    generator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: crypto.randomUUID(),
          status: "succeeded",
          output: PLAN,
        }),
      },
      contexts,
      works,
    );
  });

  afterEach(async () => database.close());

  it("0114 Strategy generation recovery migration checksum을 고정한다", () => {
    expect(STRATEGY_GENERATION_RECOVERY_MIGRATION.id).toBe("0114-strategy-generation-recovery");
    expect(STRATEGY_GENERATION_RECOVERY_MIGRATION.checksum).toBe(
      "eb14071915ecf7d72ead06b68664534dc80e7d39c9169abea92d801badae4fec",
    );
  });

  async function generated(commandId = crypto.randomUUID()) {
    return await generator.generate(context, {
      commandId: `${commandId}:generate`,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });
  }

  async function pending(commandId = crypto.randomUUID()) {
    const strategyGenerationId = crypto.randomUUID();
    const generationCommandId = `${commandId}:generate`;
    await database.query(
      `CREATE strategy_generation CONTENT { strategy_generation_id: $strategy_generation_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: $command_id, request_hash: $request_hash, expected_work_revision: 1, status: 'pending', created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() };
CREATE strategy_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, command_id: $started_command_id, event_type: 'strategy_generation_started', payload_json: '{}', created_at: time::now() };`,
      {
        strategy_generation_id: strategyGenerationId,
        organization_id: context.organizationId,
        work_id: workId,
        context_version_id: version.contextVersionId,
        command_id: generationCommandId,
        request_hash: "0".repeat(64),
        created_by_user_id: context.userId,
        event_id: crypto.randomUUID(),
        started_command_id: `${generationCommandId}:started`,
      },
    );
    return { commandId, generationCommandId, strategyGenerationId };
  }

  it("projection commit 뒤 applied 기록 전 crash를 active plan 근거로 조정한다", async () => {
    const rootCommandId = crypto.randomUUID();
    const generation = await generated(rootCommandId);
    if (!generation.checksum || !generation.plan) throw new Error("테스트 Strategy generation이 불완전합니다");
    const strategyChecksum = generation.checksum;
    const strategyPlan = generation.plan;
    let projectedPlanId: string | undefined;
    await expect(
      (async () => {
        const projection = await works.applyStrategyProjection(context, {
          commandId: `${rootCommandId}:project`,
          workId,
          expectedRevision: 1,
          contextVersionId: version.contextVersionId,
          strategyGenerationId: generation.strategyGenerationId,
          strategyChecksum,
          plan: strategyPlan,
        });
        projectedPlanId = projection.plan.plan_version_id;
        throw new Error("injected-after-projection-commit");
      })(),
    ).rejects.toThrow("injected-after-projection-commit");
    const recovery = StrategyRecovery.create(generator, works);

    const recovered = await recovery.recover(context);

    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: generation.strategyGenerationId, status: "applied" }),
    ]);
    expect((await works.getWork(context, workId)).active_plan_version_id).toBe(projectedPlanId);
    expect(
      (await works.listEvents(context, workId)).filter((event) => event.event_type === "strategy_projection_applied"),
    ).toHaveLength(1);
  });

  it("projection 전 crash는 같은 revision에서 한 번 투영하고 revision 변경 시 conflicted로 종료한다", async () => {
    const retryGeneration = await generated();
    const recovery = StrategyRecovery.create(generator, works);
    expect((await recovery.recover(context))[0]?.status).toBe("applied");
    expect((await works.listTasks(context, workId)).map((task) => task.task_key)).toEqual(["recover"]);

    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "충돌할 계획",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    const content = "충돌할 계획";
    version = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "충돌",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-conflict",
          revision: "1",
          contentHash: hashContextContent(content),
          observedAt: "2026-07-10T00:00:00.000Z",
          classification: "internal",
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
    const conflictGeneration = await generated();
    await works.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: 1,
      content: { objective: "경쟁 변경" },
    });

    const results = await recovery.recover(context);
    expect(
      results.find((candidate) => candidate.strategyGenerationId === conflictGeneration.strategyGenerationId),
    ).toMatchObject({ status: "conflicted" });
    expect(await generator.get(context, retryGeneration.strategyGenerationId)).toMatchObject({ status: "applied" });
  });

  it("runner 시작 전의 pending row를 새 instance가 claim해 terminal과 projection으로 복구한다", async () => {
    const candidate = await pending();
    const identity = await IdentityService.create(database);
    const other = await identity.registerPersonalUser({ email: "recovery-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-pending-recovery",
      status: "succeeded",
      output: PLAN,
    });
    const restarted = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);

    const recovery = StrategyRecovery.create(restarted, works);
    expect(await recovery.recover(otherContext)).toEqual([]);
    await expect(restarted.get(otherContext, candidate.strategyGenerationId)).rejects.toThrow(
      "Strategy generation을 찾을 수 없습니다",
    );
    const recovered = await recovery.recover(context);

    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: candidate.strategyGenerationId, status: "applied" }),
    ]);
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("두 recovery가 동시에 같은 pending generation을 복구해도 runner는 한 번만 실행한다", async () => {
    const candidate = await pending();
    let releaseRunner!: () => void;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const executeStructured = vi.fn(async () => {
      await runnerReleased;
      return { executionId: "execution-concurrent-recovery", status: "succeeded" as const, output: PLAN };
    });
    const first = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);
    const second = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);

    const recoveries = Promise.all([
      StrategyRecovery.create(first, works).recover(context),
      StrategyRecovery.create(second, works).recover(context),
    ]);
    await vi.waitFor(() => expect(executeStructured).toHaveBeenCalledTimes(1));
    releaseRunner();
    await recoveries;

    expect(await first.get(context, candidate.strategyGenerationId)).toMatchObject({ status: "applied" });
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("runner 성공 결과를 저장한 뒤 terminal write가 실패해도 Provider를 재호출하지 않는다", async () => {
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-terminal-write-fault",
      status: "succeeded",
      output: PLAN,
    });
    const originalTransaction = database.transaction.bind(database);
    let injectFault = true;
    const faultDatabase = {
      query: database.query.bind(database),
      transaction: async <T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> =>
        await originalTransaction(
          async (transaction) =>
            await operation({
              query: async <R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> => {
                if (injectFault && surql.includes("UPDATE strategy_generation SET status = $status")) {
                  injectFault = false;
                  throw new Error("injected-strategy-terminal-write-fault");
                }
                return await transaction.query<R>(surql, bindings);
              },
            }),
        ),
    } as MassionDatabase;
    const faulting = await StrategyGenerator.create(
      faultDatabase,
      organizations,
      { executeStructured },
      contexts,
      works,
    );

    await expect(
      faulting.generate(context, {
        commandId: "strategy-terminal-write-fault:generate",
        workId,
        expectedWorkRevision: 1,
        contextVersionId: version.contextVersionId,
      }),
    ).rejects.toThrow("injected-strategy-terminal-write-fault");

    const restarted = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);
    await StrategyRecovery.create(restarted, works).recover(context);

    const [rows] = await database.query<[{ readonly status: string }[]]>(
      "SELECT status FROM strategy_generation WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: "strategy-terminal-write-fault:generate" },
    );
    expect(rows[0]?.status).toBe("applied");
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("유효한 claim lease의 pending은 재실행하지 않는다", async () => {
    const candidate = await pending();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_id = 'active-owner', execution_claim_expires_at = type::datetime('2099-01-01T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );
    const executeStructured = vi.fn<StructuredAgentRunner["executeStructured"]>();
    const restarted = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);

    expect(await StrategyRecovery.create(restarted, works).recover(context)).toEqual([]);
    expect(await restarted.get(context, candidate.strategyGenerationId)).toMatchObject({ status: "pending" });
    expect(executeStructured).not.toHaveBeenCalled();
  });

  it("시작 복구는 이전 owner의 유효한 lease가 만료될 때까지 Provider를 빼앗지 않고 이어서 수렴한다", async () => {
    const candidate = await pending();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_id = 'previous-owner', execution_claim_expires_at = type::datetime('2099-01-01T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-after-lease-expiry",
      status: "succeeded",
      output: PLAN,
    });
    const restarted = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);
    const recoverPending = restarted.recoverPending.bind(restarted) as (
      recoveryContext: TenantContext,
      strategyGenerationId: string,
      waitForLease: boolean,
    ) => Promise<unknown>;

    const recovery = recoverPending(context, candidate.strategyGenerationId, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executeStructured).not.toHaveBeenCalled();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );

    await expect(recovery).resolves.toMatchObject({ status: "generated" });
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("Strategy checkpoint 전 crash는 deterministic Runtime terminal 결과로 복원하고 Provider를 재호출하지 않는다", async () => {
    const candidate = await pending();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_id = 'crashed-owner', execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z'), execution_started_at = type::datetime('2026-07-10T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );
    const executeStructured = vi.fn<StructuredAgentRunner["executeStructured"]>();
    const findResultByCommand = vi.fn().mockResolvedValue({
      executionId: "execution-before-strategy-checkpoint",
      status: "succeeded",
      output: PLAN,
    });
    const restarted = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured, findResultByCommand },
      contexts,
      works,
    );

    const recovered = await StrategyRecovery.create(restarted, works).recover(context);

    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: candidate.strategyGenerationId, status: "applied" }),
    ]);
    expect(findResultByCommand).toHaveBeenCalledWith(context, `${candidate.generationCommandId}:runtime`);
    expect(executeStructured).not.toHaveBeenCalled();
  });

  it("Strategy checkpoint 전 crash 복구도 부분 충족 Agent 추천을 거부한다", async () => {
    const candidate = await pending();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_id = 'crashed-owner', execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z'), execution_started_at = type::datetime('2026-07-10T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );
    const [recoveryTask] = PLAN.tasks;
    if (!recoveryTask) throw new Error("복구 Strategy Task가 없습니다");
    const partialPlan: StrategyPlan = {
      ...PLAN,
      tasks: [
        {
          ...recoveryTask,
          requiredCapabilities: ["delivery-coordination", "security-review"],
        },
      ],
    };
    const executeStructured = vi.fn<StructuredAgentRunner["executeStructured"]>();
    const restarted = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured,
        findResultByCommand: vi.fn().mockResolvedValue({
          executionId: "execution-partial-agent-before-checkpoint",
          status: "succeeded",
          output: partialPlan,
        }),
      },
      contexts,
      works,
    );

    await expect(StrategyRecovery.create(restarted, works).recover(context)).resolves.toEqual([
      expect.objectContaining({ strategyGenerationId: candidate.strategyGenerationId, status: "failed" }),
    ]);
    expect(await restarted.get(context, candidate.strategyGenerationId)).toMatchObject({
      status: "failed",
      error: { category: "structured_output" },
    });
    expect(executeStructured).not.toHaveBeenCalled();
  });

  it("실행 시작 후 결과 증거가 없는 expired pending은 Provider 재호출 없이 failed로 닫는다", async () => {
    const candidate = await pending();
    await database.query(
      "UPDATE strategy_generation SET execution_claim_id = 'expired-owner', execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z'), execution_started_at = type::datetime('2026-07-10T00:00:00.000Z') WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: candidate.strategyGenerationId },
    );
    const executeStructured = vi.fn<StructuredAgentRunner["executeStructured"]>();
    const restarted = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);

    const recovered = await StrategyRecovery.create(restarted, works).recover(context);

    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: candidate.strategyGenerationId, status: "failed" }),
    ]);
    expect(executeStructured).not.toHaveBeenCalled();
  });
});
