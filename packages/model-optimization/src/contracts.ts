import type { OptimizationRoleKey, EvaluationDataPolicy, EvaluationPolicy } from "./scoring.js";

export type EvaluationTaskAxis =
  "code-generation" | "code-understanding" | "planning-design" | "review-critique" | "summary-records";
export type EvaluationReasoningDifficulty = "low" | "medium" | "high";
export type EvaluationEvidenceTier = "t0-bundled" | "t1-local";

export interface EvaluationExecutionDisclosure {
  readonly expectedCallCount: number;
  readonly maximumCostMicros: number;
  readonly providerId: string;
  readonly dataKinds: readonly string[];
}

export interface EvaluationPreflight extends EvaluationExecutionDisclosure {
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly configurationChecksum: string;
  readonly checksum: string;
}

export type EvaluationReceiptEvidence =
  | {
      readonly tier: "t0-bundled";
      readonly expiresAt: string;
      readonly sourceVersion: string;
      readonly sourceChecksum: string;
      readonly configurationChecksum: string;
      readonly license: string;
      readonly contaminationPossible: boolean;
    }
  | {
      readonly tier: "t1-local";
      readonly sourceVersion: string;
      readonly configurationChecksum: string;
      readonly disclosure: EvaluationExecutionDisclosure;
    };

export interface OptimizationModelProfile {
  readonly modelProfileId: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly verified: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsTools: boolean;
  readonly supportsVision?: boolean;
  readonly supportsStreaming: boolean;
  readonly contextWindow?: number;
  readonly maximumCostMicrosPerCall?: number;
  readonly dataPolicy: EvaluationDataPolicy;
}

export interface EvaluationCase {
  readonly caseId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly promptChecksum: string;
  readonly toolsChecksum: string;
  readonly environmentChecksum: string;
  readonly prompt?: string;
  readonly expectedOutcome: string;
  /** 기존 평가 묶음은 이 분류 없이도 읽히며 역할 baseline으로만 사용합니다. */
  readonly taskAxis?: EvaluationTaskAxis;
  readonly reasoningDifficulty?: EvaluationReasoningDifficulty;
}

export interface EvaluationBundle {
  readonly bundleId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly caseIds: readonly string[];
  readonly runtimeVersion: string;
  readonly checksum: string;
  readonly status: "active" | "superseded";
}

export interface EvaluationRun {
  readonly runId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode: "standard" | "shadow";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly inputChecksum: string;
  readonly commandId: string;
}

export interface StoredEvaluationReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly organizationId: string;
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
  /** 0129 이전 receipt는 권한을 추정하지 않고 이 필드가 없습니다. */
  readonly evidence?: EvaluationReceiptEvidence;
}

export interface OptimizationPolicyVersion {
  readonly policyVersionId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly policy: EvaluationPolicy;
  readonly autoOptimize: boolean;
  readonly productionLearning: boolean;
  readonly shadowEnabled: boolean;
  readonly minimumSampleCount: number;
  readonly improvementThreshold: number;
  readonly observationBudgetMicros: number;
  readonly observationRetentionDays: number;
  readonly status: "active" | "superseded";
  readonly checksum: string;
}

export interface ModelRecommendationRecord {
  readonly recommendationId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly policyVersionId: string;
  readonly primaryModelProfileId?: string;
  readonly fallbackModelProfileIds: readonly string[];
  readonly excludedJson: string;
  readonly receiptIds: readonly string[];
  readonly status: "pending-approval" | "approved" | "rejected" | "superseded";
  readonly checksum: string;
}

export type OptimizationBatchStatus = "candidate" | "shadow" | "limited" | "active" | "reverted";

export interface OptimizationBatch {
  readonly batchId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly recommendationId: string;
  readonly policyVersionId: string;
  readonly status: OptimizationBatchStatus;
  readonly primaryModelProfileId?: string;
  readonly fallbackModelProfileIds: readonly string[];
  readonly parentBatchId?: string;
  readonly checksum: string;
}

export interface OptimizationObservation {
  readonly observationId: string;
  readonly organizationId: string;
  readonly batchId: string;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly status: "healthy" | "degraded";
  readonly source: "evaluation" | "production";
  readonly policyVersionId?: string;
  readonly expiresAt?: string;
  readonly checksum: string;
}

export interface OptimizationRecoveryEvent {
  readonly recoveryId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly fromBatchId: string;
  readonly toBatchId: string;
  readonly reason: string;
  readonly observationId: string;
}

export interface ConfigureOptimizationPolicyInput {
  readonly commandId: string;
  readonly policy: EvaluationPolicy;
  readonly autoOptimize: boolean;
  readonly productionLearning: boolean;
  readonly shadowEnabled: boolean;
  readonly minimumSampleCount?: number;
  readonly improvementThreshold?: number;
  readonly observationBudgetMicros?: number;
  readonly observationRetentionDays?: number;
  readonly governanceDecisionId: string;
}

export interface StartEvaluationInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode?: "standard" | "shadow";
  readonly inputChecksum: string;
}

export interface CompleteEvaluationInput {
  readonly commandId: string;
  readonly runId: string;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
}
