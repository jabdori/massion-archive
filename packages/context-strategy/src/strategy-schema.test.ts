import { describe, expect, it } from "vitest";

import {
  automaticStrategyPlanJsonSchema,
  validateAutomaticStrategyPlan,
  validateStrategyPlan,
  type StrategyPlan,
} from "./index.js";

export const VALID_STRATEGY_PLAN: StrategyPlan = {
  objective: "Massion 완제품을 구현한다",
  summary: "설계, 구현과 검증을 순서대로 수행한다",
  scopeIn: ["Context & Strategy"],
  scopeOut: ["Repository Index"],
  assumptions: ["Phase 8 완료"],
  unknowns: ["외부 근거 추가 조사"],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "전체 테스트가 통과한다",
      method: "test",
      evidenceKinds: ["test-report"],
      planLevel: false,
    },
  ],
  risks: [
    {
      key: "risk-migration",
      description: "migration 충돌",
      likelihood: "low",
      impact: "high",
      mitigation: "고정 ID와 checksum을 검증한다",
      requiresApproval: false,
    },
  ],
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
    },
    {
      key: "verify",
      title: "검증",
      objective: "테스트를 실행한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: ["design"],
      requiredCapabilities: ["testing"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [{ key: "evidence-runtime", question: "Runtime 계약이 최신인가", required: true }],
};

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`테스트 fixture가 없습니다: ${label}`);
  return value;
}

describe("StrategyPlan schema", () => {
  it("자동 계획 JSON schema가 단순 응답·근거 조사·전문 역량을 구분한다", () => {
    const schema = JSON.stringify(automaticStrategyPlanJsonSchema);
    expect(schema).toContain("사용자 제공 요청에만 답하는 인사·접수 확인 Task에는 빈 배열을 사용");
    expect(schema).toContain("코드·설정·문서·제공된 근거 조사 Task에는 evidence-research를 사용");
    expect(schema).toContain("도메인·방법론 전문성");
    expect(schema).toContain("현재 Agent 보유 여부와 무관");
    expect(schema).toContain("critical이면 requiresApproval을 반드시 true");
  });

  it("자동 계획 JSON schema가 critical risk 승인 불변조건을 직접 표현한다", () => {
    const properties = automaticStrategyPlanJsonSchema.properties as Record<string, unknown>;
    const risks = properties.risks as { readonly items?: { readonly anyOf?: readonly unknown[] } };
    const variants = risks.items?.anyOf;

    expect(variants).toHaveLength(3);
    expect(JSON.stringify(variants)).toContain('"const":"critical"');
    expect(JSON.stringify(variants)).toContain('"const":true');
    expect(JSON.stringify(variants)).toContain('"minLength":1');
  });

  it("자동 계획의 모든 배열에 구조화 출력 item schema를 제공한다", () => {
    const missing: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "array" && !("items" in record)) missing.push(path);
      for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
    };

    visit(automaticStrategyPlanJsonSchema, "schema");

    expect(missing).toEqual([]);
  });

  it("유효한 계획을 정규화한다", () => {
    expect(validateStrategyPlan(VALID_STRATEGY_PLAN)).toEqual(VALID_STRATEGY_PLAN);
  });

  it("존재하지 않는 criterion과 dependency를 거부한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [{ ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), criterionKeys: ["missing"] }],
      }),
    ).toThrow("criterion");
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [{ ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), dependencyKeys: ["missing"] }],
      }),
    ).toThrow("dependency");
  });

  it("Task cycle과 중복 key를 거부한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [
          { ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), dependencyKeys: ["verify"] },
          required(VALID_STRATEGY_PLAN.tasks[1], "second task"),
        ],
      }),
    ).toThrow("cycle");
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [
          required(VALID_STRATEGY_PLAN.tasks[0], "first task"),
          { ...required(VALID_STRATEGY_PLAN.tasks[0], "first task") },
        ],
      }),
    ).toThrow("중복");
  });

  it("critical risk는 mitigation과 사람 승인을 요구한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        risks: [
          {
            ...required(VALID_STRATEGY_PLAN.risks[0], "first risk"),
            impact: "critical",
            mitigation: "",
            requiresApproval: false,
          },
        ],
      }),
    ).toThrow("critical");
  });

  it("자동 계획은 소비되지 않는 evidence request를 조용히 남기지 않는다", () => {
    const criterion = required(VALID_STRATEGY_PLAN.acceptanceCriteria[0], "first criterion");
    const automatic = {
      ...VALID_STRATEGY_PLAN,
      acceptanceCriteria: [
        { ...criterion, method: "evidence" as const, evidenceKinds: ["artifact-version"], planLevel: false },
      ],
      evidenceRequests: [],
    };

    expect(validateAutomaticStrategyPlan(automatic).evidenceRequests).toEqual([]);
    expect(() =>
      validateAutomaticStrategyPlan({
        ...automatic,
        evidenceRequests: [{ key: "missing-evidence", question: "추가 근거가 필요한가", required: true }],
      }),
    ).toThrow();
  });
});
