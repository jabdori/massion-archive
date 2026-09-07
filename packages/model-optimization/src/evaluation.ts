import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  isOptimizationRoleKey,
  rankEvaluationCandidates,
  recommendModels,
  type EvaluationReceipt,
  type EvaluationRequirements,
  type EvaluationPolicy,
  type ModelRecommendation,
  type OptimizationRoleKey,
} from "./scoring.js";
import type {
  ConfigureOptimizationPolicyInput,
  CompleteEvaluationInput,
  EvaluationBundle,
  EvaluationCase,
  EvaluationExecutionDisclosure,
  EvaluationPreflight,
  EvaluationReceiptEvidence,
  EvaluationReasoningDifficulty,
  EvaluationRun,
  EvaluationTaskAxis,
  ModelRecommendationRecord,
  OptimizationModelProfile,
  OptimizationPolicyVersion,
  StartEvaluationInput,
  StoredEvaluationReceipt,
} from "./contracts.js";
import type { EvaluationCapabilities, ModelEvaluationExecutionResult, ModelEvaluationExecutor } from "./ports.js";
import {
  MODEL_OPTIMIZATION_EVIDENCE_AUTHORITY_MIGRATION,
  MODEL_OPTIMIZATION_HARDENING_MIGRATION,
  MODEL_OPTIMIZATION_MIGRATION,
  MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION,
  MODEL_OPTIMIZATION_TASK_AXIS_SCORE_MIGRATION,
} from "./schema.js";
import { createEvaluationExport, validateEvaluationExport, type EvaluationExport } from "./transfer.js";

export type { OptimizationModelProfile } from "./contracts.js";
export type {
  EvaluationCapabilities,
  ModelEvaluationExecutionInput,
  ModelEvaluationExecutionResult,
  ModelEvaluationExecutor,
} from "./ports.js";

interface BundleRecord {
  readonly bundle_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly version: number;
  readonly case_ids: readonly string[];
  readonly runtime_version: string;
  readonly checksum: string;
  readonly status: "active" | "superseded";
  readonly command_id: string;
  readonly request_hash: string;
}

interface RunRecord {
  readonly run_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly bundle_id: string;
  readonly bundle_version: number;
  readonly model_profile_id: string;
  readonly runtime_version: string;
  readonly mode: "standard" | "shadow";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly input_checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface ReceiptRecord {
  readonly receipt_id: string;
  readonly run_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly model_profile_id: string;
  readonly bundle_id: string;
  readonly bundle_version: number;
  readonly sample_count: number;
  readonly quality_score: number;
  readonly latency_ms: number;
  readonly cost_micros: number;
  readonly privacy_allowed: boolean;
  readonly completed: boolean;
  readonly input_checksum: string;
  readonly receipt_checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly evidence_tier?: "t0-bundled" | "t1-local";
  readonly evidence_expires_at?: string | Date;
  readonly evidence_source_version?: string;
  readonly evidence_source_checksum?: string;
  readonly evidence_configuration_checksum?: string;
  readonly evidence_license?: string;
  readonly evidence_contamination_possible?: boolean;
  readonly evidence_disclosure_json?: string;
}

interface AxisScoreRecord {
  readonly score_id: string;
  readonly receipt_id: string;
  readonly run_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly model_profile_id: string;
  readonly bundle_id: string;
  readonly bundle_version: number;
  readonly task_axis: EvaluationTaskAxis;
  readonly reasoning_difficulty: EvaluationReasoningDifficulty;
  readonly sample_count: number;
  readonly quality_score: number;
  readonly latency_ms: number;
  readonly cost_micros: number;
  readonly privacy_allowed: boolean;
  readonly completed: boolean;
  readonly score_checksum: string;
}

interface PolicyRecord {
  readonly policy_version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly policy: EvaluationPolicy;
  readonly auto_optimize: boolean;
  readonly production_learning: boolean;
  readonly shadow_enabled: boolean;
  readonly minimum_sample_count: number;
  readonly improvement_threshold: number;
  readonly observation_budget_micros?: number;
  readonly observation_retention_days?: number;
  readonly status: "active" | "superseded";
  readonly checksum: string;
  readonly governance_decision_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly created_by_user_id: string;
}

interface RecommendationRecord {
  readonly recommendation_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly policy_version_id: string;
  readonly primary_model_profile_id?: string;
  readonly fallback_model_profile_ids: readonly string[];
  readonly excluded_json: string;
  readonly receipt_ids: readonly string[];
  readonly status: ModelRecommendationRecord["status"];
  readonly checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertText(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}이(가) 유효하지 않습니다`);
  }
}

function assertChecksum(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} checksum이 유효하지 않습니다`);
}

function assertRole(value: string): asserts value is OptimizationRoleKey {
  if (!isOptimizationRoleKey(value)) throw new Error(`지원하지 않는 최적화 역할입니다: ${value}`);
}

function assertTaskAxis(value: unknown): asserts value is EvaluationTaskAxis {
  if (
    !new Set<EvaluationTaskAxis>([
      "code-generation",
      "code-understanding",
      "planning-design",
      "review-critique",
      "summary-records",
    ]).has(value as EvaluationTaskAxis)
  ) {
    throw new Error("평가 작업 축이 유효하지 않습니다");
  }
}

function assertReasoningDifficulty(value: unknown): asserts value is EvaluationReasoningDifficulty {
  if (!new Set<EvaluationReasoningDifficulty>(["low", "medium", "high"]).has(value as EvaluationReasoningDifficulty)) {
    throw new Error("평가 추론 난이도가 유효하지 않습니다");
  }
}

function executionDisclosure(value: unknown): EvaluationExecutionDisclosure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("평가 실행 전 고지가 유효하지 않습니다");
  }
  const disclosure = value as Partial<EvaluationExecutionDisclosure>;
  if (!Number.isSafeInteger(disclosure.expectedCallCount) || (disclosure.expectedCallCount ?? 0) < 1) {
    throw new Error("평가 예상 호출 수가 유효하지 않습니다");
  }
  if (
    !Number.isSafeInteger(disclosure.maximumCostMicros) ||
    (disclosure.maximumCostMicros ?? -1) < 0
  ) {
    throw new Error("평가 예상 최대 비용이 유효하지 않습니다");
  }
  assertText(disclosure.providerId, "평가 Provider 식별자");
  if (
    !Array.isArray(disclosure.dataKinds) ||
    disclosure.dataKinds.length < 1 ||
    disclosure.dataKinds.length > 16
  ) {
    throw new Error("평가 전송 데이터 종류가 유효하지 않습니다");
  }
  const dataKinds = disclosure.dataKinds.map((kind) => {
    assertText(kind, "평가 전송 데이터 종류", 128);
    return kind;
  });
  if (new Set(dataKinds).size !== dataKinds.length) throw new Error("평가 전송 데이터 종류가 중복되었습니다");
  return {
    expectedCallCount: disclosure.expectedCallCount as number,
    maximumCostMicros: disclosure.maximumCostMicros as number,
    providerId: disclosure.providerId,
    dataKinds,
  };
}

function receiptEvidence(record: ReceiptRecord): EvaluationReceiptEvidence | undefined {
  if (record.evidence_tier === undefined) return undefined;
  assertText(record.evidence_source_version, "평가 evidence source version");
  assertChecksum(record.evidence_configuration_checksum, "평가 evidence configuration");
  if (record.evidence_tier === "t0-bundled") {
    assertText(record.evidence_license, "평가 evidence license", 256);
    assertChecksum(record.evidence_source_checksum, "평가 evidence source");
    if (typeof record.evidence_contamination_possible !== "boolean") {
      throw new Error("평가 evidence 오염 가능성이 유효하지 않습니다");
    }
    const expiresAt = new Date(String(record.evidence_expires_at));
    if (!Number.isFinite(expiresAt.getTime())) throw new Error("평가 evidence 만료 시각이 유효하지 않습니다");
    return {
      tier: "t0-bundled",
      expiresAt: expiresAt.toISOString(),
      sourceVersion: record.evidence_source_version,
      sourceChecksum: record.evidence_source_checksum,
      configurationChecksum: record.evidence_configuration_checksum,
      license: record.evidence_license,
      contaminationPossible: record.evidence_contamination_possible,
    };
  }
  if (record.evidence_tier !== "t1-local" || record.evidence_disclosure_json === undefined) {
    throw new Error("평가 evidence 권한이 유효하지 않습니다");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.evidence_disclosure_json);
  } catch {
    throw new Error("평가 실행 전 고지 JSON이 유효하지 않습니다");
  }
  return {
    tier: "t1-local",
    sourceVersion: record.evidence_source_version,
    configurationChecksum: record.evidence_configuration_checksum,
    disclosure: executionDisclosure(parsed),
  };
}

function bundleView(record: BundleRecord): EvaluationBundle {
  return {
    bundleId: record.bundle_id,
    roleKey: record.role_key,
    version: record.version,
    caseIds: record.case_ids,
    runtimeVersion: record.runtime_version,
    checksum: record.checksum,
    status: record.status,
  };
}

function runView(record: RunRecord): EvaluationRun {
  return {
    runId: record.run_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    bundleId: record.bundle_id,
    bundleVersion: record.bundle_version,
    modelProfileId: record.model_profile_id,
    runtimeVersion: record.runtime_version,
    mode: record.mode,
    status: record.status,
    inputChecksum: record.input_checksum,
    commandId: record.command_id,
  };
}

function receiptView(record: ReceiptRecord): StoredEvaluationReceipt {
  const evidence = receiptEvidence(record);
  return {
    receiptId: record.receipt_id,
    runId: record.run_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    modelProfileId: record.model_profile_id,
    bundleId: record.bundle_id,
    bundleVersion: record.bundle_version,
    sampleCount: record.sample_count,
    qualityScore: record.quality_score,
    latencyMs: record.latency_ms,
    costMicros: record.cost_micros,
    privacyAllowed: record.privacy_allowed,
    completed: record.completed,
    inputChecksum: record.input_checksum,
    receiptChecksum: record.receipt_checksum,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function policyView(record: PolicyRecord): OptimizationPolicyVersion {
  return {
    policyVersionId: record.policy_version_id,
    organizationId: record.organization_id,
    version: record.version,
    policy: record.policy,
    autoOptimize: record.auto_optimize,
    productionLearning: record.production_learning,
    shadowEnabled: record.shadow_enabled,
    minimumSampleCount: record.minimum_sample_count,
    improvementThreshold: record.improvement_threshold,
    observationBudgetMicros: record.observation_budget_micros ?? 1_000_000,
    observationRetentionDays: record.observation_retention_days ?? 30,
    status: record.status,
    checksum: record.checksum,
  };
}

function recommendationView(record: RecommendationRecord): ModelRecommendationRecord {
  return {
    recommendationId: record.recommendation_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    policyVersionId: record.policy_version_id,
    ...(record.primary_model_profile_id ? { primaryModelProfileId: record.primary_model_profile_id } : {}),
    fallbackModelProfileIds: record.fallback_model_profile_ids,
    excludedJson: record.excluded_json,
    receiptIds: record.receipt_ids,
    status: record.status,
    checksum: record.checksum,
  };
}

function scoreReceipt(record: StoredEvaluationReceipt): EvaluationReceipt {
  return {
    receiptId: record.receiptId,
    roleKey: record.roleKey,
    modelProfileId: record.modelProfileId,
    bundleId: record.bundleId,
    bundleVersion: record.bundleVersion,
    sampleCount: record.sampleCount,
    qualityScore: record.qualityScore,
    latencyMs: record.latencyMs,
    costMicros: record.costMicros,
    privacyAllowed: record.privacyAllowed,
    completed: record.completed,
    inputChecksum: record.inputChecksum,
    receiptChecksum: record.receiptChecksum,
  };
}

function buildEvaluationPreflight(
  bundle: BundleRecord,
  cases: readonly EvaluationCase[],
  profile: OptimizationModelProfile,
  runtimeVersion: string,
): EvaluationPreflight {
  assertText(runtimeVersion, "runtime version");
  assertText(profile.providerId, "평가 Provider 식별자");
  const maximumCostMicrosPerCall = profile.maximumCostMicrosPerCall;
  if (!Number.isSafeInteger(maximumCostMicrosPerCall) || (maximumCostMicrosPerCall ?? -1) < 0) {
    throw new Error("평가 Route의 호출당 최대 비용이 유효하지 않습니다");
  }
  if (cases.length !== bundle.case_ids.length || cases.length < 1) {
    throw new Error("평가 bundle case 계보가 유효하지 않습니다");
  }
  const maximumCostMicros = (maximumCostMicrosPerCall as number) * cases.length;
  if (!Number.isSafeInteger(maximumCostMicros)) throw new Error("평가 예상 최대 비용이 유효하지 않습니다");
  const disclosure = executionDisclosure({
    expectedCallCount: cases.length,
    maximumCostMicros,
    providerId: profile.providerId,
    dataKinds: ["evaluation-prompt"],
  });
  const configurationChecksum = digest({
    bundleChecksum: bundle.checksum,
    modelProfileId: profile.modelProfileId,
    routeId: profile.routeId,
    providerId: profile.providerId,
    runtimeVersion,
    maximumCostMicrosPerCall,
  });
  const value = {
    bundleId: bundle.bundle_id,
    bundleVersion: bundle.version,
    modelProfileId: profile.modelProfileId,
    runtimeVersion,
    configurationChecksum,
    ...disclosure,
  };
  return { ...value, checksum: digest(value) };
}

export interface CreateBundleInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly runtimeVersion: string;
  readonly cases: readonly Omit<EvaluationCase, "caseId" | "roleKey" | "version">[];
}

export interface RecommendInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly requirements: EvaluationRequirements;
  readonly manualModelProfileId?: string;
}

export interface ExportBundleInput {
  readonly bundleId: string;
  readonly license: string;
  readonly configurationChecksum: string;
}

export interface ImportBundleInput {
  readonly commandId: string;
  readonly exportValue: unknown;
}

export interface ModelOptimizationStoreOptions {
  readonly modelCatalog?: (context: TenantContext) => Promise<readonly OptimizationModelProfile[]>;
  readonly executor?: ModelEvaluationExecutor;
}

export interface ExecuteEvaluationInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode?: "standard" | "shadow";
  readonly inputChecksum?: string;
  readonly preflightChecksum?: string;
}

export type PreviewEvaluationInput = Pick<
  ExecuteEvaluationInput,
  "roleKey" | "bundleId" | "modelProfileId" | "runtimeVersion"
>;

export interface SelectTaskAxisModelsInput {
  readonly roleKey: OptimizationRoleKey;
  readonly recommendationId: string;
  readonly modelProfileIds: readonly string[];
  readonly taskAxis: EvaluationTaskAxis;
  readonly reasoningDifficulty: EvaluationReasoningDifficulty;
}

export interface TaskAxisModelSelection {
  readonly modelProfileIds: readonly string[];
  readonly receiptIds: readonly string[];
  readonly bundleId: string;
  readonly bundleVersion: number;
}

interface AxisScoreInput {
  readonly taskAxis: EvaluationTaskAxis;
  readonly reasoningDifficulty: EvaluationReasoningDifficulty;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
}

export class ModelOptimizationStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly options: ModelOptimizationStoreOptions,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: ModelOptimizationStoreOptions = {},
  ): Promise<ModelOptimizationStore> {
    await applyMigrations(database, [
      MODEL_OPTIMIZATION_MIGRATION,
      MODEL_OPTIMIZATION_HARDENING_MIGRATION,
      MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION,
      MODEL_OPTIMIZATION_TASK_AXIS_SCORE_MIGRATION,
      MODEL_OPTIMIZATION_EVIDENCE_AUTHORITY_MIGRATION,
    ]);
    return new ModelOptimizationStore(database, organizations, options);
  }

  public async createBundle(context: TenantContext, input: CreateBundleInput): Promise<EvaluationBundle> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.runtimeVersion, "runtime version");
    if (input.cases.length < 1 || input.cases.length > 128) throw new Error("평가 case 수가 유효하지 않습니다");
    const hasPlacementSignal = input.cases.map(
      (item) => item.taskAxis !== undefined || item.reasoningDifficulty !== undefined,
    );
    if (hasPlacementSignal.some(Boolean) && !hasPlacementSignal.every(Boolean)) {
      throw new Error("평가 bundle의 작업 축과 추론 난이도는 모든 case에 함께 필요합니다");
    }
    for (const item of input.cases) {
      assertChecksum(item.promptChecksum, "prompt");
      assertChecksum(item.toolsChecksum, "tools");
      assertChecksum(item.environmentChecksum, "environment");
      if (item.prompt !== undefined) assertText(item.prompt, "평가 prompt", 16_384);
      assertText(item.expectedOutcome, "expected outcome", 4_096);
      if ((item.taskAxis === undefined) !== (item.reasoningDifficulty === undefined)) {
        throw new Error("평가 case의 작업 축과 추론 난이도는 함께 필요합니다");
      }
      if (item.taskAxis !== undefined) assertTaskAxis(item.taskAxis);
      if (item.reasoningDifficulty !== undefined) assertReasoningDifficulty(item.reasoningDifficulty);
    }
    const requestHash = digest({ ...input, roleKey: input.roleKey });
    return await this.database.transaction(async (tx) => {
      const repeated = await this.command<BundleRecord>(
        tx,
        context.organizationId,
        "optimization_bundle",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 bundle을 사용할 수 없습니다");
        return bundleView(repeated);
      }
      const [versions] = await tx.query<[{ readonly version: number }[]]>(
        "SELECT version FROM optimization_bundle WHERE organization_id = $organization_id AND role_key = $role_key;",
        { organization_id: context.organizationId, role_key: input.roleKey },
      );
      // SurrealDB transaction query의 ORDER BY·LIMIT 결과 순서는 저장 엔진에 따라 보장되지 않을 수 있으므로
      // 읽어온 모든 version에서 최댓값을 계산해 다음 immutable version을 결정합니다.
      const version = versions.reduce((maximum, record) => Math.max(maximum, record.version), 0) + 1;
      const caseIds: string[] = [];
      for (const item of input.cases) {
        const caseId = randomUUID();
        caseIds.push(caseId);
        await tx.query(
          "CREATE optimization_case CONTENT { case_id: $case_id, organization_id: $organization_id, role_key: $role_key, version: $version, prompt_checksum: $prompt_checksum, tools_checksum: $tools_checksum, environment_checksum: $environment_checksum, prompt: $prompt, expected_outcome: $expected_outcome, task_axis: $task_axis, reasoning_difficulty: $reasoning_difficulty, created_at: time::now() };",
          {
            case_id: caseId,
            organization_id: context.organizationId,
            role_key: input.roleKey,
            version,
            prompt_checksum: item.promptChecksum,
            tools_checksum: item.toolsChecksum,
            environment_checksum: item.environmentChecksum,
            prompt: item.prompt,
            expected_outcome: item.expectedOutcome,
            task_axis: item.taskAxis,
            reasoning_difficulty: item.reasoningDifficulty,
          },
        );
      }
      const bundleId = randomUUID();
      const checksum = digest({
        roleKey: input.roleKey,
        version,
        runtimeVersion: input.runtimeVersion,
        caseIds,
        cases: input.cases.map((item) => ({
          taskAxis: item.taskAxis,
          reasoningDifficulty: item.reasoningDifficulty,
        })),
      });
      const [created] = await tx.query<[BundleRecord[]]>(
        "CREATE optimization_bundle CONTENT { bundle_id: $bundle_id, organization_id: $organization_id, role_key: $role_key, version: $version, case_ids: $case_ids, runtime_version: $runtime_version, checksum: $checksum, status: 'active', command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          bundle_id: bundleId,
          organization_id: context.organizationId,
          role_key: input.roleKey,
          version,
          case_ids: caseIds,
          runtime_version: input.runtimeVersion,
          checksum,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("평가 bundle 생성 결과가 없습니다");
      return bundleView(created[0]);
    });
  }

  public async startEvaluation(context: TenantContext, input: StartEvaluationInput): Promise<EvaluationRun> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.bundleId, "bundle 식별자");
    assertText(input.modelProfileId, "model profile 식별자");
    assertText(input.runtimeVersion, "runtime version");
    assertChecksum(input.inputChecksum, "평가 입력");
    const mode = input.mode ?? "standard";
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const repeated = await this.command<RunRecord>(tx, context.organizationId, "optimization_run", input.commandId);
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 run을 사용할 수 없습니다");
        return runView(repeated);
      }
      if (mode === "shadow") {
        const policy = await this.activePolicy(tx, context.organizationId);
        if (!policy?.shadow_enabled) throw new Error("shadow 평가가 활성화되지 않았습니다");
      }
      const [bundles] = await tx.query<[BundleRecord[]]>(
        "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
        { organization_id: context.organizationId, bundle_id: input.bundleId },
      );
      const bundle = bundles[0];
      if (!bundle || bundle.role_key !== input.roleKey) throw new Error("평가 bundle을 찾을 수 없거나 역할이 다릅니다");
      const [created] = await tx.query<[RunRecord[]]>(
        "CREATE optimization_run CONTENT { run_id: $run_id, organization_id: $organization_id, role_key: $role_key, bundle_id: $bundle_id, bundle_version: $bundle_version, model_profile_id: $model_profile_id, runtime_version: $runtime_version, mode: $mode, status: 'running', input_checksum: $input_checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          run_id: randomUUID(),
          organization_id: context.organizationId,
          role_key: input.roleKey,
          bundle_id: bundle.bundle_id,
          bundle_version: bundle.version,
          model_profile_id: input.modelProfileId,
          runtime_version: input.runtimeVersion,
          mode,
          input_checksum: input.inputChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("평가 run 생성 결과가 없습니다");
      return runView(created[0]);
    });
  }

  public async completeEvaluation(
    context: TenantContext,
    input: CompleteEvaluationInput,
  ): Promise<StoredEvaluationReceipt> {
    return await this.completeEvaluationWithAxisScores(context, input);
  }

  private async completeEvaluationWithAxisScores(
    context: TenantContext,
    input: CompleteEvaluationInput,
    axisScores: readonly AxisScoreInput[] = [],
    evidence?: EvaluationReceiptEvidence,
  ): Promise<StoredEvaluationReceipt> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertText(input.runId, "평가 run 식별자");
    if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1)
      throw new Error("평가 sample count가 유효하지 않습니다");
    if (!Number.isFinite(input.qualityScore) || input.qualityScore < 0 || input.qualityScore > 1)
      throw new Error("평가 quality score가 유효하지 않습니다");
    if (
      !Number.isFinite(input.latencyMs) ||
      input.latencyMs < 0 ||
      !Number.isFinite(input.costMicros) ||
      input.costMicros < 0
    )
      throw new Error("평가 latency 또는 cost가 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const requestHash = digest({ input, evidence });
      const repeated = await this.command<ReceiptRecord>(
        tx,
        context.organizationId,
        "optimization_receipt",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 receipt를 사용할 수 없습니다");
        return receiptView(repeated);
      }
      const [runs] = await tx.query<[RunRecord[]]>(
        "SELECT * OMIT id FROM optimization_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
        { organization_id: context.organizationId, run_id: input.runId },
      );
      const run = runs[0];
      if (!run) throw new Error("평가 run을 찾을 수 없습니다");
      if (run.status !== "running") throw new Error("running 상태의 평가 run만 완료할 수 있습니다");
      const receiptChecksum = digest({
        runId: run.run_id,
        bundleId: run.bundle_id,
        sampleCount: input.sampleCount,
        qualityScore: input.qualityScore,
        latencyMs: input.latencyMs,
        costMicros: input.costMicros,
        privacyAllowed: input.privacyAllowed,
        completed: input.completed,
        evidence,
      });
      const [created] = await tx.query<[ReceiptRecord[]]>(
        "CREATE optimization_receipt CONTENT { receipt_id: $receipt_id, run_id: $run_id, organization_id: $organization_id, role_key: $role_key, model_profile_id: $model_profile_id, bundle_id: $bundle_id, bundle_version: $bundle_version, sample_count: $sample_count, quality_score: $quality_score, latency_ms: $latency_ms, cost_micros: $cost_micros, privacy_allowed: $privacy_allowed, completed: $completed, input_checksum: $input_checksum, receipt_checksum: $receipt_checksum, evidence_tier: $evidence_tier, evidence_expires_at: $evidence_expires_at, evidence_source_version: $evidence_source_version, evidence_source_checksum: $evidence_source_checksum, evidence_configuration_checksum: $evidence_configuration_checksum, evidence_license: $evidence_license, evidence_contamination_possible: $evidence_contamination_possible, evidence_disclosure_json: $evidence_disclosure_json, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          receipt_id: randomUUID(),
          run_id: run.run_id,
          organization_id: context.organizationId,
          role_key: run.role_key,
          model_profile_id: run.model_profile_id,
          bundle_id: run.bundle_id,
          bundle_version: run.bundle_version,
          sample_count: input.sampleCount,
          quality_score: input.qualityScore,
          latency_ms: input.latencyMs,
          cost_micros: input.costMicros,
          privacy_allowed: input.privacyAllowed,
          completed: input.completed,
          input_checksum: run.input_checksum,
          receipt_checksum: receiptChecksum,
          evidence_tier: evidence?.tier,
          evidence_expires_at: evidence?.tier === "t0-bundled" ? new Date(evidence.expiresAt) : undefined,
          evidence_source_version: evidence?.sourceVersion,
          evidence_source_checksum: evidence?.tier === "t0-bundled" ? evidence.sourceChecksum : undefined,
          evidence_configuration_checksum: evidence?.configurationChecksum,
          evidence_license: evidence?.tier === "t0-bundled" ? evidence.license : undefined,
          evidence_contamination_possible:
            evidence?.tier === "t0-bundled" ? evidence.contaminationPossible : undefined,
          evidence_disclosure_json:
            evidence?.tier === "t1-local" ? canonicalJson(evidence.disclosure) : undefined,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("평가 receipt 생성 결과가 없습니다");
      for (const score of axisScores) {
        const scoreChecksum = digest({
          receiptId: created[0].receipt_id,
          runId: run.run_id,
          bundleId: run.bundle_id,
          bundleVersion: run.bundle_version,
          taskAxis: score.taskAxis,
          reasoningDifficulty: score.reasoningDifficulty,
          sampleCount: score.sampleCount,
          qualityScore: score.qualityScore,
          latencyMs: score.latencyMs,
          costMicros: score.costMicros,
          privacyAllowed: score.privacyAllowed,
          completed: score.completed,
        });
        await tx.query(
          "CREATE optimization_receipt_axis_score CONTENT { score_id: $score_id, receipt_id: $receipt_id, run_id: $run_id, organization_id: $organization_id, role_key: $role_key, model_profile_id: $model_profile_id, bundle_id: $bundle_id, bundle_version: $bundle_version, task_axis: $task_axis, reasoning_difficulty: $reasoning_difficulty, sample_count: $sample_count, quality_score: $quality_score, latency_ms: $latency_ms, cost_micros: $cost_micros, privacy_allowed: $privacy_allowed, completed: $completed, score_checksum: $score_checksum, created_at: time::now() };",
          {
            score_id: randomUUID(),
            receipt_id: created[0].receipt_id,
            run_id: run.run_id,
            organization_id: context.organizationId,
            role_key: run.role_key,
            model_profile_id: run.model_profile_id,
            bundle_id: run.bundle_id,
            bundle_version: run.bundle_version,
            task_axis: score.taskAxis,
            reasoning_difficulty: score.reasoningDifficulty,
            sample_count: score.sampleCount,
            quality_score: score.qualityScore,
            latency_ms: score.latencyMs,
            cost_micros: score.costMicros,
            privacy_allowed: score.privacyAllowed,
            completed: score.completed,
            score_checksum: scoreChecksum,
          },
        );
      }
      await tx.query(
        "UPDATE optimization_run SET status = 'completed', updated_at = time::now() WHERE organization_id = $organization_id AND run_id = $run_id;",
        { organization_id: context.organizationId, run_id: run.run_id },
      );
      return receiptView(created[0]);
    });
  }

  /** 구독 실행 작업공간에 사용할 평가 run의 조직 소유권을 확인합니다. */
  public async hasEvaluationRun(context: TenantContext, runId: string): Promise<boolean> {
    await this.organizations.verifyTenantContext(context);
    assertText(runId, "평가 run 식별자");
    const [runs] = await this.database.query<[Array<{ readonly run_id: string }>]>(
      "SELECT run_id FROM optimization_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
      { organization_id: context.organizationId, run_id: runId },
    );
    return runs.length > 0;
  }

  /** T1 로컬 bench가 실행 전에 공개하고 실행 시 다시 검증할 비용·전송 스냅샷입니다. */
  public async previewEvaluation(
    context: TenantContext,
    input: PreviewEvaluationInput,
  ): Promise<EvaluationPreflight> {
    await this.organizations.verifyTenantContext(context);
    assertRole(input.roleKey);
    assertText(input.bundleId, "bundle 식별자");
    assertText(input.modelProfileId, "model profile 식별자");
    assertText(input.runtimeVersion, "runtime version");
    if (!this.options.modelCatalog) throw new Error("정본 모델 catalog가 구성되지 않았습니다");
    const [bundles, profiles] = await Promise.all([
      this.database.query<[BundleRecord[]]>(
        "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
        { organization_id: context.organizationId, bundle_id: input.bundleId },
      ),
      this.options.modelCatalog(context),
    ]);
    const bundle = bundles[0][0];
    if (!bundle || bundle.role_key !== input.roleKey) throw new Error("평가 bundle을 찾을 수 없거나 역할이 다릅니다");
    const profile = profiles.find((candidate) => candidate.modelProfileId === input.modelProfileId);
    if (!profile?.verified) throw new Error("검증된 연결 모델 profile이 아닙니다");
    return buildEvaluationPreflight(
      bundle,
      await this.listBundleCases(context, bundle.bundle_id),
      profile,
      input.runtimeVersion,
    );
  }

  /** 고정된 평가 묶음의 모든 case를 실행하고 하나의 불변 receipt로 집계합니다. */
  public async executeEvaluation(
    context: TenantContext,
    input: ExecuteEvaluationInput,
  ): Promise<StoredEvaluationReceipt> {
    const executor = this.options.executor;
    if (!executor) throw new Error("모델 평가 실행기가 구성되지 않았습니다");
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.bundleId, "bundle 식별자");
    assertText(input.modelProfileId, "model profile 식별자");
    assertText(input.runtimeVersion, "runtime version");
    if (input.preflightChecksum !== undefined) assertChecksum(input.preflightChecksum, "평가 실행 전 고지");
    const mode = input.mode ?? "standard";

    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: input.bundleId },
    );
    const bundle = bundles[0];
    if (!bundle || bundle.role_key !== input.roleKey) throw new Error("평가 bundle을 찾을 수 없거나 역할이 다릅니다");
    const cases = await this.listBundleCases(context, bundle.bundle_id);
    if (!cases.length) throw new Error("평가 bundle에 case가 없습니다");

    let profile: OptimizationModelProfile | undefined;
    if (this.options.modelCatalog) {
      const profiles = await this.options.modelCatalog(context);
      profile = profiles.find((candidate) => candidate.modelProfileId === input.modelProfileId);
      if (!profile || !profile.verified) throw new Error("검증된 연결 모델 profile이 아닙니다");
    }
    const preflight =
      profile?.maximumCostMicrosPerCall === undefined
        ? undefined
        : buildEvaluationPreflight(bundle, cases, profile, input.runtimeVersion);
    if (input.preflightChecksum !== undefined && preflight?.checksum !== input.preflightChecksum) {
      throw new Error("평가 실행 전 고지가 현재 bundle·모델·Route와 일치하지 않습니다");
    }

    const inputChecksum =
      input.inputChecksum ??
      digest({
        bundleChecksum: bundle.checksum,
        caseChecksums: cases.map((item) => [item.promptChecksum, item.toolsChecksum, item.environmentChecksum]),
        roleKey: input.roleKey,
        modelProfileId: input.modelProfileId,
        runtimeVersion: input.runtimeVersion,
        mode,
      });
    assertChecksum(inputChecksum, "평가 입력");
    const run = await this.startEvaluation(context, {
      commandId: `${input.commandId}:run`,
      roleKey: input.roleKey,
      bundleId: input.bundleId,
      modelProfileId: input.modelProfileId,
      runtimeVersion: input.runtimeVersion,
      mode,
      inputChecksum,
    });
    const capabilities: EvaluationCapabilities = {
      write: false,
      message: false,
      deployment: false,
      approval: false,
      organizationMutation: false,
    };
    const executions: Array<{
      readonly evaluationCase: EvaluationCase;
      readonly result: ModelEvaluationExecutionResult;
    }> = [];
    try {
      for (const evaluationCase of cases) {
        const result = await executor.execute({
          context,
          organizationId: context.organizationId,
          roleKey: input.roleKey,
          modelProfileId: input.modelProfileId,
          runtimeVersion: input.runtimeVersion,
          mode,
          run,
          case: evaluationCase,
          ...(profile ? { profile } : {}),
          capabilities,
        });
        this.assertExecutionResult(result);
        executions.push({ evaluationCase, result });
      }
    } catch (error) {
      await this.markRunFailed(context, run.runId);
      throw error;
    }
    const results = executions.map((execution) => execution.result);
    const sampleCount = results.length;
    const axisScores = this.axisScores(executions);
    return await this.completeEvaluationWithAxisScores(
      context,
      {
        commandId: `${input.commandId}:receipt`,
        runId: run.runId,
        sampleCount,
        qualityScore: results.reduce((total, result) => total + result.qualityScore, 0) / sampleCount,
        latencyMs: results.reduce((total, result) => total + result.latencyMs, 0) / sampleCount,
        costMicros: results.reduce((total, result) => total + result.costMicros, 0),
        privacyAllowed: results.every((result) => result.privacyAllowed),
        completed: results.every((result) => result.completed),
      },
      axisScores,
      preflight
        ? {
            tier: "t1-local",
            sourceVersion: input.runtimeVersion,
            configurationChecksum: preflight.configurationChecksum,
            disclosure: {
              expectedCallCount: preflight.expectedCallCount,
              maximumCostMicros: preflight.maximumCostMicros,
              providerId: preflight.providerId,
              dataKinds: preflight.dataKinds,
            },
          }
        : undefined,
    );
  }

  public async configurePolicy(
    context: TenantContext,
    input: ConfigureOptimizationPolicyInput,
  ): Promise<OptimizationPolicyVersion> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertText(input.governanceDecisionId, "거버넌스 결정 식별자");
    if (!["quality", "value", "speed", "privacy", "manual"].includes(input.policy))
      throw new Error("모델 평가 정책이 유효하지 않습니다");
    const minimumSampleCount = input.minimumSampleCount ?? 3;
    const improvementThreshold = input.improvementThreshold ?? 0.05;
    const observationBudgetMicros = input.observationBudgetMicros ?? 1_000_000;
    const observationRetentionDays = input.observationRetentionDays ?? 30;
    if (!Number.isSafeInteger(minimumSampleCount) || minimumSampleCount < 1)
      throw new Error("모델 평가 최소 표본 수가 유효하지 않습니다");
    if (!Number.isFinite(improvementThreshold) || improvementThreshold < 0 || improvementThreshold > 1)
      throw new Error("모델 평가 개선 기준이 유효하지 않습니다");
    if (!Number.isFinite(observationBudgetMicros) || observationBudgetMicros <= 0)
      throw new Error("실사용 observation 예산이 유효하지 않습니다");
    if (
      !Number.isSafeInteger(observationRetentionDays) ||
      observationRetentionDays < 1 ||
      observationRetentionDays > 3650
    )
      throw new Error("실사용 observation 보존 기간이 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const repeated = await this.command<PolicyRecord>(
        tx,
        context.organizationId,
        "optimization_policy_version",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 최적화 정책을 사용할 수 없습니다");
        return policyView(repeated);
      }
      const current = await this.activePolicy(tx, context.organizationId);
      if (current) {
        await tx.query(
          "UPDATE optimization_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id AND status = 'active';",
          { organization_id: context.organizationId, policy_version_id: current.policy_version_id },
        );
      }
      const version = (current?.version ?? 0) + 1;
      const policyChecksum = digest({
        policy: input.policy,
        autoOptimize: input.autoOptimize,
        productionLearning: input.productionLearning,
        shadowEnabled: input.shadowEnabled,
        minimumSampleCount,
        improvementThreshold,
        observationBudgetMicros,
        observationRetentionDays,
        version,
      });
      const [created] = await tx.query<[PolicyRecord[]]>(
        "CREATE optimization_policy_version CONTENT { policy_version_id: $policy_version_id, organization_id: $organization_id, version: $version, policy: $policy, auto_optimize: $auto_optimize, production_learning: $production_learning, shadow_enabled: $shadow_enabled, minimum_sample_count: $minimum_sample_count, improvement_threshold: $improvement_threshold, observation_budget_micros: $observation_budget_micros, observation_retention_days: $observation_retention_days, status: 'active', checksum: $checksum, governance_decision_id: $governance_decision_id, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() } RETURN AFTER;",
        {
          policy_version_id: randomUUID(),
          organization_id: context.organizationId,
          version,
          policy: input.policy,
          auto_optimize: input.autoOptimize,
          production_learning: input.productionLearning,
          shadow_enabled: input.shadowEnabled,
          minimum_sample_count: minimumSampleCount,
          improvement_threshold: improvementThreshold,
          observation_budget_micros: observationBudgetMicros,
          observation_retention_days: observationRetentionDays,
          status: "active",
          checksum: policyChecksum,
          governance_decision_id: input.governanceDecisionId,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("최적화 정책 생성 결과가 없습니다");
      return policyView(created[0]);
    });
  }

  public async getActivePolicy(context: TenantContext): Promise<OptimizationPolicyVersion | undefined> {
    await this.organizations.verifyTenantContext(context);
    const record = await this.activePolicy(this.database, context.organizationId);
    return record ? policyView(record) : undefined;
  }

  public async recommend(context: TenantContext, input: RecommendInput): Promise<ModelRecommendationRecord> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    const policy = (await this.getActivePolicy(context)) ?? {
      policyVersionId: "implicit-default",
      organizationId: context.organizationId,
      version: 0,
      policy: "quality" as const,
      autoOptimize: false,
      productionLearning: false,
      shadowEnabled: false,
      minimumSampleCount: 3,
      improvementThreshold: 0.05,
      status: "active" as const,
      checksum: digest("implicit-default"),
    };
    if (!this.options.modelCatalog) throw new Error("정본 모델 catalog가 구성되지 않았습니다");
    const candidates = await this.options.modelCatalog(context);
    const requestHash = digest(input);
    return await this.database.transaction(async (tx) => {
      const repeated = await this.command<RecommendationRecord>(
        tx,
        context.organizationId,
        "optimization_recommendation",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 모델 추천을 사용할 수 없습니다");
        return recommendationView(repeated);
      }
      const [receipts] = await tx.query<[ReceiptRecord[]]>(
        "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY created_at DESC;",
        { organization_id: context.organizationId, role_key: input.roleKey },
      );
      const scored: ModelRecommendation = recommendModels({
        roleKey: input.roleKey,
        policy: policy.policy,
        candidates,
        receipts: receipts.map((receipt) => scoreReceipt(receiptView(receipt))),
        requirements: input.requirements,
        ...(input.manualModelProfileId ? { manualModelProfileId: input.manualModelProfileId } : {}),
        minimumSampleCount: policy.minimumSampleCount,
      });
      const receiptIds = scored.receiptIds;
      const recommendationChecksum = digest({
        roleKey: input.roleKey,
        policyVersionId: policy.policyVersionId,
        primaryModelProfileId: scored.primary?.modelProfileId,
        fallbackModelProfileIds: scored.fallbacks.map((candidate) => candidate.modelProfileId),
        excluded: scored.excluded,
        receiptIds,
      });
      const [created] = await tx.query<[RecommendationRecord[]]>(
        "CREATE optimization_recommendation CONTENT { recommendation_id: $recommendation_id, organization_id: $organization_id, role_key: $role_key, policy_version_id: $policy_version_id, primary_model_profile_id: $primary_model_profile_id, fallback_model_profile_ids: $fallback_model_profile_ids, excluded_json: $excluded_json, receipt_ids: $receipt_ids, status: $status, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() } RETURN AFTER;",
        {
          recommendation_id: randomUUID(),
          organization_id: context.organizationId,
          role_key: input.roleKey,
          policy_version_id: policy.policyVersionId,
          primary_model_profile_id: scored.primary?.modelProfileId,
          fallback_model_profile_ids: scored.fallbacks.map((candidate) => candidate.modelProfileId),
          excluded_json: JSON.stringify(scored.excluded),
          receipt_ids: receiptIds,
          status: policy.autoOptimize && scored.primary ? "approved" : "pending-approval",
          checksum: recommendationChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("모델 추천 생성 결과가 없습니다");
      return recommendationView(created[0]);
    });
  }

  public async listReceipts(
    context: TenantContext,
    roleKey?: OptimizationRoleKey,
  ): Promise<readonly StoredEvaluationReceipt[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ReceiptRecord[]]>(
      roleKey
        ? "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY created_at DESC;"
        : "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id ORDER BY created_at DESC;",
      { organization_id: context.organizationId, role_key: roleKey },
    );
    return records.map(receiptView);
  }

  public async selectTaskAxisModels(
    context: TenantContext,
    input: SelectTaskAxisModelsInput,
  ): Promise<TaskAxisModelSelection | undefined> {
    await this.organizations.verifyTenantContext(context);
    assertRole(input.roleKey);
    assertText(input.recommendationId, "추천 식별자");
    assertTaskAxis(input.taskAxis);
    assertReasoningDifficulty(input.reasoningDifficulty);
    if (!input.modelProfileIds.length || new Set(input.modelProfileIds).size !== input.modelProfileIds.length)
      return undefined;
    for (const modelProfileId of input.modelProfileIds) assertText(modelProfileId, "model profile 식별자");
    if (!this.options.modelCatalog) return undefined;
    const candidates = await this.options.modelCatalog(context);
    const profiles = input.modelProfileIds.map((modelProfileId) =>
      candidates.find((candidate) => candidate.modelProfileId === modelProfileId),
    );
    if (profiles.some((profile) => !profile?.verified)) return undefined;
    const profilesById = new Map(
      profiles
        .filter((profile): profile is OptimizationModelProfile => profile !== undefined)
        .map((profile) => [profile.modelProfileId, profile]),
    );
    const [recommendations] = await this.database.query<[RecommendationRecord[]]>(
      "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id LIMIT 1;",
      { organization_id: context.organizationId, recommendation_id: input.recommendationId },
    );
    const recommendation = recommendations[0];
    const recommendationModelProfileIds = [
      recommendation?.primary_model_profile_id,
      ...(recommendation?.fallback_model_profile_ids ?? []),
    ].filter((modelProfileId): modelProfileId is string => modelProfileId !== undefined);
    const requestedModelProfileIds = new Set(input.modelProfileIds);
    if (
      !recommendation ||
      recommendation.role_key !== input.roleKey ||
      recommendation.status !== "approved" ||
      recommendation.receipt_ids.length !== input.modelProfileIds.length ||
      new Set(recommendation.receipt_ids).size !== recommendation.receipt_ids.length ||
      recommendationModelProfileIds.length !== input.modelProfileIds.length ||
      new Set(recommendationModelProfileIds).size !== recommendationModelProfileIds.length ||
      recommendationModelProfileIds.some((modelProfileId) => !requestedModelProfileIds.has(modelProfileId))
    ) {
      return undefined;
    }
    const [policies] = await this.database.query<[PolicyRecord[]]>(
      "SELECT * OMIT id FROM optimization_policy_version WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id LIMIT 1;",
      { organization_id: context.organizationId, policy_version_id: recommendation.policy_version_id },
    );
    const policy = policies[0];
    if (!policy || policy.policy === "manual") return undefined;
    const [receipts] = await this.database.query<[ReceiptRecord[]]>(
      "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id AND receipt_id IN $receipt_ids;",
      { organization_id: context.organizationId, receipt_ids: recommendation.receipt_ids },
    );
    const receiptsById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
    if (
      receipts.length !== recommendation.receipt_ids.length ||
      receiptsById.size !== recommendation.receipt_ids.length ||
      recommendation.receipt_ids.some((receiptId) => !receiptsById.has(receiptId))
    ) {
      return undefined;
    }
    const [scores] = await this.database.query<[AxisScoreRecord[]]>(
      "SELECT * OMIT id FROM optimization_receipt_axis_score WHERE organization_id = $organization_id AND receipt_id IN $receipt_ids AND role_key = $role_key AND task_axis = $task_axis AND reasoning_difficulty = $reasoning_difficulty;",
      {
        organization_id: context.organizationId,
        receipt_ids: recommendation.receipt_ids,
        role_key: input.roleKey,
        task_axis: input.taskAxis,
        reasoning_difficulty: input.reasoningDifficulty,
      },
    );
    const recommendationReceiptIds = new Set(recommendation.receipt_ids);
    const scoreReceiptIds = new Set(scores.map((score) => score.receipt_id));
    const scoreModelProfileIds = new Set(scores.map((score) => score.model_profile_id));
    if (
      scores.length !== input.modelProfileIds.length ||
      scoreReceiptIds.size !== scores.length ||
      scoreModelProfileIds.size !== scores.length ||
      scoreReceiptIds.size !== recommendationReceiptIds.size ||
      [...scoreReceiptIds].some((receiptId) => !recommendationReceiptIds.has(receiptId))
    ) {
      return undefined;
    }
    const byProfile = new Map(scores.map((score) => [score.model_profile_id, score]));
    const orderedScores = input.modelProfileIds.map((modelProfileId) => byProfile.get(modelProfileId));
    if (orderedScores.some((score) => score === undefined)) return undefined;
    const selectedScores = orderedScores as AxisScoreRecord[];
    const first = selectedScores[0];
    if (
      !first ||
      selectedScores.some((score) => {
        const receipt = receiptsById.get(score.receipt_id);
        return (
          !receipt ||
          receipt.run_id !== score.run_id ||
          receipt.role_key !== score.role_key ||
          receipt.model_profile_id !== score.model_profile_id ||
          receipt.bundle_id !== score.bundle_id ||
          receipt.bundle_version !== score.bundle_version ||
          score.bundle_id !== first.bundle_id ||
          score.bundle_version !== first.bundle_version ||
          !score.completed ||
          !score.privacy_allowed ||
          score.sample_count < policy.minimum_sample_count
        );
      })
    ) {
      return undefined;
    }
    const rankedCandidates: Array<{
      readonly candidate: OptimizationModelProfile;
      readonly receipt: EvaluationReceipt;
    }> = [];
    for (const score of selectedScores) {
      const candidate = profilesById.get(score.model_profile_id);
      if (!candidate) return undefined;
      rankedCandidates.push({
        candidate,
        receipt: {
          receiptId: score.receipt_id,
          roleKey: score.role_key,
          modelProfileId: score.model_profile_id,
          bundleId: score.bundle_id,
          bundleVersion: score.bundle_version,
          sampleCount: score.sample_count,
          qualityScore: score.quality_score,
          latencyMs: score.latency_ms,
          costMicros: score.cost_micros,
          privacyAllowed: score.privacy_allowed,
          completed: score.completed,
          inputChecksum: score.score_checksum,
          receiptChecksum: score.score_checksum,
        },
      });
    }
    const ranked = rankEvaluationCandidates(policy.policy, rankedCandidates);
    return {
      modelProfileIds: ranked.map((entry) => entry.candidate.modelProfileId),
      receiptIds: ranked.map((entry) => entry.receipt.receiptId),
      bundleId: first.bundle_id,
      bundleVersion: first.bundle_version,
    };
  }

  public async listRecommendations(
    context: TenantContext,
    roleKey?: OptimizationRoleKey,
  ): Promise<readonly ModelRecommendationRecord[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[RecommendationRecord[]]>(
      roleKey
        ? "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY created_at DESC;"
        : "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id ORDER BY created_at DESC;",
      { organization_id: context.organizationId, role_key: roleKey },
    );
    return records.map(recommendationView);
  }

  public async listBundleCases(context: TenantContext, bundleId: string): Promise<readonly EvaluationCase[]> {
    await this.organizations.verifyTenantContext(context);
    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: bundleId },
    );
    const bundle = bundles[0];
    if (!bundle) throw new Error("평가 bundle을 찾을 수 없습니다");
    const [cases] = await this.database.query<
      [
        Array<{
          readonly case_id: string;
          readonly version: number;
          readonly prompt_checksum: string;
          readonly tools_checksum: string;
          readonly environment_checksum: string;
          readonly prompt?: string;
          readonly expected_outcome: string;
          readonly task_axis?: EvaluationTaskAxis;
          readonly reasoning_difficulty?: EvaluationReasoningDifficulty;
        }>,
      ]
    >(
      "SELECT * OMIT id FROM optimization_case WHERE organization_id = $organization_id AND case_id IN $case_ids ORDER BY case_id ASC;",
      { organization_id: context.organizationId, case_ids: bundle.case_ids },
    );
    return cases.map((item) => ({
      caseId: item.case_id,
      roleKey: bundle.role_key,
      version: item.version,
      promptChecksum: item.prompt_checksum,
      toolsChecksum: item.tools_checksum,
      environmentChecksum: item.environment_checksum,
      ...(item.prompt ? { prompt: item.prompt } : {}),
      expectedOutcome: item.expected_outcome,
      ...(item.task_axis === undefined ? {} : { taskAxis: item.task_axis }),
      ...(item.reasoning_difficulty === undefined ? {} : { reasoningDifficulty: item.reasoning_difficulty }),
    }));
  }

  public async exportBundle(context: TenantContext, input: ExportBundleInput): Promise<EvaluationExport> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.bundleId, "bundle 식별자");
    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: input.bundleId },
    );
    const bundle = bundles[0];
    if (!bundle) throw new Error("평가 bundle을 찾을 수 없습니다");
    const cases = await this.listBundleCases(context, bundle.bundle_id);
    return createEvaluationExport({
      license: input.license,
      configurationChecksum: input.configurationChecksum,
      bundle: bundleView(bundle),
      cases,
    });
  }

  public async importBundle(context: TenantContext, input: ImportBundleInput): Promise<EvaluationBundle> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    const imported = validateEvaluationExport(input.exportValue);
    return await this.createBundle(context, {
      commandId: input.commandId,
      roleKey: imported.bundle.roleKey,
      runtimeVersion: imported.bundle.runtimeVersion,
      cases: imported.cases.map((evaluationCase) => ({
        promptChecksum: evaluationCase.promptChecksum,
        toolsChecksum: evaluationCase.toolsChecksum,
        environmentChecksum: evaluationCase.environmentChecksum,
        ...(evaluationCase.prompt === undefined ? {} : { prompt: evaluationCase.prompt }),
        expectedOutcome: evaluationCase.expectedOutcome,
        ...(evaluationCase.taskAxis === undefined ? {} : { taskAxis: evaluationCase.taskAxis }),
        ...(evaluationCase.reasoningDifficulty === undefined
          ? {}
          : { reasoningDifficulty: evaluationCase.reasoningDifficulty }),
      })),
    });
  }

  private async activePolicy(executor: QueryExecutor, organizationId: string): Promise<PolicyRecord | undefined> {
    const [records] = await executor.query<[PolicyRecord[]]>(
      "SELECT * OMIT id FROM optimization_policy_version WHERE organization_id = $organization_id AND status = 'active' ORDER BY version DESC LIMIT 1;",
      { organization_id: organizationId },
    );
    return records[0];
  }

  private assertExecutionResult(result: ModelEvaluationExecutionResult): void {
    if (
      !Number.isFinite(result.qualityScore) ||
      result.qualityScore < 0 ||
      result.qualityScore > 1 ||
      !Number.isFinite(result.latencyMs) ||
      result.latencyMs < 0 ||
      !Number.isFinite(result.costMicros) ||
      result.costMicros < 0 ||
      typeof result.privacyAllowed !== "boolean" ||
      typeof result.completed !== "boolean"
    ) {
      throw new Error("모델 평가 실행 결과가 유효하지 않습니다");
    }
  }

  private axisScores(
    executions: readonly {
      readonly evaluationCase: EvaluationCase;
      readonly result: ModelEvaluationExecutionResult;
    }[],
  ): readonly AxisScoreInput[] {
    if (
      !executions.every(
        (execution) =>
          execution.evaluationCase.taskAxis !== undefined && execution.evaluationCase.reasoningDifficulty !== undefined,
      )
    ) {
      return [];
    }
    const groups = new Map<string, Array<(typeof executions)[number]>>();
    for (const execution of executions) {
      const { taskAxis, reasoningDifficulty } = execution.evaluationCase;
      if (!taskAxis || !reasoningDifficulty) return [];
      const key = `${taskAxis}\0${reasoningDifficulty}`;
      const group = groups.get(key) ?? [];
      group.push(execution);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => {
      const first = group[0];
      if (!first?.evaluationCase.taskAxis || !first.evaluationCase.reasoningDifficulty) {
        throw new Error("평가 작업 축 집계가 유효하지 않습니다");
      }
      const results = group.map((execution) => execution.result);
      return {
        taskAxis: first.evaluationCase.taskAxis,
        reasoningDifficulty: first.evaluationCase.reasoningDifficulty,
        sampleCount: results.length,
        qualityScore: results.reduce((total, result) => total + result.qualityScore, 0) / results.length,
        latencyMs: results.reduce((total, result) => total + result.latencyMs, 0) / results.length,
        costMicros: results.reduce((total, result) => total + result.costMicros, 0),
        privacyAllowed: results.every((result) => result.privacyAllowed),
        completed: results.every((result) => result.completed),
      };
    });
  }

  private async markRunFailed(context: TenantContext, runId: string): Promise<void> {
    await this.database.query(
      "UPDATE optimization_run SET status = 'failed', updated_at = time::now() WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running';",
      { organization_id: context.organizationId, run_id: runId },
    );
  }

  private async command<T extends { readonly request_hash: string }>(
    executor: QueryExecutor,
    organizationId: string,
    table: string,
    commandId: string,
  ): Promise<T | undefined> {
    const allowed = new Set([
      "optimization_bundle",
      "optimization_run",
      "optimization_receipt",
      "optimization_policy_version",
      "optimization_recommendation",
    ]);
    if (!allowed.has(table)) throw new Error("허용되지 않은 최적화 command table입니다");
    const [records] = await executor.query<[T[]]>(
      `SELECT * OMIT id FROM ${table} WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }
}

export { scoreReceipt };
