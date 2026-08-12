import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  ContinuationService,
  hashContextContent,
  StrategyGenerator,
  StrategyService,
  type ContextVersion,
  type ContinuationModelDecision,
  type StrategyPlan,
} from "./index.js";

const REPLAN: StrategyPlan = {
  objective: "배포 범위를 포함한다",
  summary: "추가 범위를 검증한다",
  scopeIn: ["core", "deployment"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-deploy",
      statement: "배포 검증이 통과한다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "deploy-verify",
      title: "배포 검증",
      objective: "배포 환경을 검증한다",
      criterionKeys: ["criterion-deploy"],
      dependencyKeys: [],
      requiredCapabilities: ["deployment"],
      recommendedAgentHandles: [],
      parallelizable: false,
      reasoningDifficulty: "medium",
      taskAxis: "planning-design",
    },
  ],
  evidenceRequests: [],
};

function modelDecision(decision: ContinuationModelDecision["decision"]): ContinuationModelDecision {
  return {
    decision,
    confidence: 0.91,
    reasonCodes: ["same-product-line"],
    contextDelta: {
      scopeIn: ["추가 범위"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
    },
    replanRequired: false,
  };
}

describe("후속 요청 Continuation 분류와 적용", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let works: WorkService;
  let contexts: ContextStore;
  let workId: string;
  let initialContext: ContextVersion;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await database.query("DEFINE TABLE runtime_execution SCHEMALESS;");
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "continuation@example.com",
      displayName: "Continuation",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    works = await WorkService.create(database, organizations);
    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "기본 제품을 구현한다",
        surface: "test",
        organizationVersionId: "organization-v1",
        policyVersionId: "policy-v1",
        promptVersionId: "prompt-v1",
      })
    ).work.work_id;
    contexts = await ContextStore.create(database, organizations, works);
    const content = "기본 제품을 구현한다";
    initialContext = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 2_000,
      objective: "기본 제품 구현",
      scopeIn: ["core"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-initial",
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
  });

  afterEach(async () => database.close());

  function input(commandId = crypto.randomUUID()) {
    return {
      commandId,
      workId,
      expectedWorkRevision: 1,
      text: "배포 환경도 추가해주세요",
      surface: "test",
      tokenBudget: 3_000,
    };
  }

  it("명시적 사람 override는 모델을 호출하지 않고 draft Work의 Context를 연장한다", async () => {
    const executeStructured = vi.fn();
    const service = await ContinuationService.create(database, organizations, { executeStructured }, contexts, works);
    const request = {
      ...input(),
      override: { decision: "extend_current" as const, reason: "같은 제품의 배포 범위입니다" },
    };

    const first = await service.continue(context, request);
    const repeated = await service.continue(context, request);

    expect(executeStructured).not.toHaveBeenCalled();
    expect(first.decision).toMatchObject({
      decision: "extend_current",
      source: "human_override",
      actorUserId: context.userId,
      actorReason: request.override.reason,
      status: "applied",
      appliedWorkId: workId,
    });
    expect(first.contextVersion).toMatchObject({
      version: 2,
      parentContextVersionId: initialContext.contextVersionId,
    });
    expect(first.contextVersion?.scopeIn).toContain("core");
    expect(repeated.decision.decisionId).toBe(first.decision.decisionId);
    expect(repeated.contextVersion?.contextVersionId).toBe(first.contextVersion?.contextVersionId);
  });

  it("running Work의 model extend 판단은 상태 규칙으로 linked follow-up으로 강제한다", async () => {
    const plan = await works.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: 1,
      content: { objective: "기존 계획" },
    });
    const planned = await works.transition(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    await database.query(
      "UPDATE work SET status = 'ready' WHERE organization_id = $organization_id AND work_id = $work_id; UPDATE work SET status = 'running' WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: workId },
    );
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "continuation-running",
      status: "succeeded",
      output: modelDecision("extend_current"),
    });
    const service = await ContinuationService.create(database, organizations, { executeStructured }, contexts, works);

    const result = await service.continue(context, {
      ...input(),
      expectedWorkRevision: planned.work.revision,
    });

    expect(result.decision).toMatchObject({ decision: "create_follow_up", source: "model", status: "applied" });
    expect(result.decision.reasonCodes).toContain("state_requires_snapshot");
    expect(result.work).toMatchObject({ parent_work_id: workId, status: "draft" });
    expect(result.contextVersion?.parentContextVersionId).toBe(initialContext.contextVersionId);
    expect((await works.getWork(context, workId)).status).toBe("running");
  });

  it.each(["create_follow_up", "create_independent"] as const)(
    "model의 %s 결정을 구조화 적용하고 actor와 근거를 저장한다",
    async (decision) => {
      const executeStructured = vi.fn().mockResolvedValue({
        executionId: `continuation-${decision}`,
        status: "succeeded",
        output: modelDecision(decision),
      });
      const service = await ContinuationService.create(database, organizations, { executeStructured }, contexts, works);
      const result = await service.continue(context, {
        ...input(),
        independentProjectId: "project-independent",
      });

      expect(result.decision).toMatchObject({
        decision,
        source: "model",
        actorUserId: context.userId,
        reasonCodes: ["same-product-line"],
        status: "applied",
      });
      expect(result.work?.parent_work_id).toBe(decision === "create_follow_up" ? workId : undefined);
      if (decision === "create_independent") expect(result.work?.project_id).toBe("project-independent");
      expect(executeStructured).toHaveBeenCalledOnce();
    },
  );

  it("draft 연장에 replan이 필요하면 StrategyService로 새 계획을 실제 투영한다", async () => {
    const strategyGenerator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn(async () => {
          await database.query(
            "CREATE runtime_execution CONTENT { execution_id: 'continuation-replan-strategy', organization_id: $organization_id, work_id: $work_id, agent_handle: 'context-strategy', status: 'succeeded' };",
            { organization_id: context.organizationId, work_id: workId },
          );
          return {
            executionId: "continuation-replan-strategy",
            status: "succeeded" as const,
            output: REPLAN,
          };
        }),
      },
      contexts,
      works,
    );
    const strategy = StrategyService.create(contexts, strategyGenerator, works);
    const decision = { ...modelDecision("extend_current"), replanRequired: true };
    const service = await ContinuationService.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "continuation-replan-decision",
          status: "succeeded",
          output: decision,
        }),
      },
      contexts,
      works,
      strategy,
    );

    const result = await service.continue(context, input());

    expect(result.decision).toMatchObject({ decision: "extend_current", replanRequired: true, status: "applied" });
    expect(result.work).toMatchObject({ work_id: workId, status: "planned", revision: 2 });
    expect(result.work?.active_plan_version_id).toBeTruthy();
    expect(result.contextVersion).toMatchObject({
      version: 2,
      parentContextVersionId: initialContext.contextVersionId,
    });
    expect((await works.listTasks(context, workId)).map((task) => task.task_key)).toEqual(["deploy-verify"]);
  });

  it("모델 사용 불가 시 임의 결정을 만들지 않고 Work를 유지한다", async () => {
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "continuation-blocked",
      status: "blocked_model_unavailable",
    });
    const service = await ContinuationService.create(database, organizations, { executeStructured }, contexts, works);

    await expect(service.continue(context, { ...input(), classification: "local-private" })).rejects.toThrow(
      "모델을 사용할 수 없습니다",
    );
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelRoute: "local-private" }),
      expect.any(Object),
    );
    expect(await works.getWork(context, workId)).toMatchObject({ status: "draft", revision: 1 });
  });
});
