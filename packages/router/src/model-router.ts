import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import {
  listSubscriptionProviderManifests,
  subscriptionProviderApprovalModes,
  type SubscriptionAccountService,
  type ConnectorLocation,
  type ConnectorExecutionKind,
  type ConnectorTrustOrigin,
  type SubscriptionPolicyStore,
  type SubscriptionQuotaService,
} from "@massion/subscriptions";

import { classifyFailure, type FailureSignal } from "./failure.js";
import {
  ProviderService,
  type CredentialMaterial,
  type ProviderCredential,
  type ProviderEndpoint,
  type RouterAuditEvent,
} from "./provider.js";
import {
  MODEL_VERIFICATION_EVIDENCE_MIGRATION,
  MODEL_PRICING_MIGRATION,
  MODEL_ROUTE_MIGRATION,
  ROUTE_ATTEMPT_SIDE_EFFECT_MIGRATION,
  ROUTE_ATTEMPT_LINEAGE_MIGRATION,
  ROUTE_ATTEMPT_SUBSCRIPTION_POLICY_MIGRATION,
  ROUTER_HEALTH_MIGRATION,
  ROUTER_REGISTRY_MIGRATION,
  ROUTER_SUBSCRIPTION_ENDPOINT_MIGRATION,
  ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION,
  ROUTER_SUBSCRIPTION_REAUTH_MIGRATION,
  ROUTE_ATTEMPT_EXECUTION_LINEAGE_MIGRATION,
  ROUTE_ATTEMPT_OPTIMIZATION_RUN_LINEAGE_MIGRATION,
} from "./schema.js";

export type RouteKind = "chat" | "embedding";
export type CredentialPolicy =
  | "adaptive"
  | "priority"
  | "fill-first"
  | "round-robin"
  | "weighted"
  | "least-used"
  | "quota-headroom"
  | "reset-aware"
  | "sticky";

export interface ModelProfile {
  readonly model_profile_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly endpoint_id: string;
  readonly model_id: string;
  readonly route_kind: RouteKind;
  readonly context_window: number;
  readonly supports_tools: boolean;
  readonly supports_structured_output: boolean;
  readonly supports_vision: boolean;
  readonly supports_streaming: boolean;
  readonly equivalence_group: string;
  readonly eval_score: number;
  readonly input_cost_micros_per_million: number;
  readonly output_cost_micros_per_million: number;
  readonly verified: boolean;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export type ModelVerificationEvidenceKind =
  "runtime-availability" | "provider-capability-contract" | "runtime-capability-contract";

export interface ModelVerificationEvidence {
  readonly evidence_id: string;
  readonly organization_id: string;
  readonly model_profile_id: string;
  readonly model_id: string;
  readonly subscription_account_id?: string;
  readonly evidence_kind: ModelVerificationEvidenceKind;
  readonly source: string;
  readonly source_version: string;
  readonly claim_json: string;
  readonly claim_digest: string;
  readonly observed_at: unknown;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface RegisterModelVerificationEvidenceInput {
  readonly kind: ModelVerificationEvidenceKind;
  readonly source: string;
  readonly sourceVersion: string;
  readonly claim: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly subscriptionAccountId?: string;
}

export interface RecordModelVerificationEvidenceInput {
  readonly commandId: string;
  readonly modelProfileId: string;
  readonly verificationEvidence: readonly RegisterModelVerificationEvidenceInput[];
}

export interface ModelRoute {
  readonly route_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly route_kind: RouteKind;
  readonly credential_policy: CredentialPolicy;
  readonly data_policy: "external-allowed" | "local-private";
  readonly equivalence_group: string;
  readonly min_eval_score: number;
  readonly require_tools: boolean;
  readonly require_structured_output: boolean;
  readonly require_vision: boolean;
  readonly require_streaming: boolean;
  readonly max_context_tokens: number;
  readonly request_budget_micros: number;
  readonly total_budget_micros: number;
  readonly spent_micros: number;
  readonly selection_sequence: number;
  readonly routing_policy_version: number;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface RouteCandidate {
  readonly candidate_id: string;
  readonly organization_id: string;
  readonly route_id: string;
  readonly model_profile_id: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly created_at: unknown;
}

export interface RouteAttempt {
  readonly attempt_id: string;
  readonly organization_id: string;
  readonly route_id: string;
  readonly candidate_id: string;
  readonly model_profile_id: string;
  readonly credential_id: string;
  readonly credential_secret_version: number;
  readonly command_id: string;
  readonly execution_id?: string;
  readonly optimization_run_id?: string;
  readonly optimization_batch_id?: string;
  readonly status: string;
  readonly failure_class?: string;
  readonly status_code?: number;
  readonly emitted_tokens: number;
  readonly side_effects_started: boolean;
  readonly actual_input_tokens: number;
  readonly actual_output_tokens: number;
  readonly actual_cost_micros: number;
  readonly fallback_allowed: boolean;
  readonly retry_at?: unknown;
  readonly selection_sequence: number;
  readonly estimated_tokens: number;
  readonly reserved_cost_micros: number;
  readonly sticky_key_hash?: string;
  readonly fallback_from_attempt_id?: string;
  readonly quota_snapshot_id?: string;
  readonly routing_policy_version?: number;
  readonly effective_credential_policy?: CredentialPolicy;
  readonly subscription_policy_version_id?: string;
  readonly subscription_policy_version?: number;
  readonly explanation_json: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface RouteAttemptListItem {
  readonly attempt_id: string;
  readonly route_id: string;
  /** 계보 정본. 등록이 제거돼도 이 ID는 남으므로 감사는 언제나 가능합니다. */
  readonly model_profile_id: string;
  /** Provider 등록이 제거된 과거 호출에는 없습니다. 이름을 지어내지 않습니다. */
  readonly model_id?: string;
  readonly provider_id?: string;
  readonly execution_id?: string;
  readonly optimization_run_id?: string;
  readonly optimization_batch_id?: string;
  readonly status: "reserved" | "succeeded" | "failed" | "interrupted";
  readonly failure_class?: string;
  readonly status_code?: number;
  readonly actual_input_tokens: number;
  readonly actual_output_tokens: number;
  readonly actual_cost_micros: number;
  readonly fallback_from_attempt_id?: string;
  readonly created_at: unknown;
}

interface RouteAttemptListRow extends Omit<RouteAttemptListItem, "model_id" | "provider_id"> {
  readonly organization_id: string;
  readonly model_profile_id: string;
}

interface OptimizationBatchRoutingRecord {
  readonly batch_id: unknown;
  readonly organization_id: unknown;
  readonly role_key: unknown;
  readonly version: unknown;
  readonly status: unknown;
  readonly primary_model_profile_id?: unknown;
  readonly fallback_model_profile_ids: unknown;
  readonly checksum: unknown;
}

interface OptimizationActivePointerRoutingRecord {
  readonly organization_id: unknown;
  readonly role_key: unknown;
  readonly batch_id: unknown;
  readonly batch_version: unknown;
  readonly checksum: unknown;
}

export interface CredentialSelectionView {
  readonly credential_id: string;
  readonly label: string;
  readonly priority: number;
  readonly weight: number;
  readonly request_count: number;
  readonly cost_micros: number;
  readonly quota_limit?: number;
  readonly quota_remaining?: number;
  readonly quota_reset_at?: unknown;
  readonly last_selected_sequence: number;
  readonly quota_windows?: readonly {
    readonly kind: string;
    readonly remainingRatio?: number;
    readonly resetsAt?: string;
    readonly observedAt: string;
  }[];
  readonly quota_snapshot_id?: string;
}

export interface ModelRouterSubscriptionServices {
  readonly accounts: SubscriptionAccountService;
  readonly quota: SubscriptionQuotaService;
  readonly policies?: Pick<SubscriptionPolicyStore, "resolve">;
}

export interface RegisterModelInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly routeKind: RouteKind;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
  readonly equivalenceGroup: string;
  readonly evalScore: number;
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly verified: boolean;
  readonly verificationEvidence?: readonly RegisterModelVerificationEvidenceInput[];
}

export interface CreateRouteInput {
  readonly commandId: string;
  readonly name: string;
  readonly routeKind: RouteKind;
  readonly credentialPolicy: CredentialPolicy;
  readonly dataPolicy: "external-allowed" | "local-private";
  readonly equivalenceGroup: string;
  readonly minEvalScore: number;
  readonly requireTools: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireVision: boolean;
  readonly requireStreaming: boolean;
  readonly maxContextTokens: number;
  readonly requestBudgetMicros: number;
  readonly totalBudgetMicros: number;
}

export interface AddCandidateInput {
  readonly commandId: string;
  readonly routeId: string;
  readonly modelProfileId: string;
  readonly priority: number;
}

export interface RouteRequest {
  readonly routeName: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly executionId?: string;
  readonly optimizationRunId?: string;
  readonly optimizationBatchId?: string;
  /** 모델 평가실이 활성 배치에서 선택한 선호 model profile 순서입니다. */
  readonly preferredModelProfileIds?: readonly string[];
  readonly stickyKey?: string;
  readonly fallbackFromAttemptId?: string;
  readonly requiredExecutionKind?: ConnectorExecutionKind;
}

export interface ReserveRouteInput extends RouteRequest {
  readonly commandId: string;
}

export interface RouteSimulation {
  readonly status: "selected" | "blocked_model_unavailable";
  readonly route: ModelRoute;
  readonly candidate?: RouteCandidate;
  readonly profile?: ModelProfile;
  readonly endpoint?: ProviderEndpoint;
  readonly credential?: ProviderCredential;
  readonly explanation: {
    readonly selected: string[];
    readonly excluded: string[];
  };
  readonly quotaSnapshotId?: string;
  readonly effectiveCredentialPolicy?: CredentialPolicy;
  readonly subscriptionPolicyVersionId?: string;
  readonly subscriptionPolicyVersion?: number;
  readonly resumeAt?: string;
}

export interface RouteReservation extends RouteSimulation {
  readonly status: "selected";
  readonly attempt: RouteAttempt;
  readonly material: CredentialMaterial;
  readonly secret?: string;
}

export interface RouteDiagnostic {
  readonly routeName: string;
  readonly routeKind: RouteKind;
  readonly dataPolicy: ModelRoute["data_policy"];
  readonly status: "available" | "blocked_model_unavailable";
  readonly reasons: readonly string[];
  readonly recovery?: string;
  readonly resumeAt?: string;
}

export interface RouterDiagnostic {
  readonly status: "available" | "degraded";
  readonly routes: readonly RouteDiagnostic[];
}

export interface ReportFailureInput {
  readonly commandId: string;
  readonly attemptId: string;
  readonly signal: FailureSignal;
  readonly emittedTokens: number;
  readonly sideEffectsStarted: boolean;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly actualCostMicros: number;
}

export interface ReportSuccessInput {
  readonly commandId: string;
  readonly attemptId: string;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly actualCostMicros: number;
}

export interface AttemptOutcome {
  readonly attempt: RouteAttempt;
  readonly next?: RouteSimulation;
}

interface RouterCircuit {
  readonly circuit_id: string;
  readonly scope_id: string;
  readonly state: "closed" | "open";
  readonly failure_count: number;
  readonly open_until?: unknown;
  readonly version: number;
}

type CircuitScope = "credential" | "endpoint" | "model";

const POLICIES = new Set<CredentialPolicy>([
  "adaptive",
  "priority",
  "fill-first",
  "round-robin",
  "weighted",
  "least-used",
  "quota-headroom",
  "reset-aware",
  "sticky",
]);

function serializedMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  const parsed = serialized ? (JSON.parse(serialized) as unknown) : undefined;
  return typeof parsed === "string" || typeof parsed === "number"
    ? new Date(parsed).getTime()
    : Number.POSITIVE_INFINITY;
}

function attemptRowText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error(`Route Attempt 행의 ${label}이(가) 유효하지 않습니다`);
  return value;
}

function attemptRowOptionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : attemptRowText(value, label);
}

function attemptRowCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Route Attempt 행의 ${label}이(가) 유효하지 않습니다`);
  return value as number;
}

function routeAttemptListRow(value: unknown, organizationId: string): RouteAttemptListRow {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Route Attempt 행이 유효하지 않습니다");
  const row = value as Record<string, unknown>;
  const status = row.status;
  if (status !== "reserved" && status !== "succeeded" && status !== "failed" && status !== "interrupted")
    throw new Error("Route Attempt 행의 상태가 유효하지 않습니다");
  if (row.organization_id !== organizationId) throw new Error("Route Attempt 행의 조직 계보가 유효하지 않습니다");
  if (!Number.isFinite(serializedMillis(row.created_at)))
    throw new Error("Route Attempt 행의 생성 시각이 유효하지 않습니다");
  const executionId = attemptRowOptionalText(row.execution_id, "실행 ID");
  const optimizationRunId = attemptRowOptionalText(row.optimization_run_id, "최적화 평가 run ID");
  const optimizationBatchId = attemptRowOptionalText(row.optimization_batch_id, "최적화 배치 ID");
  const failureClass = attemptRowOptionalText(row.failure_class, "실패 분류");
  const fallbackFromAttemptId = attemptRowOptionalText(row.fallback_from_attempt_id, "fallback 원본 ID");
  const statusCode = row.status_code === undefined ? undefined : attemptRowCount(row.status_code, "상태 코드");
  return {
    attempt_id: attemptRowText(row.attempt_id, "시도 ID"),
    organization_id: organizationId,
    route_id: attemptRowText(row.route_id, "경로 ID"),
    model_profile_id: attemptRowText(row.model_profile_id, "모델 프로필 ID"),
    ...(executionId === undefined ? {} : { execution_id: executionId }),
    ...(optimizationRunId === undefined ? {} : { optimization_run_id: optimizationRunId }),
    ...(optimizationBatchId === undefined ? {} : { optimization_batch_id: optimizationBatchId }),
    status,
    ...(failureClass === undefined ? {} : { failure_class: failureClass }),
    ...(statusCode === undefined ? {} : { status_code: statusCode }),
    actual_input_tokens: attemptRowCount(row.actual_input_tokens, "입력 토큰"),
    actual_output_tokens: attemptRowCount(row.actual_output_tokens, "출력 토큰"),
    actual_cost_micros: attemptRowCount(row.actual_cost_micros, "비용"),
    ...(fallbackFromAttemptId === undefined ? {} : { fallback_from_attempt_id: fallbackFromAttemptId }),
    created_at: row.created_at,
  };
}

function isSubscriptionCredential(credential: ProviderCredential): boolean {
  return (
    credential.material_kind === "connector_session" ||
    credential.subscription_account_id !== undefined ||
    credential.subscription_connector_id !== undefined ||
    credential.subscription_scope !== undefined
  );
}

export function selectCredential(
  policy: CredentialPolicy,
  credentials: readonly CredentialSelectionView[],
  stickyKey?: string,
  now = new Date(),
): CredentialSelectionView | undefined {
  if (credentials.length === 0) return undefined;
  const ordered = [...credentials].sort((left, right) => left.credential_id.localeCompare(right.credential_id));
  const by = (compare: (left: CredentialSelectionView, right: CredentialSelectionView) => number) =>
    [...ordered].sort(compare)[0];
  if (policy === "adaptive") {
    const freshWindows = (credential: CredentialSelectionView) =>
      (credential.quota_windows ?? []).filter((window) => {
        const observedAt = new Date(window.observedAt).getTime();
        return Number.isFinite(observedAt) && Math.abs(now.getTime() - observedAt) <= 5 * 60 * 1_000;
      });
    const activelyExhausted = (window: NonNullable<CredentialSelectionView["quota_windows"]>[number]) => {
      if (window.remainingRatio !== 0) return false;
      if (window.resetsAt === undefined) return true;
      const resetsAt = new Date(window.resetsAt).getTime();
      return !Number.isFinite(resetsAt) || resetsAt > now.getTime();
    };
    const eligible = ordered.filter(
      (credential) => !freshWindows(credential).some((window) => activelyExhausted(window)),
    );
    if (eligible.length === 0) return undefined;
    const score = (credential: CredentialSelectionView) => {
      const windows = freshWindows(credential);
      if (windows.length === 0) return -1;
      return Math.max(
        ...windows.map((window) => {
          const ratio = window.remainingRatio ?? 0;
          const resetMillis = window.resetsAt === undefined ? Number.NaN : new Date(window.resetsAt).getTime();
          if (!Number.isFinite(resetMillis) || resetMillis <= now.getTime()) return 0;
          return ratio / Math.max(60, (resetMillis - now.getTime()) / 1_000);
        }),
      );
    };
    return [...eligible].sort(
      (left, right) =>
        score(right) - score(left) ||
        left.request_count / left.weight - right.request_count / right.weight ||
        left.last_selected_sequence - right.last_selected_sequence ||
        left.credential_id.localeCompare(right.credential_id),
    )[0];
  }
  if (policy === "fill-first")
    return by((left, right) => left.priority - right.priority || left.credential_id.localeCompare(right.credential_id));
  if (policy === "priority")
    return by(
      (left, right) =>
        left.priority - right.priority ||
        left.last_selected_sequence - right.last_selected_sequence ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "round-robin")
    return by(
      (left, right) =>
        left.last_selected_sequence - right.last_selected_sequence ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "weighted")
    return by(
      (left, right) =>
        left.request_count / left.weight - right.request_count / right.weight ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "least-used")
    return by(
      (left, right) =>
        left.request_count - right.request_count ||
        left.cost_micros - right.cost_micros ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "quota-headroom") {
    const headroom = (credential: CredentialSelectionView) =>
      credential.quota_limit && credential.quota_remaining !== undefined
        ? credential.quota_remaining / credential.quota_limit
        : 1;
    return by(
      (left, right) => headroom(right) - headroom(left) || left.credential_id.localeCompare(right.credential_id),
    );
  }
  if (policy === "reset-aware")
    return by(
      (left, right) =>
        serializedMillis(left.quota_reset_at) - serializedMillis(right.quota_reset_at) ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (!stickyKey) throw new Error("sticky policy에는 stickyKey가 필요합니다");
  const totalWeight = ordered.reduce((sum, credential) => sum + credential.weight, 0);
  const digest = createHash("sha256").update(stickyKey).digest();
  let bucket = digest.readUInt32BE(0) % totalWeight;
  for (const credential of ordered) {
    if (bucket < credential.weight) return credential;
    bucket -= credential.weight;
  }
  return ordered.at(-1);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface NormalizedModelVerificationEvidence {
  readonly kind: ModelVerificationEvidenceKind;
  readonly source: string;
  readonly sourceVersion: string;
  readonly claimJson: string;
  readonly claimDigest: string;
  readonly observedAt: Date;
  readonly subscriptionAccountId?: string;
}

const CODEX_VERIFICATION_EVIDENCE_KINDS = new Set<ModelVerificationEvidenceKind>([
  "runtime-availability",
  "provider-capability-contract",
  "runtime-capability-contract",
]);

function safeEvidenceValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("Model verification evidence claim 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Model verification evidence 숫자가 유효하지 않습니다");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4_096 || /[\0\r]/u.test(value)) {
      throw new Error("Model verification evidence 문자열이 유효하지 않습니다");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("Model verification evidence 배열 상한을 초과했습니다");
    for (const child of value) safeEvidenceValue(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Model verification evidence claim 값이 유효하지 않습니다");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 128) throw new Error("Model verification evidence 필드 상한을 초과했습니다");
  for (const [key, child] of entries) {
    if (!key || key.length > 128 || /[\0\r\n]/u.test(key)) {
      throw new Error("Model verification evidence 필드 이름이 유효하지 않습니다");
    }
    safeEvidenceValue(child, depth + 1);
  }
}

function requireEvidenceText(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}이(가) 유효하지 않습니다`);
  }
  return normalized;
}

function normalizedEvidence(input: RegisterModelInput): readonly NormalizedModelVerificationEvidence[] {
  const raw = input.verificationEvidence ?? [];
  if (!input.verified && raw.length > 0) {
    throw new Error("검증되지 않은 Model Profile에는 verification evidence를 연결할 수 없습니다");
  }
  if (input.providerId === "openai-codex" && input.verified) {
    const kinds = new Set(raw.map((evidence) => evidence.kind));
    if (
      raw.length !== CODEX_VERIFICATION_EVIDENCE_KINDS.size ||
      kinds.size !== CODEX_VERIFICATION_EVIDENCE_KINDS.size ||
      [...CODEX_VERIFICATION_EVIDENCE_KINDS].some((kind) => !kinds.has(kind))
    ) {
      throw new Error("Codex 검증 Model Profile에는 독립된 availability·provider·runtime 근거가 필요합니다");
    }
  }
  const normalized = raw.map((evidence) => {
    if (!CODEX_VERIFICATION_EVIDENCE_KINDS.has(evidence.kind)) {
      throw new Error("Model verification evidence 종류가 유효하지 않습니다");
    }
    const source = requireEvidenceText(evidence.source, "Model verification evidence 출처", 2_048);
    const sourceVersion = requireEvidenceText(evidence.sourceVersion, "Model verification evidence 출처 버전", 256);
    const subscriptionAccountId =
      evidence.subscriptionAccountId === undefined
        ? undefined
        : requireEvidenceText(evidence.subscriptionAccountId, "Model verification evidence 구독 계정", 256);
    const observedAt = new Date(evidence.observedAt);
    if (!Number.isFinite(observedAt.getTime())) {
      throw new Error("Model verification evidence 관측 시각이 유효하지 않습니다");
    }
    safeEvidenceValue(evidence.claim);
    const claimJson = canonicalJson(evidence.claim);
    if (Buffer.byteLength(claimJson, "utf8") > 65_536) {
      throw new Error("Model verification evidence claim 크기 상한을 초과했습니다");
    }
    return {
      kind: evidence.kind,
      source,
      sourceVersion,
      claimJson,
      claimDigest: createHash("sha256").update(claimJson).digest("hex"),
      observedAt,
      ...(subscriptionAccountId === undefined ? {} : { subscriptionAccountId }),
    };
  });
  if (new Set(normalized.map((evidence) => evidence.source)).size !== normalized.length) {
    throw new Error("Model verification evidence는 서로 독립된 출처여야 합니다");
  }
  if (input.providerId === "openai-codex" && input.verified) {
    const byKind = new Map(normalized.map((evidence) => [evidence.kind, evidence]));
    const availability = byKind.get("runtime-availability");
    const provider = byKind.get("provider-capability-contract");
    const runtime = byKind.get("runtime-capability-contract");
    const availabilityClaim = JSON.parse(availability?.claimJson ?? "null") as Record<string, unknown> | null;
    const providerClaim = JSON.parse(provider?.claimJson ?? "null") as Record<string, unknown> | null;
    const runtimeClaim = JSON.parse(runtime?.claimJson ?? "null") as Record<string, unknown> | null;
    if (
      availability?.source !== "codex-app-server:model/list" ||
      availabilityClaim?.modelId !== input.modelId ||
      availabilityClaim.actualAvailable !== true ||
      !provider?.source.startsWith("https://developers.openai.com/api/docs/") ||
      typeof providerClaim?.contextWindow !== "number" ||
      providerClaim.contextWindow < input.contextWindow ||
      (input.supportsTools && providerClaim.tools !== true) ||
      (input.supportsStructuredOutput && providerClaim.structuredOutput !== true) ||
      (input.supportsVision && providerClaim.vision !== true) ||
      (input.supportsStreaming && providerClaim.streaming !== true) ||
      runtime?.source !== "massion:bundled-codex-runtime-attestation" ||
      runtimeClaim?.agentRuntime !== true ||
      typeof runtimeClaim.runtimeArtifactDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(runtimeClaim.runtimeArtifactDigest) ||
      runtimeClaim.contextWindow !== input.contextWindow ||
      runtimeClaim.tools !== input.supportsTools ||
      runtimeClaim.structuredOutput !== input.supportsStructuredOutput ||
      runtimeClaim.vision !== input.supportsVision ||
      runtimeClaim.streaming !== input.supportsStreaming
    ) {
      throw new Error("Codex Model verification evidence claim이 profile 계약과 일치하지 않습니다");
    }
    if (
      !availability.subscriptionAccountId ||
      runtime.subscriptionAccountId !== availability.subscriptionAccountId ||
      provider.subscriptionAccountId !== undefined
    ) {
      throw new Error("Codex Model verification evidence의 구독 계정 계보가 일치하지 않습니다");
    }
  }
  return normalized;
}

export class ModelRouter {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly providers: ProviderService,
    private readonly subscriptions?: ModelRouterSubscriptionServices,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    providers: ProviderService,
    subscriptions?: ModelRouterSubscriptionServices,
  ): Promise<ModelRouter> {
    await applyMigrations(database, [
      ROUTER_REGISTRY_MIGRATION,
      MODEL_ROUTE_MIGRATION,
      ROUTER_HEALTH_MIGRATION,
      MODEL_PRICING_MIGRATION,
      ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION,
      ROUTER_SUBSCRIPTION_ENDPOINT_MIGRATION,
      ROUTE_ATTEMPT_LINEAGE_MIGRATION,
      ROUTE_ATTEMPT_SUBSCRIPTION_POLICY_MIGRATION,
      ROUTE_ATTEMPT_SIDE_EFFECT_MIGRATION,
      ROUTER_SUBSCRIPTION_REAUTH_MIGRATION,
      MODEL_VERIFICATION_EVIDENCE_MIGRATION,
      ROUTE_ATTEMPT_EXECUTION_LINEAGE_MIGRATION,
      ROUTE_ATTEMPT_OPTIMIZATION_RUN_LINEAGE_MIGRATION,
    ]);
    return new ModelRouter(database, organizations, providers, subscriptions);
  }

  public async registerModel(
    context: TenantContext,
    input: RegisterModelInput,
    executor: QueryExecutor = this.database,
  ): Promise<{
    profile: ModelProfile;
    evidence: readonly ModelVerificationEvidence[];
    audit: RouterAuditEvent;
  }> {
    if (
      input.contextWindow < 1 ||
      input.evalScore < 0 ||
      input.evalScore > 1 ||
      input.inputCostMicrosPerMillion < 0 ||
      input.outputCostMicrosPerMillion < 0
    )
      throw new Error("Model Profile 수치가 유효하지 않습니다");
    const evidence = normalizedEvidence(input);
    return await this.command(
      context,
      input.commandId,
      "model_profile_registered",
      canonicalJson(input),
      async (tx) => {
        const endpoint = await this.endpoint(tx, context.organizationId, input.endpointId);
        if (endpoint.provider_id !== input.providerId)
          throw new Error("Model Profile의 Provider와 Endpoint가 다릅니다");
        const [profiles] = await tx.query<[ModelProfile[]]>(
          "CREATE model_profile CONTENT { model_profile_id: $profile_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, model_id: $model_id, route_kind: $route_kind, context_window: $context_window, supports_tools: $supports_tools, supports_structured_output: $supports_structured, supports_vision: $supports_vision, supports_streaming: $supports_streaming, equivalence_group: $equivalence_group, eval_score: $eval_score, input_cost_micros_per_million: $input_cost, output_cost_micros_per_million: $output_cost, verified: $verified, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            profile_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            model_id: input.modelId,
            route_kind: input.routeKind,
            context_window: input.contextWindow,
            supports_tools: input.supportsTools,
            supports_structured: input.supportsStructuredOutput,
            supports_vision: input.supportsVision,
            supports_streaming: input.supportsStreaming,
            equivalence_group: input.equivalenceGroup,
            eval_score: input.evalScore,
            input_cost: input.inputCostMicrosPerMillion,
            output_cost: input.outputCostMicrosPerMillion,
            verified: input.verified,
          },
        );
        const profile = profiles[0];
        if (!profile) throw new Error("Model Profile 생성 결과가 없습니다");
        const recorded = await this.createModelEvidence(tx, context, profile, evidence);
        return { profile, evidence: recorded };
      },
      { executor },
    );
  }

  public async listModelEvidence(
    context: TenantContext,
    modelProfileId: string,
    executor: QueryExecutor = this.database,
  ): Promise<readonly ModelVerificationEvidence[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const profileId = modelProfileId.trim();
    if (!profileId || profileId.length > 256) throw new Error("Model Profile ID가 유효하지 않습니다");
    await this.profile(executor, context.organizationId, profileId);
    const [evidence] = await executor.query<[ModelVerificationEvidence[]]>(
      `SELECT * OMIT id FROM model_verification_evidence
       WHERE organization_id = $organization_id AND model_profile_id = $model_profile_id
       ORDER BY evidence_kind ASC, observed_at ASC, evidence_id ASC;`,
      { organization_id: context.organizationId, model_profile_id: profileId },
    );
    return evidence;
  }

  public async recordModelEvidence(
    context: TenantContext,
    input: RecordModelVerificationEvidenceInput,
  ): Promise<{ evidence: readonly ModelVerificationEvidence[]; audit: RouterAuditEvent }> {
    return await this.command(
      context,
      input.commandId,
      "model_verification_evidence_recorded",
      canonicalJson(input),
      async (tx) => {
        const profile = await this.profile(tx, context.organizationId, input.modelProfileId);
        if (!profile.verified || !profile.enabled) {
          throw new Error("검증된 활성 Model Profile에만 추가 evidence를 기록할 수 있습니다");
        }
        const evidence = normalizedEvidence({
          commandId: input.commandId,
          providerId: profile.provider_id,
          endpointId: profile.endpoint_id,
          modelId: profile.model_id,
          routeKind: profile.route_kind,
          contextWindow: profile.context_window,
          supportsTools: profile.supports_tools,
          supportsStructuredOutput: profile.supports_structured_output,
          supportsVision: profile.supports_vision,
          supportsStreaming: profile.supports_streaming,
          equivalenceGroup: profile.equivalence_group,
          evalScore: profile.eval_score,
          inputCostMicrosPerMillion: profile.input_cost_micros_per_million,
          outputCostMicrosPerMillion: profile.output_cost_micros_per_million,
          verified: true,
          verificationEvidence: input.verificationEvidence,
        });
        return { evidence: await this.createModelEvidence(tx, context, profile, evidence) };
      },
    );
  }

  public async createRoute(
    context: TenantContext,
    input: CreateRouteInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ route: ModelRoute; audit: RouterAuditEvent }> {
    if (!POLICIES.has(input.credentialPolicy)) throw new Error("지원하지 않는 Credential policy입니다");
    if (input.maxContextTokens < 1 || input.requestBudgetMicros < 0 || input.totalBudgetMicros < 0)
      throw new Error("Route budget 또는 context가 유효하지 않습니다");
    return await this.command(
      context,
      input.commandId,
      "model_route_created",
      canonicalJson(input),
      async (tx) => {
        const [routes] = await tx.query<[ModelRoute[]]>(
          "CREATE model_route CONTENT { route_id: $route_id, organization_id: $organization_id, name: $name, route_kind: $route_kind, credential_policy: $credential_policy, data_policy: $data_policy, equivalence_group: $equivalence_group, min_eval_score: $min_eval_score, require_tools: $require_tools, require_structured_output: $require_structured, require_vision: $require_vision, require_streaming: $require_streaming, max_context_tokens: $max_context_tokens, request_budget_micros: $request_budget, total_budget_micros: $total_budget, spent_micros: 0, selection_sequence: 0, routing_policy_version: 1, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            route_id: randomUUID(),
            organization_id: context.organizationId,
            name: input.name,
            route_kind: input.routeKind,
            credential_policy: input.credentialPolicy,
            data_policy: input.dataPolicy,
            equivalence_group: input.equivalenceGroup,
            min_eval_score: input.minEvalScore,
            require_tools: input.requireTools,
            require_structured: input.requireStructuredOutput,
            require_vision: input.requireVision,
            require_streaming: input.requireStreaming,
            max_context_tokens: input.maxContextTokens,
            request_budget: input.requestBudgetMicros,
            total_budget: input.totalBudgetMicros,
          },
        );
        if (!routes[0]) throw new Error("Model Route 생성 결과가 없습니다");
        return { route: routes[0] };
      },
      { executor },
    );
  }

  public async listModels(
    context: TenantContext,
    executor: QueryExecutor = this.database,
  ): Promise<readonly ModelProfile[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [profiles] = await executor.query<[ModelProfile[]]>(
      "SELECT * OMIT id FROM model_profile WHERE organization_id = $organization_id ORDER BY provider_id ASC, model_id ASC, model_profile_id ASC;",
      { organization_id: context.organizationId },
    );
    return profiles;
  }

  public async listRoutes(
    context: TenantContext,
    executor: QueryExecutor = this.database,
  ): Promise<readonly ModelRoute[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [routes] = await executor.query<[ModelRoute[]]>(
      "SELECT * OMIT id FROM model_route WHERE organization_id = $organization_id ORDER BY name ASC, route_id ASC;",
      { organization_id: context.organizationId },
    );
    return routes;
  }

  public async resolveSubscriptionModelEndpoint(
    context: TenantContext,
    accountId: string,
    providerId: string,
  ): Promise<string> {
    await this.organizations.verifyTenantContext(context);
    if (!this.subscriptions) throw new Error("구독 Model endpoint 조회 서비스가 구성되지 않았습니다");
    const account = (await this.subscriptions.accounts.requireRoutingAccess(context, accountId, this.database)).account;
    if (account.provider_id !== providerId) throw new Error("구독 계정 Provider 계보가 일치하지 않습니다");
    const [credentials] = await this.database.query<[Array<{ readonly endpoint_id: string }>]>(
      `SELECT endpoint_id FROM provider_credential
       WHERE organization_id = $organization_id AND provider_id = $provider_id
         AND subscription_account_id = $account_id AND subscription_connector_id = $connector_id
         AND material_kind = 'connector_session' AND status = 'active';`,
      {
        organization_id: context.organizationId,
        provider_id: providerId,
        account_id: account.account_id,
        connector_id: account.connector_id,
      },
    );
    if (credentials.length !== 1 || !credentials[0]?.endpoint_id) {
      throw new Error("구독 계정의 Model endpoint 계보가 하나로 확정되지 않았습니다");
    }
    return credentials[0].endpoint_id;
  }

  public async readAttempt(context: TenantContext, attemptId: string): Promise<RouteAttempt> {
    await this.organizations.verifyTenantContext(context);
    const normalizedAttemptId = attemptId.trim();
    if (!normalizedAttemptId || normalizedAttemptId.length > 256)
      throw new Error("Route Attempt ID가 유효하지 않습니다");
    const attempt = await this.attempt(this.database, context.organizationId, normalizedAttemptId);
    await this.requireAttemptActor(this.database, context, attempt);
    return attempt;
  }

  public async readReservedAttemptByExecution(
    context: TenantContext,
    executionId: string,
  ): Promise<RouteAttempt | undefined> {
    await this.organizations.verifyTenantContext(context);
    const normalizedExecutionId = executionId.trim();
    if (!normalizedExecutionId || normalizedExecutionId.length > 256 || /[\0\r\n]/u.test(normalizedExecutionId)) {
      throw new Error("실행 ID가 유효하지 않습니다");
    }
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [records] = await tx.query<[Array<{ readonly attempt_id: unknown; readonly selection_sequence: unknown }>]>(
        `SELECT attempt_id, selection_sequence FROM route_attempt
         WHERE organization_id = $organization_id AND execution_id = $execution_id AND status = 'reserved'
         ORDER BY selection_sequence DESC, attempt_id ASC LIMIT 2;`,
        { organization_id: context.organizationId, execution_id: normalizedExecutionId },
      );
      if (records.length > 1) throw new Error("실행에 reserved Route Attempt가 둘 이상입니다");
      const record = records[0];
      if (!record) return undefined;
      const attempt = await this.attempt(tx, context.organizationId, attemptRowText(record.attempt_id, "시도 ID"));
      if (
        attempt.organization_id !== context.organizationId ||
        attempt.execution_id !== normalizedExecutionId ||
        attempt.status !== "reserved"
      ) {
        throw new Error("reserved Route Attempt 실행 계보가 일치하지 않습니다");
      }
      await this.requireAttemptActor(tx, context, attempt);
      const [candidates] = await tx.query<[RouteCandidate[]]>(
        `SELECT * OMIT id FROM model_route_candidate
         WHERE organization_id = $organization_id AND candidate_id = $candidate_id LIMIT 2;`,
        { organization_id: context.organizationId, candidate_id: attempt.candidate_id },
      );
      const candidate = candidates[0];
      if (
        candidates.length !== 1 ||
        !candidate ||
        candidate.organization_id !== context.organizationId ||
        candidate.route_id !== attempt.route_id ||
        candidate.model_profile_id !== attempt.model_profile_id
      ) {
        throw new Error("reserved Route Attempt의 Candidate 계보가 일치하지 않습니다");
      }
      await this.profile(tx, context.organizationId, attempt.model_profile_id);
      return attempt;
    });
  }

  public async listAttempts(context: TenantContext, limit = 50): Promise<readonly RouteAttemptListItem[]> {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Route Attempt 조회 개수가 유효하지 않습니다");
    const [records] = await this.database.query<[unknown[]]>(
      `SELECT attempt_id, organization_id, route_id, model_profile_id, execution_id, optimization_run_id,
              optimization_batch_id,
              status, failure_class, status_code, actual_input_tokens, actual_output_tokens, actual_cost_micros,
              fallback_from_attempt_id, created_at
       FROM route_attempt WHERE organization_id = $organization_id
       ORDER BY created_at DESC, attempt_id DESC LIMIT $limit;`,
      { organization_id: context.organizationId, limit },
    );
    if (records.length === 0) return [];
    const profiles = new Map((await this.listModels(context)).map((profile) => [profile.model_profile_id, profile]));
    return records.map((value) => {
      const row = routeAttemptListRow(value, context.organizationId);
      const profile = profiles.get(row.model_profile_id);
      if (profile && profile.organization_id !== context.organizationId)
        throw new Error("Route Attempt 행의 모델 계보가 유효하지 않습니다");
      // profile이 없는 행은 다른 조직의 것이 아니라 등록이 제거된 과거 호출입니다.
      // 여기서 던지면 한 행 때문에 목록 전체가 죽어 예산 표면이 통째로 오류가 됩니다.
      // 행은 남기되 모델 이름을 지어내지 않습니다 — 화면이 등록이 없어졌다고 말합니다.
      return {
        attempt_id: row.attempt_id,
        route_id: row.route_id,
        model_profile_id: row.model_profile_id,
        ...(profile
          ? {
              model_id: attemptRowText(profile.model_id, "모델 ID"),
              provider_id: attemptRowText(profile.provider_id, "Provider ID"),
            }
          : {}),
        ...(row.execution_id === undefined ? {} : { execution_id: row.execution_id }),
        ...(row.optimization_run_id === undefined ? {} : { optimization_run_id: row.optimization_run_id }),
        ...(row.optimization_batch_id === undefined ? {} : { optimization_batch_id: row.optimization_batch_id }),
        status: row.status,
        ...(row.failure_class === undefined ? {} : { failure_class: row.failure_class }),
        ...(row.status_code === undefined ? {} : { status_code: row.status_code }),
        actual_input_tokens: row.actual_input_tokens,
        actual_output_tokens: row.actual_output_tokens,
        actual_cost_micros: row.actual_cost_micros,
        ...(row.fallback_from_attempt_id === undefined
          ? {}
          : { fallback_from_attempt_id: row.fallback_from_attempt_id }),
        created_at: row.created_at,
      };
    });
  }

  /**
   * 이미 있는 경로의 예산 한도를 바꿉니다.
   *
   * `createRoute`가 아니라 이 명령이 필요한 이유: `createRoute`는 이름과 달리 **새 route_id를 만들고
   * `spent_micros`를 0으로 리셋**합니다. 그것을 화면의 「한도 설정」에 연결하면 경로가 중복 생성되고
   * 누적 지출이 사라져, 한도를 못 거는 것보다 나쁜 상태가 됩니다.
   *
   * 지출과 후보는 건드리지 않습니다. 한도만 바꾸는 것이 사람이 기대하는 것이고, 라우터는 예약
   * 시점에 `spent_micros + estimated > total_budget_micros`로 이미 차단합니다.
   */
  public async setRouteBudget(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly routeId: string;
      readonly requestBudgetMicros: number;
      readonly totalBudgetMicros: number;
    },
    executor: QueryExecutor = this.database,
  ): Promise<{ route: ModelRoute; audit: RouterAuditEvent }> {
    if (
      !Number.isFinite(input.requestBudgetMicros) ||
      !Number.isFinite(input.totalBudgetMicros) ||
      input.requestBudgetMicros < 0 ||
      input.totalBudgetMicros < 0
    ) {
      throw new Error("Route budget이 유효하지 않습니다");
    }
    return await this.command(
      context,
      input.commandId,
      "model_route_budget_set",
      canonicalJson(input),
      async (tx) => {
        const route = await this.routeById(tx, context.organizationId, input.routeId);
        const [routes] = await tx.query<[ModelRoute[]]>(
          "UPDATE model_route SET request_budget_micros = $request_budget, total_budget_micros = $total_budget, updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            route_id: route.route_id,
            request_budget: input.requestBudgetMicros,
            total_budget: input.totalBudgetMicros,
          },
        );
        const updated = routes[0];
        if (!updated) throw new Error("Model Route 예산 변경 결과가 없습니다");
        return { route: updated };
      },
      { executor },
    );
  }

  public async addCandidate(
    context: TenantContext,
    input: AddCandidateInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ candidate: RouteCandidate; audit: RouterAuditEvent }> {
    return await this.command(
      context,
      input.commandId,
      "route_candidate_added",
      canonicalJson(input),
      async (tx) => {
        const route = await this.routeById(tx, context.organizationId, input.routeId);
        const profile = await this.profile(tx, context.organizationId, input.modelProfileId);
        const endpoint = await this.endpoint(tx, context.organizationId, profile.endpoint_id);
        const failures = this.profileFailures(route, profile, endpoint);
        if (failures.length > 0)
          throw new Error(`Route Candidate가 요구사항을 충족하지 않습니다: ${failures.join(", ")}`);
        const [candidates] = await tx.query<[RouteCandidate[]]>(
          "CREATE model_route_candidate CONTENT { candidate_id: $candidate_id, organization_id: $organization_id, route_id: $route_id, model_profile_id: $profile_id, priority: $priority, enabled: true, created_at: time::now() } RETURN AFTER;",
          {
            candidate_id: randomUUID(),
            organization_id: context.organizationId,
            route_id: route.route_id,
            profile_id: profile.model_profile_id,
            priority: input.priority,
          },
        );
        if (!candidates[0]) throw new Error("Route Candidate 생성 결과가 없습니다");
        await tx.query(
          "UPDATE model_route SET routing_policy_version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id;",
          { organization_id: context.organizationId, route_id: route.route_id },
        );
        return { candidate: candidates[0] };
      },
      { executor },
    );
  }

  public async listCandidates(
    context: TenantContext,
    routeId?: string,
    executor: QueryExecutor = this.database,
  ): Promise<readonly RouteCandidate[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [candidates] = await executor.query<[RouteCandidate[]]>(
      routeId === undefined
        ? "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id ORDER BY route_id ASC, priority ASC, candidate_id ASC;"
        : "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id AND route_id = $route_id ORDER BY priority ASC, candidate_id ASC;",
      { organization_id: context.organizationId, route_id: routeId },
    );
    return candidates;
  }

  public async simulate(context: TenantContext, request: RouteRequest): Promise<RouteSimulation> {
    await this.organizations.verifyTenantContext(context);
    const excludedAttemptKeys = request.fallbackFromAttemptId
      ? await this.fallbackAttemptKeys(this.database, context, {
          ...request,
          fallbackFromAttemptId: request.fallbackFromAttemptId,
        })
      : undefined;
    return await this.select(this.database, context, request, excludedAttemptKeys);
  }

  public async diagnose(context: TenantContext, requests: readonly RouteRequest[]): Promise<RouterDiagnostic> {
    await this.organizations.verifyTenantContext(context);
    const routes: RouteDiagnostic[] = [];
    for (const request of requests) {
      const simulation = await this.select(this.database, context, request);
      const available = simulation.status === "selected";
      const recovery = available
        ? undefined
        : simulation.route.data_policy === "local-private"
          ? "활성 local Endpoint, 검증된 local Model Profile, Candidate와 Credential을 구성해주세요."
          : "요구사항을 만족하는 Model Profile, Candidate와 활성 Credential을 구성해주세요.";
      routes.push({
        routeName: simulation.route.name,
        routeKind: simulation.route.route_kind,
        dataPolicy: simulation.route.data_policy,
        status: available ? "available" : "blocked_model_unavailable",
        reasons: simulation.explanation.excluded,
        ...(recovery ? { recovery } : {}),
        ...(simulation.resumeAt ? { resumeAt: simulation.resumeAt } : {}),
      });
    }
    return { status: routes.every((route) => route.status === "available") ? "available" : "degraded", routes };
  }

  public async reserve(context: TenantContext, input: ReserveRouteInput): Promise<RouteReservation> {
    await this.organizations.verifyTenantContext(context);
    const stickyKeyHash = input.stickyKey ? createHash("sha256").update(input.stickyKey).digest("hex") : undefined;
    const requestJson = canonicalJson({
      commandId: input.commandId,
      routeName: input.routeName,
      estimatedTokens: input.estimatedTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      ...(input.optimizationRunId !== undefined ? { optimizationRunId: input.optimizationRunId } : {}),
      ...(input.optimizationBatchId !== undefined ? { optimizationBatchId: input.optimizationBatchId } : {}),
      ...(input.preferredModelProfileIds ? { preferredModelProfileIds: input.preferredModelProfileIds } : {}),
      ...(stickyKeyHash ? { stickyKeyHash } : {}),
      ...(input.fallbackFromAttemptId ? { fallbackFromAttemptId: input.fallbackFromAttemptId } : {}),
      ...(input.requiredExecutionKind ? { requiredExecutionKind: input.requiredExecutionKind } : {}),
    });
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [repeated] = await tx.query<[RouteAttempt[]]>(
        "SELECT * OMIT id FROM route_attempt WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) {
        await this.requireCommandActor(tx, context, input.commandId);
        return await this.reservationFromAttempt(tx, context, repeated[0], requestJson);
      }
      const excludedAttemptKeys = input.fallbackFromAttemptId
        ? await this.fallbackAttemptKeys(tx, context, {
            ...input,
            fallbackFromAttemptId: input.fallbackFromAttemptId,
          })
        : undefined;
      const simulation = await this.select(tx, context, input, excludedAttemptKeys);
      if (
        simulation.status !== "selected" ||
        !simulation.candidate ||
        !simulation.profile ||
        !simulation.endpoint ||
        !simulation.credential
      ) {
        throw new Error(`blocked_model_unavailable: ${simulation.explanation.excluded.join("; ")}`);
      }
      const route = simulation.route;
      if (input.estimatedCostMicros > route.request_budget_micros) throw new Error("요청 예산을 초과했습니다");
      if (route.spent_micros + input.estimatedCostMicros > route.total_budget_micros)
        throw new Error("Route 총 예산을 초과했습니다");
      const sequence = route.selection_sequence + 1;
      await tx.query(
        "UPDATE model_route SET selection_sequence = $sequence, spent_micros += $cost, updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET status = 'active', reauth_required = false, cooldown_until = NONE, request_count += 1, cost_micros += $cost, last_selected_sequence = $sequence, quota_remaining = IF quota_remaining != NONE { math::max([0, quota_remaining - 1]) } ELSE { NONE }, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          sequence,
          cost: input.estimatedCostMicros,
          organization_id: context.organizationId,
          route_id: route.route_id,
          credential_id: simulation.credential.credential_id,
        },
      );
      const [attempts] = await tx.query<[RouteAttempt[]]>(
        "CREATE route_attempt CONTENT { attempt_id: $attempt_id, organization_id: $organization_id, execution_id: $execution_id, optimization_run_id: $optimization_run_id, optimization_batch_id: $optimization_batch_id, route_id: $route_id, candidate_id: $candidate_id, model_profile_id: $profile_id, credential_id: $credential_id, credential_secret_version: $secret_version, command_id: $command_id, status: 'reserved', selection_sequence: $sequence, estimated_tokens: $tokens, reserved_cost_micros: $cost, sticky_key_hash: $sticky_hash, fallback_from_attempt_id: $fallback_from, quota_snapshot_id: $quota_snapshot_id, routing_policy_version: $routing_policy_version, effective_credential_policy: $effective_credential_policy, subscription_policy_version_id: $subscription_policy_version_id, subscription_policy_version: $subscription_policy_version, explanation_json: $explanation_json, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          attempt_id: randomUUID(),
          organization_id: context.organizationId,
          route_id: route.route_id,
          candidate_id: simulation.candidate.candidate_id,
          profile_id: simulation.profile.model_profile_id,
          credential_id: simulation.credential.credential_id,
          secret_version: simulation.credential.secret_version,
          command_id: input.commandId,
          execution_id: input.executionId,
          optimization_run_id: input.optimizationRunId,
          optimization_batch_id: input.optimizationBatchId,
          sequence,
          tokens: input.estimatedTokens,
          cost: input.estimatedCostMicros,
          sticky_hash: stickyKeyHash,
          fallback_from: input.fallbackFromAttemptId,
          quota_snapshot_id: simulation.quotaSnapshotId,
          routing_policy_version: route.routing_policy_version,
          effective_credential_policy: simulation.effectiveCredentialPolicy,
          subscription_policy_version_id: simulation.subscriptionPolicyVersionId,
          subscription_policy_version: simulation.subscriptionPolicyVersion,
          explanation_json: canonicalJson({ request: requestJson, explanation: simulation.explanation }),
        },
      );
      const attempt = attempts[0];
      if (!attempt) throw new Error("Route Attempt 생성 결과가 없습니다");
      if (attempt.routing_policy_version === undefined) {
        throw new Error("Route Attempt에 routing policy version이 없습니다");
      }
      const material = await this.providers.resolveExecutionMaterial(
        context,
        simulation.credential,
        tx,
        attempt.credential_secret_version,
      );
      const auditRequestJson = canonicalJson({
        routeName: input.routeName,
        estimatedTokens: input.estimatedTokens,
        estimatedCostMicros: input.estimatedCostMicros,
        ...(input.preferredModelProfileIds ? { preferredModelProfileIds: input.preferredModelProfileIds } : {}),
        ...(stickyKeyHash ? { stickyKeyHash } : {}),
        ...(input.fallbackFromAttemptId ? { fallbackFromAttemptId: input.fallbackFromAttemptId } : {}),
      });
      const auditResultJson = canonicalJson({
        attemptId: attempt.attempt_id,
        routeId: attempt.route_id,
        candidateId: attempt.candidate_id,
        modelProfileId: attempt.model_profile_id,
        credentialId: attempt.credential_id,
        ...(attempt.quota_snapshot_id ? { quotaSnapshotId: attempt.quota_snapshot_id } : {}),
        routingPolicyVersion: attempt.routing_policy_version,
        ...(attempt.effective_credential_policy
          ? { effectiveCredentialPolicy: attempt.effective_credential_policy }
          : {}),
        ...(attempt.subscription_policy_version_id
          ? { subscriptionPolicyVersionId: attempt.subscription_policy_version_id }
          : {}),
        ...(attempt.subscription_policy_version === undefined
          ? {}
          : { subscriptionPolicyVersion: attempt.subscription_policy_version }),
      });
      const [events] = await tx.query<[RouterAuditEvent[]]>(
        "CREATE router_audit_event CONTENT { audit_event_id: $audit_id, organization_id: $organization_id, command_id: $command_id, event_type: 'route_attempt_recorded', actor_user_id: $actor_user_id, request_json: $request_json, result_json: $result_json, created_at: time::now() } RETURN AFTER;",
        {
          audit_id: randomUUID(),
          organization_id: context.organizationId,
          command_id: input.commandId,
          actor_user_id: context.userId,
          request_json: auditRequestJson,
          result_json: auditResultJson,
        },
      );
      if (!events[0]) throw new Error("Route Attempt 감사 사건을 생성하지 못했습니다");
      return {
        ...simulation,
        status: "selected",
        attempt,
        material,
        ...(material.kind === "encrypted_secret" ? { secret: material.secret } : {}),
      };
    });
  }

  public async reportFailure(
    context: TenantContext,
    input: ReportFailureInput,
  ): Promise<AttemptOutcome & { audit: RouterAuditEvent }> {
    if (
      input.emittedTokens < 0 ||
      input.actualInputTokens < 0 ||
      input.actualOutputTokens < 0 ||
      input.actualCostMicros < 0
    )
      throw new Error("Attempt 사용량은 음수일 수 없습니다");
    if (typeof input.sideEffectsStarted !== "boolean") throw new Error("Attempt 부작용 시작 여부가 유효하지 않습니다");
    return await this.command(
      context,
      input.commandId,
      "route_attempt_failed",
      canonicalJson(input),
      async (tx) => {
        const current = await this.attempt(tx, context.organizationId, input.attemptId);
        await this.requireAttemptActor(tx, context, current);
        if (current.status !== "reserved") throw new Error("reserved 상태의 Attempt만 실패 처리할 수 있습니다");
        const classified = classifyFailure(input.signal);
        const fallbackAllowed = classified.fallbackEligible && input.emittedTokens === 0 && !input.sideEffectsStarted;
        const status = input.emittedTokens > 0 || input.sideEffectsStarted ? "interrupted" : "failed";
        const costDelta = input.actualCostMicros - current.reserved_cost_micros;
        const credential = await this.credential(tx, context.organizationId, current.credential_id);
        const subscriptionAuthenticationFailure =
          classified.failureClass === "authentication" &&
          isSubscriptionCredential(credential) &&
          credential.subscription_account_id !== undefined;
        const quotaResetMillis = serializedMillis(credential.quota_reset_at);
        const retryAt = classified.retryAt
          ? new Date(classified.retryAt)
          : classified.failureClass === "quota"
            ? new Date(quotaResetMillis > Date.now() ? quotaResetMillis : Date.now() + 60_000)
            : undefined;
        await tx.query(
          "UPDATE model_route SET spent_micros = math::max([0, spent_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET status = IF $disable { 'disabled' } ELSE IF $cooldown { 'cooldown' } ELSE { status }, reauth_required = IF $reauth_required { true } ELSE { reauth_required }, version = IF $disable OR $cooldown { version + 1 } ELSE { version }, cooldown_until = IF $cooldown { $retry_at } ELSE { cooldown_until }, input_tokens += $input_tokens, output_tokens += $output_tokens, cost_micros = math::max([0, cost_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
          {
            organization_id: context.organizationId,
            route_id: current.route_id,
            credential_id: current.credential_id,
            disable: classified.failureClass === "authentication" || classified.failureClass === "billing",
            reauth_required: subscriptionAuthenticationFailure,
            cooldown: classified.failureClass === "quota",
            retry_at: retryAt,
            input_tokens: input.actualInputTokens,
            output_tokens: input.actualOutputTokens,
            cost_delta: costDelta,
          },
        );
        if (subscriptionAuthenticationFailure) {
          const accountId = credential.subscription_account_id;
          const connectorId = credential.subscription_connector_id;
          if (!accountId || !connectorId) throw new Error("구독 인증 실패 계보가 불완전합니다");
          const [updatedAccounts] = await tx.query<[Array<{ account_id: string }>]>(
            `UPDATE subscription_account
           SET status = 'needs-reauth', version += IF status = 'needs-reauth' { 0 } ELSE { 1 }, updated_at = time::now()
           WHERE organization_id = $organization_id AND account_id = $account_id
             AND provider_id = $provider_id AND connector_id = $connector_id AND status != 'revoked'
           RETURN AFTER;`,
            {
              organization_id: context.organizationId,
              account_id: accountId,
              provider_id: credential.provider_id,
              connector_id: connectorId,
            },
          );
          if (updatedAccounts.length !== 1) throw new Error("구독 계정 재인증 상태 전이가 충돌했습니다");
        }
        if (
          classified.failureClass === "quota" &&
          this.subscriptions &&
          isSubscriptionCredential(credential) &&
          credential.subscription_account_id
        ) {
          await this.subscriptions.quota.recordRateLimitForRouting(
            context,
            {
              commandId: `${input.commandId}:subscription-quota`,
              accountId: credential.subscription_account_id,
              observedAt: new Date().toISOString(),
              ...(retryAt === undefined ? {} : { resetsAt: retryAt.toISOString() }),
              source: "router-http-429",
            },
            tx,
          );
        }
        if (["upstream", "timeout", "network"].includes(classified.failureClass)) {
          const profile = await this.profile(tx, context.organizationId, current.model_profile_id);
          await this.recordCircuitFailure(
            tx,
            context.organizationId,
            "credential",
            current.credential_id,
            classified.failureClass,
          );
          await this.recordCircuitFailure(
            tx,
            context.organizationId,
            "endpoint",
            profile.endpoint_id,
            classified.failureClass,
          );
          await this.recordCircuitFailure(
            tx,
            context.organizationId,
            "model",
            profile.model_profile_id,
            classified.failureClass,
          );
        }
        const [attempts] = await tx.query<[RouteAttempt[]]>(
          "UPDATE route_attempt SET status = $status, failure_class = $failure_class, status_code = $status_code, emitted_tokens = $emitted_tokens, side_effects_started = $side_effects_started, actual_input_tokens = $input_tokens, actual_output_tokens = $output_tokens, actual_cost_micros = $actual_cost, fallback_allowed = $fallback_allowed, retry_at = $retry_at, updated_at = time::now() WHERE organization_id = $organization_id AND attempt_id = $attempt_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            attempt_id: current.attempt_id,
            status,
            failure_class: classified.failureClass,
            status_code: input.signal.statusCode,
            emitted_tokens: input.emittedTokens,
            side_effects_started: input.sideEffectsStarted,
            input_tokens: input.actualInputTokens,
            output_tokens: input.actualOutputTokens,
            actual_cost: input.actualCostMicros,
            fallback_allowed: fallbackAllowed,
            retry_at: retryAt,
          },
        );
        const attempt = attempts[0];
        if (!attempt) throw new Error("Route Attempt 실패 처리 결과가 없습니다");
        if (!fallbackAllowed) return { attempt };
        const route = await this.routeById(tx, context.organizationId, current.route_id);
        const excludedAttemptKeys = await this.fallbackAttemptKeys(tx, context, {
          routeName: route.name,
          estimatedTokens: current.estimated_tokens,
          estimatedCostMicros: current.reserved_cost_micros,
          fallbackFromAttemptId: current.attempt_id,
        });
        const next = await this.select(
          tx,
          context,
          {
            routeName: route.name,
            estimatedTokens: current.estimated_tokens,
            estimatedCostMicros: current.reserved_cost_micros,
            fallbackFromAttemptId: current.attempt_id,
          },
          excludedAttemptKeys,
        );
        return { attempt, next };
      },
      { roles: ["owner", "admin", "member"] },
    );
  }

  public async reportSuccess(
    context: TenantContext,
    input: ReportSuccessInput,
  ): Promise<{ attempt: RouteAttempt; audit: RouterAuditEvent }> {
    if (input.actualInputTokens < 0 || input.actualOutputTokens < 0 || input.actualCostMicros < 0)
      throw new Error("Attempt 사용량은 음수일 수 없습니다");
    return await this.command(
      context,
      input.commandId,
      "route_attempt_succeeded",
      canonicalJson(input),
      async (tx) => {
        const current = await this.attempt(tx, context.organizationId, input.attemptId);
        await this.requireAttemptActor(tx, context, current);
        if (current.status !== "reserved") throw new Error("reserved 상태의 Attempt만 성공 처리할 수 있습니다");
        const costDelta = input.actualCostMicros - current.reserved_cost_micros;
        await tx.query(
          "UPDATE model_route SET spent_micros = math::max([0, spent_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET input_tokens += $input_tokens, output_tokens += $output_tokens, cost_micros = math::max([0, cost_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
          {
            organization_id: context.organizationId,
            route_id: current.route_id,
            credential_id: current.credential_id,
            input_tokens: input.actualInputTokens,
            output_tokens: input.actualOutputTokens,
            cost_delta: costDelta,
          },
        );
        const profile = await this.profile(tx, context.organizationId, current.model_profile_id);
        await this.recordCircuitSuccess(tx, context.organizationId, "credential", current.credential_id);
        await this.recordCircuitSuccess(tx, context.organizationId, "endpoint", profile.endpoint_id);
        await this.recordCircuitSuccess(tx, context.organizationId, "model", profile.model_profile_id);
        const [attempts] = await tx.query<[RouteAttempt[]]>(
          "UPDATE route_attempt SET status = 'succeeded', emitted_tokens = $output_tokens, actual_input_tokens = $input_tokens, actual_output_tokens = $output_tokens, actual_cost_micros = $actual_cost, fallback_allowed = false, updated_at = time::now() WHERE organization_id = $organization_id AND attempt_id = $attempt_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            attempt_id: current.attempt_id,
            input_tokens: input.actualInputTokens,
            output_tokens: input.actualOutputTokens,
            actual_cost: input.actualCostMicros,
          },
        );
        if (!attempts[0]) throw new Error("Route Attempt 성공 처리 결과가 없습니다");
        return { attempt: attempts[0] };
      },
      { roles: ["owner", "admin", "member"] },
    );
  }

  private async select(
    executor: QueryExecutor,
    context: TenantContext,
    request: RouteRequest,
    excludedAttemptKeys?: ReadonlySet<string>,
  ): Promise<RouteSimulation> {
    const route = await this.routeByName(executor, context.organizationId, request.routeName);
    const requestedExecutionKind: unknown = request.requiredExecutionKind;
    if (
      requestedExecutionKind !== undefined &&
      !new Set<unknown>(["model", "agent-runtime"]).has(requestedExecutionKind)
    ) {
      throw new Error("요구 실행 종류가 유효하지 않습니다");
    }
    const budgetFailures: string[] = [];
    if (request.estimatedTokens > route.max_context_tokens) budgetFailures.push("context token 한도 초과");
    if (request.estimatedCostMicros > route.request_budget_micros) budgetFailures.push("요청 예산 초과");
    if (route.spent_micros + request.estimatedCostMicros > route.total_budget_micros) {
      budgetFailures.push("Route 총 예산 초과");
    }
    if (budgetFailures.length > 0) {
      return {
        status: "blocked_model_unavailable",
        route,
        explanation: { selected: [], excluded: budgetFailures },
      };
    }
    const [candidates] = await executor.query<[RouteCandidate[]]>(
      "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id AND route_id = $route_id AND enabled = true ORDER BY priority ASC, candidate_id ASC;",
      { organization_id: context.organizationId, route_id: route.route_id },
    );
    const preferences = request.preferredModelProfileIds ?? [];
    if (new Set(preferences).size !== preferences.length) throw new Error("선호 Model Profile 목록에 중복이 있습니다");
    const preferenceRank = new Map(preferences.map((profileId, index) => [profileId, index]));
    if (request.optimizationBatchId !== undefined) {
      const batchId = request.optimizationBatchId.trim();
      if (!batchId || batchId !== request.optimizationBatchId || batchId.length > 256) {
        throw new Error("Optimization Batch ID가 유효하지 않습니다");
      }
      let batches: OptimizationBatchRoutingRecord[];
      try {
        [batches] = await executor.query<[OptimizationBatchRoutingRecord[]]>(
          `SELECT batch_id, organization_id, role_key, version, status, primary_model_profile_id,
                  fallback_model_profile_ids, checksum
           FROM optimization_batch
           WHERE organization_id = $organization_id AND batch_id = $batch_id LIMIT 2;`,
          { organization_id: context.organizationId, batch_id: batchId },
        );
      } catch (cause) {
        throw new Error("현재 tenant의 활성 Optimization Batch가 유효하지 않습니다", { cause });
      }
      const batch = batches[0];
      if (
        batches.length !== 1 ||
        !batch ||
        batch.organization_id !== context.organizationId ||
        batch.batch_id !== batchId ||
        batch.status !== "active" ||
        typeof batch.role_key !== "string" ||
        !batch.role_key ||
        !Number.isSafeInteger(batch.version) ||
        (batch.version as number) < 1 ||
        typeof batch.checksum !== "string" ||
        !Array.isArray(batch.fallback_model_profile_ids) ||
        batch.fallback_model_profile_ids.some((profileId) => typeof profileId !== "string") ||
        (batch.primary_model_profile_id !== undefined && typeof batch.primary_model_profile_id !== "string")
      ) {
        throw new Error("현재 tenant의 활성 Optimization Batch가 유효하지 않습니다");
      }
      const batchProfileIds = [
        ...(typeof batch.primary_model_profile_id === "string" ? [batch.primary_model_profile_id] : []),
        ...(batch.fallback_model_profile_ids as string[]),
      ];
      if (
        batchProfileIds.length === 0 ||
        new Set(batchProfileIds).size !== batchProfileIds.length ||
        batchProfileIds.length !== preferences.length ||
        batchProfileIds.some((profileId, index) => preferences[index] !== profileId)
      ) {
        throw new Error("Optimization Batch의 선호 순서가 Router 요청과 일치하지 않습니다");
      }
      let pointers: OptimizationActivePointerRoutingRecord[];
      try {
        [pointers] = await executor.query<[OptimizationActivePointerRoutingRecord[]]>(
          `SELECT organization_id, role_key, batch_id, batch_version, checksum
           FROM optimization_active_pointer
           WHERE organization_id = $organization_id AND batch_id = $batch_id
           ORDER BY role_key ASC LIMIT 2;`,
          { organization_id: context.organizationId, batch_id: batchId },
        );
      } catch (cause) {
        throw new Error("Optimization Batch의 활성 pointer가 유효하지 않습니다", { cause });
      }
      const pointer = pointers[0];
      if (
        pointers.length !== 1 ||
        !pointer ||
        pointer.organization_id !== context.organizationId ||
        pointer.batch_id !== batchId ||
        pointer.role_key !== batch.role_key ||
        pointer.batch_version !== batch.version ||
        pointer.checksum !== batch.checksum
      ) {
        throw new Error("Optimization Batch의 활성 pointer가 유효하지 않습니다");
      }
    }
    if (preferences.some((profileId) => !candidates.some((candidate) => candidate.model_profile_id === profileId))) {
      throw new Error("선호 Model Profile은 현재 tenant Route 후보여야 합니다");
    }
    const orderedCandidates = (
      preferences.length > 0
        ? candidates.filter((candidate) => preferenceRank.has(candidate.model_profile_id))
        : [...candidates]
    ).sort(
      (left, right) =>
        (preferenceRank.get(left.model_profile_id) ?? Number.MAX_SAFE_INTEGER) -
          (preferenceRank.get(right.model_profile_id) ?? Number.MAX_SAFE_INTEGER) ||
        left.priority - right.priority ||
        left.candidate_id.localeCompare(right.candidate_id),
    );
    const excluded: string[] = [];
    let resumeAt: string | undefined;
    for (const candidate of orderedCandidates) {
      const profile = await this.profile(executor, context.organizationId, candidate.model_profile_id);
      const endpoint = await this.endpoint(executor, context.organizationId, profile.endpoint_id);
      const profileFailures = this.profileFailures(route, profile, endpoint);
      if (profileFailures.length > 0) {
        excluded.push(`${profile.model_id}: ${profileFailures.join(", ")}`);
        continue;
      }
      const scopedCircuits = [
        await this.circuit(executor, context.organizationId, "model", profile.model_profile_id),
        await this.circuit(executor, context.organizationId, "endpoint", endpoint.endpoint_id),
      ];
      const openCircuit = scopedCircuits.find(
        (item) => item?.state === "open" && serializedMillis(item.open_until) > Date.now(),
      );
      if (openCircuit) {
        const until = new Date(serializedMillis(openCircuit.open_until)).toISOString();
        excluded.push(`${profile.model_id}/${endpoint.name}: circuit open until ${until}`);
        if (!resumeAt || until < resumeAt) resumeAt = until;
        continue;
      }
      const [credentials] = await executor.query<[ProviderCredential[]]>(
        "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND provider_id = $provider_id AND endpoint_id = $endpoint_id;",
        { organization_id: context.organizationId, provider_id: profile.provider_id, endpoint_id: profile.endpoint_id },
      );
      const subscriptionPolicy = await this.subscriptions?.policies?.resolve(context, profile.provider_id, executor);
      const configuredSubscriptionPolicy = subscriptionPolicy?.source === "configured" ? subscriptionPolicy : undefined;
      const effectiveCredentialPolicy = configuredSubscriptionPolicy?.credentialPolicy ?? route.credential_policy;
      const subscriptionManifest = listSubscriptionProviderManifests().find(
        (manifest) => manifest.id === profile.provider_id,
      );
      const now = Date.now();
      const eligible: CredentialSelectionView[] = [];
      for (const credential of credentials) {
        if (request.requiredExecutionKind === "agent-runtime" && !isSubscriptionCredential(credential)) {
          excluded.push(`${profile.model_id}/${credential.label}: agent runtime 실행 표면 없음`);
          continue;
        }
        if (excludedAttemptKeys?.has(`${profile.model_profile_id}:${credential.credential_id}`)) {
          excluded.push(`${profile.model_id}/${credential.label}: 이전 실패 Model/Credential 조합 제외`);
          continue;
        }
        const credentialCircuit = await this.circuit(
          executor,
          context.organizationId,
          "credential",
          credential.credential_id,
        );
        if (credentialCircuit?.state === "open" && serializedMillis(credentialCircuit.open_until) > now) {
          const until = new Date(serializedMillis(credentialCircuit.open_until)).toISOString();
          excluded.push(`${profile.model_id}/${credential.label}: circuit open until ${until}`);
          if (!resumeAt || until < resumeAt) resumeAt = until;
          continue;
        }
        let selectionCredential: CredentialSelectionView = credential;
        let recoveredReauthentication = false;
        if (isSubscriptionCredential(credential)) {
          const accountId = credential.subscription_account_id;
          const connectorId = credential.subscription_connector_id;
          const scope = credential.subscription_scope;
          if (!this.subscriptions || !accountId || !connectorId || !scope) {
            excluded.push(`${profile.model_id}/${credential.label}: 구독 Connector 구성이 불완전함`);
            continue;
          }
          try {
            const access = await this.subscriptions.accounts.requireRoutingAccess(context, accountId, executor);
            const account = access.account;
            if (account.provider_id !== credential.provider_id) throw new Error("Provider binding 불일치");
            if (account.connector_id !== connectorId) throw new Error("Connector binding 불일치");
            const [connectors] = await executor.query<
              [
                Array<{
                  readonly location: ConnectorLocation;
                  readonly trust_origin?: ConnectorTrustOrigin;
                  readonly execution_kind: ConnectorExecutionKind;
                }>,
              ]
            >(
              `SELECT location, trust_origin, execution_kind FROM subscription_connector
               WHERE organization_id = $organization_id AND connector_id = $connector_id LIMIT 1;`,
              { organization_id: context.organizationId, connector_id: connectorId },
            );
            const connector = connectors[0];
            if (!connector) throw new Error("Connector 연결 표면을 찾을 수 없습니다");
            if (request.requiredExecutionKind && connector.execution_kind !== request.requiredExecutionKind) {
              excluded.push(
                `${profile.model_id}/${credential.label}: ${request.requiredExecutionKind} 실행 종류 불일치`,
              );
              continue;
            }
            if (!(
              (connector.location === "server" && connector.trust_origin === "server-managed") ||
              (connector.location === "edge" && connector.trust_origin === "edge-device")
            )) {
              throw new Error("Connector 위치와 신뢰 출처 조합이 유효하지 않습니다");
            }
            if (subscriptionManifest && subscriptionPolicy) {
              const supportedApprovalModes = subscriptionProviderApprovalModes(
                subscriptionManifest,
                connector.location,
              );
              if (supportedApprovalModes && !supportedApprovalModes.includes(subscriptionPolicy.approvalMode)) {
                const surfaceLabel = connector.location === "edge" ? "Edge" : "서버";
                excluded.push(
                  `${profile.model_id}/${credential.label}: ${surfaceLabel} 연결 표면은 ${subscriptionPolicy.approvalMode} 승인을 지원하지 않음`,
                );
                continue;
              }
            }
            if (
              profile.provider_id === "openai-codex" &&
              !(await this.hasCodexAccountModelEvidence(
                executor,
                context.organizationId,
                profile.model_profile_id,
                accountId,
              ))
            ) {
              throw new Error("이 Codex 계정에서 선택 model의 가용성이 검증되지 않았습니다");
            }
            const current = await this.subscriptions.quota.currentForRouting(context, accountId, executor);
            selectionCredential = current
              ? { ...credential, quota_windows: current.windows, quota_snapshot_id: current.snapshotId }
              : credential;
            recoveredReauthentication =
              credential.status === "disabled" &&
              (credential as ProviderCredential & { readonly reauth_required?: boolean }).reauth_required === true;
            const now = Date.now();
            const freshExhausted =
              current?.windows.some((window) => {
                const observedAt = new Date(window.observedAt).getTime();
                const resetsAt = window.resetsAt === undefined ? undefined : new Date(window.resetsAt).getTime();
                const resetIsActive = resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt > now;
                return (
                  Number.isFinite(observedAt) &&
                  Math.abs(now - observedAt) <= 5 * 60 * 1_000 &&
                  resetIsActive &&
                  (window.remaining === 0 || window.remainingRatio === 0)
                );
              }) ?? false;
            if (freshExhausted) {
              excluded.push(`${profile.model_id}/${credential.label}: 구독 quota 소진`);
              continue;
            }
          } catch (error) {
            excluded.push(
              `${profile.model_id}/${credential.label}: ${error instanceof Error ? error.message : "구독 계정 사용 불가"}`,
            );
            continue;
          }
        }
        if ((credential.status === "active" || recoveredReauthentication) && credential.quota_remaining !== 0) {
          eligible.push(selectionCredential);
          continue;
        }
        if (credential.status === "cooldown" && serializedMillis(credential.cooldown_until) <= now) {
          eligible.push(credential);
          continue;
        }
        if (credential.cooldown_until) {
          const until = new Date(serializedMillis(credential.cooldown_until)).toISOString();
          if (!resumeAt || until < resumeAt) resumeAt = until;
        }
        excluded.push(`${profile.model_id}/${credential.label}: ${credential.status}`);
      }
      const selected = selectCredential(effectiveCredentialPolicy, eligible, request.stickyKey);
      if (selected) {
        const credential = credentials.find((item) => item.credential_id === selected.credential_id);
        if (!credential) continue;
        return {
          status: "selected",
          route,
          candidate,
          profile,
          endpoint,
          credential:
            credential.status === "cooldown" ||
            ((credential as ProviderCredential & { readonly reauth_required?: boolean }).reauth_required === true &&
              credential.status === "disabled")
              ? { ...credential, status: "active" }
              : credential,
          ...(selected.quota_snapshot_id ? { quotaSnapshotId: selected.quota_snapshot_id } : {}),
          effectiveCredentialPolicy,
          ...(configuredSubscriptionPolicy?.policyVersionId
            ? { subscriptionPolicyVersionId: configuredSubscriptionPolicy.policyVersionId }
            : {}),
          ...(configuredSubscriptionPolicy ? { subscriptionPolicyVersion: configuredSubscriptionPolicy.version } : {}),
          explanation: {
            selected: [
              `candidate=${candidate.candidate_id}`,
              `model=${profile.provider_id}/${profile.model_id}`,
              `credential=${credential.credential_id}`,
              `policy=${effectiveCredentialPolicy}`,
              ...(configuredSubscriptionPolicy?.policyVersionId
                ? [`subscription-policy-version=${configuredSubscriptionPolicy.policyVersionId}`]
                : []),
            ],
            excluded,
          },
        };
      }
      excluded.push(`${profile.model_id}: 사용 가능한 Credential 없음`);
    }
    return {
      status: "blocked_model_unavailable",
      route,
      explanation: { selected: [], excluded },
      ...(resumeAt ? { resumeAt } : {}),
    };
  }

  private profileFailures(route: ModelRoute, profile: ModelProfile, endpoint: ProviderEndpoint): string[] {
    const failures: string[] = [];
    if (!profile.enabled || !profile.verified) failures.push("검증되지 않은 model");
    if (profile.route_kind !== route.route_kind) failures.push("route kind 불일치");
    if (profile.equivalence_group !== route.equivalence_group) failures.push("equivalence group 불일치");
    if (profile.eval_score < route.min_eval_score) failures.push("eval score 부족");
    if (profile.context_window < route.max_context_tokens) failures.push("context window 부족");
    if (route.require_tools && !profile.supports_tools) failures.push("tool capability 없음");
    if (route.require_structured_output && !profile.supports_structured_output) failures.push("structured output 없음");
    if (route.require_vision && !profile.supports_vision) failures.push("vision capability 없음");
    if (route.require_streaming && !profile.supports_streaming) failures.push("streaming capability 없음");
    if (route.data_policy === "local-private" && !endpoint.local) failures.push("외부 endpoint 금지");
    return failures;
  }

  private async fallbackAttemptKeys(
    executor: QueryExecutor,
    context: TenantContext,
    request: RouteRequest & { readonly fallbackFromAttemptId: string },
  ): Promise<ReadonlySet<string>> {
    const route = await this.routeByName(executor, context.organizationId, request.routeName);
    const attemptIds = new Set<string>();
    const attemptKeys = new Set<string>();
    let attemptId: string | undefined = request.fallbackFromAttemptId;
    let childSequence: number | undefined;
    for (let depth = 0; attemptId !== undefined; depth += 1) {
      if (depth >= 256) throw new Error("fallback Attempt 체인 상한을 초과했습니다");
      if (attemptIds.has(attemptId)) throw new Error("fallback Attempt 체인에 순환이 있습니다");
      attemptIds.add(attemptId);
      const attempt = await this.attempt(executor, context.organizationId, attemptId);
      await this.requireAttemptActor(executor, context, attempt);
      if (attempt.route_id !== route.route_id) throw new Error("fallback Attempt의 Route가 요청 Route와 다릅니다");
      if (attempt.status !== "failed" || !attempt.fallback_allowed) {
        throw new Error("이전 Attempt는 fallback이 허용되지 않습니다");
      }
      if (childSequence !== undefined && attempt.selection_sequence >= childSequence) {
        throw new Error("fallback Attempt 선택 순서가 유효하지 않습니다");
      }
      childSequence = attempt.selection_sequence;
      attemptKeys.add(`${attempt.model_profile_id}:${attempt.credential_id}`);
      attemptId = attempt.fallback_from_attempt_id;
    }
    return attemptKeys;
  }

  private async reservationFromAttempt(
    executor: QueryExecutor,
    context: TenantContext,
    attempt: RouteAttempt,
    requestJson: string,
  ): Promise<RouteReservation> {
    const explanation = JSON.parse(attempt.explanation_json) as {
      request: string;
      explanation: RouteSimulation["explanation"];
    };
    if (explanation.request !== requestJson) throw new Error("같은 commandId에 다른 route 요청을 사용할 수 없습니다");
    const route = await this.routeById(executor, context.organizationId, attempt.route_id);
    const [candidates] = await executor.query<[RouteCandidate[]]>(
      "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id AND candidate_id = $candidate_id LIMIT 1;",
      { organization_id: context.organizationId, candidate_id: attempt.candidate_id },
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error("Attempt Candidate를 찾을 수 없습니다");
    const profile = await this.profile(executor, context.organizationId, attempt.model_profile_id);
    const endpoint = await this.endpoint(executor, context.organizationId, profile.endpoint_id);
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND credential_id = $credential_id LIMIT 1;",
      { organization_id: context.organizationId, credential_id: attempt.credential_id },
    );
    const credential = credentials[0];
    if (!credential) throw new Error("Attempt Credential을 찾을 수 없습니다");
    const material = await this.providers.resolveExecutionMaterial(
      context,
      credential,
      executor,
      attempt.credential_secret_version,
    );
    return {
      status: "selected",
      route,
      candidate,
      profile,
      endpoint,
      credential,
      attempt,
      material,
      ...(material.kind === "encrypted_secret" ? { secret: material.secret } : {}),
      ...(attempt.quota_snapshot_id ? { quotaSnapshotId: attempt.quota_snapshot_id } : {}),
      explanation: explanation.explanation,
    };
  }

  private async requireCommandActor(executor: QueryExecutor, context: TenantContext, commandId: string): Promise<void> {
    const [events] = await executor.query<[RouterAuditEvent[]]>(
      `SELECT * OMIT id FROM router_audit_event
       WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: context.organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) throw new Error("Route Attempt 감사 계보를 찾을 수 없습니다");
    if (event.actor_user_id !== context.userId) {
      throw new Error("같은 commandId를 다른 사용자가 재사용할 수 없습니다");
    }
  }

  private async requireAttemptActor(
    executor: QueryExecutor,
    context: TenantContext,
    attempt: RouteAttempt,
  ): Promise<void> {
    try {
      await this.requireCommandActor(executor, context, attempt.command_id);
    } catch {
      throw new Error("Route Attempt 예약 사용자만 fallback 또는 정산할 수 있습니다");
    }
  }

  private async createModelEvidence(
    executor: QueryExecutor,
    context: TenantContext,
    profile: ModelProfile,
    evidence: readonly NormalizedModelVerificationEvidence[],
  ): Promise<readonly ModelVerificationEvidence[]> {
    const recorded: ModelVerificationEvidence[] = [];
    const verifiedAccounts = new Set<string>();
    for (const item of evidence) {
      if (item.subscriptionAccountId && !verifiedAccounts.has(item.subscriptionAccountId)) {
        const [accounts] = await executor.query<
          [Array<{ readonly account_id: string; readonly provider_id: string; readonly status: string }>]
        >(
          `SELECT account_id, provider_id, status FROM subscription_account
           WHERE organization_id = $organization_id AND account_id = $account_id
             AND provider_id = $provider_id AND status = 'active' LIMIT 1;`,
          {
            organization_id: context.organizationId,
            account_id: item.subscriptionAccountId,
            provider_id: profile.provider_id,
          },
        );
        const [credentials] = await executor.query<
          [Array<{ readonly credential_id: string; readonly material_kind: string }>]
        >(
          `SELECT credential_id, material_kind FROM provider_credential
           WHERE organization_id = $organization_id AND provider_id = $provider_id
             AND endpoint_id = $endpoint_id AND subscription_account_id = $account_id
             AND status = 'active';`,
          {
            organization_id: context.organizationId,
            provider_id: profile.provider_id,
            endpoint_id: profile.endpoint_id,
            account_id: item.subscriptionAccountId,
          },
        );
        const expectedMaterialKind = profile.provider_id === "openai-codex" ? "connector_session" : "encrypted_secret";
        if (
          accounts.length !== 1 ||
          credentials.length !== 1 ||
          credentials[0]?.material_kind !== expectedMaterialKind
        ) {
          throw new Error("Model verification evidence의 구독 계정·Credential·Endpoint 계보가 일치하지 않습니다");
        }
        verifiedAccounts.add(item.subscriptionAccountId);
      }
      const [rows] = await executor.query<[ModelVerificationEvidence[]]>(
        `CREATE model_verification_evidence CONTENT {
          evidence_id: $evidence_id, organization_id: $organization_id,
          model_profile_id: $model_profile_id, model_id: $model_id,
          subscription_account_id: $subscription_account_id,
          evidence_kind: $evidence_kind, source: $source, source_version: $source_version,
          claim_json: $claim_json, claim_digest: $claim_digest, observed_at: $observed_at,
          created_by: $created_by, created_at: time::now()
        } RETURN AFTER;`,
        {
          evidence_id: randomUUID(),
          organization_id: context.organizationId,
          model_profile_id: profile.model_profile_id,
          model_id: profile.model_id,
          subscription_account_id: item.subscriptionAccountId,
          evidence_kind: item.kind,
          source: item.source,
          source_version: item.sourceVersion,
          claim_json: item.claimJson,
          claim_digest: item.claimDigest,
          observed_at: item.observedAt,
          created_by: context.userId,
        },
      );
      const row = rows[0];
      if (!row) throw new Error("Model verification evidence 생성 결과가 없습니다");
      recorded.push(row);
    }
    return recorded;
  }

  private async command<Payload extends object>(
    context: TenantContext,
    commandId: string,
    eventType: string,
    requestJson: string,
    operation: (executor: QueryExecutor) => Promise<Payload>,
    options: {
      readonly roles?: readonly ("owner" | "admin" | "member")[];
      readonly executor?: QueryExecutor;
    } = {},
  ): Promise<Payload & { audit: RouterAuditEvent }> {
    const roles = options.roles ?? ["owner", "admin"];
    const execute = async (tx: QueryExecutor): Promise<Payload & { audit: RouterAuditEvent }> => {
      await this.organizations.verifyTenantContext(context, roles, tx);
      const [existing] = await tx.query<[RouterAuditEvent[]]>(
        "SELECT * OMIT id FROM router_audit_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (existing[0]) {
        if (existing[0].actor_user_id !== context.userId) {
          throw new Error("같은 commandId를 다른 사용자가 재사용할 수 없습니다");
        }
        if (existing[0].request_json !== requestJson)
          throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
        return JSON.parse(existing[0].result_json) as Payload & { audit: RouterAuditEvent };
      }
      const payload = await operation(tx);
      const [events] = await tx.query<[RouterAuditEvent[]]>(
        "CREATE router_audit_event CONTENT { audit_event_id: $audit_id, organization_id: $organization_id, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, request_json: $request_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
        {
          audit_id: randomUUID(),
          organization_id: context.organizationId,
          command_id: commandId,
          event_type: eventType,
          actor_user_id: context.userId,
          request_json: requestJson,
        },
      );
      const audit = events[0];
      if (!audit) throw new Error("Router audit event 생성 결과가 없습니다");
      const result = { ...payload, audit };
      await tx.query("UPDATE router_audit_event SET result_json = $result_json WHERE audit_event_id = $audit_id;", {
        result_json: JSON.stringify(result),
        audit_id: audit.audit_event_id,
      });
      return result;
    };
    const executor = options.executor ?? this.database;
    return executor === this.database ? await this.database.transaction(execute) : await execute(executor);
  }

  private async routeByName(executor: QueryExecutor, organizationId: string, name: string): Promise<ModelRoute> {
    const [routes] = await executor.query<[ModelRoute[]]>(
      "SELECT * OMIT id FROM model_route WHERE organization_id = $organization_id AND name = $name AND enabled = true LIMIT 1;",
      { organization_id: organizationId, name },
    );
    if (!routes[0]) throw new Error(`Model Route를 찾을 수 없습니다: ${name}`);
    return routes[0];
  }

  private async routeById(executor: QueryExecutor, organizationId: string, routeId: string): Promise<ModelRoute> {
    const [routes] = await executor.query<[ModelRoute[]]>(
      "SELECT * OMIT id FROM model_route WHERE organization_id = $organization_id AND route_id = $route_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, route_id: routeId },
    );
    if (!routes[0]) throw new Error(`Model Route를 찾을 수 없습니다: ${routeId}`);
    return routes[0];
  }

  private async profile(executor: QueryExecutor, organizationId: string, profileId: string): Promise<ModelProfile> {
    const [profiles] = await executor.query<[ModelProfile[]]>(
      "SELECT * OMIT id FROM model_profile WHERE organization_id = $organization_id AND model_profile_id = $profile_id LIMIT 1;",
      { organization_id: organizationId, profile_id: profileId },
    );
    if (!profiles[0]) throw new Error(`Model Profile을 찾을 수 없습니다: ${profileId}`);
    return profiles[0];
  }

  private async hasCodexAccountModelEvidence(
    executor: QueryExecutor,
    organizationId: string,
    modelProfileId: string,
    accountId: string,
  ): Promise<boolean> {
    const [rows] = await executor.query<[Array<{ readonly evidence_kind: string }>]>(
      `SELECT evidence_kind FROM model_verification_evidence
       WHERE organization_id = $organization_id AND model_profile_id = $model_profile_id
         AND subscription_account_id = $subscription_account_id
         AND evidence_kind IN ['runtime-availability', 'runtime-capability-contract'];`,
      {
        organization_id: organizationId,
        model_profile_id: modelProfileId,
        subscription_account_id: accountId,
      },
    );
    const kinds = new Set(rows.map((row) => row.evidence_kind));
    return kinds.has("runtime-availability") && kinds.has("runtime-capability-contract");
  }

  private async endpoint(
    executor: QueryExecutor,
    organizationId: string,
    endpointId: string,
  ): Promise<ProviderEndpoint> {
    const [endpoints] = await executor.query<[ProviderEndpoint[]]>(
      "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, endpoint_id: endpointId },
    );
    if (!endpoints[0]) throw new Error(`Provider Endpoint를 찾을 수 없습니다: ${endpointId}`);
    return endpoints[0];
  }

  private async attempt(executor: QueryExecutor, organizationId: string, attemptId: string): Promise<RouteAttempt> {
    const [attempts] = await executor.query<[RouteAttempt[]]>(
      "SELECT * OMIT id FROM route_attempt WHERE organization_id = $organization_id AND attempt_id = $attempt_id LIMIT 1;",
      { organization_id: organizationId, attempt_id: attemptId },
    );
    if (!attempts[0]) throw new Error(`Route Attempt를 찾을 수 없습니다: ${attemptId}`);
    return attempts[0];
  }

  private async credential(
    executor: QueryExecutor,
    organizationId: string,
    credentialId: string,
  ): Promise<ProviderCredential> {
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND credential_id = $credential_id LIMIT 1;",
      { organization_id: organizationId, credential_id: credentialId },
    );
    if (!credentials[0]) throw new Error(`Provider Credential을 찾을 수 없습니다: ${credentialId}`);
    return credentials[0];
  }

  private async circuit(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
  ): Promise<RouterCircuit | undefined> {
    const [circuits] = await executor.query<[RouterCircuit[]]>(
      "SELECT * OMIT id FROM router_circuit WHERE organization_id = $organization_id AND scope_type = $scope_type AND scope_id = $scope_id LIMIT 1;",
      { organization_id: organizationId, scope_type: scopeType, scope_id: scopeId },
    );
    return circuits[0];
  }

  private async recordCircuitFailure(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
    failureClass: string,
  ): Promise<void> {
    const current = await this.circuit(executor, organizationId, scopeType, scopeId);
    const failureCount = (current?.failure_count ?? 0) + 1;
    const open = failureCount >= 3;
    const openUntil = open ? new Date(Date.now() + 60_000) : undefined;
    if (!current) {
      await executor.query(
        "CREATE router_circuit CONTENT { circuit_id: $circuit_id, organization_id: $organization_id, scope_type: $scope_type, scope_id: $scope_id, state: $state, failure_count: $failure_count, success_count: 0, threshold: 3, open_until: $open_until, last_failure_class: $failure_class, version: 1, created_at: time::now(), updated_at: time::now() };",
        {
          circuit_id: randomUUID(),
          organization_id: organizationId,
          scope_type: scopeType,
          scope_id: scopeId,
          state: open ? "open" : "closed",
          failure_count: failureCount,
          open_until: openUntil,
          failure_class: failureClass,
        },
      );
      return;
    }
    await executor.query(
      "UPDATE router_circuit SET state = $state, failure_count = $failure_count, open_until = $open_until, last_failure_class = $failure_class, version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND circuit_id = $circuit_id;",
      {
        organization_id: organizationId,
        circuit_id: current.circuit_id,
        state: open ? "open" : "closed",
        failure_count: failureCount,
        open_until: openUntil,
        failure_class: failureClass,
      },
    );
  }

  private async recordCircuitSuccess(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
  ): Promise<void> {
    const current = await this.circuit(executor, organizationId, scopeType, scopeId);
    if (!current) return;
    await executor.query(
      "UPDATE router_circuit SET state = 'closed', failure_count = 0, success_count += 1, open_until = NONE, last_failure_class = NONE, version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND circuit_id = $circuit_id;",
      { organization_id: organizationId, circuit_id: current.circuit_id },
    );
  }
}
