export const CORE_ROLE_KEYS = [
  "representative",
  "context-strategy",
  "evidence-research",
  "governance",
  "delivery-coordination",
  "assurance",
  "records-documentation",
  "growth",
] as const;

export const SOFTWARE_ENGINEERING_ROLE_KEYS = [
  "software-engineering.lead",
  "software-engineering.frontend-specialist",
  "software-engineering.backend-specialist",
  "software-engineering.database-specialist",
  "software-engineering.infrastructure-specialist",
  "software-engineering.test-engineer",
  "software-engineering.security-reviewer",
  "software-engineering.release-engineer",
] as const;

export type CoreRoleKey = (typeof CORE_ROLE_KEYS)[number];
export type SoftwareEngineeringRoleKey = (typeof SOFTWARE_ENGINEERING_ROLE_KEYS)[number];
export type OptimizationRoleKey = CoreRoleKey | SoftwareEngineeringRoleKey;
export type EvaluationPolicy = "quality" | "value" | "speed" | "privacy" | "manual";
export type EvaluationDataPolicy = "external-allowed" | "local-private";

export interface EvaluationCandidate {
  readonly modelProfileId: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly verified: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly dataPolicy: EvaluationDataPolicy;
}

export interface EvaluationReceipt {
  readonly receiptId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly modelProfileId: string;
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
  readonly inputChecksum: string;
  readonly receiptChecksum: string;
}

export interface EvaluationRequirements {
  readonly requiresTools: boolean;
  readonly requiresStructuredOutput: boolean;
  readonly requiresStreaming: boolean;
  readonly dataPolicy: EvaluationDataPolicy;
}

export interface RecommendationExclusion {
  readonly modelProfileId: string;
  readonly reason:
    | "unverified"
    | "missing-tools"
    | "missing-structured-output"
    | "missing-streaming"
    | "privacy-not-allowed"
    | "incomplete-receipt"
    | "insufficient-samples";
}

export interface ModelRecommendation {
  readonly roleKey: OptimizationRoleKey;
  readonly policy: EvaluationPolicy;
  readonly primary?: EvaluationCandidate;
  readonly fallbacks: readonly EvaluationCandidate[];
  readonly excluded: readonly RecommendationExclusion[];
  /** 실제 비교에 사용한 동일 bundle의 immutable receipt 집합입니다. */
  readonly receiptIds: readonly string[];
}

export interface RecommendModelsInput {
  readonly roleKey: OptimizationRoleKey;
  readonly policy: EvaluationPolicy;
  readonly candidates: readonly EvaluationCandidate[];
  readonly receipts: readonly EvaluationReceipt[];
  readonly requirements: EvaluationRequirements;
  readonly manualModelProfileId?: string;
  readonly minimumSampleCount?: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function isOptimizationRoleKey(value: string): value is OptimizationRoleKey {
  return (
    (CORE_ROLE_KEYS as readonly string[]).includes(value) ||
    (SOFTWARE_ENGINEERING_ROLE_KEYS as readonly string[]).includes(value)
  );
}

function assertRoleKey(value: string): asserts value is OptimizationRoleKey {
  if (!isOptimizationRoleKey(value)) throw new Error(`지원하지 않는 최적화 역할입니다: ${value}`);
}

function assertReceipt(receipt: EvaluationReceipt, roleKey: OptimizationRoleKey): void {
  if (receipt.roleKey !== roleKey) throw new Error("모델 평가 receipt의 역할이 추천 역할과 다릅니다");
  for (const [value, label] of [
    [receipt.receiptId, "receipt ID"],
    [receipt.bundleId, "bundle ID"],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) {
      throw new Error(`모델 평가 ${label}가 유효하지 않습니다`);
    }
  }
  if (!Number.isSafeInteger(receipt.bundleVersion) || receipt.bundleVersion < 1) {
    throw new Error("모델 평가 bundle version이 유효하지 않습니다");
  }
  if (!Number.isSafeInteger(receipt.sampleCount) || receipt.sampleCount < 0) {
    throw new Error("모델 평가 sample count가 유효하지 않습니다");
  }
  if (!Number.isFinite(receipt.qualityScore) || receipt.qualityScore < 0 || receipt.qualityScore > 1) {
    throw new Error("모델 평가 quality score가 유효하지 않습니다");
  }
  if (
    !Number.isFinite(receipt.latencyMs) ||
    receipt.latencyMs < 0 ||
    !Number.isFinite(receipt.costMicros) ||
    receipt.costMicros < 0
  ) {
    throw new Error("모델 평가 latency 또는 cost가 유효하지 않습니다");
  }
  if (!SHA256.test(receipt.inputChecksum) || !SHA256.test(receipt.receiptChecksum)) {
    throw new Error("모델 평가 checksum이 유효하지 않습니다");
  }
}

function matchingReceipts(
  candidate: EvaluationCandidate,
  receipts: readonly EvaluationReceipt[],
  roleKey: OptimizationRoleKey,
): readonly EvaluationReceipt[] {
  const matching = receipts.filter(
    (receipt) => receipt.modelProfileId === candidate.modelProfileId && receipt.roleKey === roleKey,
  );
  for (const item of matching) assertReceipt(item, roleKey);
  return matching;
}

function receiptFailure(
  receipts: readonly EvaluationReceipt[],
  minimumSampleCount: number,
): RecommendationExclusion["reason"] | undefined {
  const completed = receipts.filter((receipt) => receipt.completed);
  if (completed.length === 0) return "incomplete-receipt";
  if (!completed.some((receipt) => receipt.sampleCount >= minimumSampleCount)) return "insufficient-samples";
  if (!completed.some((receipt) => receipt.sampleCount >= minimumSampleCount && receipt.privacyAllowed)) {
    return "privacy-not-allowed";
  }
  return undefined;
}

function receiptForBundle(
  receipts: readonly EvaluationReceipt[],
  bundleId: string,
  bundleVersion: number,
): EvaluationReceipt {
  const receipt = [...receipts]
    .filter((item) => item.bundleId === bundleId && item.bundleVersion === bundleVersion)
    .sort(
      (left, right) =>
        right.sampleCount - left.sampleCount ||
        left.receiptChecksum.localeCompare(right.receiptChecksum) ||
        left.receiptId.localeCompare(right.receiptId),
    )[0];
  if (!receipt) throw new Error("동일 bundle의 모델 평가 receipt를 찾을 수 없습니다");
  return receipt;
}

function comparableBundle(
  candidates: readonly { readonly receipts: readonly EvaluationReceipt[] }[],
): { readonly bundleId: string; readonly bundleVersion: number } | undefined {
  const [first, ...rest] = candidates;
  if (!first) return undefined;
  const shared = [...first.receipts]
    .filter((receipt) =>
      rest.every((candidate) =>
        candidate.receipts.some(
          (item) => item.bundleId === receipt.bundleId && item.bundleVersion === receipt.bundleVersion,
        ),
      ),
    )
    .sort((left, right) => right.bundleVersion - left.bundleVersion || left.bundleId.localeCompare(right.bundleId))[0];
  return shared ? { bundleId: shared.bundleId, bundleVersion: shared.bundleVersion } : undefined;
}

export interface RankedEvaluationCandidate {
  readonly candidate: EvaluationCandidate;
  readonly receipt: EvaluationReceipt;
}

export function rankEvaluationCandidates(
  policy: EvaluationPolicy,
  candidates: readonly RankedEvaluationCandidate[],
): readonly RankedEvaluationCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      compareCandidates(policy, left, right) ||
      left.candidate.modelProfileId.localeCompare(right.candidate.modelProfileId),
  );
}

function compareCandidates(
  policy: EvaluationPolicy,
  left: RankedEvaluationCandidate,
  right: RankedEvaluationCandidate,
): number {
  const quality = right.receipt.qualityScore - left.receipt.qualityScore;
  const speed = left.receipt.latencyMs - right.receipt.latencyMs;
  const cost = left.receipt.costMicros - right.receipt.costMicros;
  const privacy =
    Number(right.candidate.dataPolicy === "local-private") - Number(left.candidate.dataPolicy === "local-private");
  if (policy === "quality") return quality || speed || cost;
  if (policy === "value") {
    const value =
      right.receipt.qualityScore / Math.max(1, right.receipt.costMicros) -
      left.receipt.qualityScore / Math.max(1, left.receipt.costMicros);
    return value || quality || speed;
  }
  if (policy === "speed") return speed || quality || cost;
  if (policy === "privacy") return privacy || quality || speed || cost;
  return 0;
}

export function recommendModels(input: RecommendModelsInput): ModelRecommendation {
  assertRoleKey(input.roleKey);
  if (!new Set(["quality", "value", "speed", "privacy", "manual"]).has(input.policy)) {
    throw new Error("모델 평가 정책이 유효하지 않습니다");
  }
  const minimumSampleCount = input.minimumSampleCount ?? 3;
  if (!Number.isSafeInteger(minimumSampleCount) || minimumSampleCount < 1) {
    throw new Error("모델 평가 최소 표본 수가 유효하지 않습니다");
  }
  const excluded: RecommendationExclusion[] = [];
  const comparable: Array<{ candidate: EvaluationCandidate; receipts: readonly EvaluationReceipt[] }> = [];
  const eligible: Array<{ candidate: EvaluationCandidate; receipt: EvaluationReceipt }> = [];
  for (const candidate of input.candidates) {
    const fail = (reason: RecommendationExclusion["reason"]) =>
      excluded.push({ modelProfileId: candidate.modelProfileId, reason });
    if (!candidate.verified) returnFail(fail, "unverified");
    else if (input.requirements.requiresTools && !candidate.supportsTools) returnFail(fail, "missing-tools");
    else if (input.requirements.requiresStructuredOutput && !candidate.supportsStructuredOutput)
      returnFail(fail, "missing-structured-output");
    else if (input.requirements.requiresStreaming && !candidate.supportsStreaming)
      returnFail(fail, "missing-streaming");
    else if (input.requirements.dataPolicy === "local-private" && candidate.dataPolicy !== "local-private")
      returnFail(fail, "privacy-not-allowed");
    else {
      const receipts = matchingReceipts(candidate, input.receipts, input.roleKey);
      const failure = receiptFailure(receipts, minimumSampleCount);
      if (failure) returnFail(fail, failure);
      else {
        comparable.push({
          candidate,
          receipts: receipts.filter(
            (receipt) => receipt.completed && receipt.sampleCount >= minimumSampleCount && receipt.privacyAllowed,
          ),
        });
      }
    }
  }
  const bundle = comparableBundle(comparable);
  if (comparable.length > 0 && !bundle) {
    for (const item of comparable)
      excluded.push({ modelProfileId: item.candidate.modelProfileId, reason: "incomplete-receipt" });
  } else if (bundle) {
    for (const item of comparable) {
      eligible.push({
        candidate: item.candidate,
        receipt: receiptForBundle(item.receipts, bundle.bundleId, bundle.bundleVersion),
      });
    }
  }
  const sorted = rankEvaluationCandidates(input.policy, eligible);
  const primary =
    input.policy === "manual" && input.manualModelProfileId
      ? sorted.find((entry) => entry.candidate.modelProfileId === input.manualModelProfileId)?.candidate
      : sorted[0]?.candidate;
  const fallbacks = sorted
    .filter((entry) => entry.candidate.modelProfileId !== primary?.modelProfileId)
    .map((entry) => entry.candidate);
  excluded.sort((left, right) => left.modelProfileId.localeCompare(right.modelProfileId));
  const receiptIds = [...new Set(sorted.map((entry) => entry.receipt.receiptId))].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    roleKey: input.roleKey,
    policy: input.policy,
    ...(primary ? { primary } : {}),
    fallbacks,
    excluded,
    receiptIds,
  };
}

function returnFail(
  callback: (reason: RecommendationExclusion["reason"]) => void,
  reason: RecommendationExclusion["reason"],
): void {
  callback(reason);
}
