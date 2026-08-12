import { z } from "zod";

const key = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);
const agentHandle = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9.-]*$/u);
const shortText = z.string().trim().min(1).max(1_000);

export const acceptanceCriterionSchema = z
  .object({
    key,
    statement: z.string().trim().min(1).max(2_000),
    method: z.enum(["test", "inspection", "evidence", "metric", "human"]),
    evidenceKinds: z.array(shortText).max(20),
    planLevel: z.boolean(),
  })
  .strict();

const automaticAcceptanceCriterionSchema = acceptanceCriterionSchema.extend({
  method: z.literal("evidence"),
  evidenceKinds: z.array(z.literal("artifact-version")).length(1),
});

export const strategyRiskSchema = z
  .object({
    key,
    description: z.string().trim().min(1).max(2_000),
    likelihood: z.enum(["low", "medium", "high", "critical"]),
    impact: z.enum(["low", "medium", "high", "critical"]),
    mitigation: z
      .string()
      .trim()
      .max(2_000)
      .describe("likelihood 또는 impact가 critical이면 비어 있지 않은 완화 방안을 작성합니다."),
    requiresApproval: z
      .boolean()
      .describe("likelihood 또는 impact가 critical이면 requiresApproval을 반드시 true로 설정합니다."),
  })
  .strict();

const nonCriticalRiskLevel = z.enum(["low", "medium", "high"]);
const criticalRiskFields = {
  mitigation: z.string().trim().min(1).max(2_000),
  requiresApproval: z.literal(true),
} as const;
const automaticStrategyRiskSchema = z.union([
  strategyRiskSchema.extend({
    likelihood: nonCriticalRiskLevel,
    impact: nonCriticalRiskLevel,
  }),
  strategyRiskSchema.extend({
    impact: z.literal("critical"),
    ...criticalRiskFields,
  }),
  strategyRiskSchema.extend({
    likelihood: z.literal("critical"),
    ...criticalRiskFields,
  }),
]);

export const strategyTaskSchema = z
  .object({
    key,
    title: z.string().trim().min(1).max(500),
    objective: z.string().trim().min(1).max(2_000),
    criterionKeys: z.array(key).max(100),
    dependencyKeys: z.array(key).max(50),
    requiredCapabilities: z
      .array(shortText)
      .max(50)
      .describe(
        "사용자 제공 요청에만 답하는 인사·접수 확인 Task에는 빈 배열을 사용하고, 코드·설정·문서·제공된 근거 조사 Task에는 evidence-research를 사용합니다. 그 밖에는 현재 Agent 보유 여부와 무관하게 불가결한 도메인·방법론 전문성을 구체적으로 나열합니다.",
      ),
    recommendedAgentHandles: z
      .array(agentHandle)
      .max(20)
      .describe(
        "인사·접수 확인 Task에는 빈 배열을 사용합니다. 그 밖에는 모든 필수 역량을 실제로 보유한 현재 Agent만 추천하며, 없으면 빈 배열을 사용합니다.",
      ),
    parallelizable: z.boolean(),
  })
  .strict();

export const evidenceRequestSchema = z
  .object({
    key,
    question: z.string().trim().min(1).max(2_000),
    required: z.boolean(),
  })
  .strict();

export const strategyPlanSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000),
    summary: z.string().trim().min(1).max(4_000),
    scopeIn: z.array(shortText).max(100),
    scopeOut: z.array(shortText).max(100),
    assumptions: z.array(shortText).max(100),
    unknowns: z.array(shortText).max(100),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(100),
    risks: z.array(strategyRiskSchema).max(100),
    tasks: z.array(strategyTaskSchema).min(1).max(50),
    evidenceRequests: z.array(evidenceRequestSchema).max(100),
  })
  .strict();

const automaticStrategyPlanSchema = strategyPlanSchema.extend({
  acceptanceCriteria: z.array(automaticAcceptanceCriterionSchema).min(1).max(100),
  risks: z.array(automaticStrategyRiskSchema).max(100),
  // 자동 실행 경로에는 별도 evidence request 소비자가 없습니다. 필요한 조사는 실행 Task로 계획합니다.
  evidenceRequests: z.array(evidenceRequestSchema).length(0),
});

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type StrategyRisk = z.infer<typeof strategyRiskSchema>;
export type StrategyTask = z.infer<typeof strategyTaskSchema>;
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;
export type StrategyPlan = z.infer<typeof strategyPlanSchema>;

function uniqueKeys(kind: string, values: readonly { readonly key: string }[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) throw new Error(`${kind} key가 중복됐습니다: ${value.key}`);
    seen.add(value.key);
  }
}

function assertAcyclic(tasks: readonly StrategyTask[]): void {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskKey: string): void => {
    if (visiting.has(taskKey)) throw new Error(`Strategy Task dependency cycle이 있습니다: ${taskKey}`);
    if (visited.has(taskKey)) return;
    visiting.add(taskKey);
    for (const dependency of byKey.get(taskKey)?.dependencyKeys ?? []) visit(dependency);
    visiting.delete(taskKey);
    visited.add(taskKey);
  };
  for (const task of tasks) visit(task.key);
}

export function validateStrategyPlan(input: unknown): StrategyPlan {
  const plan = strategyPlanSchema.parse(input);
  uniqueKeys("Acceptance criterion", plan.acceptanceCriteria);
  uniqueKeys("Risk", plan.risks);
  uniqueKeys("Task", plan.tasks);
  uniqueKeys("Evidence request", plan.evidenceRequests);
  const criteria = new Map(plan.acceptanceCriteria.map((criterion) => [criterion.key, criterion]));
  const tasks = new Set(plan.tasks.map((task) => task.key));
  const assignedCriteria = new Set<string>();
  for (const task of plan.tasks) {
    for (const criterionKey of task.criterionKeys) {
      if (!criteria.has(criterionKey)) throw new Error(`존재하지 않는 criterion입니다: ${criterionKey}`);
      assignedCriteria.add(criterionKey);
    }
    for (const dependencyKey of task.dependencyKeys) {
      if (!tasks.has(dependencyKey)) throw new Error(`존재하지 않는 dependency입니다: ${dependencyKey}`);
      if (dependencyKey === task.key) throw new Error(`Strategy Task dependency cycle이 있습니다: ${task.key}`);
    }
  }
  for (const criterion of plan.acceptanceCriteria) {
    if (!criterion.planLevel && !assignedCriteria.has(criterion.key)) {
      throw new Error(`Task에 귀속되지 않은 criterion입니다: ${criterion.key}`);
    }
  }
  for (const risk of plan.risks) {
    if (
      (risk.impact === "critical" || risk.likelihood === "critical") &&
      (!risk.mitigation.trim() || !risk.requiresApproval)
    ) {
      throw new Error(`critical risk에는 mitigation과 사람 승인이 필요합니다: ${risk.key}`);
    }
  }
  assertAcyclic(plan.tasks);
  return plan;
}

export function validateAutomaticStrategyPlan(input: unknown): StrategyPlan {
  return validateStrategyPlan(automaticStrategyPlanSchema.parse(input));
}

export const strategyPlanJsonSchema = z.toJSONSchema(strategyPlanSchema) as Readonly<Record<string, unknown>>;
export const automaticStrategyPlanJsonSchema = z.toJSONSchema(automaticStrategyPlanSchema) as Readonly<
  Record<string, unknown>
>;
