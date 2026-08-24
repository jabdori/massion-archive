import { describe, expect, it } from "vitest";

import {
  CORE_ROLE_KEYS,
  SOFTWARE_ENGINEERING_ROLE_KEYS,
  recommendModels,
  type EvaluationCandidate,
  type EvaluationPolicy,
  type EvaluationReceipt,
} from "./scoring.js";

function candidate(overrides: Partial<EvaluationCandidate> = {}): EvaluationCandidate {
  return {
    modelProfileId: "profile-sol",
    modelId: "gpt-5.6-sol",
    routeId: "route-sol",
    providerId: "openai-codex",
    verified: true,
    supportsStructuredOutput: true,
    supportsTools: true,
    supportsStreaming: true,
    dataPolicy: "external-allowed",
    ...overrides,
  };
}

function receipt(overrides: Partial<EvaluationReceipt> = {}): EvaluationReceipt {
  const value: EvaluationReceipt = {
    receiptId: "receipt-profile-sol",
    roleKey: "context-strategy",
    modelProfileId: "profile-sol",
    bundleId: "bundle-1",
    bundleVersion: 1,
    sampleCount: 10,
    qualityScore: 0.9,
    latencyMs: 500,
    costMicros: 100,
    privacyAllowed: true,
    completed: true,
    inputChecksum: "a".repeat(64),
    receiptChecksum: "b".repeat(64),
    ...overrides,
  };
  return value;
}

describe("모델 평가 추천", () => {
  it("Core Office 8개와 Software Engineering 8개 역할을 고정한다", () => {
    expect(CORE_ROLE_KEYS).toHaveLength(8);
    expect(SOFTWARE_ENGINEERING_ROLE_KEYS).toHaveLength(8);
    expect(new Set([...CORE_ROLE_KEYS, ...SOFTWARE_ENGINEERING_ROLE_KEYS]).size).toBe(16);
  });

  it("검증되지 않았거나 capability·privacy hard gate를 통과하지 못한 모델은 추천에서 제외한다", () => {
    const result = recommendModels({
      roleKey: "context-strategy",
      policy: "quality",
      candidates: [
        candidate({ modelProfileId: "unverified", verified: false }),
        candidate({ modelProfileId: "no-tools", supportsTools: false }),
        candidate({ modelProfileId: "private-only", dataPolicy: "local-private" }),
        candidate({ modelProfileId: "eligible" }),
      ],
      receipts: [receipt({ modelProfileId: "eligible" })],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });

    expect(result.primary?.modelProfileId).toBe("eligible");
    expect(result.fallbacks).toEqual([]);
    expect(result.excluded.map((item) => item.modelProfileId)).toEqual(["no-tools", "private-only", "unverified"]);
  });

  it.each<[EvaluationPolicy, string]>([
    ["quality", "quality"],
    ["value", "value"],
    ["speed", "speed"],
    ["privacy", "privacy"],
    ["manual", "manual"],
  ])("%s 정책은 결정론적으로 주 모델과 fallback을 만든다", (policy, expectedPolicy) => {
    const result = recommendModels({
      roleKey: "assurance",
      policy,
      candidates: [
        candidate({ modelProfileId: "slow", modelId: "slow-model" }),
        candidate({ modelProfileId: "cheap", modelId: "cheap-model" }),
        candidate({ modelProfileId: "backup", modelId: "backup-model" }),
      ],
      receipts: [
        receipt({
          roleKey: "assurance",
          modelProfileId: "slow",
          qualityScore: 0.99,
          latencyMs: 1_000,
          costMicros: 900,
        }),
        receipt({ roleKey: "assurance", modelProfileId: "cheap", qualityScore: 0.8, latencyMs: 300, costMicros: 10 }),
        receipt({ roleKey: "assurance", modelProfileId: "backup", qualityScore: 0.7, latencyMs: 600, costMicros: 100 }),
      ],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
      ...(policy === "manual" ? { manualModelProfileId: "backup" } : {}),
    });

    expect(result.policy).toBe(expectedPolicy);
    expect(result.primary).toBeDefined();
    expect(result.fallbacks).toHaveLength(2);
    expect(new Set([result.primary?.modelProfileId, ...result.fallbacks.map((item) => item.modelProfileId)]).size).toBe(
      3,
    );
  });

  it("완료된 receipt의 최소 표본이 없으면 모델을 추천하지 않는다", () => {
    const result = recommendModels({
      roleKey: "growth",
      policy: "quality",
      candidates: [candidate()],
      receipts: [receipt({ roleKey: "growth", sampleCount: 1 })],
      requirements: {
        requiresTools: false,
        requiresStructuredOutput: false,
        requiresStreaming: false,
        dataPolicy: "external-allowed",
      },
      minimumSampleCount: 3,
    });

    expect(result.primary).toBeUndefined();
    expect(result.excluded[0]?.reason).toBe("insufficient-samples");
  });

  it("같은 평가 bundle의 receipt만 비교하고 선택 근거를 고정한다", () => {
    const result = recommendModels({
      roleKey: "assurance",
      policy: "quality",
      candidates: [candidate({ modelProfileId: "profile-a" }), candidate({ modelProfileId: "profile-b" })],
      receipts: [
        receipt({
          roleKey: "assurance",
          modelProfileId: "profile-a",
          receiptId: "receipt-a-old",
          bundleId: "bundle-old",
          bundleVersion: 1,
          qualityScore: 1,
        }),
        receipt({
          roleKey: "assurance",
          modelProfileId: "profile-a",
          receiptId: "receipt-a-shared",
          bundleId: "bundle-shared",
          bundleVersion: 2,
          qualityScore: 0.2,
        }),
        receipt({
          roleKey: "assurance",
          modelProfileId: "profile-b",
          receiptId: "receipt-b-shared",
          bundleId: "bundle-shared",
          bundleVersion: 2,
          qualityScore: 0.9,
        }),
      ],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });

    expect(result.primary?.modelProfileId).toBe("profile-b");
    expect(result.fallbacks.map((item) => item.modelProfileId)).toEqual(["profile-a"]);
    expect(result.receiptIds).toEqual(["receipt-a-shared", "receipt-b-shared"]);
  });

  it("공통 평가 bundle이 없으면 후보를 추천하지 않는다", () => {
    const result = recommendModels({
      roleKey: "assurance",
      policy: "quality",
      candidates: [candidate({ modelProfileId: "profile-a" }), candidate({ modelProfileId: "profile-b" })],
      receipts: [
        receipt({ roleKey: "assurance", modelProfileId: "profile-a", bundleId: "bundle-a" }),
        receipt({ roleKey: "assurance", modelProfileId: "profile-b", bundleId: "bundle-b" }),
      ],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });

    expect(result.primary).toBeUndefined();
    expect(result.fallbacks).toEqual([]);
    expect(result.excluded).toEqual([
      { modelProfileId: "profile-a", reason: "incomplete-receipt" },
      { modelProfileId: "profile-b", reason: "incomplete-receipt" },
    ]);
    expect(result.receiptIds).toEqual([]);
  });
});
