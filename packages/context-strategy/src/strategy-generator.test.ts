import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import type { StructuredAgentRunner } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  type ContextClassification,
  type ContextVersion,
  type StrategyPlan,
} from "./index.js";

const VALID_STRATEGY_PLAN: StrategyPlan = {
  objective: "Massion 완제품을 구현한다",
  summary: "설계와 검증을 수행한다",
  scopeIn: ["strategy"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "산출물이 생성된다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "verify",
      title: "검증",
      objective: "산출물을 생성한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: [],
      requiredCapabilities: ["assurance"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

function planWithAgent(agentHandle: string): StrategyPlan {
  const [baseTask] = VALID_STRATEGY_PLAN.tasks;
  if (!baseTask) throw new Error("기본 Strategy Task가 없습니다");
  return {
    ...VALID_STRATEGY_PLAN,
    tasks: [{ ...baseTask, recommendedAgentHandles: [agentHandle] }],
  };
}

describe("Strategy Generator", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let work: WorkService;
  let workId: string;
  let contextStore: ContextStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "strategy@example.com", displayName: "Strategy" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    work = await WorkService.create(database, organizations);
    workId = (
      await work.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "계획을 만들어주세요",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    contextStore = await ContextStore.create(database, organizations, work);
  });

  async function contextVersion(classification: ContextClassification = "internal"): Promise<ContextVersion> {
    const content = "계획을 만들어주세요";
    return await contextStore.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "계획 생성",
      scopeIn: ["strategy"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-1",
          revision: "1",
          contentHash: hashContextContent(content),
          observedAt: "2026-07-10T00:00:00.000Z",
          classification,
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
  }

  it("ContextVersion을 structured Runtime으로 생성하고 plan checksum을 저장한다", async () => {
    const version = await contextVersion();
    const runner: StructuredAgentRunner = {
      executeStructured: vi.fn().mockResolvedValue({
        executionId: "execution-1",
        status: "succeeded",
        output: VALID_STRATEGY_PLAN,
      }),
    };
    const generator = await StrategyGenerator.create(database, organizations, runner, contextStore, work);

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated).toMatchObject({ status: "generated", runtimeExecutionId: "execution-1" });
    expect(generated.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(generated.plan).toEqual(VALID_STRATEGY_PLAN);
    expect(runner.executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        agentHandle: "context-strategy",
        modelRoute: "planning-quality",
        estimatedTokens: 1_000,
        input: expect.objectContaining({
          planningContract: expect.stringMatching(
            /자연어 목표.+코드·설정·문서.+Evidence & Research.+evidence-research.+비완전 목록.+허용 목록.+Evidence & Research 책임만으로 해결할 수 없는.+도메인.+방법론.+현재 Agent에 없어도.+모든 필수 역량.+빈 배열.+동적 배치.+critical.+requiresApproval/su,
          ),
        }),
      }),
      expect.objectContaining({ name: "massion-strategy-plan", validate: expect.any(Function) }),
    );
  });

  it("metadata-only evidence source를 materialize해 Strategy runner의 별도 field에 전달한다", async () => {
    const checksum = "a".repeat(64);
    const source = {
      kind: "evidence" as const,
      sourceId: "strategy-brief-1",
      revision: "strategy-index-1",
      contentHash: checksum,
      observedAt: "2026-07-25T00:00:00.000Z",
      classification: "internal" as const,
      priority: 80,
      estimatedTokens: 0,
      mandatory: true,
      evidenceRef: {
        evidenceBriefId: "strategy-brief-1",
        repositoryId: "strategy-repository-1",
        repositoryRevisionId: "strategy-revision-1",
        indexVersionId: "strategy-index-1",
        briefChecksum: checksum,
        freshnessStatus: "fresh" as const,
      },
    };
    const version = await contextStore.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 10_000,
      objective: "근거로 계획 생성",
      scopeIn: [],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [source],
    });
    const materialized = {
      evidenceBriefId: source.sourceId,
      indexVersionId: source.revision,
      briefChecksum: checksum,
      snippets: [{ citation: "src/strategy.ts:1-1", content: "export const strategy = true;" }],
      estimatedTokens: 8,
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-evidence",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const materialize = vi.fn().mockResolvedValue(materialized);
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
      undefined,
      { materialize },
    );

    await expect(
      generator.generate(context, {
        commandId: crypto.randomUUID(),
        workId,
        expectedWorkRevision: 1,
        contextVersionId: version.contextVersionId,
      }),
    ).resolves.toMatchObject({ status: "generated" });
    expect(materialize).toHaveBeenCalledWith(context, {
      workId,
      evidenceBriefId: source.sourceId,
      maxEstimatedTokens: 6_000,
    });
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        estimatedTokens: 4_008,
        input: expect.objectContaining({ sources: [source], evidenceMaterials: [materialized] }),
      }),
      expect.any(Object),
    );
    expect(version.selectedSources[0]).not.toHaveProperty("content");
  });

  it("materialized token이 Context의 남은 실행 예산을 넘으면 runner 호출 전에 차단한다", async () => {
    const checksum = "b".repeat(64);
    const source = (evidenceBriefId: string, indexVersionId: string) => ({
      kind: "evidence" as const,
      sourceId: evidenceBriefId,
      revision: indexVersionId,
      contentHash: checksum,
      observedAt: "2026-07-25T00:00:00.000Z",
      classification: "internal" as const,
      priority: 80,
      estimatedTokens: 0,
      mandatory: true,
      evidenceRef: {
        evidenceBriefId,
        repositoryId: `${evidenceBriefId}-repository`,
        repositoryRevisionId: `${evidenceBriefId}-revision`,
        indexVersionId,
        briefChecksum: checksum,
        freshnessStatus: "fresh" as const,
      },
    });
    const version = await contextStore.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 10_000,
      objective: "예산 초과 근거 계획",
      scopeIn: [],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [source("strategy-brief-a", "strategy-index-a")],
    });
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-over-budget",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured } as never,
      contextStore,
      work,
      undefined,
      {
        materialize: async (_context, input) => ({
          evidenceBriefId: input.evidenceBriefId,
          indexVersionId: "strategy-index-a",
          briefChecksum: checksum,
          snippets: [],
          estimatedTokens: 6_001,
          truncated: false,
        }),
      },
    );

    await expect(
      generator.generate(context, {
        commandId: crypto.randomUUID(),
        workId,
        expectedWorkRevision: 1,
        contextVersionId: version.contextVersionId,
      }),
    ).rejects.toThrow("예산");
    expect(executeStructured).not.toHaveBeenCalled();
  });

  it("local-private Context는 local-private Route만 사용한다", async () => {
    const version = await contextVersion("local-private");
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-local",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelRoute: "local-private" }),
      expect.any(Object),
    );
  });

  it("자동 Core Office 계획은 자동 검증 가능한 산출물 증거만 허용한다", async () => {
    const version = await contextVersion();
    const nonAutomaticPlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      acceptanceCriteria: [
        {
          key: "criterion-tests",
          statement: "기록을 검사한다",
          method: "inspection",
          evidenceKinds: ["text-record"],
          planLevel: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-non-automatic",
      status: "succeeded",
      output: nonAutomaticPlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated.status).toBe("failed");
    const output = executeStructured.mock.calls[0]?.[2];
    expect(output?.validate?.(nonAutomaticPlan)).toMatchObject({ success: false });
  });

  it("자동 Core Office 계획은 실제 Core Office 담당자만 Task에 추천한다", async () => {
    const version = await contextVersion();
    const unknownAgentPlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      tasks: [
        {
          key: "verify",
          title: "검증",
          objective: "산출물을 생성한다",
          criterionKeys: ["criterion-tests"],
          dependencyKeys: [],
          requiredCapabilities: ["testing"],
          recommendedAgentHandles: ["zai-agent"],
          parallelizable: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-unknown-agent",
      status: "succeeded",
      output: unknownAgentPlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated.status).toBe("failed");
    const output = executeStructured.mock.calls[0]?.[2];
    expect(output?.validate?.(unknownAgentPlan)).toMatchObject({ success: false });
  });

  it("활성 Software Engineering 전문 담당자를 자동 계획에 추천할 수 있다", async () => {
    const version = await contextVersion();
    const softwarePlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      tasks: [
        {
          key: "implement-backend-change",
          title: "Backend 변경 구현",
          objective: "테스트 우선으로 작은 Backend 변경을 구현한다",
          criterionKeys: ["criterion-tests"],
          dependencyKeys: [],
          requiredCapabilities: ["backend-engineering"],
          recommendedAgentHandles: ["software-engineering.backend-specialist"],
          parallelizable: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-software-specialist",
      status: "succeeded",
      output: softwarePlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
      {
        listNodes: async () => [
          {
            handle: "software-engineering.backend-specialist",
            status: "active",
            capabilities: ["backend-engineering"],
            scope: "persistent",
          },
        ],
      } as never,
    );

    await expect(
      generator.generate(context, {
        commandId: crypto.randomUUID(),
        workId,
        expectedWorkRevision: 1,
        contextVersionId: version.contextVersionId,
      }),
    ).resolves.toMatchObject({ status: "generated", plan: softwarePlan });
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        input: expect.objectContaining({
          availableAgents: [
            expect.objectContaining({
              handle: "software-engineering.backend-specialist",
              capabilities: ["backend-engineering"],
            }),
          ],
        }),
      }),
      expect.any(Object),
    );
    const structuredOutput = executeStructured.mock.calls[0]?.[2];
    expect(
      structuredOutput?.validate?.({
        ...softwarePlan,
        tasks: [
          {
            ...softwarePlan.tasks[0],
            requiredCapabilities: ["backend-engineering", "security-review"],
          },
        ],
      }),
    ).toMatchObject({ success: false });
  });

  it("현재 Work에서 사용할 수 없는 work-scoped Agent를 모델 입력과 structured output에서 거부한다", async () => {
    const version = await contextVersion();
    const [baseTask] = VALID_STRATEGY_PLAN.tasks;
    if (!baseTask) throw new Error("기본 Strategy Task가 없습니다");
    const otherWorkPlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      tasks: [
        {
          ...baseTask,
          recommendedAgentHandles: ["staffing-other-work"],
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-other-work-agent",
      status: "succeeded",
      output: otherWorkPlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
      {
        listNodes: async () => [
          {
            handle: "staffing-persistent",
            status: "active",
            capabilities: ["assurance"],
            scope: "persistent",
          },
          {
            handle: "staffing-current-work",
            status: "active",
            capabilities: ["assurance"],
            scope: "work",
            work_id: workId,
          },
          {
            handle: "staffing-other-work",
            status: "active",
            capabilities: ["assurance"],
            scope: "work",
            work_id: "different-work",
          },
        ],
      },
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated.status).toBe("failed");
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        input: expect.objectContaining({
          availableAgents: [
            expect.objectContaining({ handle: "staffing-current-work" }),
            expect.objectContaining({ handle: "staffing-persistent" }),
          ],
        }),
      }),
      expect.any(Object),
    );
    const output = executeStructured.mock.calls[0]?.[2];
    expect(output?.validate?.(otherWorkPlan)).toMatchObject({ success: false });
  });

  it("runner 실행 중 추천 Agent가 inactive가 되면 checkpoint에서 failed로 수렴하고 plan을 저장하지 않는다", async () => {
    const version = await contextVersion();
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "checkpoint-deactivation",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "checkpoint-deactivation-agent",
          name: "Checkpoint Deactivation",
          responsibility: "Checkpoint 경쟁 검증",
          outputs: ["Review"],
          capabilities: ["assurance"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId,
          role: "operator",
        },
      ],
    });
    const outputPlan = planWithAgent("checkpoint-deactivation-agent");
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: async () => {
          await graph.execute(context, {
            commandId: crypto.randomUUID(),
            expectedVersion: 2,
            kind: "deactivate",
            handle: "checkpoint-deactivation-agent",
          });
          return { executionId: "execution-checkpoint-deactivation", status: "succeeded", output: outputPlan };
        },
      },
      contextStore,
      work,
      graph,
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated).toMatchObject({
      status: "failed",
      runtimeExecutionId: "execution-checkpoint-deactivation",
      error: { category: "structured_output" },
    });
    expect(generated.plan).toBeUndefined();
    expect(generated.checksum).toBeUndefined();
  });

  it("runner 실행 중 추천 Agent가 다른 Work 범위로 바뀌면 checkpoint snapshot으로 거부한다", async () => {
    const version = await contextVersion();
    const listNodes = vi.fn(async () => {
      const checkpointRead = listNodes.mock.calls.length > 1;
      return [
        {
          handle: "checkpoint-work-scope-agent",
          status: "active",
          capabilities: ["assurance"],
          scope: "work" as const,
          work_id: checkpointRead ? "different-work" : workId,
        },
      ];
    });
    const outputPlan = planWithAgent("checkpoint-work-scope-agent");
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: async () => ({
          executionId: "execution-checkpoint-work-scope",
          status: "succeeded",
          output: outputPlan,
        }),
      },
      contextStore,
      work,
      { listNodes },
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(listNodes).toHaveBeenCalledTimes(2);
    expect(generated).toMatchObject({ status: "failed", error: { category: "structured_output" } });
    expect(generated.plan).toBeUndefined();
    expect(generated.checksum).toBeUndefined();
  });

  it("모델 부재와 invalid output은 Work를 변경하지 않고 secret 없는 상태를 남긴다", async () => {
    const version = await contextVersion();
    const blocked = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "execution-blocked",
          status: "blocked_model_unavailable",
        }),
      },
      contextStore,
      work,
    );
    const blockedResult = await blocked.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });
    expect(blockedResult.status).toBe("blocked_model_unavailable");

    const invalid = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "execution-invalid",
          status: "succeeded",
          output: { apiKey: "secret-value" },
        }),
      },
      contextStore,
      work,
    );
    const invalidResult = await invalid.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(invalidResult.status).toBe("failed");
    expect(JSON.stringify(await invalid.get(context, invalidResult.strategyGenerationId))).not.toContain(
      "secret-value",
    );
    expect((await work.getWork(context, workId)).status).toBe("draft");
  });

  it("같은 command를 멱등 재생하고 Work revision 변경을 모델 호출 전에 거부한다", async () => {
    const version = await contextVersion();
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-idempotent",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    };

    const first = await generator.generate(context, input);
    const repeated = await generator.generate(context, input);

    expect(repeated).toEqual(first);
    expect(executeStructured).toHaveBeenCalledTimes(1);
    await expect(
      generator.generate(context, { ...input, commandId: crypto.randomUUID(), expectedWorkRevision: 2 }),
    ).rejects.toThrow("Work revision");
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("같은 command 동시 호출은 하나의 terminal generation으로 수렴한다", async () => {
    const version = await contextVersion();
    let releaseRunner!: () => void;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const executeStructured = vi.fn(async () => {
      await runnerReleased;
      return { executionId: "execution-concurrent", status: "succeeded" as const, output: VALID_STRATEGY_PLAN };
    });
    const firstGenerator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );
    const secondGenerator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );
    const commandId = crypto.randomUUID();
    const request = {
      commandId,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    };

    const resultsPromise = Promise.all([
      firstGenerator.generate(context, request),
      secondGenerator.generate(context, request),
    ]);
    await vi.waitFor(() => expect(executeStructured).toHaveBeenCalledTimes(1));
    releaseRunner();
    const results = await resultsPromise;
    const firstResult = results[0];
    if (!firstResult) throw new Error("첫 Strategy 생성 결과가 없습니다");
    const [events] = await database.query<[{ readonly event_type: string }[]]>(
      "SELECT event_type FROM strategy_event WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: firstResult.strategyGenerationId },
    );

    expect(firstResult).toEqual(results[1]);
    expect(firstResult.status).toBe("generated");
    expect(executeStructured).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.event_type === "strategy_generation_started")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "strategy_generated")).toHaveLength(1);
  });

  it("같은 command의 다른 payload를 runner 호출 전에 거부한다", async () => {
    const version = await contextVersion();
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-payload-collision",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );
    const commandId = crypto.randomUUID();
    const request = {
      commandId,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    };

    await generator.generate(context, request);
    await expect(generator.generate(context, { ...request, expectedWorkRevision: 2 })).rejects.toThrow(
      "같은 commandId",
    );
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("lease 만료 후 돌아온 stale owner는 Strategy checkpoint와 generated terminal을 쓸 수 없다", async () => {
    const version = await contextVersion();
    const commandId = "strategy-stale-owner";
    const executeStructured = vi.fn(async () => {
      await database.query(
        "UPDATE strategy_generation SET execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z') WHERE organization_id = $organization_id AND command_id = $command_id;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      return { executionId: "execution-stale-owner", status: "succeeded" as const, output: VALID_STRATEGY_PLAN };
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    const result = await generator.generate(context, {
      commandId,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });
    const [events] = await database.query<[{ readonly event_type: string }[]]>(
      "SELECT event_type FROM strategy_event WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: result.strategyGenerationId },
    );

    expect(result.status).toBe("failed");
    expect(events.some((event) => event.event_type === "strategy_generated")).toBe(false);
  });
});
