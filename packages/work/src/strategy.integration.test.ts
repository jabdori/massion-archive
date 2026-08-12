import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type StrategyProjection } from "./work.js";

const STRATEGY: StrategyProjection = {
  objective: "제품 계획을 실행 가능한 작업으로 전환한다",
  summary: "설계한 뒤 검증한다",
  scopeIn: ["작업 계획"],
  scopeOut: ["배포"],
  assumptions: ["조직이 준비됨"],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "전체 테스트가 통과한다",
      method: "test",
      evidenceKinds: ["test-report"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "design",
      title: "설계",
      objective: "계약을 고정한다",
      criterionKeys: [],
      dependencyKeys: [],
      requiredCapabilities: ["architecture"],
      recommendedAgentHandles: ["context-strategy"],
      parallelizable: false,
      taskAxis: "planning-design",
      reasoningDifficulty: "high",
    },
    {
      key: "verify",
      title: "검증",
      objective: "계약 준수를 검증한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: ["design"],
      requiredCapabilities: ["testing"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
      taskAxis: "review-critique",
      reasoningDifficulty: "medium",
    },
  ],
  evidenceRequests: [],
};

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`테스트 fixture가 없습니다: ${label}`);
  return value;
}

describe("StrategyPlan의 Work 투영", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await WorkService.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function draftWork() {
    return (
      await service.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "전략을 실행해주세요",
        surface: "test",
        organizationVersionId: "organization-version-1",
      })
    ).work;
  }

  it("계획 버전과 안정적인 Task DAG를 만들고 Work를 planned로 한 번에 전이한다", async () => {
    const work = await draftWork();
    const result = await service.applyStrategyProjection(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      contextVersionId: "context-version-1",
      strategyGenerationId: "strategy-generation-1",
      strategyChecksum: "a".repeat(64),
      plan: STRATEGY,
    });

    expect(result.work).toMatchObject({
      status: "planned",
      revision: 2,
      context_version_id: "context-version-1",
      active_plan_version_id: result.plan.plan_version_id,
    });
    expect(result.plan).toMatchObject({
      version: 1,
      valid: true,
      context_version_id: "context-version-1",
      strategy_generation_id: "strategy-generation-1",
      strategy_checksum: "a".repeat(64),
    });
    expect(result.tasks.map((task) => [task.task_key, task.status])).toEqual([
      ["design", "ready"],
      ["verify", "blocked"],
    ]);
    expect(result.tasks[1]?.dependency_ids).toEqual([result.tasks[0]?.task_id]);
    expect(result.tasks.map((task) => [task.task_axis, task.reasoning_difficulty])).toEqual([
      ["planning-design", "high"],
      ["review-critique", "medium"],
    ]);
    expect(JSON.parse(result.plan.content_json)).toMatchObject({
      tasks: [
        { taskAxis: "planning-design", reasoningDifficulty: "high" },
        { taskAxis: "review-critique", reasoningDifficulty: "medium" },
      ],
    });
    expect(JSON.parse(result.tasks[1]?.acceptance_criteria_json ?? "[]")).toEqual([STRATEGY.acceptanceCriteria[0]]);
    expect(result.event.event_type).toBe("strategy_projection_applied");
  });

  it("신호가 없는 이전 계획도 유효한 JSON으로 투영한다", async () => {
    const work = await draftWork();
    const legacyPlan: StrategyProjection = {
      ...STRATEGY,
      tasks: STRATEGY.tasks.map((task) => ({
        ...task,
        taskAxis: undefined,
        reasoningDifficulty: undefined,
      })),
    };
    const result = await service.applyStrategyProjection(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      contextVersionId: "context-version-legacy",
      strategyGenerationId: "strategy-generation-legacy",
      strategyChecksum: "d".repeat(64),
      plan: legacyPlan,
    });

    const persisted = JSON.parse(result.plan.content_json) as { tasks: Record<string, unknown>[] };
    expect(persisted.tasks).toHaveLength(2);
    expect(
      persisted.tasks.every((task) => !Object.hasOwn(task, "taskAxis") && !Object.hasOwn(task, "reasoningDifficulty")),
    ).toBe(true);
  });

  it("잘못된 계획은 Plan, Task와 Work 상태를 일부도 남기지 않고 rollback한다", async () => {
    const work = await draftWork();
    await expect(
      service.applyStrategyProjection(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        contextVersionId: "context-version-1",
        strategyGenerationId: "strategy-generation-invalid",
        strategyChecksum: "b".repeat(64),
        plan: {
          ...STRATEGY,
          tasks: [{ ...required(STRATEGY.tasks[0], "first task"), dependencyKeys: ["missing"] }],
        },
      }),
    ).rejects.toThrow("dependency");

    expect(await service.getWork(context, work.work_id)).toMatchObject({ status: "draft", revision: 1 });
    const [plans, tasks] = await Promise.all([
      database.query<[unknown[]]>(
        "SELECT * FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: work.work_id },
      ),
      service.listTasks(context, work.work_id),
    ]);
    expect(plans[0]).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  it("같은 command는 같은 투영을 재생하고 같은 revision의 동시 투영은 하나만 반영한다", async () => {
    const firstWork = await draftWork();
    const input = {
      commandId: crypto.randomUUID(),
      workId: firstWork.work_id,
      expectedRevision: firstWork.revision,
      contextVersionId: "context-version-1",
      strategyGenerationId: "strategy-generation-idempotent",
      strategyChecksum: "c".repeat(64),
      plan: STRATEGY,
    } as const;
    const first = await service.applyStrategyProjection(context, input);
    const repeated = await service.applyStrategyProjection(context, input);
    expect(repeated.plan.plan_version_id).toBe(first.plan.plan_version_id);
    expect(repeated.tasks.map((task) => task.task_id)).toEqual(first.tasks.map((task) => task.task_id));

    const secondWork = await draftWork();
    const settled = await Promise.allSettled(
      ["d", "e"].map((character, index) =>
        service.applyStrategyProjection(context, {
          ...input,
          commandId: crypto.randomUUID(),
          workId: secondWork.work_id,
          expectedRevision: secondWork.revision,
          strategyGenerationId: `strategy-generation-${String(index)}`,
          strategyChecksum: character.repeat(64),
        }),
      ),
    );
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(await service.listTasks(context, secondWork.work_id)).toHaveLength(2);
  });

  it("재계획은 이전 계획을 무효화하고 미완료 Task를 취소하되 이력을 보존한다", async () => {
    const work = await draftWork();
    const first = await service.applyStrategyProjection(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      contextVersionId: "context-version-1",
      strategyGenerationId: "strategy-generation-1",
      strategyChecksum: "f".repeat(64),
      plan: STRATEGY,
    });
    const second = await service.applyStrategyProjection(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: first.work.revision,
      contextVersionId: "context-version-2",
      strategyGenerationId: "strategy-generation-2",
      strategyChecksum: "1".repeat(64),
      plan: { ...STRATEGY, summary: "재검토한 계획" },
    });

    const recovered = await service.recoverWork(context, work.work_id);
    expect(recovered.plans.map((plan) => [plan.version, plan.valid])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(recovered.tasks.filter((task) => task.plan_version_id === first.plan.plan_version_id)).toSatisfy(
      (tasks: typeof recovered.tasks) => tasks.every((task) => task.status === "cancelled"),
    );
    expect(second.tasks.every((task) => task.plan_version_id === second.plan.plan_version_id)).toBe(true);
    expect(second.work.active_plan_version_id).toBe(second.plan.plan_version_id);
  });

  it("다른 조직과 종료된 Work에서는 전략을 투영할 수 없다", async () => {
    const work = await draftWork();
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const outsider = await identity.registerPersonalUser({ email: "outsider@example.com", displayName: "Outsider" });
    const outsiderContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    const projection = {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      contextVersionId: "context-version-1",
      strategyGenerationId: "strategy-generation-tenant",
      strategyChecksum: "2".repeat(64),
      plan: STRATEGY,
    } as const;

    await expect(service.applyStrategyProjection(outsiderContext, projection)).rejects.toThrow(
      "Work를 찾을 수 없습니다",
    );
    const applied = await service.applyStrategyProjection(context, projection);
    const cancelled = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: applied.work.revision,
      target: "cancelled",
    });
    await expect(
      service.applyStrategyProjection(context, {
        ...projection,
        commandId: crypto.randomUUID(),
        expectedRevision: cancelled.work.revision,
        strategyGenerationId: "strategy-generation-terminal",
      }),
    ).rejects.toThrow("terminal Work");
  });
});
