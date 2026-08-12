import type { ExtensionGateway } from "@massion/extension-host";
import type { AssuranceBindingStore } from "@massion/assurance";
import {
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceDeniedError,
  type GovernanceGate,
  type ApprovalStore,
} from "@massion/governance";
import type { GrowthGateway } from "@massion/growth";
import type { OrganizationGraphService } from "@massion/organization";
import type { ModelRouter, ProviderService } from "@massion/router";
import type { AgentRunner } from "@massion/runtime";
import {
  isOptimizationRoleKey,
  type EvaluationPolicy,
  type EvaluationReceipt,
  type ModelRecommendationRecord,
  type ModelOptimizationStore,
  type OptimizationBatchService,
  type OptimizationModelProfile,
  type OptimizationRoleKey,
} from "@massion/model-optimization";
import {
  listSubscriptionProviderManifests,
  ServerConnectorAuthenticationRequiredError,
  ServerConnectorPaidSubscriptionRequiredError,
  ServerConnectorQuotaObservationUnavailableError,
  subscriptionProviderApprovalModes,
} from "@massion/subscriptions";
import type { SubscriptionAuthKind, SubscriptionProviderProtocol } from "@massion/subscriptions";
import type { WorkService } from "@massion/work";
import type { WorkspaceService, WorkspaceView } from "@massion/workspace";
import type { AutonomyStore } from "@massion/governance";

import type { ApplicationCommandDescriptor, ApplicationCommandRegistry } from "../command-registry.js";
import type { AutonomyTransitionCoordinator } from "../autonomy-transition-coordinator.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "../contracts.js";
import { ApplicationError } from "../errors.js";
import type {
  SubscriptionAccountCommands,
  SubscriptionConnectionCommands,
  SubscriptionConnectorCommands,
  SubscriptionServerConnectionCommands,
  SubscriptionPolicyStore,
  SubscriptionPolicyView,
} from "../subscription-operations.js";
import { SUBSCRIPTION_APPROVAL_MODES, SUBSCRIPTION_CREDENTIAL_POLICIES } from "../subscription-operations.js";
import { approveGrowthSuggestion, rejectGrowthSuggestion } from "../growth-suggestion-decision.js";

export interface ApplicationDomainDependencies {
  readonly works?: Pick<
    WorkService,
    | "createWork"
    | "createFollowUpWork"
    | "transition"
    | "forkWork"
    | "planMerge"
    | "applyMerge"
    | "openRoom"
    | "joinRoom"
    | "leaveRoom"
    | "postMessage"
    | "assignTask"
  >;
  readonly workspaces?: Pick<WorkspaceService, "register" | "decideTrust" | "archive" | "get" | "list">;
  readonly autonomy?: Pick<AutonomyStore, "set">;
  readonly autonomyTransition?: Pick<AutonomyTransitionCoordinator, "set">;
  readonly runtime?: Pick<AgentRunner, "execute" | "cancel" | "suspend" | "resume"> &
    Partial<Pick<AgentRunner, "cancelOrganization">>;
  readonly emergency?: Pick<EmergencyControl, "activate" | "release" | "get">;
  readonly governanceGate?: Pick<GovernanceGate, "authorize">;
  readonly approvals?: Pick<ApprovalStore, "get" | "vote" | "cancel">;
  readonly assuranceBindings?: Pick<AssuranceBindingStore, "propose" | "activate">;
  readonly organization?: Pick<OrganizationGraphService, "execute">;
  readonly extension?: Pick<ExtensionGateway, "validate" | "link" | "pack" | "install" | "update" | "rollback">;
  // `start`는 onboarding(LocalApplicationBootstrap)에서 메모리 시드 연결에 사용합니다.
  readonly growth?: Pick<
    GrowthGateway,
    | "configure"
    | "adopt"
    | "getSuggestionDetails"
    | "getSuggestionDetailsByApproval"
    | "reject"
    | "revert"
    | "start"
    | "putExplicitMemory"
    | "forgetExplicitMemory"
  >;
  readonly providers?: Pick<
    ProviderService,
    | "registerProvider"
    | "removeProvider"
    | "registerEndpoint"
    | "addCredential"
    | "revokeCredential"
    | "synchronizeModelCatalog"
  >;
  readonly router?: Pick<
    ModelRouter,
    "registerModel" | "setModelEnabled" | "createRoute" | "addCandidate" | "setRouteBudget"
  >;
  readonly optimization?: {
    readonly evaluations: Pick<
      ModelOptimizationStore,
      | "createBundle"
      | "exportBundle"
      | "importBundle"
      | "startEvaluation"
      | "executeEvaluation"
      | "completeEvaluation"
      | "configurePolicy"
      | "recommend"
      | "listRecommendations"
    >;
    readonly batches: Pick<
      OptimizationBatchService,
      "approveRecommendation" | "createBatch" | "activateBatch" | "recordObservation" | "recover"
    >;
  };
  readonly subscriptionAccounts?: SubscriptionAccountCommands;
  readonly subscriptionConnections?: SubscriptionConnectionCommands;
  readonly subscriptionServerConnections?: SubscriptionServerConnectionCommands;
  readonly subscriptionConnectors?: SubscriptionConnectorCommands;
  readonly subscriptionPolicy?: SubscriptionPolicyStore;
}

type Payload = Readonly<Record<string, unknown>>;

function payload(value: unknown, allowed: readonly string[], required: readonly string[] = []): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application operation payload는 object여야 합니다");
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Application operation payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = required.find((key) => result[key] === undefined);
  if (missing) throw new Error(`Application operation payload 필드가 필요합니다: ${missing}`);
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024)
    throw new Error(`${label} 문자열이 유효하지 않습니다`);
  return value;
}

function explicitMemoryKind(value: unknown): "fact" | "preference" | "procedure" {
  const kind = string(value, "kind");
  if (kind !== "fact" && kind !== "preference" && kind !== "procedure")
    throw new Error("지원하지 않는 개인 Memory kind입니다");
  return kind;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} 정수가 유효하지 않습니다`);
  return value as number;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 배열이 유효하지 않습니다`);
  return value.map((item) => string(item, label));
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} boolean이 유효하지 않습니다`);
  return value;
}

function subscriptionAuthKind(value: unknown): SubscriptionAuthKind {
  const candidate = string(value, "authKind");
  if (!new Set(["oauth", "device-code", "api-key", "subscription-key", "cli-profile", "acp"]).has(candidate)) {
    throw new Error("지원하지 않는 구독 인증 방식입니다");
  }
  return candidate as SubscriptionAuthKind;
}

function subscriptionModelAuthKind(value: unknown): Extract<SubscriptionAuthKind, "api-key" | "subscription-key"> {
  const candidate = subscriptionAuthKind(value);
  if (candidate !== "api-key" && candidate !== "subscription-key") {
    throw new Error("model 구독 인증 방식이 유효하지 않습니다");
  }
  return candidate;
}

function subscriptionSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 16 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("구독 Credential secret이 유효하지 않습니다");
  }
  return value;
}

function subscriptionProtocol(value: unknown): SubscriptionProviderProtocol {
  const candidate = string(value, "protocol");
  if (
    !new Set(["openai", "anthropic", "gemini", "acp", "cli-process", "codex-app-server", "claude-agent-sdk"]).has(
      candidate,
    )
  ) {
    throw new Error("지원하지 않는 구독 Provider protocol입니다");
  }
  return candidate as SubscriptionProviderProtocol;
}

function subscriptionCredentialPolicy(value: unknown): SubscriptionPolicyView["credentialPolicy"] {
  const candidate = string(value, "credentialPolicy");
  if (!SUBSCRIPTION_CREDENTIAL_POLICIES.includes(candidate as never)) {
    throw new Error("지원하지 않는 구독 계정 선택 정책입니다");
  }
  return candidate as SubscriptionPolicyView["credentialPolicy"];
}

function subscriptionApprovalMode(value: unknown): SubscriptionPolicyView["approvalMode"] {
  const candidate = string(value, "approvalMode");
  if (!SUBSCRIPTION_APPROVAL_MODES.includes(candidate as never)) {
    throw new Error("지원하지 않는 구독 승인 방식입니다");
  }
  return candidate as SubscriptionPolicyView["approvalMode"];
}

function providerApprovalMode(providerId: string, value: unknown): SubscriptionPolicyView["approvalMode"] {
  const manifest = listSubscriptionProviderManifests().find((candidate) => candidate.id === providerId);
  if (manifest?.connectionSurface === "unavailable") {
    throw new Error("공개 연결 표면이 없는 Provider에는 구독 실행 정책이 허용되지 않습니다");
  }
  const declared = manifest ? subscriptionProviderApprovalModes(manifest) : undefined;
  const selected = subscriptionApprovalMode(value);
  if (declared && !declared.includes(selected)) {
    throw new Error(`이 Provider에서 허용되지 않는 구독 승인 방식입니다: ${selected}`);
  }
  return selected;
}

function expectedRevision(command: ApplicationCommandV1): number {
  if (command.expectedRevision === undefined) throw new Error("expectedRevision이 필요합니다");
  return command.expectedRevision;
}

function result(
  command: ApplicationCommandV1,
  input: {
    readonly outcome?: ApplicationCommandResultV1["outcome"];
    readonly resource?: { readonly type: string; readonly id: string; readonly revision?: number };
    readonly data?: unknown;
  },
): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: input.outcome ?? "succeeded",
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
}

function register<Parsed>(
  registry: ApplicationCommandRegistry,
  descriptor: ApplicationCommandDescriptor<Parsed>,
): void {
  registry.register({
    ...descriptor,
    async handle(context, command, value) {
      try {
        return await descriptor.handle(context, command, value);
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
}

function domainError(error: unknown, correlationId: string): never {
  if (error instanceof ServerConnectorAuthenticationRequiredError) {
    throw new ApplicationError({
      category: "authentication",
      severity: "warning",
      retryable: false,
      userMessage: "Codex 구독 profile에 재인증이 필요합니다",
      operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
      correlationId,
      cause: error,
    });
  }
  if (error instanceof ServerConnectorPaidSubscriptionRequiredError) {
    throw new ApplicationError({
      category: "validation",
      severity: "warning",
      retryable: false,
      userMessage: "Codex 계정의 유료 소비자 구독을 확인할 수 없습니다",
      operatorCode: "APP_SUBSCRIPTION_PAID_PLAN_REQUIRED",
      correlationId,
      cause: error,
    });
  }
  if (error instanceof ServerConnectorQuotaObservationUnavailableError) {
    throw new ApplicationError({
      category: "unavailable",
      severity: "warning",
      retryable: true,
      userMessage: "Codex 구독 할당량을 확인할 수 없어 연결을 완료하지 않았습니다",
      operatorCode: "APP_SUBSCRIPTION_QUOTA_UNAVAILABLE",
      correlationId,
      cause: error,
    });
  }
  if (error instanceof GovernanceDeniedError) {
    throw new ApplicationError({
      category: "policy",
      severity: "error",
      retryable: false,
      userMessage: "활성 Governance 정책이 요청을 거부했습니다",
      operatorCode: "APP_POLICY_DENIED",
      correlationId,
      cause: error,
    });
  }
  if (error instanceof ApplicationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  // 제거 거부는 사용자가 직접 조치할 수 있는 사유이므로 도메인 문구를 그대로 전달합니다.
  if (/구독으로 연결한 Provider|실행 계보가 남아 있어/u.test(message)) {
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: false,
      userMessage: message,
      operatorCode: "APP_PROVIDER_REMOVE_BLOCKED",
      correlationId,
      cause: error,
    });
  }
  if (/revision|generation|동시성|stale|같은 commandId/iu.test(message)) {
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: false,
      userMessage: "요청의 현재 version 조건이 일치하지 않습니다",
      operatorCode: "APP_DOMAIN_CONFLICT",
      correlationId,
      cause: error,
    });
  }
  if (/찾을 수 없/iu.test(message)) {
    throw new ApplicationError({
      category: "not-found",
      severity: "error",
      retryable: false,
      userMessage: "요청한 resource를 찾을 수 없습니다",
      operatorCode: "APP_DOMAIN_NOT_FOUND",
      correlationId,
      cause: error,
    });
  }
  if (/권한|Membership|owner|admin/iu.test(message)) {
    throw new ApplicationError({
      category: "authorization",
      severity: "error",
      retryable: false,
      userMessage: "현재 사용자 또는 조직 역할에 요청 권한이 없습니다",
      operatorCode: "APP_DOMAIN_AUTHORIZATION",
      correlationId,
      cause: error,
    });
  }
  if (
    /candidate batch|shadow 동의|최소 표본|개선 폭|승격 게이트|되돌려진 batch|production learning 동의/iu.test(message)
  ) {
    throw new ApplicationError({
      category: "policy",
      severity: "error",
      retryable: false,
      userMessage: "모델 최적화 정책이 요청을 거부했습니다",
      operatorCode: "APP_OPTIMIZATION_POLICY_GATE",
      correlationId,
      cause: error,
    });
  }
  if (/유효하지|필요합니다|허용되지|비어 있을 수 없|상한|만료|expired/iu.test(message)) {
    throw new ApplicationError({
      category: "validation",
      severity: "error",
      retryable: false,
      userMessage: "도메인 요청 값이 유효하지 않습니다",
      operatorCode: "APP_DOMAIN_VALIDATION",
      correlationId,
      cause: error,
    });
  }
  throw error;
}

function workData(work: { readonly work_id: string; readonly status: string; readonly revision: number }) {
  return { workId: work.work_id, status: work.status, revision: work.revision };
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new Error(`${label} 시각이 유효하지 않습니다`);
}

function subscriptionAccountData(account: {
  readonly account_id: string;
  readonly provider_id: string;
  readonly alias: string;
  readonly scope: string;
  readonly connector_id: string;
  readonly billing_kind: string;
  readonly status: string;
  readonly consent_version: number;
  readonly version: number;
  readonly cooldown_until?: unknown;
}) {
  return {
    accountId: account.account_id,
    providerId: account.provider_id,
    alias: account.alias,
    scope: account.scope,
    connectorId: account.connector_id,
    billingKind: account.billing_kind,
    status: account.status,
    consentVersion: account.consent_version,
    version: account.version,
    ...(account.cooldown_until === undefined
      ? {}
      : { cooldownUntil: timestamp(account.cooldown_until, "구독 계정 cooldown") }),
  };
}

function subscriptionConnectorData(connector: {
  readonly connector_id: string;
  readonly location: string;
  readonly execution_kind: string;
  readonly protocol: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly expires_at?: unknown;
}) {
  return {
    connectorId: connector.connector_id,
    location: connector.location,
    executionKind: connector.execution_kind,
    protocol: connector.protocol,
    version: connector.version,
    capabilities: connector.capabilities,
    status: connector.status,
    ...(connector.expires_at === undefined ? {} : { expiresAt: timestamp(connector.expires_at, "Connector 만료") }),
  };
}

function subscriptionServerConnectorData(connector: {
  readonly connectorId: string;
  readonly providerId: string;
  readonly executionKind: string;
  readonly runtimeId: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly trustOrigin: string;
  readonly processGeneration?: number;
  readonly lastHealthAt?: string;
  readonly quotaObservation?: {
    readonly source: "direct";
    readonly attestedAt: string;
  };
}) {
  return {
    connectorId: connector.connectorId,
    providerId: connector.providerId,
    executionKind: connector.executionKind,
    runtimeId: connector.runtimeId,
    version: connector.version,
    capabilities: connector.capabilities,
    status: connector.status,
    trustOrigin: connector.trustOrigin,
    ...(connector.processGeneration === undefined ? {} : { processGeneration: connector.processGeneration }),
    ...(connector.lastHealthAt === undefined ? {} : { lastHealthAt: connector.lastHealthAt }),
    ...(connector.quotaObservation === undefined
      ? {}
      : {
          quotaObservation: {
            source: connector.quotaObservation.source,
            attestedAt: timestamp(connector.quotaObservation.attestedAt, "Codex 직접 quota 관측 시각"),
          },
        }),
  };
}

function subscriptionProfileHandle(value: string): string {
  if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/u.test(value)) throw new Error("구독 profile handle이 유효하지 않습니다");
  return value;
}

function subscriptionPolicyData(policy: SubscriptionPolicyView) {
  return {
    providerId: policy.providerId,
    credentialPolicy: policy.credentialPolicy,
    approvalMode: policy.approvalMode,
    version: policy.version,
    source: policy.source,
    ...(policy.updatedAt === undefined ? {} : { updatedAt: policy.updatedAt }),
  };
}

function extensionData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "installationId",
    "versionId",
    "packageName",
    "packageVersion",
    "artifactDigest",
    "permissionDigest",
    "activationGeneration",
    "state",
    "sourceDigest",
    "files",
    "trustLevel",
    "validatedAt",
  ];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function growthData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "configurationVersionId",
    "version",
    "reflectionEnabled",
    "adoptionMode",
    "status",
    "checksum",
    "beforeVersionId",
    "afterVersionId",
    "approvalId",
    "adoptionId",
    "revertOperationId",
    "suggestionId",
    "revision",
    "reason",
    "decidedByUserId",
    "commandId",
  ];
  const selected = Object.fromEntries(
    allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  if (source.adoption && typeof source.adoption === "object") {
    const adoption = source.adoption as Record<string, unknown>;
    selected.adoption = Object.fromEntries(
      ["adoption_id", "suggestion_id", "status", "mode", "revision"]
        .filter((key) => adoption[key] !== undefined)
        .map((key) => [key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()), adoption[key]]),
    );
  }
  return selected;
}

function workspaceData(workspace: WorkspaceView): Record<string, unknown> {
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: workspace.path,
    kind: workspace.kind,
    trust: workspace.trust,
    status: workspace.status,
    revision: workspace.revision,
    createdAt: String(workspace.createdAt),
    lastUsedAt: String(workspace.lastUsedAt),
  };
}

function workspaceTrustDecision(value: unknown): "trusted" | "blocked" {
  const decision = string(value, "decision");
  if (decision !== "trusted" && decision !== "blocked") throw new Error("지원하지 않는 workspace 신뢰 결정입니다");
  return decision;
}

function registerAutonomy(
  registry: ApplicationCommandRegistry,
  autonomy: NonNullable<ApplicationDomainDependencies["autonomy"]>,
  transition?: NonNullable<ApplicationDomainDependencies["autonomyTransition"]>,
): void {
  register(registry, {
    operation: "governance.autonomy.set",
    requiredScopes: ["governance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["mode"], ["mode"]),
    async handle(context, command, value) {
      try {
        const mode = string(value.mode, "mode");
        if (mode !== "automatic" && mode !== "review" && mode !== "full-access")
          throw new Error("지원하지 않는 자율성 모드입니다");
        const state = transition
          ? await transition.set(context, { mode, expectedRevision: expectedRevision(command) })
          : await autonomy.set(context, { mode, expectedRevision: expectedRevision(command) });
        const runtimePermissionStatus = "runtimePermissionStatus" in state ? state.runtimePermissionStatus : undefined;
        return result(command, {
          resource: { type: "GovernanceAutonomy", id: context.organizationId, revision: state.revision },
          data: {
            mode: state.mode,
            revision: state.revision,
            ...(runtimePermissionStatus === undefined
              ? {}
              : {
                  runtimePermissionStatus,
                  ...("limitedReason" in state && state.limitedReason !== undefined
                    ? { limitedReason: state.limitedReason }
                    : {}),
                }),
          },
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerEmergency(
  registry: ApplicationCommandRegistry,
  emergency: NonNullable<ApplicationDomainDependencies["emergency"]>,
  runtime: NonNullable<ApplicationDomainDependencies["runtime"]>,
  approvals?: ApplicationDomainDependencies["approvals"],
  governanceGate?: ApplicationDomainDependencies["governanceGate"],
): void {
  register(registry, {
    operation: "governance.emergency.activate",
    requiredScopes: ["governance:write"],
    allowedRoles: ["owner"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["reason"], ["reason"]),
    async handle(context, command, value) {
      try {
        const state = await emergency.activate(context, {
          commandId: command.commandId,
          reason: string(value.reason, "reason"),
        });
        if (!runtime.cancelOrganization) throw new Error("조직 실행 취소 경로가 구성되지 않았습니다");
        await runtime.cancelOrganization(context, "emergency_stop");
        return result(command, {
          resource: { type: "GovernanceEmergency", id: context.organizationId, revision: state.revision },
          data: {
            active: state.active,
            reason: state.reason,
            revision: state.revision,
            changedByUserId: state.changed_by_user_id,
            changedAt: String(state.changed_at),
          },
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  if (!approvals || !governanceGate) return;
  register(registry, {
    operation: "governance.emergency.release",
    requiredScopes: ["governance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["approvalId", "reason"], ["reason"]),
    idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
    resumeAwaitingApproval: (value) => value.approvalId !== undefined,
    async handle(context, command, value) {
      const reason = string(value.reason, "reason");
      const approvalId = value.approvalId === undefined ? undefined : string(value.approvalId, "approvalId");
      if (approvalId === undefined) {
        const current = await emergency.get(context);
        if (!current?.active) throw new Error("긴급 중단이 활성 상태가 아닙니다");
        try {
          await governanceGate.authorize(context, {
            commandId: `${command.commandId}:approval`,
            action: "emergency.stop.disable",
            resource: { type: "Organization", id: context.organizationId, revision: current.revision },
            environment: "local",
            riskClass: "destructive",
            external: false,
            executionId: `emergency-release:${context.organizationId}:${String(current.revision)}`,
            approvalPreview: {
              kind: "provider",
              title: "긴급 정지 해제",
              reason: "긴급 정지 상태를 해제하고 새 실행을 허용합니다.",
            },
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError) {
            return result(command, {
              outcome: "awaiting-approval",
              resource: { type: "GovernanceEmergency", id: context.organizationId, revision: current.revision },
              data: { active: true, revision: current.revision, approvalId: error.approvalId },
            });
          }
          throw error;
        }
        throw new Error("긴급 정지 해제에는 승인 Permit이 필요합니다");
      }
      const approval = await approvals.get(context, approvalId);
      if (approval.resource_revision === undefined)
        throw new Error("긴급 정지 해제 Approval에 resource revision이 없습니다");
      const state = await emergency.release(context, {
        commandId: command.commandId,
        approvalId: approval.approval_id,
        requestHash: approval.request_hash,
        policyVersionId: approval.policy_version_id,
        resourceRevision: approval.resource_revision,
        reason,
      });
      return result(command, {
        resource: { type: "GovernanceEmergency", id: context.organizationId, revision: state.revision },
        data: {
          active: state.active,
          reason: state.reason,
          revision: state.revision,
          changedByUserId: state.changed_by_user_id,
          changedAt: String(state.changed_at),
        },
      });
    },
  });
}

function registerWorkspace(
  registry: ApplicationCommandRegistry,
  workspaces: NonNullable<ApplicationDomainDependencies["workspaces"]>,
): void {
  register(registry, {
    operation: "workspace.register",
    requiredScopes: ["workspace:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["path", "name"], ["path"]),
    async handle(context, command, value) {
      try {
        const workspace = await workspaces.register(context, {
          path: string(value.path, "path"),
          ...(value.name === undefined ? {} : { name: string(value.name, "name") }),
        });
        return result(command, {
          resource: { type: "Workspace", id: workspace.workspaceId, revision: workspace.revision },
          data: workspaceData(workspace),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "workspace.trust",
    requiredScopes: ["workspace:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workspaceId", "decision"], ["workspaceId", "decision"]),
    async handle(context, command, value) {
      try {
        const workspace = await workspaces.decideTrust(context, {
          workspaceId: string(value.workspaceId, "workspaceId"),
          decision: workspaceTrustDecision(value.decision),
          expectedRevision: expectedRevision(command),
        });
        return result(command, {
          resource: { type: "Workspace", id: workspace.workspaceId, revision: workspace.revision },
          data: workspaceData(workspace),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "workspace.archive",
    requiredScopes: ["workspace:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workspaceId"], ["workspaceId"]),
    async handle(context, command, value) {
      try {
        const workspace = await workspaces.archive(context, {
          workspaceId: string(value.workspaceId, "workspaceId"),
          expectedRevision: expectedRevision(command),
        });
        return result(command, {
          resource: { type: "Workspace", id: workspace.workspaceId, revision: workspace.revision },
          data: workspaceData(workspace),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerWork(
  registry: ApplicationCommandRegistry,
  works: NonNullable<ApplicationDomainDependencies["works"]>,
): void {
  register(registry, {
    operation: "work.create",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "text",
          "surface",
          "organizationVersionId",
          "projectId",
          "workspaceId",
          "contextVersionId",
          "policyVersionId",
          "promptVersionId",
        ],
        ["text", "surface", "organizationVersionId"],
      ),
    async handle(context, command, value) {
      try {
        const created = await works.createWork(context, {
          commandId: command.commandId,
          text: string(value.text, "text"),
          surface: string(value.surface, "surface"),
          organizationVersionId: string(value.organizationVersionId, "organizationVersionId"),
          ...(value.projectId === undefined ? {} : { projectId: string(value.projectId, "projectId") }),
          ...(value.workspaceId === undefined ? {} : { workspaceId: string(value.workspaceId, "workspaceId") }),
          ...(value.contextVersionId === undefined
            ? {}
            : { contextVersionId: string(value.contextVersionId, "contextVersionId") }),
          ...(value.policyVersionId === undefined
            ? {}
            : { policyVersionId: string(value.policyVersionId, "policyVersionId") }),
          ...(value.promptVersionId === undefined
            ? {}
            : { promptVersionId: string(value.promptVersionId, "promptVersionId") }),
        });
        return result(command, {
          resource: { type: "Work", id: created.work.work_id, revision: created.work.revision },
          data: workData(created.work),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "work.cancel",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId"], ["workId"]),
    async handle(context, command, value) {
      try {
        const cancelled = await works.transition(context, {
          commandId: command.commandId,
          workId: string(value.workId, "workId"),
          expectedRevision: expectedRevision(command),
          target: "cancelled",
        });
        return result(command, {
          resource: { type: "Work", id: cancelled.work.work_id, revision: cancelled.work.revision },
          data: workData(cancelled.work),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "work.follow-up",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["parentWorkId", "text", "surface"], ["parentWorkId", "text", "surface"]),
    async handle(context, command, value) {
      const created = await works.createFollowUpWork(context, {
        commandId: command.commandId,
        parentWorkId: string(value.parentWorkId, "parentWorkId"),
        text: string(value.text, "text"),
        surface: string(value.surface, "surface"),
      });
      return result(command, {
        resource: { type: "Work", id: created.work.work_id, revision: created.work.revision },
        data: workData(created.work),
      });
    },
  });
  register(registry, {
    operation: "work.fork",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "objective"], ["workId", "objective"]),
    async handle(context, command, value) {
      const forked = await works.forkWork(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        objective: string(value.objective, "objective"),
      });
      return result(command, {
        resource: { type: "Work", id: forked.childWork.work_id, revision: forked.childWork.revision },
        data: { parentWorkId: forked.work.work_id, ...workData(forked.childWork) },
      });
    },
  });
  register(registry, {
    operation: "work.merge.plan",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "childWorkId"], ["workId", "childWorkId"]),
    async handle(context, command, value) {
      const planned = await works.planMerge(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        childWorkId: string(value.childWorkId, "childWorkId"),
      });
      return result(command, {
        resource: { type: "MergePlan", id: planned.mergePlan.merge_plan_id },
        data: { mergePlanId: planned.mergePlan.merge_plan_id, status: planned.mergePlan.status },
      });
    },
  });
  register(registry, {
    operation: "work.merge.apply",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "mergePlanId"], ["workId", "mergePlanId"]),
    async handle(context, command, value) {
      const applied = await works.applyMerge(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        mergePlanId: string(value.mergePlanId, "mergePlanId"),
      });
      return result(command, {
        resource: { type: "Work", id: applied.work.work_id, revision: applied.work.revision },
        data: { ...workData(applied.work), mergePlanId: applied.mergePlan.merge_plan_id },
      });
    },
  });
  register(registry, {
    operation: "task.assign",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "taskId", "agentHandle"], ["workId", "taskId", "agentHandle"]),
    async handle(context, command, value) {
      const assigned = await works.assignTask(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        taskId: string(value.taskId, "taskId"),
        agentHandle: string(value.agentHandle, "agentHandle"),
      });
      return result(command, {
        resource: { type: "Assignment", id: assigned.assignment.assignment_id, revision: assigned.assignment.revision },
        data: {
          assignmentId: assigned.assignment.assignment_id,
          taskId: assigned.assignment.task_id,
          agentHandle: assigned.assignment.agent_handle,
          status: assigned.assignment.status,
        },
      });
    },
  });
  register(registry, {
    operation: "collaboration.room.open",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "title", "coordinatorHandle", "participants", "limits"],
        ["workId", "title", "coordinatorHandle", "participants", "limits"],
      ),
    async handle(context, command, value) {
      const opened = await works.openRoom(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        title: string(value.title, "title"),
        coordinatorHandle: string(value.coordinatorHandle, "coordinatorHandle"),
        participants: value.participants as never,
        limits: value.limits as never,
      });
      return result(command, {
        resource: { type: "CollaborationRoom", id: opened.room.room_id, revision: opened.room.revision },
        data: { roomId: opened.room.room_id, status: opened.room.status },
      });
    },
  });
  register(registry, {
    operation: "collaboration.message.post",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "workId",
          "roomId",
          "messageType",
          "authorKind",
          "authorId",
          "recipientAgentId",
          "content",
          "replyToMessageId",
          "causedByMessageId",
          "taskId",
          "contextVersionId",
          "executionId",
          "artifactVersionId",
          "tokenCount",
          "costMicros",
        ],
        ["workId", "roomId", "messageType", "authorKind", "authorId", "content"],
      ),
    async handle(context, command, value) {
      const posted = await works.postMessage(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        roomId: string(value.roomId, "roomId"),
        messageType: string(value.messageType, "messageType") as never,
        authorKind: string(value.authorKind, "authorKind") as never,
        authorId: string(value.authorId, "authorId"),
        ...(value.recipientAgentId === undefined
          ? {}
          : { recipientAgentId: string(value.recipientAgentId, "recipientAgentId") }),
        content: string(value.content, "content"),
        ...(value.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: string(value.replyToMessageId, "replyToMessageId") }),
        ...(value.causedByMessageId === undefined
          ? {}
          : { causedByMessageId: string(value.causedByMessageId, "causedByMessageId") }),
        ...(value.taskId === undefined ? {} : { taskId: string(value.taskId, "taskId") }),
        ...(value.contextVersionId === undefined
          ? {}
          : { contextVersionId: string(value.contextVersionId, "contextVersionId") }),
        ...(value.executionId === undefined ? {} : { executionId: string(value.executionId, "executionId") }),
        ...(value.artifactVersionId === undefined
          ? {}
          : { artifactVersionId: string(value.artifactVersionId, "artifactVersionId") }),
        tokenCount: value.tokenCount === undefined ? 0 : integer(value.tokenCount, "tokenCount"),
        costMicros: value.costMicros === undefined ? 0 : integer(value.costMicros, "costMicros"),
      });
      return result(command, {
        resource: { type: "CollaborationMessage", id: posted.message.message_id, revision: posted.message.sequence },
        data: {
          messageId: posted.message.message_id,
          roomId: posted.message.room_id,
          sequence: posted.message.sequence,
        },
      });
    },
  });
  for (const operation of ["join", "leave"] as const) {
    register(registry, {
      operation: `collaboration.participant.${operation}`,
      requiredScopes: ["collaboration:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId", "role"],
          operation === "join"
            ? ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId", "role"]
            : ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId"],
        ),
      async handle(context, command, value) {
        const common = {
          commandId: command.commandId,
          workId: string(value.workId, "workId"),
          expectedRevision: expectedRevision(command),
          roomId: string(value.roomId, "roomId"),
          expectedRoomRevision: integer(value.expectedRoomRevision, "expectedRoomRevision"),
          kind: string(value.kind, "kind") as "user" | "agent",
          subjectId: string(value.subjectId, "subjectId"),
        };
        const changed =
          operation === "join"
            ? await works.joinRoom(context, {
                ...common,
                role: string(value.role, "role") as "coordinator" | "participant" | "observer",
              })
            : await works.leaveRoom(context, common);
        return result(command, {
          resource: {
            type: "CollaborationRoom",
            id: changed.room.room_id,
            revision: changed.room.revision,
          },
          data: {
            roomId: changed.room.room_id,
            participantId: changed.participant.participant_id,
            subjectId: changed.participant.subject_id,
            status: changed.participant.status,
          },
        });
      },
    });
  }
}

function registerOrganization(
  registry: ApplicationCommandRegistry,
  organization: NonNullable<ApplicationDomainDependencies["organization"]>,
): void {
  register(registry, {
    operation: "organization.command",
    requiredScopes: ["organization:write"],
    allowedRoles: ["owner"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "kind",
          "handle",
          "name",
          "responsibility",
          "parentHandle",
          "scope",
          "workId",
          "role",
          "outputs",
          "sourceHandle",
          "newHandle",
          "childHandles",
          "referencePlan",
          "survivorHandle",
          "targetVersion",
          "profileId",
          "profileVersion",
          "nodes",
          "governanceApprovalId",
        ],
        ["kind"],
      ),
    idempotencyPayload: (value) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "governanceApprovalId")),
    resumeAwaitingApproval: (value) => value.governanceApprovalId !== undefined,
    async handle(context, command, value) {
      try {
        const changed = await organization.execute(context, {
          ...value,
          commandId: command.commandId,
          expectedVersion: expectedRevision(command),
        } as never);
        return result(command, {
          resource: { type: "Organization", id: context.organizationId, revision: changed.version.version },
          data: { version: changed.version.version, changedHandles: changed.impact.nodeHandles },
        });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError) {
          return result(command, {
            outcome: "awaiting-approval",
            resource: {
              type: "Organization",
              id: context.organizationId,
              revision: expectedRevision(command),
            },
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        }
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerRuntime(
  registry: ApplicationCommandRegistry,
  runtime: NonNullable<ApplicationDomainDependencies["runtime"]>,
): void {
  register(registry, {
    operation: "runtime.execute",
    requiredScopes: ["runtime:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "taskId", "agentHandle", "modelRoute", "estimatedTokens", "estimatedCostMicros", "input"],
        ["workId", "agentHandle", "modelRoute", "input"],
      ),
    async handle(context, command, value) {
      const executed = await runtime.execute(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        ...(value.taskId === undefined ? {} : { taskId: string(value.taskId, "taskId") }),
        agentHandle: string(value.agentHandle, "agentHandle"),
        modelRoute: string(value.modelRoute, "modelRoute"),
        correlationId: command.correlationId,
        estimatedTokens: value.estimatedTokens === undefined ? 0 : integer(value.estimatedTokens, "estimatedTokens"),
        estimatedCostMicros:
          value.estimatedCostMicros === undefined ? 0 : integer(value.estimatedCostMicros, "estimatedCostMicros"),
        input: value.input,
      });
      return result(command, {
        resource: { type: "Execution", id: executed.executionId },
        data: {
          executionId: executed.executionId,
          status: executed.status,
          ...(executed.output === undefined ? {} : { output: executed.output }),
        },
      });
    },
  });
  for (const operation of ["cancel", "suspend", "resume"] as const) {
    register(registry, {
      operation: `runtime.${operation}`,
      requiredScopes: ["runtime:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["executionId", "reason", "input"], ["executionId"]),
      async handle(context, command, value) {
        const executionId = string(value.executionId, "executionId");
        if (operation === "cancel")
          await runtime.cancel(
            context,
            executionId,
            value.reason === undefined ? undefined : string(value.reason, "reason"),
          );
        else if (operation === "suspend")
          await runtime.suspend(
            context,
            executionId,
            value.reason === undefined ? undefined : string(value.reason, "reason"),
          );
        else await runtime.resume(context, executionId, value.input);
        return result(command, { resource: { type: "Execution", id: executionId }, data: { executionId, operation } });
      },
    });
  }
}

function registerApprovals(
  registry: ApplicationCommandRegistry,
  approvals: NonNullable<ApplicationDomainDependencies["approvals"]>,
  runtime?: ApplicationDomainDependencies["runtime"],
): void {
  register(registry, {
    operation: "approval.vote",
    requiredScopes: ["approval:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["approvalId", "vote", "reason"], ["approvalId", "vote", "reason"]),
    async handle(context, command, value) {
      const voted = await approvals.vote(context, {
        commandId: command.commandId,
        approvalId: string(value.approvalId, "approvalId"),
        vote: string(value.vote, "vote") as "approve" | "reject",
        reason: string(value.reason, "reason"),
      });
      if (
        runtime &&
        voted.execution_id &&
        voted.resume_target === "runtime-subscription" &&
        (voted.status === "approved" || voted.status === "rejected")
      ) {
        await runtime.resume(context, voted.execution_id, { approvalId: voted.approval_id });
      }
      return result(command, {
        resource: { type: "Approval", id: voted.approval_id, revision: voted.revision },
        data: { approvalId: voted.approval_id, status: voted.status, revision: voted.revision },
      });
    },
  });
  register(registry, {
    operation: "approval.cancel",
    requiredScopes: ["approval:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["approvalId", "reason"], ["approvalId", "reason"]),
    async handle(context, command, value) {
      const cancelled = await approvals.cancel(context, {
        commandId: command.commandId,
        approvalId: string(value.approvalId, "approvalId"),
        reason: string(value.reason, "reason"),
      });
      return result(command, {
        resource: { type: "Approval", id: cancelled.approval_id, revision: cancelled.revision },
        data: { approvalId: cancelled.approval_id, status: cancelled.status, revision: cancelled.revision },
      });
    },
  });
}

function registerExtension(
  registry: ApplicationCommandRegistry,
  extension: NonNullable<ApplicationDomainDependencies["extension"]>,
): void {
  const mutation = (operation: "install" | "update") => {
    register(registry, {
      operation: `extension.${operation}`,
      requiredScopes: ["extension:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["archiveBase64", "environment", "riskClass", "executionId", "installApprovalId", "permissionApprovalId"],
          ["archiveBase64"],
        ),
      idempotencyPayload: (value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !["installApprovalId", "permissionApprovalId"].includes(key)),
        ),
      resumeAwaitingApproval: (value) =>
        value.installApprovalId !== undefined || value.permissionApprovalId !== undefined,
      async handle(context, command, value) {
        try {
          const encoded = string(value.archiveBase64, "archiveBase64");
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
            throw new Error("Extension archive base64가 유효하지 않습니다");
          }
          const archive = Buffer.from(encoded, "base64");
          if (archive.length === 0 || archive.length > 64 * 1024 * 1024)
            throw new Error("Extension archive byte 상한이 유효하지 않습니다");
          const activated = await extension[operation](context, {
            commandId: command.commandId,
            archive,
            ...(value.environment === undefined ? {} : { environment: string(value.environment, "environment") }),
            ...(value.riskClass === undefined ? {} : { riskClass: string(value.riskClass, "riskClass") }),
            ...(value.executionId === undefined ? {} : { executionId: string(value.executionId, "executionId") }),
            ...(value.installApprovalId === undefined
              ? {}
              : { installApprovalId: string(value.installApprovalId, "installApprovalId") }),
            ...(value.permissionApprovalId === undefined
              ? {}
              : { permissionApprovalId: string(value.permissionApprovalId, "permissionApprovalId") }),
          });
          const data = extensionData(activated);
          return result(command, {
            ...(typeof data.installationId === "string"
              ? {
                  resource: {
                    type: "Extension",
                    id: data.installationId,
                    ...(typeof data.activationGeneration === "number" ? { revision: data.activationGeneration } : {}),
                  },
                }
              : {}),
            data,
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError) {
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          }
          return domainError(error, command.correlationId);
        }
      },
    });
  };
  mutation("install");
  mutation("update");
  register(registry, {
    operation: "extension.validate",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["source"], ["source"]),
    async handle(_context, command, value) {
      return result(command, { data: extensionData(await extension.validate(string(value.source, "source"))) });
    },
  });
  register(registry, {
    operation: "extension.link",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["source", "environment"], ["source", "environment"]),
    async handle(_context, command, value) {
      const linked = await extension.link(string(value.source, "source"), {
        environment: string(value.environment, "environment"),
      });
      return result(command, { data: extensionData(linked) });
    },
  });
  register(registry, {
    operation: "extension.pack",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["source", "destination"], ["source", "destination"]),
    async handle(_context, command, value) {
      const packed = await extension.pack(string(value.source, "source"), string(value.destination, "destination"));
      return result(command, { data: extensionData(packed) });
    },
  });
  register(registry, {
    operation: "extension.rollback",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "packageName",
          "targetVersionId",
          "environment",
          "riskClass",
          "executionId",
          "installApprovalId",
          "permissionApprovalId",
        ],
        ["packageName", "targetVersionId", "environment", "riskClass", "executionId"],
      ),
    idempotencyPayload: (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !["installApprovalId", "permissionApprovalId"].includes(key)),
      ),
    resumeAwaitingApproval: (value) =>
      value.installApprovalId !== undefined || value.permissionApprovalId !== undefined,
    async handle(context, command, value) {
      try {
        const activated = await extension.rollback(context, {
          commandId: command.commandId,
          packageName: string(value.packageName, "packageName"),
          targetVersionId: string(value.targetVersionId, "targetVersionId"),
          environment: string(value.environment, "environment"),
          riskClass: string(value.riskClass, "riskClass"),
          executionId: string(value.executionId, "executionId"),
          ...(value.installApprovalId === undefined
            ? {}
            : { installApprovalId: string(value.installApprovalId, "installApprovalId") }),
          ...(value.permissionApprovalId === undefined
            ? {}
            : { permissionApprovalId: string(value.permissionApprovalId, "permissionApprovalId") }),
        });
        return result(command, { data: extensionData(activated) });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError)
          return result(command, {
            outcome: "awaiting-approval",
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerGrowth(
  registry: ApplicationCommandRegistry,
  growth: NonNullable<ApplicationDomainDependencies["growth"]>,
  approvals?: NonNullable<ApplicationDomainDependencies["approvals"]>,
): void {
  const definitions = [
    ["growth.configure", "configure", ["subject", "reflectionEnabled", "adoptionMode", "expectedVersion"]],
    [
      "growth.adopt",
      "adopt",
      [
        "suggestionId",
        "suggestionRevision",
        "evaluationRunId",
        "expectedEvaluationInputHash",
        "expectedTargetChecksum",
        "approvalId",
      ],
    ],
    ["growth.suggestion.reject", "reject", ["suggestionId", "expectedRevision", "reason"]],
    ["growth.revert", "revert", ["adoptionId", "suggestionRevision", "reason", "approvalId"]],
  ] as const;
  for (const [operation, method, fields] of definitions) {
    register(registry, {
      operation,
      requiredScopes: ["growth:write"],
      allowedRoles: operation === "growth.suggestion.reject" ? ["owner", "admin"] : ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, fields),
      idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
      resumeAwaitingApproval: (value) => value.approvalId !== undefined,
      async handle(context, command, value) {
        try {
          if (method === "reject" && approvals) {
            const suggestionId = string(value.suggestionId, "suggestionId");
            const detail = await growth.getSuggestionDetails(context, suggestionId);
            const approvalId = detail.adoption?.approvalId;
            if (detail.adoption?.status === "awaiting-review" && approvalId) {
              const rejected = await rejectGrowthSuggestion(
                context,
                { approvals, growth },
                {
                  commandId: command.commandId,
                  approvalId,
                  reason: string(value.reason, "reason"),
                  detail,
                  expectedSuggestionRevision: integer(value.expectedRevision, "expectedRevision", 1),
                },
              );
              return result(command, { data: growthData(rejected.suggestion) });
            }
          }
          const output = await growth[method](context, { commandId: command.commandId, ...value } as never);
          return result(command, { data: growthData(output) });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError)
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          return domainError(error, command.correlationId);
        }
      },
    });
  }
  if (approvals) {
    register(registry, {
      operation: "growth.suggestion.approve",
      requiredScopes: ["growth:write", "approval:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["suggestionId", "expectedRevision", "reason"], ["suggestionId", "expectedRevision"]),
      idempotencyPayload: (value) => value,
      async handle(context, command, value) {
        try {
          const suggestionId = string(value.suggestionId, "suggestionId");
          const detail = await growth.getSuggestionDetails(context, suggestionId);
          const adoption = detail.adoption;
          if (!adoption?.approvalId || adoption.status !== "awaiting-review")
            throw new Error("승인 대기 중인 Growth Adoption을 찾을 수 없습니다");
          const decided = await approveGrowthSuggestion(
            context,
            { approvals, growth },
            {
              commandId: `${command.commandId}:approval`,
              approvalId: adoption.approvalId,
              reason: string(value.reason ?? "개선 상세에서 승인했습니다", "reason"),
              detail,
              expectedSuggestionRevision: integer(value.expectedRevision, "expectedRevision", 1),
            },
          );
          if (decided.approval.status !== "approved") {
            return result(command, {
              outcome: "accepted",
              resource: { type: "Approval", id: adoption.approvalId, revision: decided.approval.revision },
              data: {
                approvalId: adoption.approvalId,
                approvalStatus: decided.approval.status,
                approvalRevision: decided.approval.revision,
              },
            });
          }
          return result(command, {
            resource: { type: "GrowthSuggestion", id: suggestionId, revision: detail.suggestion.revision },
            data: {
              approvalId: adoption.approvalId,
              approvalStatus: decided.approval.status,
              adoption: growthData(decided.adoption),
            },
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError)
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          return domainError(error, command.correlationId);
        }
      },
    });
  }
  register(registry, {
    operation: "growth.memory.put",
    requiredScopes: ["growth:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["key", "kind", "value"], ["key", "kind", "value"]),
    async handle(context, command, value) {
      const memory = await growth.putExplicitMemory(context, {
        commandId: command.commandId,
        expectedRevision: expectedRevision(command),
        key: string(value.key, "key"),
        kind: explicitMemoryKind(value.kind),
        value: string(value.value, "value"),
      });
      return result(command, {
        resource: { type: "ExplicitMemory", id: memory.memoryVersionId, revision: memory.version },
        data: { memoryVersionId: memory.memoryVersionId, revision: memory.version },
      });
    },
  });
  register(registry, {
    operation: "growth.memory.forget",
    requiredScopes: ["growth:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["key"], ["key"]),
    async handle(context, command, value) {
      const memory = await growth.forgetExplicitMemory(context, {
        commandId: command.commandId,
        expectedRevision: expectedRevision(command),
        key: string(value.key, "key"),
      });
      return result(command, {
        resource: { type: "ExplicitMemory", id: memory.memoryVersionId, revision: memory.version },
        data: { memoryVersionId: memory.memoryVersionId, revision: memory.version },
      });
    },
  });
}

function registerRouter(registry: ApplicationCommandRegistry, dependencies: ApplicationDomainDependencies): void {
  if (dependencies.providers) {
    register(registry, {
      operation: "router.provider.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["providerId", "displayName", "adapterKind"], ["providerId", "displayName", "adapterKind"]),
      async handle(context, command, value) {
        const registered = await dependencies.providers?.registerProvider(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelProvider", id: registered.provider.provider_id },
          data: { providerId: registered.provider.provider_id },
        });
      },
    });
    register(registry, {
      operation: "router.provider.remove",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      retryFailedCommand: true,
      validate: (value) => payload(value, ["providerId"], ["providerId"]),
      async handle(context, command, value) {
        try {
          const removed = await dependencies.providers?.removeProvider(context, {
            commandId: command.commandId,
            providerId: string(value.providerId, "providerId"),
          });
          if (!removed) throw new Error("Provider service가 구성되지 않았습니다");
          return result(command, {
            resource: { type: "ModelProvider", id: removed.providerId },
            data: { providerId: removed.providerId, removed: removed.removed },
          });
        } catch (error) {
          return domainError(error, command.correlationId);
        }
      },
    });
    register(registry, {
      operation: "router.endpoint.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["providerId", "name", "baseUrl", "local", "gatewayKind"],
          ["providerId", "name", "baseUrl", "local"],
        ),
      async handle(context, command, value) {
        const registered = await dependencies.providers?.registerEndpoint(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ProviderEndpoint", id: registered.endpoint.endpoint_id },
          data: {
            endpointId: registered.endpoint.endpoint_id,
            providerId: registered.endpoint.provider_id,
          },
        });
      },
    });
    register(registry, {
      operation: "router.credential.add",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "operator-action",
      validate: (value) =>
        payload(
          value,
          ["providerId", "endpointId", "label", "credentialType", "secret", "priority", "weight"],
          ["providerId", "endpointId", "label", "credentialType", "secret", "priority", "weight"],
        ),
      async handle(context, command, value) {
        const added = await dependencies.providers?.addCredential(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!added) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "Credential", id: added.credential.credential_id, revision: added.credential.version },
          data: {
            credentialId: added.credential.credential_id,
            label: added.credential.label,
            status: added.credential.status,
            version: added.credential.version,
          },
        });
      },
    });
    register(registry, {
      operation: "router.credential.disable",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["credentialId", "expectedVersion"], ["credentialId", "expectedVersion"]),
      async handle(context, command, value) {
        const revoked = await dependencies.providers?.revokeCredential(context, {
          commandId: command.commandId,
          credentialId: string(value.credentialId, "credentialId"),
          expectedVersion: integer(value.expectedVersion, "expectedVersion"),
        });
        if (!revoked) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "Credential", id: revoked.credential.credential_id, revision: revoked.credential.version },
          data: {
            credentialId: revoked.credential.credential_id,
            status: revoked.credential.status,
            version: revoked.credential.version,
          },
        });
      },
    });
    register(registry, {
      operation: "router.models.sync",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      retryFailedCommand: true,
      validate(value) {
        const parsed = payload(value, ["endpointId"], ["endpointId"]);
        const endpointId = string(parsed.endpointId, "endpointId").trim();
        if (!endpointId || endpointId.length > 256) throw new Error("endpointId 문자열이 유효하지 않습니다");
        return { endpointId };
      },
      async handle(context, command, value) {
        const synchronized = await dependencies.providers?.synchronizeModelCatalog(context, {
          commandId: command.commandId,
          endpointId: value.endpointId,
        });
        if (!synchronized) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ProviderModelCatalog", id: value.endpointId },
          data: {
            endpointId: value.endpointId,
            status: synchronized.status,
            activeCount: synchronized.activeCount,
            invalidCount: synchronized.invalidCount,
            duplicateCount: synchronized.duplicateCount,
            ...(synchronized.snapshotId === undefined ? {} : { snapshotId: synchronized.snapshotId }),
            ...(synchronized.diagnosticReason === undefined ? {} : { diagnosticReason: synchronized.diagnosticReason }),
            ...(synchronized.retryAt === undefined ? {} : { retryAt: synchronized.retryAt }),
          },
        });
      },
    });
  }
  if (dependencies.router) {
    register(registry, {
      operation: "router.model.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "endpointId",
            "modelId",
            "routeKind",
            "contextWindow",
            "supportsTools",
            "supportsStructuredOutput",
            "supportsVision",
            "supportsStreaming",
            "equivalenceGroup",
            "evalScore",
            "inputCostMicrosPerMillion",
            "outputCostMicrosPerMillion",
            "verified",
          ],
          [
            "providerId",
            "endpointId",
            "modelId",
            "routeKind",
            "contextWindow",
            "supportsTools",
            "supportsStructuredOutput",
            "supportsVision",
            "supportsStreaming",
            "equivalenceGroup",
            "evalScore",
            "inputCostMicrosPerMillion",
            "outputCostMicrosPerMillion",
            "verified",
          ],
        ),
      async handle(context, command, value) {
        const registered = await dependencies.router?.registerModel(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelProfile", id: registered.profile.model_profile_id },
          data: { modelProfileId: registered.profile.model_profile_id, modelId: registered.profile.model_id },
        });
      },
    });
    register(registry, {
      operation: "router.model.enabled.set",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate(value) {
        const parsed = payload(value, ["modelProfileId", "enabled"], ["modelProfileId", "enabled"]);
        const modelProfileId = string(parsed.modelProfileId, "modelProfileId").trim();
        if (!modelProfileId || modelProfileId.length > 256)
          throw new Error("modelProfileId 문자열이 유효하지 않습니다");
        return { modelProfileId, enabled: boolean(parsed.enabled, "enabled") };
      },
      async handle(context, command, value) {
        const changed = await dependencies.router?.setModelEnabled(context, {
          commandId: command.commandId,
          modelProfileId: value.modelProfileId,
          enabled: value.enabled,
        });
        if (!changed) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelProfile", id: changed.profile.model_profile_id },
          data: {
            modelProfileId: changed.profile.model_profile_id,
            modelId: changed.profile.model_id,
            enabled: changed.profile.enabled,
          },
        });
      },
    });
    register(registry, {
      operation: "router.route.budget.set",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["routeId", "requestBudgetMicros", "totalBudgetMicros"], ["routeId"]),
      async handle(context, command, value) {
        const changed = await dependencies.router?.setRouteBudget(context, {
          commandId: command.commandId,
          routeId: string(value.routeId, "routeId"),
          requestBudgetMicros: Number(value.requestBudgetMicros ?? 0),
          totalBudgetMicros: Number(value.totalBudgetMicros ?? 0),
        });
        if (!changed) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelRoute", id: changed.route.route_id },
          data: {
            routeId: changed.route.route_id,
            requestBudgetMicros: changed.route.request_budget_micros,
            totalBudgetMicros: changed.route.total_budget_micros,
            spentMicros: changed.route.spent_micros,
          },
        });
      },
    });
    register(registry, {
      operation: "router.route.configure",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, [
          "name",
          "routeKind",
          "credentialPolicy",
          "dataPolicy",
          "equivalenceGroup",
          "minEvalScore",
          "requireTools",
          "requireStructuredOutput",
          "requireVision",
          "requireStreaming",
          "maxContextTokens",
          "requestBudgetMicros",
          "totalBudgetMicros",
        ]),
      async handle(context, command, value) {
        const configured = await dependencies.router?.createRoute(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!configured) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelRoute", id: configured.route.route_id },
          data: { routeId: configured.route.route_id, name: configured.route.name, enabled: configured.route.enabled },
        });
      },
    });
    register(registry, {
      operation: "router.candidate.add",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["routeId", "modelProfileId", "priority"], ["routeId", "modelProfileId", "priority"]),
      async handle(context, command, value) {
        const added = await dependencies.router?.addCandidate(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!added) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "RouteCandidate", id: added.candidate.candidate_id },
          data: { candidateId: added.candidate.candidate_id, routeId: added.candidate.route_id },
        });
      },
    });
  }
}

function registerAssuranceBindings(
  registry: ApplicationCommandRegistry,
  bindings: NonNullable<ApplicationDomainDependencies["assuranceBindings"]>,
): void {
  register(registry, {
    operation: "assurance.binding.propose",
    requiredScopes: ["assurance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "planVersionId", "profileId", "profileVersion", "authorHandle", "requiredCriteria", "bindings"],
        ["workId", "planVersionId", "profileId", "profileVersion", "authorHandle", "requiredCriteria", "bindings"],
      ),
    async handle(context, command, value) {
      const proposed = await bindings.propose(context, { commandId: command.commandId, ...value } as never);
      return result(command, {
        resource: { type: "AssuranceBindingVersion", id: proposed.bindingVersionId, revision: proposed.revision },
        data: {
          bindingVersionId: proposed.bindingVersionId,
          status: proposed.status,
          revision: proposed.revision,
        },
      });
    },
  });
  register(registry, {
    operation: "assurance.binding.activate",
    requiredScopes: ["assurance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(value, ["bindingVersionId", "expectedRevision", "approvalId"], ["bindingVersionId", "expectedRevision"]),
    idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
    resumeAwaitingApproval: (value) => value.approvalId !== undefined,
    async handle(context, command, value) {
      try {
        const activated = await bindings.activate(context, {
          commandId: command.commandId,
          bindingVersionId: string(value.bindingVersionId, "bindingVersionId"),
          expectedRevision: integer(value.expectedRevision, "expectedRevision", 1),
          ...(value.approvalId === undefined ? {} : { approvalId: string(value.approvalId, "approvalId") }),
        });
        return result(command, {
          resource: {
            type: "AssuranceBindingVersion",
            id: activated.bindingVersionId,
            revision: activated.revision,
          },
          data: {
            bindingVersionId: activated.bindingVersionId,
            status: activated.status,
            revision: activated.revision,
          },
        });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError)
          return result(command, {
            outcome: "awaiting-approval",
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        throw error;
      }
    },
  });
}

function registerSubscriptions(
  registry: ApplicationCommandRegistry,
  dependencies: ApplicationDomainDependencies,
): void {
  const connectors = dependencies.subscriptionConnectors;
  if (connectors) {
    register(registry, {
      operation: "subscription.connector.enroll",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "operator-action",
      validate: (value) =>
        payload(
          value,
          [
            "enrollmentId",
            "enrollmentCode",
            "challengeNonce",
            "expiresAt",
            "connectorId",
            "publicKey",
            "protocol",
            "version",
            "capabilities",
            "signature",
          ],
          [
            "enrollmentId",
            "enrollmentCode",
            "challengeNonce",
            "expiresAt",
            "connectorId",
            "publicKey",
            "protocol",
            "version",
            "capabilities",
            "signature",
          ],
        ),
      async handle(_context, command, value) {
        const connector = await connectors.enroll({
          enrollmentId: string(value.enrollmentId, "enrollmentId"),
          enrollmentCode: string(value.enrollmentCode, "enrollmentCode"),
          challengeNonce: string(value.challengeNonce, "challengeNonce"),
          expiresAt: string(value.expiresAt, "expiresAt"),
          connectorId: string(value.connectorId, "connectorId"),
          publicKey: string(value.publicKey, "publicKey"),
          protocol: string(value.protocol, "protocol"),
          version: string(value.version, "version"),
          capabilities: strings(value.capabilities, "capabilities"),
          signature: string(value.signature, "signature"),
        });
        return result(command, {
          resource: { type: "SubscriptionConnector", id: connector.connector_id },
          data: subscriptionConnectorData(connector),
        });
      },
    });

    register(registry, {
      operation: "subscription.connector.revoke",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["connectorId"], ["connectorId"]),
      async handle(context, command, value) {
        const connector = await connectors.revoke(context, string(value.connectorId, "connectorId"));
        return result(command, {
          resource: { type: "SubscriptionConnector", id: connector.connector_id },
          data: subscriptionConnectorData(connector),
        });
      },
    });
  }

  const serverConnections = dependencies.subscriptionServerConnections;
  if (serverConnections) {
    register(registry, {
      operation: "subscription.server.connect-model",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      retryFailedCommand: true,
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "alias",
            "authKind",
            "billingKind",
            "secret",
            "endpointUrl",
            "protocol",
            "acceptExperimental",
            "priority",
            "weight",
          ],
          ["providerId", "alias", "authKind", "billingKind", "secret"],
        ),
      async handle(context, command, value) {
        const connected = await serverConnections.connectModel(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          authKind: subscriptionModelAuthKind(value.authKind),
          billingKind: string(value.billingKind, "billingKind"),
          secret: subscriptionSecret(value.secret),
          ...(value.endpointUrl === undefined ? {} : { endpointUrl: string(value.endpointUrl, "endpointUrl") }),
          ...(value.protocol === undefined ? {} : { protocol: subscriptionProtocol(value.protocol) }),
          ...(value.acceptExperimental === undefined
            ? {}
            : { acceptExperimental: boolean(value.acceptExperimental, "acceptExperimental") }),
          ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
          ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
        });
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: connected.account.account_id,
            revision: connected.account.version,
          },
          data: {
            ...subscriptionAccountData(connected.account),
            connectorStatus: connected.connector.status,
          },
        });
      },
    });

    register(registry, {
      operation: "subscription.server.prepare",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      retryFailedCommand: true,
      validate: (value) =>
        payload(
          value,
          ["providerId", "alias", "authKind", "billingKind", "priority", "weight"],
          ["providerId", "alias", "authKind", "billingKind"],
        ),
      async handle(context, command, value) {
        const prepared = await serverConnections.prepare(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          authKind: subscriptionAuthKind(value.authKind),
          billingKind: string(value.billingKind, "billingKind"),
          ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
          ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
        });
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: prepared.account.account_id,
            revision: prepared.account.version,
          },
          data: {
            ...subscriptionAccountData(prepared.account),
            connectorStatus: prepared.connector.status,
            loginRequired: prepared.connector.status !== "ready",
            profileHandle: subscriptionProfileHandle(prepared.profileHandle),
          },
        });
      },
    });

    for (const [operation, method] of [
      ["subscription.server.attest", "attest"],
      ["subscription.server.offline", "offline"],
    ] as const) {
      register(registry, {
        operation,
        requiredScopes: ["subscription:write"],
        allowedRoles: ["owner", "admin", "member"],
        recovery: "replay-domain",
        ...(operation === "subscription.server.attest" ? { retryFailedCommand: true } : {}),
        validate: (value) =>
          payload(value, method === "attest" ? ["connectorId", "accountId", "modelId"] : ["connectorId"], [
            "connectorId",
          ]),
        async handle(context, command, value) {
          const connector = await serverConnections[method](context, {
            commandId: command.commandId,
            connectorId: string(value.connectorId, "connectorId"),
            ...(method !== "attest" || value.accountId === undefined
              ? {}
              : { accountId: string(value.accountId, "accountId") }),
            ...(method !== "attest" || value.modelId === undefined
              ? {}
              : { modelId: string(value.modelId, "modelId") }),
          });
          const modelRuntime =
            method === "attest"
              ? (
                  connector as {
                    readonly modelRuntime?: {
                      readonly modelId: string;
                      readonly modelProfileId: string;
                      readonly routeNames: readonly string[];
                    };
                  }
                ).modelRuntime
              : undefined;
          return result(command, {
            resource: { type: "SubscriptionConnector", id: connector.connectorId },
            data: {
              ...subscriptionServerConnectorData(connector),
              ...(modelRuntime
                ? {
                    modelId: modelRuntime.modelId,
                    modelProfileId: modelRuntime.modelProfileId,
                    routeNames: modelRuntime.routeNames,
                  }
                : {}),
            },
          });
        },
      });
    }
  }

  const accounts = dependencies.subscriptionAccounts;
  const connections = dependencies.subscriptionConnections;
  if (accounts || connections) {
    register(registry, {
      operation: "subscription.account.register",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "alias",
            "connectorId",
            "profileLocator",
            "authKind",
            "billingKind",
            "endpointUrl",
            "protocol",
            "acceptExperimental",
            "priority",
            "weight",
          ],
          ["providerId", "alias", "connectorId", "profileLocator", "billingKind"],
        ),
      async handle(context, command, value) {
        const common = {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          connectorId: string(value.connectorId, "connectorId"),
          profileLocator: string(value.profileLocator, "profileLocator"),
          billingKind: string(value.billingKind, "billingKind"),
        };
        let account;
        if (connections) {
          account = (
            await connections.connect(context, {
              ...common,
              authKind: subscriptionAuthKind(value.authKind),
              ...(value.endpointUrl === undefined ? {} : { endpointUrl: string(value.endpointUrl, "endpointUrl") }),
              ...(value.protocol === undefined ? {} : { protocol: subscriptionProtocol(value.protocol) }),
              ...(value.acceptExperimental === undefined
                ? {}
                : { acceptExperimental: boolean(value.acceptExperimental, "acceptExperimental") }),
              ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
              ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
            })
          ).account;
        } else {
          if (!accounts) throw new Error("구독 계정 서비스가 구성되지 않았습니다");
          account = await accounts.register(context, common);
        }
        return result(command, {
          resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
          data: subscriptionAccountData(account),
        });
      },
    });
  }

  if (accounts) {
    register(registry, {
      operation: "subscription.account.share",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["accountId", "approvalId"], ["accountId"]),
      idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
      resumeAwaitingApproval: (value) => value.approvalId !== undefined,
      async handle(context, command, value) {
        try {
          const account = await accounts.share(context, {
            commandId: command.commandId,
            accountId: string(value.accountId, "accountId"),
            expectedVersion: expectedRevision(command),
            ...(value.approvalId === undefined ? {} : { approvalId: string(value.approvalId, "approvalId") }),
          });
          return result(command, {
            resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
            data: subscriptionAccountData(account),
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError) {
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          }
          throw error;
        }
      },
    });

    const definitions = [["subscription.account.unshare", "unshare"]] as const;
    for (const [operation, method] of definitions) {
      register(registry, {
        operation,
        requiredScopes: ["subscription:write"],
        allowedRoles: ["owner", "admin", "member"],
        recovery: "replay-domain",
        validate: (value) => payload(value, ["accountId"], ["accountId"]),
        async handle(context, command, value) {
          const account = await accounts[method](context, {
            commandId: command.commandId,
            accountId: string(value.accountId, "accountId"),
            expectedVersion: expectedRevision(command),
          });
          return result(command, {
            resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
            data: subscriptionAccountData(account),
          });
        },
      });
    }

    register(registry, {
      operation: "subscription.account.disconnect",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["accountId"], ["accountId"]),
      async handle(context, command, value) {
        const disconnectInput = {
          commandId: command.commandId,
          accountId: string(value.accountId, "accountId"),
          expectedVersion: expectedRevision(command),
        };
        const disconnected = connections
          ? await connections.disconnect(context, disconnectInput)
          : { account: await accounts.disconnect(context, disconnectInput), revokedCredentialCount: undefined };
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: disconnected.account.account_id,
            revision: disconnected.account.version,
          },
          data: {
            ...subscriptionAccountData(disconnected.account),
            ...(disconnected.revokedCredentialCount === undefined
              ? {}
              : { revokedCredentialCount: disconnected.revokedCredentialCount }),
          },
        });
      },
    });
  }

  const policy = dependencies.subscriptionPolicy;
  if (policy) {
    register(registry, {
      operation: "subscription.policy.configure",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["providerId", "credentialPolicy", "approvalMode"], ["providerId", "credentialPolicy"]),
      async handle(context, command, value) {
        const providerId = string(value.providerId, "providerId");
        const configured = await policy.configure(context, {
          commandId: command.commandId,
          providerId,
          credentialPolicy: subscriptionCredentialPolicy(value.credentialPolicy),
          ...(value.approvalMode === undefined
            ? {}
            : { approvalMode: providerApprovalMode(providerId, value.approvalMode) }),
          ...(command.expectedRevision === undefined ? {} : { expectedVersion: command.expectedRevision }),
        });
        return result(command, {
          resource: { type: "SubscriptionPolicy", id: configured.providerId, revision: configured.version },
          data: subscriptionPolicyData(configured),
        });
      },
    });
  }
}

function optimizationRole(value: unknown): OptimizationRoleKey {
  const candidate = string(value, "roleKey");
  if (!isOptimizationRoleKey(candidate)) throw new Error("지원하지 않는 최적화 roleKey입니다");
  return candidate;
}

function optimizationPolicy(value: unknown): EvaluationPolicy {
  const candidate = string(value, "policy");
  if (!new Set(["quality", "value", "speed", "privacy", "manual"]).has(candidate)) {
    throw new Error("지원하지 않는 최적화 policy입니다");
  }
  return candidate as EvaluationPolicy;
}

function optimizationCandidate(value: unknown): OptimizationModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("모델 후보가 object여야 합니다");
  const candidate = value as Record<string, unknown>;
  return {
    modelProfileId: string(candidate.modelProfileId, "modelProfileId"),
    modelId: string(candidate.modelId, "modelId"),
    routeId: string(candidate.routeId, "routeId"),
    providerId: string(candidate.providerId, "providerId"),
    verified: boolean(candidate.verified, "verified"),
    supportsStructuredOutput: boolean(candidate.supportsStructuredOutput, "supportsStructuredOutput"),
    supportsTools: boolean(candidate.supportsTools, "supportsTools"),
    supportsStreaming: boolean(candidate.supportsStreaming, "supportsStreaming"),
    dataPolicy:
      candidate.dataPolicy === "local-private"
        ? "local-private"
        : candidate.dataPolicy === "external-allowed"
          ? "external-allowed"
          : (() => {
              throw new Error("dataPolicy가 유효하지 않습니다");
            })(),
  };
}

function optimizationCandidates(value: unknown): readonly OptimizationModelProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 128)
    throw new Error("모델 후보 목록이 유효하지 않습니다");
  return value.map(optimizationCandidate);
}

function optimizationReceipts(value: unknown): readonly EvaluationReceipt[] {
  if (!Array.isArray(value) || (value.length > 0 && value.length > 1_024))
    throw new Error("모델 receipt 목록이 유효하지 않습니다");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("모델 receipt가 object여야 합니다");
    const receipt = item as Record<string, unknown>;
    return {
      roleKey: optimizationRole(receipt.roleKey),
      modelProfileId: string(receipt.modelProfileId, "modelProfileId"),
      bundleVersion: integer(receipt.bundleVersion, "bundleVersion", 1),
      sampleCount: integer(receipt.sampleCount, "sampleCount", 0),
      qualityScore: Number(receipt.qualityScore),
      latencyMs: Number(receipt.latencyMs),
      costMicros: Number(receipt.costMicros),
      privacyAllowed: boolean(receipt.privacyAllowed, "privacyAllowed"),
      completed: boolean(receipt.completed, "completed"),
      inputChecksum: string(receipt.inputChecksum, "inputChecksum"),
      receiptChecksum: string(receipt.receiptChecksum, "receiptChecksum"),
    };
  });
}

function optimizationRequirements(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("모델 평가 requirements가 object여야 합니다");
  const requirements = value as Record<string, unknown>;
  return {
    requiresTools: boolean(requirements.requiresTools, "requiresTools"),
    requiresStructuredOutput: boolean(requirements.requiresStructuredOutput, "requiresStructuredOutput"),
    requiresStreaming: boolean(requirements.requiresStreaming, "requiresStreaming"),
    dataPolicy:
      requirements.dataPolicy === "local-private"
        ? "local-private"
        : requirements.dataPolicy === "external-allowed"
          ? "external-allowed"
          : (() => {
              throw new Error("requirements dataPolicy가 유효하지 않습니다");
            })(),
  } as const;
}

function registerOptimization(registry: ApplicationCommandRegistry, dependencies: ApplicationDomainDependencies): void {
  const optimization = dependencies.optimization;
  if (!optimization) return;

  register(registry, {
    operation: "optimization.policy.configure",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "policy",
          "autoOptimize",
          "productionLearning",
          "shadowEnabled",
          "minimumSampleCount",
          "improvementThreshold",
          "observationBudgetMicros",
          "observationRetentionDays",
          "governanceDecisionId",
        ],
        ["policy", "autoOptimize", "productionLearning", "shadowEnabled", "governanceDecisionId"],
      ),
    async handle(context, command, value) {
      const configured = await optimization.evaluations.configurePolicy(context, {
        commandId: command.commandId,
        policy: optimizationPolicy(value.policy),
        autoOptimize: boolean(value.autoOptimize, "autoOptimize"),
        productionLearning: boolean(value.productionLearning, "productionLearning"),
        shadowEnabled: boolean(value.shadowEnabled, "shadowEnabled"),
        ...(value.minimumSampleCount === undefined
          ? {}
          : { minimumSampleCount: integer(value.minimumSampleCount, "minimumSampleCount", 1) }),
        ...(value.improvementThreshold === undefined
          ? {}
          : { improvementThreshold: Number(value.improvementThreshold) }),
        ...(value.observationBudgetMicros === undefined
          ? {}
          : { observationBudgetMicros: Number(value.observationBudgetMicros) }),
        ...(value.observationRetentionDays === undefined
          ? {}
          : { observationRetentionDays: integer(value.observationRetentionDays, "observationRetentionDays", 1) }),
        governanceDecisionId: string(value.governanceDecisionId, "governanceDecisionId"),
      });
      return result(command, {
        resource: { type: "OptimizationPolicy", id: configured.policyVersionId, revision: configured.version },
        data: configured,
      });
    },
  });

  register(registry, {
    operation: "optimization.bundle.create",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["roleKey", "runtimeVersion", "cases"], ["roleKey", "runtimeVersion", "cases"]),
    async handle(context, command, value) {
      const cases = Array.isArray(value.cases)
        ? value.cases.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
              throw new Error("평가 case가 object여야 합니다");
            const evaluationCase = item as Record<string, unknown>;
            return {
              promptChecksum: string(evaluationCase.promptChecksum, "promptChecksum"),
              toolsChecksum: string(evaluationCase.toolsChecksum, "toolsChecksum"),
              environmentChecksum: string(evaluationCase.environmentChecksum, "environmentChecksum"),
              ...(evaluationCase.prompt === undefined ? {} : { prompt: string(evaluationCase.prompt, "prompt") }),
              expectedOutcome: string(evaluationCase.expectedOutcome, "expectedOutcome"),
            };
          })
        : (() => {
            throw new Error("평가 cases가 배열이어야 합니다");
          })();
      const bundle = await optimization.evaluations.createBundle(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        runtimeVersion: string(value.runtimeVersion, "runtimeVersion"),
        cases,
      });
      return result(command, {
        resource: { type: "OptimizationBundle", id: bundle.bundleId, revision: bundle.version },
        data: bundle,
      });
    },
  });

  register(registry, {
    operation: "optimization.bundle.export",
    requiredScopes: ["optimization:read"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["bundleId", "license", "configurationChecksum"],
        ["bundleId", "license", "configurationChecksum"],
      ),
    async handle(context, command, value) {
      const exported = await optimization.evaluations.exportBundle(context, {
        bundleId: string(value.bundleId, "bundleId"),
        license: string(value.license, "license"),
        configurationChecksum: string(value.configurationChecksum, "configurationChecksum"),
      });
      return result(command, {
        resource: { type: "OptimizationBundleExport", id: exported.bundle.bundleId },
        data: exported,
      });
    },
  });

  register(registry, {
    operation: "optimization.bundle.import",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["export"], ["export"]),
    async handle(context, command, value) {
      const bundle = await optimization.evaluations.importBundle(context, {
        commandId: command.commandId,
        exportValue: value.export,
      });
      return result(command, {
        resource: { type: "OptimizationBundle", id: bundle.bundleId, revision: bundle.version },
        data: bundle,
      });
    },
  });

  register(registry, {
    operation: "optimization.evaluation.start",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion", "inputChecksum", "mode"],
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion", "inputChecksum"],
      ),
    async handle(context, command, value) {
      const run = await optimization.evaluations.startEvaluation(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        bundleId: string(value.bundleId, "bundleId"),
        modelProfileId: string(value.modelProfileId, "modelProfileId"),
        runtimeVersion: string(value.runtimeVersion, "runtimeVersion"),
        inputChecksum: string(value.inputChecksum, "inputChecksum"),
        ...(value.mode === undefined ? {} : { mode: value.mode as "standard" | "shadow" }),
      });
      return result(command, { resource: { type: "OptimizationRun", id: run.runId }, data: run });
    },
  });

  register(registry, {
    operation: "optimization.evaluation.complete",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["runId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "privacyAllowed", "completed"],
        ["runId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "privacyAllowed", "completed"],
      ),
    async handle(context, command, value) {
      const receipt = await optimization.evaluations.completeEvaluation(context, {
        commandId: command.commandId,
        runId: string(value.runId, "runId"),
        sampleCount: integer(value.sampleCount, "sampleCount", 1),
        qualityScore: Number(value.qualityScore),
        latencyMs: Number(value.latencyMs),
        costMicros: Number(value.costMicros),
        privacyAllowed: boolean(value.privacyAllowed, "privacyAllowed"),
        completed: boolean(value.completed, "completed"),
      });
      return result(command, { resource: { type: "OptimizationReceipt", id: receipt.receiptId }, data: receipt });
    },
  });

  register(registry, {
    operation: "optimization.evaluation.execute",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion", "mode", "inputChecksum"],
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion"],
      ),
    async handle(context, command, value) {
      const receipt = await optimization.evaluations.executeEvaluation(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        bundleId: string(value.bundleId, "bundleId"),
        modelProfileId: string(value.modelProfileId, "modelProfileId"),
        runtimeVersion: string(value.runtimeVersion, "runtimeVersion"),
        ...(value.mode === undefined ? {} : { mode: value.mode as "standard" | "shadow" }),
        ...(value.inputChecksum === undefined ? {} : { inputChecksum: string(value.inputChecksum, "inputChecksum") }),
      });
      return result(command, { resource: { type: "OptimizationReceipt", id: receipt.receiptId }, data: receipt });
    },
  });

  register(registry, {
    operation: "optimization.recommend",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["roleKey", "candidates", "receipts", "requirements", "manualModelProfileId"],
        ["roleKey", "receipts", "requirements"],
      ),
    async handle(context, command, value) {
      const recommendation = await optimization.evaluations.recommend(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        candidates: optimizationCandidates(value.candidates),
        receipts: optimizationReceipts(value.receipts),
        requirements: optimizationRequirements(value.requirements),
        ...(value.manualModelProfileId === undefined
          ? {}
          : { manualModelProfileId: string(value.manualModelProfileId, "manualModelProfileId") }),
      });
      return result(command, {
        resource: { type: "OptimizationRecommendation", id: recommendation.recommendationId },
        data: recommendation,
      });
    },
  });

  register(registry, {
    operation: "optimization.recommendation.approve",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["recommendationId", "approvalId"], ["recommendationId"]),
    idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
    resumeAwaitingApproval: (value) => value.approvalId !== undefined,
    async handle(context, command, value) {
      const recommendationId = string(value.recommendationId, "recommendationId");
      const recommendations = (await optimization.evaluations.listRecommendations(context)).filter(
        (recommendation: ModelRecommendationRecord) => recommendation.recommendationId === recommendationId,
      );
      if (recommendations.length !== 1 || recommendations[0]?.organizationId !== context.organizationId) {
        throw new Error("현재 tenant의 모델 추천을 정확히 하나 찾을 수 없습니다");
      }
      if (recommendations[0].status !== "pending-approval") {
        throw new Error("pending-approval 상태가 아닌 모델 추천의 새 승인 절차는 허용되지 않습니다");
      }
      if (!dependencies.governanceGate) throw new Error("모델 추천 승인 Governance Gate가 구성되지 않았습니다");
      let authorization: Awaited<ReturnType<GovernanceGate["authorize"]>>;
      try {
        authorization = await dependencies.governanceGate.authorize(context, {
          commandId: `${command.commandId}:governance`,
          action: "model.optimization.approve",
          resource: {
            type: "OptimizationRecommendation",
            id: recommendationId,
            attributes: { recommendationChecksum: recommendations[0].checksum },
          },
          environment: "local",
          riskClass: "model-optimization",
          external: false,
          executionId: `optimization-recommendation:${recommendationId}`,
          approvalPreview: {
            kind: "provider",
            title: "모델 최적화 추천 승인",
            reason: "검증된 평가 결과에 따라 활성 모델 선택 계보를 변경합니다.",
          },
          ...(value.approvalId === undefined ? {} : { approvalId: string(value.approvalId, "approvalId") }),
        });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError) {
          return result(command, {
            outcome: "awaiting-approval",
            resource: { type: "OptimizationRecommendation", id: recommendationId },
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        }
        throw error;
      }
      const approved = await optimization.batches.approveRecommendation(context, {
        commandId: command.commandId,
        recommendationId,
        recommendationChecksum: recommendations[0].checksum,
        governanceDecisionId: authorization.decision.decisionId,
      });
      return result(command, {
        resource: { type: "OptimizationRecommendation", id: approved.recommendationId },
        data: approved,
      });
    },
  });

  register(registry, {
    operation: "optimization.batch.create",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["recommendationId", "status"], ["recommendationId", "status"]),
    async handle(context, command, value) {
      const batch = await optimization.batches.createBatch(context, {
        commandId: command.commandId,
        recommendationId: string(value.recommendationId, "recommendationId"),
        status: value.status as never,
      });
      return result(command, {
        resource: { type: "OptimizationBatch", id: batch.batchId, revision: batch.version },
        data: batch,
      });
    },
  });

  register(registry, {
    operation: "optimization.batch.activate",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["batchId"], ["batchId"]),
    async handle(context, command, value) {
      const batch = await optimization.batches.activateBatch(context, {
        commandId: command.commandId,
        batchId: string(value.batchId, "batchId"),
      });
      return result(command, {
        resource: { type: "OptimizationBatch", id: batch.batchId, revision: batch.version },
        data: batch,
      });
    },
  });

  register(registry, {
    operation: "optimization.observation.record",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["batchId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "status", "source"],
        ["batchId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "status"],
      ),
    async handle(context, command, value) {
      const observation = await optimization.batches.recordObservation(context, {
        commandId: command.commandId,
        batchId: string(value.batchId, "batchId"),
        sampleCount: integer(value.sampleCount, "sampleCount", 1),
        qualityScore: Number(value.qualityScore),
        latencyMs: Number(value.latencyMs),
        costMicros: Number(value.costMicros),
        status: value.status as "healthy" | "degraded",
        ...(value.source === undefined ? {} : { source: value.source as "evaluation" | "production" }),
      });
      return result(command, {
        resource: { type: "OptimizationObservation", id: observation.observationId },
        data: observation,
      });
    },
  });

  register(registry, {
    operation: "optimization.recover",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["observationId"], ["observationId"]),
    async handle(context, command, value) {
      const recovery = await optimization.batches.recover(context, {
        commandId: command.commandId,
        observationId: string(value.observationId, "observationId"),
      });
      return result(command, { resource: { type: "OptimizationRecovery", id: recovery.recoveryId }, data: recovery });
    },
  });
}

export function registerApplicationDomainCommands(
  registry: ApplicationCommandRegistry,
  dependencies: ApplicationDomainDependencies,
): void {
  if (dependencies.works) registerWork(registry, dependencies.works);
  if (dependencies.workspaces) registerWorkspace(registry, dependencies.workspaces);
  if (dependencies.autonomy) registerAutonomy(registry, dependencies.autonomy, dependencies.autonomyTransition);
  if (dependencies.emergency && dependencies.runtime?.cancelOrganization)
    registerEmergency(
      registry,
      dependencies.emergency,
      dependencies.runtime,
      dependencies.approvals,
      dependencies.governanceGate,
    );
  if (dependencies.runtime) registerRuntime(registry, dependencies.runtime);
  if (dependencies.approvals) registerApprovals(registry, dependencies.approvals, dependencies.runtime);
  if (dependencies.assuranceBindings) registerAssuranceBindings(registry, dependencies.assuranceBindings);
  if (dependencies.organization) registerOrganization(registry, dependencies.organization);
  if (dependencies.extension) registerExtension(registry, dependencies.extension);
  if (dependencies.growth) registerGrowth(registry, dependencies.growth, dependencies.approvals);
  registerRouter(registry, dependencies);
  registerSubscriptions(registry, dependencies);
  registerOptimization(registry, dependencies);
}
