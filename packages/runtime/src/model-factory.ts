import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

import type { TenantContext } from "@massion/identity";
import {
  createSecureProviderFetch,
  validateDiscoveryBaseUrl,
  type FailureSignal,
  type ModelProvider,
  type ModelRouter,
  type ProviderEndpoint,
  type ProviderService,
  type RouteAttempt,
} from "@massion/router";
import type {
  AcquireSessionInput,
  ConnectorFailureSignal,
  ConnectorSessionLease,
  SubscriptionScope,
} from "@massion/subscriptions";

import type { ExecutionKind, StructuredOutputSpec, WorkspaceAccess } from "./contracts.js";
import type { RuntimeExecutionStore } from "./execution-store.js";
import type { SubscriptionAgentResult, SubscriptionAgentUsage } from "./subscriptions/agent-runtime.js";
import { SubscriptionExecutionReceiptCoordinator } from "./subscriptions/execution-receipt.js";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const GPT_56_RESPONSES_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export interface ProviderModelSelection {
  readonly provider: ModelProvider;
  readonly endpoint: ProviderEndpoint;
  readonly modelId: string;
  readonly credentialId: string;
  readonly secret: string;
  readonly supportsStructuredOutputs: boolean;
}

export interface ProviderModelBuilder {
  build(selection: ProviderModelSelection): LanguageModel;
}

export interface AcquireModelInput {
  readonly commandId: string;
  readonly executionId?: string;
  readonly optimizationRunId?: string;
  readonly workId?: string;
  readonly taskId?: string;
  readonly agentHandle?: string;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly workspaceCapability?: string;
  readonly workspaceRoot?: string;
  readonly instruction?: string;
  readonly requiredExecutionKind?: ExecutionKind;
  readonly routeName: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly stickyKey?: string;
  readonly preferredModelProfileIds?: readonly string[];
  readonly fallbackFromAttemptId?: string;
  readonly fallbackFromLeaseId?: string;
}

export interface ModelCompletionUsage {
  readonly commandId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelFailureUsage extends ModelCompletionUsage {
  readonly signal: FailureSignal;
  readonly emittedTokens: number;
  readonly sideEffectsStarted?: boolean;
}

export interface ModelFailureOutcome {
  readonly status: RouteAttempt["status"];
  readonly failureClass?: string;
  readonly fallbackAllowed: boolean;
}

export interface RoutedModelSelectionLease {
  readonly attemptId: string;
  readonly modelProfileId?: string;
  readonly optimizationBatchId?: string;
  readonly preferenceApplied?: boolean;
  fail(usage: ModelFailureUsage): Promise<ModelFailureOutcome>;
}

interface RoutedExecutionLeaseBase extends RoutedModelSelectionLease {
  readonly credentialId: string;
  readonly sessionLeaseId?: string;
  complete(usage: ModelCompletionUsage): Promise<RouteAttempt>;
}

export interface RoutedLanguageModelLease extends RoutedExecutionLeaseBase {
  readonly kind: "model";
  readonly model: LanguageModel;
  readonly supportsStructuredOutput: boolean;
}

export type RoutedAgentRuntimeResult =
  | (Omit<Extract<SubscriptionAgentResult, { readonly outcome: "completed" }>, "usage"> & {
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    })
  | Extract<SubscriptionAgentResult, { readonly outcome: "suspended" }>
  | Extract<SubscriptionAgentResult, { readonly outcome: "cancelled" }>
  | (Omit<
      Extract<SubscriptionAgentResult, { readonly outcome: "failed" }>,
      "signal" | "emittedTokens" | "sideEffectsStarted" | "usage"
    > & {
      readonly signal: FailureSignal;
      readonly emittedTokens: number;
      readonly sideEffectsStarted: boolean;
      readonly usage?: SubscriptionAgentUsage;
    });

export interface RoutedAgentRuntimeExecutor {
  execute(input: {
    readonly executionId: string;
    readonly prompt: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<RoutedAgentRuntimeResult>;
  executeStructured?(
    input: { readonly executionId: string; readonly prompt: string; readonly abortSignal?: AbortSignal },
    output: StructuredOutputSpec,
  ): Promise<RoutedAgentRuntimeResult>;
  resume?(input: {
    readonly executionId: string;
    readonly sessionId: string;
    readonly approvalId: string;
    readonly approved: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<RoutedAgentRuntimeResult>;
  cancel?(): Promise<void>;
}

export interface RoutedAgentRuntimeLease extends RoutedExecutionLeaseBase {
  readonly kind: "agent-runtime";
  readonly sessionLeaseId: string;
  readonly sessionExpiresAt: string;
  readonly subscription: {
    readonly workId: string;
    readonly agentHandle: string;
    readonly accountId: string;
    readonly connectorId: string;
    readonly adapterId: string;
    readonly quotaSnapshotId?: string;
  };
  readonly executor: RoutedAgentRuntimeExecutor;
  renewSession(input: { readonly commandId: string; readonly expectedExpiresAt: string }): Promise<string>;
}

export type RoutedModelLease = RoutedLanguageModelLease | RoutedAgentRuntimeLease;

export interface RoutedModelFactory {
  acquire(context: TenantContext, input: AcquireModelInput): Promise<RoutedModelLease>;
  recoverReservedSelection?(
    context: TenantContext,
    executionId: string,
  ): Promise<RoutedModelSelectionLease | undefined>;
  createSubscriptionReceipts?(store: RuntimeExecutionStore): SubscriptionExecutionReceiptCoordinator | undefined;
}

export interface RoutedModelPreferenceResolver {
  resolve(context: TenantContext, input: AcquireModelInput): Promise<ModelPreferenceResolution | undefined>;
}

export interface ModelPreferenceResolution {
  readonly profileIds: readonly string[];
  readonly batchId?: string;
}

export interface ConnectorSessionBroker {
  acquire(context: TenantContext, input: AcquireSessionInput): Promise<ConnectorSessionLease>;
  bindRuntime(
    context: TenantContext,
    input: { readonly commandId: string; readonly leaseId: string; readonly adapterId: string },
  ): Promise<{ readonly adapterId?: string }>;
  recoverActive(context: TenantContext): Promise<readonly ConnectorSessionLease[]>;
  getLease(context: TenantContext, leaseId: string): Promise<ConnectorSessionLease>;
  findExecutionLeases(context: TenantContext, executionId: string): Promise<readonly ConnectorSessionLease[]>;
}

export interface ConnectorRuntimeResolutionInput {
  readonly executionId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly agentHandle: string;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly workspaceCapability?: string;
  readonly workspaceRoot?: string;
  readonly instruction?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly scope: SubscriptionScope;
  readonly routeAttemptId: string;
  readonly quotaSnapshotId?: string;
  readonly sessionLeaseId: string;
}

export type ConnectorRuntimeBinding =
  | { readonly kind: "model"; readonly model: LanguageModel }
  | { readonly kind: "agent-runtime"; readonly executor: RoutedAgentRuntimeExecutor; readonly adapterId: string };

export interface ConnectorRuntimeResolver {
  resolve(context: TenantContext, input: ConnectorRuntimeResolutionInput): Promise<ConnectorRuntimeBinding>;
}

export interface ConnectorRouteAttemptReader {
  read(context: TenantContext, attemptId: string): Promise<RouteAttempt>;
}

export interface ConnectorRuntimeDependencies {
  readonly broker: ConnectorSessionBroker;
  readonly resolver: ConnectorRuntimeResolver;
  readonly routeAttempts?: ConnectorRouteAttemptReader;
}

export class RoutedExecutionSettlementError extends Error {
  public constructor(message: string, options: { readonly cause: unknown }) {
    super(message, options);
    this.name = "RoutedExecutionSettlementError";
  }
}

function isOfficialOpenAiApi(endpoint: ProviderEndpoint): boolean {
  try {
    const href = new URL(endpoint.base_url).href;
    return href === OPENAI_API_BASE_URL || href === `${OPENAI_API_BASE_URL}/`;
  } catch {
    return false;
  }
}

function usesGpt56Responses(selection: ProviderModelSelection): boolean {
  return (
    selection.provider.adapter_kind === "ai-sdk" &&
    isOfficialOpenAiApi(selection.endpoint) &&
    GPT_56_RESPONSES_MODEL_IDS.has(selection.modelId)
  );
}

function connectorFailureSignal(signal: FailureSignal): ConnectorFailureSignal {
  if (signal.kind === "timeout") return { kind: "timeout" };
  if (signal.kind === "network") return { kind: "provider-unavailable" };
  if (signal.kind === "cancelled") return { kind: "cancelled" };
  if (signal.kind !== "http" || signal.statusCode === undefined) return { kind: "invalid-request" };
  if (signal.statusCode === 401) return { kind: "authentication" };
  if (signal.statusCode === 408) return { kind: "timeout" };
  if (signal.statusCode === 429) return { kind: "rate-limit" };
  if (signal.statusCode >= 500) return { kind: "provider-unavailable" };
  return { kind: "invalid-request" };
}

function recoveredConnectorFailure(attempt: RouteAttempt): ConnectorFailureSignal {
  switch (attempt.failure_class) {
    case "authentication":
      return { kind: "authentication" };
    case "quota":
      return { kind: "rate-limit" };
    case "timeout":
      return { kind: "timeout" };
    case "network":
    case "upstream":
      return { kind: "provider-unavailable" };
    case "cancelled":
      return { kind: "cancelled" };
    default:
      return { kind: "invalid-request" };
  }
}

function runtimeText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Connector 실행에는 ${label}가 필요합니다`);
  return normalized;
}

function explicitlyNoSideEffects(value: unknown): value is false {
  return value === false;
}

export class OpenAICompatibleModelBuilder implements ProviderModelBuilder {
  public build(selection: ProviderModelSelection): LanguageModel {
    validateDiscoveryBaseUrl(selection.endpoint.base_url, selection.endpoint.local);
    const root = selection.endpoint.base_url.replace(/\/$/u, "");
    const fetch = createSecureProviderFetch(selection.endpoint.local);
    if (selection.endpoint.subscription_protocol === "anthropic") {
      const provider = createAnthropic({
        authToken: selection.secret,
        baseURL: root.endsWith("/v1") ? root : `${root}/v1`,
        fetch,
      });
      return provider(selection.modelId);
    }
    const useResponses = usesGpt56Responses(selection);
    const baseURL = useResponses
      ? OPENAI_API_BASE_URL
      : selection.provider.adapter_kind === "ollama"
        ? `${root}/v1`
        : root;
    if (
      !useResponses &&
      (selection.provider.adapter_kind === "openai-compatible" ||
        selection.provider.adapter_kind === "external-gateway" ||
        selection.provider.adapter_kind === "subscription-connector")
    ) {
      return createOpenAICompatible({
        name: selection.provider.provider_id,
        apiKey: selection.secret,
        baseURL,
        includeUsage: true,
        supportsStructuredOutputs: selection.supportsStructuredOutputs,
        fetch,
      })(selection.modelId);
    }
    const provider = createOpenAI({
      name: selection.provider.provider_id,
      apiKey: selection.secret,
      baseURL,
      fetch,
    });
    if (!useResponses) return provider.chat(selection.modelId);
    return wrapLanguageModel({
      model: provider.responses(selection.modelId),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { openai: { store: false } } },
      }),
    });
  }
}

export class MassionModelFactory implements RoutedModelFactory {
  public constructor(
    private readonly router: ModelRouter,
    private readonly providers: ProviderService,
    private readonly builder: ProviderModelBuilder,
    private readonly connectorRuntime?: ConnectorRuntimeDependencies,
    private readonly preferenceResolver?: RoutedModelPreferenceResolver,
  ) {}

  public createSubscriptionReceipts(store: RuntimeExecutionStore): SubscriptionExecutionReceiptCoordinator | undefined {
    if (!this.connectorRuntime) return undefined;
    return new SubscriptionExecutionReceiptCoordinator(store, this.router, this.connectorRuntime.broker);
  }

  public async acquire(context: TenantContext, input: AcquireModelInput): Promise<RoutedModelLease> {
    const preferenceResolution = input.preferredModelProfileIds
      ? { profileIds: input.preferredModelProfileIds }
      : await this.preferenceResolver?.resolve(context, input);
    const resolvedPreferences = preferenceResolution?.profileIds;
    const optimizationBatchId = resolvedPreferences?.length ? preferenceResolution?.batchId : undefined;
    const reservation = await this.router
      .reserve(context, {
        commandId: input.commandId,
        ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
        ...(input.optimizationRunId !== undefined ? { optimizationRunId: input.optimizationRunId } : {}),
        ...(optimizationBatchId !== undefined ? { optimizationBatchId } : {}),
        routeName: input.routeName,
        estimatedTokens: input.estimatedTokens,
        estimatedCostMicros: input.estimatedCostMicros,
        ...((resolvedPreferences ?? input.preferredModelProfileIds)
          ? { preferredModelProfileIds: resolvedPreferences ?? input.preferredModelProfileIds }
          : {}),
        ...(input.stickyKey ? { stickyKey: input.stickyKey } : {}),
        ...(input.fallbackFromAttemptId ? { fallbackFromAttemptId: input.fallbackFromAttemptId } : {}),
        ...(input.requiredExecutionKind ? { requiredExecutionKind: input.requiredExecutionKind } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("Model Route를 찾을 수 없습니다")) {
          throw new Error(`blocked_model_unavailable: ${input.routeName} Route가 구성되지 않았습니다`, {
            cause: error,
          });
        }
        throw error;
      });
    const endpoint = reservation.endpoint;
    const profile = reservation.profile;
    const credential = reservation.credential;
    if (!endpoint || !profile || !credential) throw new Error("Model reservation 선택 정보가 없습니다");
    const preferenceApplied = resolvedPreferences?.includes(profile.model_profile_id) ?? false;
    if (reservation.material.kind === "connector_session") {
      return await this.connectorLease(context, input, reservation, {
        modelProfileId: profile.model_profile_id,
        ...(optimizationBatchId !== undefined ? { optimizationBatchId } : {}),
        preferenceApplied,
      });
    }
    const provider = await this.providers.getProvider(context, profile.provider_id);
    const model = this.builder.build({
      provider,
      endpoint,
      modelId: profile.model_id,
      credentialId: credential.credential_id,
      secret: reservation.material.secret,
      supportsStructuredOutputs: profile.supports_structured_output,
    });
    const attemptId = reservation.attempt.attempt_id;
    const costFor = (usage: ModelCompletionUsage) =>
      Math.ceil(
        (usage.inputTokens * profile.input_cost_micros_per_million +
          usage.outputTokens * profile.output_cost_micros_per_million) /
          1_000_000,
      );
    return {
      kind: "model",
      attemptId,
      credentialId: credential.credential_id,
      modelProfileId: profile.model_profile_id,
      ...(optimizationBatchId !== undefined ? { optimizationBatchId } : {}),
      preferenceApplied,
      model,
      supportsStructuredOutput: profile.supports_structured_output,
      complete: async (usage) => await this.completeAttempt(context, attemptId, usage, costFor(usage)),
      fail: async (usage) => await this.failAttempt(context, attemptId, usage, costFor(usage)),
    };
  }

  public async recoverReservedSelection(
    context: TenantContext,
    executionId: string,
  ): Promise<RoutedModelSelectionLease | undefined> {
    const attempt = await this.router.readReservedAttemptByExecution(context, executionId);
    if (!attempt) return undefined;
    let request: Record<string, unknown>;
    try {
      const explanation = JSON.parse(attempt.explanation_json) as unknown;
      if (!explanation || typeof explanation !== "object" || Array.isArray(explanation)) throw new Error();
      const requestJson = (explanation as Record<string, unknown>).request;
      if (typeof requestJson !== "string") throw new Error();
      const parsed = JSON.parse(requestJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      request = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new Error("reserved Route Attempt의 요청 계보가 유효하지 않습니다", { cause });
    }
    if (attempt.execution_id !== executionId || request.executionId !== executionId) {
      throw new Error("reserved Route Attempt의 실행 계보가 유효하지 않습니다");
    }
    const requestBatchId = request.optimizationBatchId;
    if (
      (requestBatchId !== undefined &&
        (typeof requestBatchId !== "string" || !requestBatchId || requestBatchId.length > 256)) ||
      requestBatchId !== attempt.optimization_batch_id
    ) {
      throw new Error("reserved Route Attempt의 batch 계보가 유효하지 않습니다");
    }
    const preferences = request.preferredModelProfileIds;
    let preferenceApplied = false;
    if (preferences !== undefined) {
      if (!Array.isArray(preferences) || preferences.some((profileId) => typeof profileId !== "string")) {
        throw new Error("reserved Route Attempt의 선호 계보가 유효하지 않습니다");
      }
      const profileIds = preferences as string[];
      if (new Set(profileIds).size !== profileIds.length) {
        throw new Error("reserved Route Attempt의 선호 계보가 유효하지 않습니다");
      }
      preferenceApplied = profileIds.includes(attempt.model_profile_id);
      if (profileIds.length > 0 && !preferenceApplied) {
        throw new Error("reserved Route Attempt의 선호 계보가 유효하지 않습니다");
      }
    }
    const sessions = this.connectorRuntime
      ? await this.connectorRuntime.broker.findExecutionLeases(context, executionId)
      : [];
    const matchingSessions = sessions.filter((session) => session.routeAttemptId === attempt.attempt_id);
    if (matchingSessions.length > 1) throw new Error("reserved Route Attempt의 Session Lease가 둘 이상입니다");
    const session = matchingSessions[0];
    return {
      attemptId: attempt.attempt_id,
      modelProfileId: attempt.model_profile_id,
      ...(attempt.optimization_batch_id === undefined ? {} : { optimizationBatchId: attempt.optimization_batch_id }),
      preferenceApplied,
      fail: async (usage) =>
        session
          ? await this.failConnectorAttempt(context, attempt.attempt_id, session, usage)
          : await this.failAttempt(context, attempt.attempt_id, usage, 0),
    };
  }

  public async reconcileConnectorLeases(context: TenantContext): Promise<
    readonly {
      readonly leaseId: string;
      readonly routeAttemptId: string;
      readonly action: "completed" | "failed" | "pending";
    }[]
  > {
    const runtime = this.connectorRuntime;
    if (!runtime?.routeAttempts) throw new Error("Connector Route Attempt 복구 reader가 구성되지 않았습니다");
    const leases = await runtime.broker.recoverActive(context);
    const reconciled = [];
    for (const lease of leases) {
      const attempt = await runtime.routeAttempts.read(context, lease.routeAttemptId);
      if (attempt.status === "succeeded") {
        await lease.complete({ commandId: `${lease.routeAttemptId}:reconcile:session:complete` });
        reconciled.push({ leaseId: lease.leaseId, routeAttemptId: lease.routeAttemptId, action: "completed" as const });
        continue;
      }
      if (attempt.status === "failed" || attempt.status === "interrupted") {
        await lease.fail({
          commandId: `${lease.routeAttemptId}:reconcile:session:fail`,
          emittedTokens: attempt.emitted_tokens,
          sideEffectsStarted: true,
          signal: recoveredConnectorFailure(attempt),
        });
        reconciled.push({ leaseId: lease.leaseId, routeAttemptId: lease.routeAttemptId, action: "failed" as const });
        continue;
      }
      reconciled.push({ leaseId: lease.leaseId, routeAttemptId: lease.routeAttemptId, action: "pending" as const });
    }
    return reconciled;
  }

  private async connectorLease(
    context: TenantContext,
    input: AcquireModelInput,
    reservation: Awaited<ReturnType<ModelRouter["reserve"]>>,
    lineage: {
      readonly modelProfileId: string;
      readonly optimizationBatchId?: string;
      readonly preferenceApplied: boolean;
    },
  ): Promise<RoutedModelLease> {
    const runtime = this.connectorRuntime;
    const { material, credential, profile } = reservation;
    if (material.kind !== "connector_session" || !credential || !profile) {
      throw new Error("Connector reservation 선택 정보가 없습니다");
    }
    if (!runtime) {
      await this.failAttempt(
        context,
        reservation.attempt.attempt_id,
        {
          commandId: `${input.commandId}:connector-runtime-unavailable`,
          signal: { kind: "input" },
          emittedTokens: 0,
          sideEffectsStarted: true,
          inputTokens: 0,
          outputTokens: 0,
        },
        0,
      );
      throw new Error("Connector Runtime Broker와 실행 resolver가 구성되지 않았습니다");
    }
    const attemptId = reservation.attempt.attempt_id;
    let scope: SubscriptionScope;
    let executionId: string;
    let workId: string;
    let agentHandle: string;
    try {
      if (Boolean(input.fallbackFromAttemptId) !== Boolean(input.fallbackFromLeaseId)) {
        throw new Error("Connector fallback에는 Route Attempt ID와 Session Lease ID가 모두 필요합니다");
      }
      const candidateScope = material.scope;
      if (
        credential.subscription_account_id !== material.accountId ||
        credential.subscription_connector_id !== material.connectorId
      ) {
        throw new Error("Connector reservation 계보가 일치하지 않습니다");
      }
      scope = candidateScope;
      executionId = runtimeText(input.executionId, "Execution ID");
      workId = runtimeText(input.workId, "Work ID");
      agentHandle = runtimeText(input.agentHandle, "Agent handle");
    } catch (error) {
      await this.failAttempt(
        context,
        attemptId,
        {
          commandId: `${input.commandId}:connector-context-invalid`,
          signal: { kind: "input" },
          emittedTokens: 0,
          sideEffectsStarted: true,
          inputTokens: 0,
          outputTokens: 0,
        },
        0,
      );
      throw error;
    }
    let session: ConnectorSessionLease;
    try {
      session = await runtime.broker.acquire(context, {
        commandId: `${input.commandId}:session:acquire`,
        executionId,
        accountId: material.accountId,
        connectorId: material.connectorId,
        scope,
        workId,
        agentHandle,
        routeAttemptId: attemptId,
        ...(reservation.attempt.quota_snapshot_id ? { quotaSnapshotId: reservation.attempt.quota_snapshot_id } : {}),
        ...(input.fallbackFromLeaseId ? { fallbackFromLeaseId: input.fallbackFromLeaseId } : {}),
      });
    } catch (error) {
      await this.failAttempt(
        context,
        attemptId,
        {
          commandId: `${input.commandId}:session:acquire-failed`,
          signal: { kind: "unknown" },
          emittedTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        0,
      );
      throw error;
    }
    if (
      session.executionId !== executionId ||
      session.accountId !== material.accountId ||
      session.connectorId !== material.connectorId ||
      session.workId !== workId ||
      session.agentHandle !== agentHandle ||
      session.routeAttemptId !== attemptId ||
      session.quotaSnapshotId !== reservation.attempt.quota_snapshot_id ||
      session.status !== "active"
    ) {
      await this.failConnectorAttempt(context, attemptId, session, {
        commandId: `${input.commandId}:session:binding-failed`,
        signal: { kind: "input" },
        emittedTokens: 0,
        sideEffectsStarted: false,
        inputTokens: 0,
        outputTokens: 0,
      });
      throw new Error("Session Lease 계보가 Router reservation과 일치하지 않습니다");
    }
    let binding: ConnectorRuntimeBinding;
    try {
      binding = await runtime.resolver.resolve(context, {
        executionId,
        workId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        agentHandle,
        ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
        ...(input.workspaceCapability ? { workspaceCapability: input.workspaceCapability } : {}),
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(input.instruction ? { instruction: input.instruction } : {}),
        providerId: profile.provider_id,
        modelId: profile.model_id,
        accountId: material.accountId,
        connectorId: material.connectorId,
        scope,
        routeAttemptId: attemptId,
        ...(reservation.attempt.quota_snapshot_id ? { quotaSnapshotId: reservation.attempt.quota_snapshot_id } : {}),
        sessionLeaseId: session.leaseId,
      });
    } catch (error) {
      await this.failConnectorAttempt(context, attemptId, session, {
        commandId: `${input.commandId}:session:resolver-failed`,
        signal: { kind: "input" },
        emittedTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      throw error;
    }
    if (binding.kind === "agent-runtime") {
      try {
        const bound = await runtime.broker.bindRuntime(context, {
          commandId: `${input.commandId}:session:runtime-bind`,
          leaseId: session.leaseId,
          adapterId: binding.adapterId,
        });
        if (bound.adapterId !== binding.adapterId) {
          throw new Error("Session Lease runtime adapter 계보가 Resolver와 일치하지 않습니다");
        }
      } catch (error) {
        await this.failConnectorAttempt(context, attemptId, session, {
          commandId: `${input.commandId}:session:runtime-bind-failed`,
          signal: { kind: "input" },
          emittedTokens: 0,
          sideEffectsStarted: false,
          inputTokens: 0,
          outputTokens: 0,
        });
        throw error;
      }
    }
    const settlement = {
      attemptId,
      credentialId: credential.credential_id,
      sessionLeaseId: session.leaseId,
      complete: async (usage: ModelCompletionUsage) => {
        try {
          const attempt = await this.completeAttempt(context, attemptId, usage, 0);
          await session.complete({ commandId: `${usage.commandId}:session` });
          return attempt;
        } catch (error) {
          throw new RoutedExecutionSettlementError("Connector 성공 정산을 완료하지 못했습니다", { cause: error });
        }
      },
      fail: async (usage: ModelFailureUsage) => {
        try {
          return await this.failConnectorAttempt(context, attemptId, session, usage);
        } catch (error) {
          throw new RoutedExecutionSettlementError("Connector 실패 정산을 완료하지 못했습니다", { cause: error });
        }
      },
    };
    let sessionExpiresAt = session.expiresAt;
    const sessionLifecycle = {
      get sessionExpiresAt() {
        return sessionExpiresAt;
      },
      renewSession: async (renewal: { readonly commandId: string; readonly expectedExpiresAt: string }) => {
        const renewed = await session.renew(renewal);
        sessionExpiresAt = renewed.expiresAt;
        return sessionExpiresAt;
      },
    };
    const subscription = {
      workId,
      agentHandle,
      accountId: material.accountId,
      connectorId: material.connectorId,
      adapterId: binding.kind === "agent-runtime" ? binding.adapterId : material.connectorId,
      ...(reservation.attempt.quota_snapshot_id ? { quotaSnapshotId: reservation.attempt.quota_snapshot_id } : {}),
    };
    return binding.kind === "model"
      ? {
          kind: "model",
          ...lineage,
          model: binding.model,
          supportsStructuredOutput: profile.supports_structured_output,
          ...settlement,
        }
      : {
          kind: "agent-runtime",
          ...lineage,
          executor: binding.executor,
          subscription,
          ...sessionLifecycle,
          ...settlement,
        };
  }

  private async completeAttempt(
    context: TenantContext,
    attemptId: string,
    usage: ModelCompletionUsage,
    actualCostMicros: number,
  ): Promise<RouteAttempt> {
    try {
      const outcome = await this.router.reportSuccess(context, {
        commandId: usage.commandId,
        attemptId,
        actualInputTokens: usage.inputTokens,
        actualOutputTokens: usage.outputTokens,
        actualCostMicros,
      });
      return outcome.attempt;
    } catch (error) {
      throw new RoutedExecutionSettlementError("Router 성공 정산을 완료하지 못했습니다", { cause: error });
    }
  }

  private async failAttempt(
    context: TenantContext,
    attemptId: string,
    usage: ModelFailureUsage,
    actualCostMicros: number,
  ): Promise<ModelFailureOutcome> {
    try {
      const outcome = await this.router.reportFailure(context, {
        commandId: usage.commandId,
        attemptId,
        signal: usage.signal,
        emittedTokens: usage.emittedTokens,
        sideEffectsStarted: usage.sideEffectsStarted ?? true,
        actualInputTokens: usage.inputTokens,
        actualOutputTokens: usage.outputTokens,
        actualCostMicros,
      });
      return {
        status: outcome.attempt.status,
        ...(outcome.attempt.failure_class ? { failureClass: outcome.attempt.failure_class } : {}),
        fallbackAllowed:
          outcome.attempt.fallback_allowed &&
          usage.emittedTokens === 0 &&
          explicitlyNoSideEffects(usage.sideEffectsStarted),
      };
    } catch (error) {
      throw new RoutedExecutionSettlementError("Router 실패 정산을 완료하지 못했습니다", { cause: error });
    }
  }

  private async failConnectorAttempt(
    context: TenantContext,
    attemptId: string,
    session: ConnectorSessionLease,
    usage: ModelFailureUsage,
    defaultSideEffectsStarted = true,
  ): Promise<ModelFailureOutcome> {
    const sideEffectsStarted = usage.sideEffectsStarted ?? defaultSideEffectsStarted;
    const connector = await session.fail({
      commandId: `${usage.commandId}:session`,
      emittedTokens: usage.emittedTokens,
      sideEffectsStarted,
      signal: connectorFailureSignal(usage.signal),
    });
    const route = await this.failAttempt(context, attemptId, { ...usage, sideEffectsStarted }, 0);
    return {
      ...route,
      fallbackAllowed:
        route.fallbackAllowed && connector.fallbackAllowed && usage.emittedTokens === 0 && !sideEffectsStarted,
    };
  }
}
