import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import type {
  ModelRecommendationRecord,
  OptimizationBatch,
  OptimizationBatchStatus,
  OptimizationObservation,
  OptimizationRecoveryEvent,
} from "./contracts.js";
import type { OptimizationRoleKey } from "./scoring.js";
import {
  MODEL_OPTIMIZATION_EVIDENCE_AUTHORITY_MIGRATION,
  MODEL_OPTIMIZATION_HARDENING_MIGRATION,
  MODEL_OPTIMIZATION_MIGRATION,
  MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION,
  MODEL_OPTIMIZATION_TASK_AXIS_SCORE_MIGRATION,
} from "./schema.js";

interface RecommendationRecord {
  readonly recommendation_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly policy_version_id: string;
  readonly primary_model_profile_id?: string;
  readonly fallback_model_profile_ids: readonly string[];
  readonly status: ModelRecommendationRecord["status"];
  readonly excluded_json: string;
  readonly receipt_ids: readonly string[];
  readonly checksum: string;
  readonly governance_decision_id?: string;
}

interface BatchRecord {
  readonly batch_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly version: number;
  readonly recommendation_id: string;
  readonly policy_version_id: string;
  readonly status: OptimizationBatchStatus;
  readonly primary_model_profile_id?: string;
  readonly fallback_model_profile_ids: readonly string[];
  readonly parent_batch_id?: string;
  readonly checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface ObservationRecord {
  readonly observation_id: string;
  readonly organization_id: string;
  readonly batch_id: string;
  readonly sample_count: number;
  readonly quality_score: number;
  readonly latency_ms: number;
  readonly cost_micros: number;
  readonly status: "healthy" | "degraded";
  readonly source?: "evaluation" | "production";
  readonly policy_version_id?: string;
  readonly expires_at?: string | Date;
  readonly checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface PointerRecord {
  readonly batch_id: string;
  readonly batch_version: number;
  readonly checksum: string;
}

interface OptimizationPolicyRecord {
  readonly policy_version_id?: string;
  readonly production_learning?: boolean;
  readonly shadow_enabled?: boolean;
  readonly minimum_sample_count: number;
  readonly improvement_threshold: number;
  readonly observation_budget_micros?: number;
  readonly observation_retention_days?: number;
}

interface OptimizationReceiptRecord {
  readonly receipt_id: string;
  readonly model_profile_id: string;
  readonly sample_count: number;
  readonly quality_score: number;
  readonly completed: boolean;
  readonly privacy_allowed: boolean;
}

interface RecoveryRecord {
  readonly recovery_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly from_batch_id: string;
  readonly to_batch_id: string;
  readonly reason: string;
  readonly observation_id: string;
  readonly command_id: string;
  readonly request_hash: string;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

function batchView(record: BatchRecord): OptimizationBatch {
  return {
    batchId: record.batch_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    version: record.version,
    recommendationId: record.recommendation_id,
    policyVersionId: record.policy_version_id,
    status: record.status,
    ...(record.primary_model_profile_id ? { primaryModelProfileId: record.primary_model_profile_id } : {}),
    fallbackModelProfileIds: record.fallback_model_profile_ids,
    ...(record.parent_batch_id ? { parentBatchId: record.parent_batch_id } : {}),
    checksum: record.checksum,
  };
}

function observationView(record: ObservationRecord): OptimizationObservation {
  return {
    observationId: record.observation_id,
    organizationId: record.organization_id,
    batchId: record.batch_id,
    sampleCount: record.sample_count,
    qualityScore: record.quality_score,
    latencyMs: record.latency_ms,
    costMicros: record.cost_micros,
    status: record.status,
    source: record.source ?? "evaluation",
    ...(record.policy_version_id ? { policyVersionId: record.policy_version_id } : {}),
    ...(record.expires_at ? { expiresAt: new Date(String(record.expires_at)).toISOString() } : {}),
    checksum: record.checksum,
  };
}

export interface ApproveRecommendationInput {
  readonly commandId: string;
  readonly recommendationId: string;
  readonly recommendationChecksum: string;
  readonly governanceDecisionId: string;
}

export interface CreateBatchInput {
  readonly commandId: string;
  readonly recommendationId: string;
  readonly status: Exclude<OptimizationBatchStatus, "reverted">;
}

export interface ActivateBatchInput {
  readonly commandId: string;
  readonly batchId: string;
}

export interface RecordObservationInput {
  readonly commandId: string;
  readonly batchId: string;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly status: "healthy" | "degraded";
  readonly source?: "evaluation" | "production";
}

export interface RecoverOptimizationInput {
  readonly commandId: string;
  readonly observationId: string;
}

export class OptimizationBatchService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<OptimizationBatchService> {
    await applyMigrations(database, [
      MODEL_OPTIMIZATION_MIGRATION,
      MODEL_OPTIMIZATION_HARDENING_MIGRATION,
      MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION,
      MODEL_OPTIMIZATION_TASK_AXIS_SCORE_MIGRATION,
      MODEL_OPTIMIZATION_EVIDENCE_AUTHORITY_MIGRATION,
    ]);
    return new OptimizationBatchService(database, organizations);
  }

  public async approveRecommendation(
    context: TenantContext,
    input: ApproveRecommendationInput,
  ): Promise<ModelRecommendationRecord> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId || !input.recommendationId || !input.recommendationChecksum || !input.governanceDecisionId)
      throw new Error("추천 승인 입력이 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const [records] = await tx.query<[RecommendationRecord[]]>(
        "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id LIMIT 1;",
        { organization_id: context.organizationId, recommendation_id: input.recommendationId },
      );
      const recommendation = records[0];
      if (!recommendation) throw new Error("모델 추천을 찾을 수 없습니다");
      if (recommendation.checksum !== input.recommendationChecksum) {
        throw new Error("모델 추천 checksum precondition이 일치하지 않습니다");
      }
      if (recommendation.status === "rejected" || recommendation.status === "superseded")
        throw new Error("종료된 모델 추천은 승인할 수 없습니다");
      if (
        recommendation.status === "approved" &&
        recommendation.governance_decision_id !== input.governanceDecisionId
      ) {
        throw new Error("이미 승인된 모델 추천의 Governance decision 계보가 일치하지 않습니다");
      }
      if (recommendation.status === "pending-approval") {
        await tx.query(
          "UPDATE optimization_recommendation SET status = 'approved', governance_decision_id = $decision_id WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id;",
          {
            organization_id: context.organizationId,
            recommendation_id: recommendation.recommendation_id,
            decision_id: input.governanceDecisionId,
          },
        );
      }
      return {
        recommendationId: recommendation.recommendation_id,
        organizationId: recommendation.organization_id,
        roleKey: recommendation.role_key,
        policyVersionId: recommendation.policy_version_id,
        ...(recommendation.primary_model_profile_id
          ? { primaryModelProfileId: recommendation.primary_model_profile_id }
          : {}),
        fallbackModelProfileIds: recommendation.fallback_model_profile_ids,
        excludedJson: recommendation.excluded_json,
        receiptIds: recommendation.receipt_ids,
        status: "approved",
        checksum: recommendation.checksum,
      };
    });
  }

  public async createBatch(context: TenantContext, input: CreateBatchInput): Promise<OptimizationBatch> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId || !input.recommendationId) throw new Error("모델 batch 입력이 유효하지 않습니다");
    if (!["candidate", "shadow", "limited", "active"].includes(input.status))
      throw new Error("모델 batch 상태가 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const [repeated] = await tx.query<[BatchRecord[]]>(
        "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) {
        if (repeated[0].request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 모델 batch를 사용할 수 없습니다");
        return batchView(repeated[0]);
      }
      const [recommendations] = await tx.query<[RecommendationRecord[]]>(
        "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id LIMIT 1;",
        { organization_id: context.organizationId, recommendation_id: input.recommendationId },
      );
      const recommendation = recommendations[0];
      if (!recommendation) throw new Error("모델 추천을 찾을 수 없습니다");
      if (recommendation.status !== "approved") throw new Error("승인된 모델 추천만 batch로 만들 수 있습니다");
      const [versions] = await tx.query<[{ readonly version: number }[]]>(
        "SELECT version FROM optimization_batch WHERE organization_id = $organization_id AND role_key = $role_key;",
        { organization_id: context.organizationId, role_key: recommendation.role_key },
      );
      // SurrealDB transaction query의 ORDER BY·LIMIT 결과 순서는 저장 엔진에 따라 보장되지 않을 수 있으므로
      // 읽어온 모든 version에서 최댓값을 계산해 다음 immutable version을 결정합니다.
      const version = versions.reduce((maximum, record) => Math.max(maximum, record.version), 0) + 1;
      const [active] = await tx.query<[PointerRecord[]]>(
        "SELECT batch_id, batch_version, checksum FROM optimization_active_pointer WHERE organization_id = $organization_id AND role_key = $role_key LIMIT 1;",
        { organization_id: context.organizationId, role_key: recommendation.role_key },
      );
      if (input.status !== "candidate") {
        const [policies] = await tx.query<[OptimizationPolicyRecord[]]>(
          "SELECT shadow_enabled, minimum_sample_count, improvement_threshold FROM optimization_policy_version WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id AND status = 'active' LIMIT 1;",
          { organization_id: context.organizationId, policy_version_id: recommendation.policy_version_id },
        );
        const policy = policies[0];
        if (input.status === "shadow" && policy?.shadow_enabled !== true)
          throw new Error("shadow 동의가 활성화된 정책만 shadow batch를 만들 수 있습니다");
        // 정책이 없으면 candidate 밖으로 나갈 수 없습니다. 예전에는 여기가 `if (policy)`라서
        // 정책이 없을 때 주 모델·완료·privacy receipt·최소 표본·개선 폭 검사가 전부 건너뛰어지고
        // limited·active batch가 그대로 만들어졌습니다. recommend()가 정책 미설정 시
        // policy_version_id에 실재하지 않는 "implicit-default"를 넣으므로 정상 사용에서도 열렸습니다.
        // shadow는 이미 fail-closed였고, 승격 경로가 그보다 느슨할 이유가 없습니다.
        if (!policy) throw new Error("활성 정책이 없으면 candidate 밖으로 batch를 승격할 수 없습니다");
        if (!recommendation.primary_model_profile_id)
          throw new Error("주 모델이 없는 추천은 batch로 승격할 수 없습니다");
        const [receipts] = await tx.query<[OptimizationReceiptRecord[]]>(
          "SELECT receipt_id, model_profile_id, sample_count, quality_score, completed, privacy_allowed FROM optimization_receipt WHERE organization_id = $organization_id AND receipt_id IN $receipt_ids;",
          { organization_id: context.organizationId, receipt_ids: recommendation.receipt_ids },
        );
        const primaryReceipt = receipts.find(
          (receipt) => receipt.model_profile_id === recommendation.primary_model_profile_id,
        );
        if (
          !primaryReceipt ||
          !primaryReceipt.completed ||
          !primaryReceipt.privacy_allowed ||
          primaryReceipt.sample_count < policy.minimum_sample_count
        )
          throw new Error("최소 표본과 완료된 privacy 허용 receipt가 필요합니다");
        if (active[0]) {
          const [parentBatches] = await tx.query<[BatchRecord[]]>(
            "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
            { organization_id: context.organizationId, batch_id: active[0].batch_id },
          );
          const parentBatch = parentBatches[0];
          if (parentBatch?.primary_model_profile_id) {
            const [parentRecommendations] = await tx.query<[RecommendationRecord[]]>(
              "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id LIMIT 1;",
              { organization_id: context.organizationId, recommendation_id: parentBatch.recommendation_id },
            );
            const parentRecommendation = parentRecommendations[0];
            const [parentReceipts] = parentRecommendation
              ? await tx.query<[OptimizationReceiptRecord[]]>(
                  "SELECT model_profile_id, sample_count, quality_score, completed, privacy_allowed FROM optimization_receipt WHERE organization_id = $organization_id AND receipt_id IN $receipt_ids;",
                  { organization_id: context.organizationId, receipt_ids: parentRecommendation.receipt_ids },
                )
              : [[]];
            const parentReceipt = parentReceipts.find(
              (receipt) => receipt.model_profile_id === parentBatch.primary_model_profile_id,
            );
            if (
              parentReceipt &&
              primaryReceipt.quality_score - parentReceipt.quality_score < policy.improvement_threshold
            )
              throw new Error("정책이 요구한 개선 폭을 충족하지 못했습니다");
          }
        }
      }
      const batchId = randomUUID();
      const checksum = digest({
        batchId,
        roleKey: recommendation.role_key,
        version,
        recommendationId: recommendation.recommendation_id,
        primaryModelProfileId: recommendation.primary_model_profile_id,
        fallbackModelProfileIds: recommendation.fallback_model_profile_ids,
      });
      const [created] = await tx.query<[BatchRecord[]]>(
        "CREATE optimization_batch CONTENT { batch_id: $batch_id, organization_id: $organization_id, role_key: $role_key, version: $version, recommendation_id: $recommendation_id, policy_version_id: $policy_version_id, status: $status, primary_model_profile_id: $primary_model_profile_id, fallback_model_profile_ids: $fallback_model_profile_ids, parent_batch_id: $parent_batch_id, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() } RETURN AFTER;",
        {
          batch_id: batchId,
          organization_id: context.organizationId,
          role_key: recommendation.role_key,
          version,
          recommendation_id: recommendation.recommendation_id,
          policy_version_id: recommendation.policy_version_id,
          status: input.status,
          primary_model_profile_id: recommendation.primary_model_profile_id,
          fallback_model_profile_ids: recommendation.fallback_model_profile_ids,
          parent_batch_id: active[0]?.batch_id,
          checksum,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("모델 batch 생성 결과가 없습니다");
      return batchView(created[0]);
    });
  }

  public async activateBatch(context: TenantContext, input: ActivateBatchInput): Promise<OptimizationBatch> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (tx) => {
      const [records] = await tx.query<[BatchRecord[]]>(
        "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
        { organization_id: context.organizationId, batch_id: input.batchId },
      );
      const batch = records[0];
      if (!batch) throw new Error("모델 batch를 찾을 수 없습니다");
      if (batch.status === "candidate") throw new Error("candidate batch는 승격 게이트를 거친 뒤 활성화할 수 있습니다");
      if (batch.status === "reverted") throw new Error("되돌려진 batch는 활성화할 수 없습니다");
      await tx.query(
        "UPDATE optimization_batch SET status = 'active', activated_at = time::now() WHERE organization_id = $organization_id AND batch_id = $batch_id;",
        { organization_id: context.organizationId, batch_id: batch.batch_id },
      );
      const [pointers] = await tx.query<[PointerRecord[]]>(
        "SELECT batch_id FROM optimization_active_pointer WHERE organization_id = $organization_id AND role_key = $role_key LIMIT 1;",
        { organization_id: context.organizationId, role_key: batch.role_key },
      );
      if (pointers[0])
        await tx.query(
          "UPDATE optimization_active_pointer SET batch_id = $batch_id, batch_version = $batch_version, checksum = $checksum, updated_at = time::now() WHERE organization_id = $organization_id AND role_key = $role_key;",
          {
            organization_id: context.organizationId,
            role_key: batch.role_key,
            batch_id: batch.batch_id,
            batch_version: batch.version,
            checksum: batch.checksum,
          },
        );
      else
        await tx.query(
          "CREATE optimization_active_pointer CONTENT { pointer_id: $pointer_id, organization_id: $organization_id, role_key: $role_key, batch_id: $batch_id, batch_version: $batch_version, checksum: $checksum, updated_at: time::now() };",
          {
            pointer_id: randomUUID(),
            organization_id: context.organizationId,
            role_key: batch.role_key,
            batch_id: batch.batch_id,
            batch_version: batch.version,
            checksum: batch.checksum,
          },
        );
      return batchView({ ...batch, status: "active" });
    });
  }

  public async getActiveBatch(
    context: TenantContext,
    roleKey: OptimizationRoleKey,
  ): Promise<OptimizationBatch | undefined> {
    await this.organizations.verifyTenantContext(context);
    const [pointers] = await this.database.query<[PointerRecord[]]>(
      "SELECT batch_id FROM optimization_active_pointer WHERE organization_id = $organization_id AND role_key = $role_key LIMIT 1;",
      { organization_id: context.organizationId, role_key: roleKey },
    );
    const pointer = pointers[0];
    if (!pointer) return undefined;
    const [batches] = await this.database.query<[BatchRecord[]]>(
      "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
      { organization_id: context.organizationId, batch_id: pointer.batch_id },
    );
    return batches[0] ? batchView(batches[0]) : undefined;
  }

  public async hasBatch(context: TenantContext, batchId: string): Promise<boolean> {
    await this.organizations.verifyTenantContext(context);
    const normalized = batchId.trim();
    if (!normalized || normalized.length > 256) throw new Error("모델 batch 식별자가 유효하지 않습니다");
    const [batches] = await this.database.query<[Array<{ readonly batch_id: string }>]>(
      "SELECT batch_id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
      { organization_id: context.organizationId, batch_id: normalized },
    );
    return batches.length === 1;
  }

  public async listObservations(context: TenantContext, batchId?: string): Promise<readonly OptimizationObservation[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ObservationRecord[]]>(
      batchId
        ? "SELECT * OMIT id FROM optimization_observation WHERE organization_id = $organization_id AND batch_id = $batch_id ORDER BY created_at DESC;"
        : "SELECT * OMIT id FROM optimization_observation WHERE organization_id = $organization_id ORDER BY created_at DESC;",
      { organization_id: context.organizationId, batch_id: batchId },
    );
    return records.map(observationView);
  }

  public async recordObservation(
    context: TenantContext,
    input: RecordObservationInput,
  ): Promise<OptimizationObservation> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId || !input.batchId || !Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1)
      throw new Error("최적화 observation 입력이 유효하지 않습니다");
    if (
      !Number.isFinite(input.qualityScore) ||
      input.qualityScore < 0 ||
      input.qualityScore > 1 ||
      !Number.isFinite(input.latencyMs) ||
      input.latencyMs < 0 ||
      !Number.isFinite(input.costMicros) ||
      input.costMicros < 0
    )
      throw new Error("최적화 observation 수치가 유효하지 않습니다");
    const [batches] = await this.database.query<[BatchRecord[]]>(
      "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
      { organization_id: context.organizationId, batch_id: input.batchId },
    );
    if (!batches[0]) throw new Error("최적화 observation의 batch를 찾을 수 없습니다");
    const source = input.source ?? "evaluation";
    const normalizedInput = { ...input, source };
    const requestHash = digest(normalizedInput);
    const [repeated] = await this.database.query<[ObservationRecord[]]>(
      "SELECT * OMIT id FROM optimization_observation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    if (repeated[0]) {
      if (repeated[0].request_hash !== requestHash)
        throw new Error("같은 commandId에 다른 optimization observation을 사용할 수 없습니다");
      return observationView(repeated[0]);
    }
    let policyVersionId: string | undefined;
    let expiresAt: Date | undefined;
    if (source === "production") {
      const [policies] = await this.database.query<[OptimizationPolicyRecord[]]>(
        "SELECT * OMIT id FROM optimization_policy_version WHERE organization_id = $organization_id AND status = 'active' ORDER BY version DESC LIMIT 1;",
        { organization_id: context.organizationId },
      );
      if (!policies[0]?.production_learning) throw new Error("production learning 동의가 활성화되지 않았습니다");
      const policy = policies[0];
      policyVersionId = policy.policy_version_id;
      const budget = policy.observation_budget_micros ?? 1_000_000;
      const [existing] = await this.database.query<[{ readonly cost_micros: number }[]]>(
        "SELECT cost_micros FROM optimization_observation WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id AND source = 'production';",
        { organization_id: context.organizationId, policy_version_id: policyVersionId },
      );
      const used = existing.reduce((total, observation) => total + observation.cost_micros, 0);
      if (used + input.costMicros > budget) throw new Error("실사용 observation 예산을 초과했습니다");
      const retentionDays = policy.observation_retention_days ?? 30;
      expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
    }
    const checksum = digest(normalizedInput);
    const [created] = await this.database.query<[ObservationRecord[]]>(
      "CREATE optimization_observation CONTENT { observation_id: $observation_id, organization_id: $organization_id, batch_id: $batch_id, sample_count: $sample_count, quality_score: $quality_score, latency_ms: $latency_ms, cost_micros: $cost_micros, status: $status, source: $source, policy_version_id: $policy_version_id, expires_at: $expires_at, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
      {
        observation_id: randomUUID(),
        organization_id: context.organizationId,
        batch_id: input.batchId,
        sample_count: input.sampleCount,
        quality_score: input.qualityScore,
        latency_ms: input.latencyMs,
        cost_micros: input.costMicros,
        status: input.status,
        source,
        policy_version_id: policyVersionId,
        expires_at: expiresAt,
        checksum,
        command_id: input.commandId,
        request_hash: requestHash,
      },
    );
    if (!created[0]) throw new Error("최적화 observation 생성 결과가 없습니다");
    return observationView(created[0]);
  }

  public async recover(context: TenantContext, input: RecoverOptimizationInput): Promise<OptimizationRecoveryEvent> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const [repeated] = await tx.query<[RecoveryRecord[]]>(
        "SELECT * OMIT id FROM optimization_recovery WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) {
        if (repeated[0].request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 optimization recovery를 사용할 수 없습니다");
        return {
          recoveryId: repeated[0].recovery_id,
          organizationId: repeated[0].organization_id,
          roleKey: repeated[0].role_key,
          fromBatchId: repeated[0].from_batch_id,
          toBatchId: repeated[0].to_batch_id,
          reason: repeated[0].reason,
          observationId: repeated[0].observation_id,
        };
      }
      const [observations] = await tx.query<[ObservationRecord[]]>(
        "SELECT * OMIT id FROM optimization_observation WHERE organization_id = $organization_id AND observation_id = $observation_id LIMIT 1;",
        { organization_id: context.organizationId, observation_id: input.observationId },
      );
      const observation = observations[0];
      if (!observation) throw new Error("최적화 observation을 찾을 수 없습니다");
      if (observation.status !== "degraded") throw new Error("degraded observation만 복구할 수 있습니다");
      if (observation.expires_at !== undefined) {
        const expiresAt = new Date(String(observation.expires_at)).getTime();
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
          throw new Error("만료된 observation으로 복구할 수 없습니다");
      }
      const [currentRecords] = await tx.query<[BatchRecord[]]>(
        "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
        { organization_id: context.organizationId, batch_id: observation.batch_id },
      );
      const current = currentRecords[0];
      if (!current?.parent_batch_id) throw new Error("복구할 이전 healthy batch가 없습니다");
      const [parentRecords] = await tx.query<[BatchRecord[]]>(
        "SELECT * OMIT id FROM optimization_batch WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 1;",
        { organization_id: context.organizationId, batch_id: current.parent_batch_id },
      );
      const parent = parentRecords[0];
      if (!parent) throw new Error("이전 healthy batch를 찾을 수 없습니다");
      const [pointers] = await tx.query<[PointerRecord[]]>(
        "SELECT batch_id FROM optimization_active_pointer WHERE organization_id = $organization_id AND role_key = $role_key LIMIT 1;",
        { organization_id: context.organizationId, role_key: current.role_key },
      );
      if (pointers[0]?.batch_id !== current.batch_id) {
        throw new Error("현재 활성 batch의 observation만 복구할 수 있습니다");
      }
      await tx.query(
        "UPDATE optimization_batch SET status = 'reverted' WHERE organization_id = $organization_id AND batch_id = $batch_id; UPDATE optimization_batch SET status = 'active' WHERE organization_id = $organization_id AND batch_id = $parent_batch_id; UPDATE optimization_active_pointer SET batch_id = $parent_batch_id, batch_version = $parent_version, checksum = $parent_checksum, updated_at = time::now() WHERE organization_id = $organization_id AND role_key = $role_key;",
        {
          organization_id: context.organizationId,
          batch_id: current.batch_id,
          parent_batch_id: parent.batch_id,
          parent_version: parent.version,
          parent_checksum: parent.checksum,
          role_key: current.role_key,
        },
      );
      const recoveryId = randomUUID();
      const [created] = await tx.query<[OptimizationRecoveryEvent[]]>(
        "CREATE optimization_recovery CONTENT { recovery_id: $recovery_id, organization_id: $organization_id, role_key: $role_key, from_batch_id: $from_batch_id, to_batch_id: $to_batch_id, reason: $reason, observation_id: $observation_id, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          recovery_id: recoveryId,
          organization_id: context.organizationId,
          role_key: current.role_key,
          from_batch_id: current.batch_id,
          to_batch_id: parent.batch_id,
          reason: "degraded-observation",
          observation_id: observation.observation_id,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("최적화 recovery 생성 결과가 없습니다");
      return {
        recoveryId,
        organizationId: context.organizationId,
        roleKey: current.role_key,
        fromBatchId: current.batch_id,
        toBatchId: parent.batch_id,
        reason: "degraded-observation",
        observationId: observation.observation_id,
      } satisfies OptimizationRecoveryEvent;
    });
  }
}
