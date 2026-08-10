import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

import type { TenantContext } from "@massion/identity";
import {
  AntigravityCliConnector,
  ClaudeSubscriptionConnector,
  CodexSubscriptionConnector,
  CopilotAcpConnector,
  GeminiCliAcpConnector,
  GrokBuildAcpConnector,
  executionEvidenceIsSafe,
  normalizeConfirmedAgentUsage,
  SubscriptionStructuredOutputError,
  type AcpPermissionBridge,
  type ClaudeSubscriptionConnectorOptions,
  type ConnectorRuntimeBinding,
  type ConnectorRuntimeResolutionInput,
  type ConnectorRuntimeResolver,
  type RoutedAgentRuntimeExecutor,
  type RoutedAgentRuntimeResult,
  type StructuredOutputSpec,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
  type SubscriptionPermissionBridge,
} from "@massion/runtime";
import {
  createEdgeWorkspaceExecutionCapability,
  listCodingPlanPresets,
  listSubscriptionProviderManifests,
  selectEdgeWorkspaceRootCapability,
  type ConnectorEvent,
  type ConnectorRequest,
  type ConnectorSessionLease,
  type SubscriptionAccount,
  type SubscriptionConnector,
  type SubscriptionScope,
} from "@massion/subscriptions";

import { prepareSubscriptionProfileRoot } from "./subscription-profile.js";
import { CodexAppServerSubscriptionConnector } from "./codex-app-server-agent.js";

type WorkspaceAccess = "isolated" | "read-only" | "workspace-write";
type WorkspaceConnectorRuntimeResolutionInput = ConnectorRuntimeResolutionInput & {
  readonly taskId?: string;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly workspaceCapability?: string;
};

export type NativeSubscriptionAgentAdapterId =
  "codex" | "claude" | "gemini-acp" | "copilot-acp" | "grok-acp" | "antigravity";

export interface SubscriptionAgentExecutionPolicy {
  readonly permissionMode: "governed" | "full-access";
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "never" | "on-request" | "deny";
  readonly networkAccessEnabled: boolean;
  readonly autonomyRevision: number;
}

export interface WorkspaceCapabilityView {
  readonly workspaceRoot: string;
  readonly workspaceAccess: WorkspaceAccess;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
}

interface RemoteEdgeWorkspacePolicy {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
}

export interface SubscriptionWorkspaceCapabilityVerifier {
  verify(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
      readonly workspaceAccess?: WorkspaceAccess;
      readonly workspaceCapability: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly connectorId: string;
      readonly requestedWorkspaceRoot: string;
    },
  ): Promise<WorkspaceCapabilityView>;
}

export interface SubscriptionAgentPolicyPort {
  resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
      readonly workspaceAccess: WorkspaceAccess;
      readonly providerId: string;
      readonly accountId: string;
      readonly connectorId: string;
      readonly workspaceRoot: string;
    },
  ): Promise<SubscriptionAgentExecutionPolicy>;
}

export interface SubscriptionRuntimeAccountReader {
  requireUsable(context: TenantContext, accountId: string, visibility: SubscriptionScope): Promise<SubscriptionAccount>;
}

export interface SubscriptionRuntimeConnectorReader {
  get(context: TenantContext, connectorId: string): Promise<SubscriptionConnector>;
}

export interface SubscriptionRuntimeBroker {
  getLease(context: TenantContext, leaseId: string): Promise<ConnectorSessionLease>;
  invoke(context: TenantContext, input: unknown, signal?: AbortSignal): AsyncIterable<ConnectorEvent>;
}

export interface NativeSubscriptionAgentFactoryInput {
  readonly adapterId: NativeSubscriptionAgentAdapterId;
  readonly executable: string | undefined;
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly policy: SubscriptionAgentExecutionPolicy;
}

export interface NativeSubscriptionAgentFactory {
  create(input: NativeSubscriptionAgentFactoryInput): SubscriptionAgentAdapter;
}

export interface SubscriptionRuntimeResolverOptions {
  readonly accounts: SubscriptionRuntimeAccountReader;
  readonly connectors: SubscriptionRuntimeConnectorReader;
  readonly broker: SubscriptionRuntimeBroker;
  readonly workspaceCapabilities: SubscriptionWorkspaceCapabilityVerifier;
  readonly policies: SubscriptionAgentPolicyPort;
  readonly profileRoot: string;
  readonly executableAllowlist: Readonly<Record<string, string>>;
  readonly nativeFactory?: NativeSubscriptionAgentFactory;
  readonly permissions?: {
    readonly codex?: SubscriptionPermissionBridge;
    readonly claude?: SubscriptionPermissionBridge;
    readonly acp?: AcpPermissionBridge;
  };
}

interface ProviderRuntimeDescriptor {
  readonly providerId: string;
  readonly executionKind: "model" | "agent-runtime";
  readonly availability: "supported" | "experimental" | "requires-provider-approval";
  readonly minimumVersion?: string;
  readonly adapterId?: NativeSubscriptionAgentAdapterId;
}

const AGENT_ADAPTERS = {
  "openai-codex": "codex",
  "anthropic-claude-code": "claude",
  "google-gemini-cli-enterprise": "gemini-acp",
  "github-copilot": "copilot-acp",
  "xai-grok-build": "grok-acp",
  "google-antigravity-cli": "antigravity",
} as const satisfies Readonly<Record<string, NativeSubscriptionAgentAdapterId>>;

const EXECUTABLE_IDS = {
  codex: "codex",
  claude: "claude",
  "gemini-acp": "gemini",
  "copilot-acp": "copilot",
  "grok-acp": "grok",
  antigravity: "antigravity",
} as const satisfies Readonly<Record<NativeSubscriptionAgentAdapterId, string>>;

type ModelBinding = Extract<ConnectorRuntimeBinding, { readonly kind: "model" }>;
type RuntimeLanguageModel = Extract<ModelBinding["model"], { readonly specificationVersion: "v3" }>;
type ModelCallOptions = Parameters<RuntimeLanguageModel["doGenerate"]>[0];
type ModelGenerateResult = Awaited<ReturnType<RuntimeLanguageModel["doGenerate"]>>;
type ModelStreamResult = Awaited<ReturnType<RuntimeLanguageModel["doStream"]>>;
type ModelStreamPart = ModelStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

class ConnectorProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConnectorProtocolError";
  }
}

function providerDescriptor(providerId: string): ProviderRuntimeDescriptor {
  const manifest = listSubscriptionProviderManifests().find((candidate) => candidate.id === providerId);
  const preset = listCodingPlanPresets().find((candidate) => candidate.id === providerId);
  if (!manifest && !preset) throw new Error("지원하지 않는 구독 Provider입니다");
  const availability =
    manifest?.availability === "requires-provider-approval" || preset?.availability === "requires-provider-approval"
      ? "requires-provider-approval"
      : manifest?.availability === "experimental"
        ? "experimental"
        : "supported";
  const executionKind = manifest?.executionKind ?? "model";
  const adapterId = (AGENT_ADAPTERS as Partial<Record<string, NativeSubscriptionAgentAdapterId>>)[providerId];
  if (executionKind === "agent-runtime" && !adapterId) {
    throw new Error("구독 Agent runtime adapter가 등록되지 않았습니다");
  }
  return {
    providerId,
    executionKind,
    availability,
    ...(manifest?.runtimeCapabilities?.minimumVersion
      ? { minimumVersion: manifest.runtimeCapabilities.minimumVersion }
      : {}),
    ...(adapterId ? { adapterId } : {}),
  };
}

export function subscriptionAgentAdapterId(providerId: string): NativeSubscriptionAgentAdapterId {
  const descriptor = providerDescriptor(providerId);
  if (descriptor.executionKind !== "agent-runtime" || !descriptor.adapterId) {
    throw new Error("선택한 구독 Provider는 Agent runtime이 아닙니다");
  }
  return descriptor.adapterId;
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label}는 절대 경로여야 합니다`);
  return value;
}

function safeToolList(values: readonly string[], label: string): readonly string[] {
  if (values.length > 256) throw new Error(`${label} 개수가 유효하지 않습니다`);
  return values.map((value) => {
    if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new Error(`${label} 값이 유효하지 않습니다`);
    return value;
  });
}

function requirePolicy(value: SubscriptionAgentExecutionPolicy): SubscriptionAgentExecutionPolicy {
  if (
    !new Set(["read-only", "workspace-write", "danger-full-access"]).has(value.sandboxMode) ||
    !new Set(["never", "on-request", "deny"]).has(value.approvalPolicy) ||
    typeof value.networkAccessEnabled !== "boolean" ||
    !new Set(["governed", "full-access"]).has(value.permissionMode) ||
    !Number.isSafeInteger(value.autonomyRevision) ||
    value.autonomyRevision < 0
  ) {
    throw new Error("구독 Agent 실행 정책이 유효하지 않습니다");
  }
  return value;
}

function semver(value: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(value.trim());
  if (!match) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function atLeast(value: string, minimum: string): boolean {
  const current = semver(value);
  const required = semver(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function frameRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorProtocolError(`${label} frame payload가 유효하지 않습니다`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ConnectorProtocolError(`${label} 값이 유효하지 않습니다`);
  }
  return Number(value);
}

function usagePayload(value: unknown): { readonly inputTokens: number; readonly outputTokens: number } {
  const payload = frameRecord(value, "usage");
  return {
    inputTokens: safeInteger(payload.inputTokens, "입력 token"),
    outputTokens: safeInteger(payload.outputTokens, "출력 token"),
  };
}

function textDelta(value: unknown): string {
  const payload = frameRecord(value, "data");
  if (payload.type !== "text-delta" || typeof payload.delta !== "string" || payload.delta.length === 0) {
    throw new ConnectorProtocolError("Connector data frame payload가 유효하지 않습니다");
  }
  return payload.delta;
}

function safeCategory(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) ? value : "remote-connector-error";
}

function safeRetryAfter(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  if (/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function failureSignal(
  value: unknown,
):
  | { readonly kind: "http"; readonly statusCode: number; readonly retryAfter?: string }
  | { readonly kind: "timeout" | "network" | "input" | "policy" | "cancelled" | "unknown" } {
  const payload = frameRecord(value, "error signal");
  if (payload.kind === "http") {
    const statusCode = safeInteger(payload.statusCode, "HTTP 상태");
    if (statusCode < 100 || statusCode > 599) throw new ConnectorProtocolError("HTTP 상태 값이 유효하지 않습니다");
    const retryAfter = safeRetryAfter(payload.retryAfter);
    return {
      kind: "http",
      statusCode,
      ...(retryAfter ? { retryAfter } : {}),
    };
  }
  if (new Set(["timeout", "network", "input", "policy", "cancelled", "unknown"]).has(String(payload.kind))) {
    return { kind: payload.kind as "timeout" | "network" | "input" | "policy" | "cancelled" | "unknown" };
  }
  return { kind: "unknown" };
}

function modelUsage(value: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): ModelGenerateResult["usage"] {
  return {
    inputTokens: { total: value.inputTokens, noCache: value.inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: value.outputTokens, text: value.outputTokens, reasoning: undefined },
  };
}

function finishReason(value: unknown): ModelGenerateResult["finishReason"] {
  const payload = frameRecord(value, "done");
  const unified = payload.finishReason;
  if (!new Set(["stop", "length", "content-filter", "tool-calls", "error", "other"]).has(String(unified))) {
    throw new ConnectorProtocolError("Connector finish reason이 유효하지 않습니다");
  }
  return { unified: unified as ModelGenerateResult["finishReason"]["unified"], raw: undefined };
}

function safeTransportError(error: unknown): Error {
  return error instanceof ConnectorProtocolError ? error : new Error("원격 Connector 전송에 실패했습니다");
}

function safeModelCall(options: ModelCallOptions): Record<string, unknown> {
  if (options.headers && Object.values(options.headers).some((value) => value !== undefined)) {
    throw new Error("원격 구독 Connector에는 임의 HTTP header를 전달할 수 없습니다");
  }
  if (options.providerOptions && Object.keys(options.providerOptions).length > 0) {
    throw new Error("원격 구독 Connector에는 임의 Provider option을 전달할 수 없습니다");
  }
  return {
    prompt: options.prompt,
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stopSequences === undefined ? {} : { stopSequences: options.stopSequences }),
    ...(options.topP === undefined ? {} : { topP: options.topP }),
    ...(options.topK === undefined ? {} : { topK: options.topK }),
    ...(options.presencePenalty === undefined ? {} : { presencePenalty: options.presencePenalty }),
    ...(options.frequencyPenalty === undefined ? {} : { frequencyPenalty: options.frequencyPenalty }),
    ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
  };
}

interface RemoteBindingLineage {
  readonly providerId: string;
  readonly modelId: string;
  readonly routeAttemptId: string;
  readonly sessionLeaseId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
}

class RemoteConnectorLanguageModel implements RuntimeLanguageModel {
  public readonly specificationVersion = "v3" as const;
  public readonly supportedUrls = {};

  public constructor(
    public readonly provider: string,
    public readonly modelId: string,
    private readonly context: TenantContext,
    private readonly broker: SubscriptionRuntimeBroker,
    private readonly lineage: RemoteBindingLineage,
  ) {}

  public async doGenerate(options: ModelCallOptions): Promise<ModelGenerateResult> {
    const request = this.request(options);
    let usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    let reason: ModelGenerateResult["finishReason"] | undefined;
    const chunks: string[] = [];
    try {
      for await (const event of this.broker.invoke(this.context, request, options.abortSignal)) {
        if (event.kind === "data") {
          if (usage) throw new ConnectorProtocolError("Connector model frame 순서가 유효하지 않습니다");
          chunks.push(textDelta(event.payload));
          continue;
        }
        if (event.kind === "usage") {
          if (usage) throw new ConnectorProtocolError("Connector model usage frame이 중복되었습니다");
          usage = usagePayload(event.payload);
          continue;
        }
        if (event.kind === "error") {
          const payload = frameRecord(event.payload, "error");
          throw new ConnectorProtocolError(
            `원격 Connector model 실행이 실패했습니다 (${safeCategory(payload.category)})`,
          );
        }
        if (!usage) throw new ConnectorProtocolError("Connector model done 이전에 usage frame이 필요합니다");
        reason = finishReason(event.payload);
      }
    } catch (error) {
      throw safeTransportError(error);
    }
    if (!usage || !reason) throw new ConnectorProtocolError("Connector model terminal frame이 없습니다");
    return {
      content: [{ type: "text", text: chunks.join("") }],
      finishReason: reason,
      usage: modelUsage(usage),
      warnings: [],
    };
  }

  public doStream(options: ModelCallOptions): Promise<ModelStreamResult> {
    const stream = new ReadableStream<ModelStreamPart>({
      start: (controller) => {
        void this.writeStream(options, controller);
      },
    });
    return Promise.resolve({ stream });
  }

  private request(options: ModelCallOptions): ConnectorRequest {
    return {
      protocol: "massion.connector.v1",
      requestId: randomUUID(),
      leaseId: this.lineage.sessionLeaseId,
      operation: options.responseFormat?.type === "json" ? "generate-structured" : "generate",
      payload: { ...this.lineage, call: safeModelCall(options) },
    };
  }

  private async writeStream(options: ModelCallOptions, controller: ReadableStreamDefaultController<ModelStreamPart>) {
    const request = this.request(options);
    const textId = randomUUID();
    let usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    let started = false;
    try {
      for await (const event of this.broker.invoke(this.context, request, options.abortSignal)) {
        if (!started) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: textId });
          started = true;
        }
        if (event.kind === "data") {
          if (usage) throw new ConnectorProtocolError("Connector model frame 순서가 유효하지 않습니다");
          controller.enqueue({ type: "text-delta", id: textId, delta: textDelta(event.payload) });
          continue;
        }
        if (event.kind === "usage") {
          if (usage) throw new ConnectorProtocolError("Connector model usage frame이 중복되었습니다");
          usage = usagePayload(event.payload);
          continue;
        }
        if (event.kind === "error") {
          const payload = frameRecord(event.payload, "error");
          controller.enqueue({
            type: "error",
            error: new Error(`원격 Connector model 실행이 실패했습니다 (${safeCategory(payload.category)})`),
          });
          controller.close();
          return;
        }
        if (!usage) throw new ConnectorProtocolError("Connector model done 이전에 usage frame이 필요합니다");
        controller.enqueue({ type: "text-end", id: textId });
        controller.enqueue({ type: "finish", usage: modelUsage(usage), finishReason: finishReason(event.payload) });
        controller.close();
        return;
      }
      throw new ConnectorProtocolError("Connector model terminal frame이 없습니다");
    } catch (error) {
      controller.error(safeTransportError(error));
    }
  }
}

class RemoteConnectorAgentExecutor implements RoutedAgentRuntimeExecutor {
  private active: AbortController | undefined;

  public constructor(
    private readonly context: TenantContext,
    private readonly broker: SubscriptionRuntimeBroker,
    private readonly lineage: RemoteBindingLineage,
    private readonly accountId: string,
    private readonly workspacePolicy: RemoteEdgeWorkspacePolicy,
    private readonly workspaceCapability: string,
    private readonly policy: SubscriptionAgentExecutionPolicy,
    private readonly instruction?: string,
  ) {}

  public async execute(input: {
    readonly executionId: string;
    readonly prompt: string;
    readonly abortSignal?: AbortSignal;
  }) {
    return await this.run(input);
  }

  public async executeStructured(
    input: { readonly executionId: string; readonly prompt: string; readonly abortSignal?: AbortSignal },
    output: StructuredOutputSpec,
  ) {
    return await this.run(input, output);
  }

  public cancel(): Promise<void> {
    this.active?.abort("cancelled");
    return Promise.resolve();
  }

  private async run(
    input: { readonly executionId: string; readonly prompt: string; readonly abortSignal?: AbortSignal },
    output?: StructuredOutputSpec,
  ): Promise<RoutedAgentRuntimeResult> {
    if (input.executionId !== this.lineage.executionId) {
      throw new Error("원격 Connector 실행 계보가 일치하지 않습니다");
    }
    if (this.active) throw new Error("같은 원격 Connector executor를 동시에 실행할 수 없습니다");
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort(input.abortSignal?.reason ?? "cancelled");
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) abort();
    this.active = controller;
    const request: ConnectorRequest = {
      protocol: "massion.connector.v1",
      requestId: randomUUID(),
      leaseId: this.lineage.sessionLeaseId,
      operation: "agent-turn",
      payload: {
        ...this.lineage,
        accountId: this.accountId,
        prompt: input.prompt,
        ...(this.instruction ? { instruction: this.instruction } : {}),
        workspaceCapability: this.workspaceCapability,
        allowedTools: this.workspacePolicy.allowedTools,
        disallowedTools: this.workspacePolicy.disallowedTools,
        policy: {
          sandboxMode: this.policy.sandboxMode,
          approvalPolicy: this.policy.approvalPolicy,
          networkAccessEnabled: this.policy.networkAccessEnabled,
        },
        ...(output
          ? { output: { name: output.name, description: output.description, jsonSchema: output.jsonSchema } }
          : {}),
      },
    };
    let usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    const chunks: string[] = [];
    let readingErrorFrame = false;
    try {
      for await (const event of this.broker.invoke(this.context, request, controller.signal)) {
        if (event.kind === "data") {
          if (usage) throw new ConnectorProtocolError("Connector Agent frame 순서가 유효하지 않습니다");
          chunks.push(textDelta(event.payload));
          continue;
        }
        if (event.kind === "usage") {
          if (usage) throw new ConnectorProtocolError("Connector Agent usage frame이 중복되었습니다");
          usage = usagePayload(event.payload);
          continue;
        }
        if (event.kind === "error") {
          readingErrorFrame = true;
          return this.failure(event.payload, chunks.length, usage);
        }
        const done = frameRecord(event.payload, "done");
        if (done.outcome !== "completed") {
          throw new ConnectorProtocolError("원격 Connector가 지원하지 않는 terminal 결과를 반환했습니다");
        }
        const sessionId = this.sessionId(done.sessionId);
        let value: unknown = chunks.join("");
        if (output) {
          value = done.value;
          if (value === undefined) {
            try {
              value = JSON.parse(chunks.join("")) as unknown;
            } catch (error) {
              throw this.structuredFailure("원격 Connector 구조화 출력 JSON이 유효하지 않습니다", error, chunks, usage);
            }
          }
          let validation: ReturnType<NonNullable<StructuredOutputSpec["validate"]>> | undefined;
          try {
            validation = output.validate?.(value);
          } catch (error) {
            throw this.structuredFailure("원격 Connector 구조화 출력 검증에 실패했습니다", error, chunks, usage);
          }
          if (validation && !validation.success) {
            throw this.structuredFailure(
              "원격 Connector 구조화 출력 검증에 실패했습니다",
              validation.error,
              chunks,
              usage,
            );
          }
          if (validation?.success) value = validation.value;
        }
        if (done.executionEvidence !== undefined && !executionEvidenceIsSafe(done.executionEvidence)) {
          throw new ConnectorProtocolError("Connector Agent 실행 근거가 유효하지 않습니다");
        }
        return {
          outcome: "completed",
          executionId: this.lineage.executionId,
          sessionId,
          value,
          ...(usage ? { usage } : {}),
          ...(done.executionEvidence ? { executionEvidence: done.executionEvidence } : {}),
        };
      }
      throw new ConnectorProtocolError("Connector Agent terminal frame이 없습니다");
    } catch (error) {
      if (readingErrorFrame) throw safeTransportError(error);
      if (controller.signal.aborted) {
        return {
          outcome: "cancelled",
          executionId: this.lineage.executionId,
          emittedTokens: chunks.length,
          ...(usage ? { usage } : {}),
        };
      }
      if (error instanceof SubscriptionStructuredOutputError) throw error;
      if (!usage && chunks.length === 0) throw safeTransportError(error);
      return {
        outcome: "failed",
        executionId: this.lineage.executionId,
        category: "remote-connector-error",
        retryable: false,
        signal: { kind: error instanceof ConnectorProtocolError ? "unknown" : "network" },
        emittedTokens: chunks.length,
        sideEffectsStarted: true,
        ...(usage ? { usage } : {}),
      };
    } finally {
      input.abortSignal?.removeEventListener("abort", abort);
      if (this.active === controller) this.active = undefined;
    }
  }

  private failure(
    value: unknown,
    observedOutputParts: number,
    streamedUsage?: { readonly inputTokens: number; readonly outputTokens: number },
  ): RoutedAgentRuntimeResult {
    const payload = frameRecord(value, "error");
    const signal = failureSignal(payload.signal);
    const sessionId = typeof payload.sessionId === "string" ? this.sessionId(payload.sessionId) : undefined;
    const hasDeclaredOutput = payload.emittedTokens !== undefined;
    const declaredOutput = hasDeclaredOutput ? safeInteger(payload.emittedTokens, "출력 token") : 0;
    const embeddedUsage = payload.usage === undefined ? undefined : usagePayload(payload.usage);
    if ((streamedUsage === undefined) !== (embeddedUsage === undefined)) {
      throw new ConnectorProtocolError("Connector Agent 실패 usage 계보가 일치하지 않습니다");
    }
    if (
      streamedUsage?.inputTokens !== embeddedUsage?.inputTokens ||
      streamedUsage?.outputTokens !== embeddedUsage?.outputTokens
    ) {
      throw new ConnectorProtocolError("Connector Agent 실패 usage 계보가 일치하지 않습니다");
    }
    const confirmedUsage = embeddedUsage ?? streamedUsage;
    if (signal.kind === "cancelled") {
      return {
        outcome: "cancelled",
        executionId: this.lineage.executionId,
        ...(sessionId ? { sessionId } : {}),
        emittedTokens: Math.max(observedOutputParts, declaredOutput),
        ...(confirmedUsage ? { usage: confirmedUsage } : {}),
      };
    }
    return {
      outcome: "failed",
      executionId: this.lineage.executionId,
      ...(sessionId ? { sessionId } : {}),
      category: safeCategory(payload.category),
      retryable: payload.retryable === true,
      signal,
      emittedTokens: Math.max(observedOutputParts, declaredOutput),
      sideEffectsStarted:
        typeof payload.sideEffectsStarted === "boolean" && (hasDeclaredOutput || payload.sideEffectsStarted)
          ? payload.sideEffectsStarted
          : true,
      ...(confirmedUsage ? { usage: confirmedUsage } : {}),
    };
  }

  private structuredFailure(
    message: string,
    cause: unknown,
    chunks: readonly string[],
    usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined,
  ): SubscriptionStructuredOutputError {
    return new SubscriptionStructuredOutputError(message, {
      cause,
      sideEffectsStarted: true,
      emittedTokens: chunks.length,
      ...(usage ? { usage } : {}),
    });
  }

  private sessionId(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
      throw new ConnectorProtocolError("원격 Connector session ID가 유효하지 않습니다");
    }
    return value;
  }
}

class BuiltinNativeSubscriptionAgentFactory implements NativeSubscriptionAgentFactory {
  public constructor(
    private readonly permissions: {
      readonly codex?: SubscriptionPermissionBridge;
      readonly claude?: SubscriptionPermissionBridge;
      readonly acp?: AcpPermissionBridge;
    } = {},
  ) {}

  public create(input: NativeSubscriptionAgentFactoryInput): SubscriptionAgentAdapter {
    if (input.policy.approvalPolicy === "deny") {
      throw new Error("차단된 구독 Agent 정책은 실행 adapter를 만들 수 없습니다");
    }
    const policy = input.policy as SubscriptionAgentExecutionPolicy & {
      readonly approvalPolicy: "never" | "on-request";
    };
    if (policy.permissionMode === "full-access" && policy.approvalPolicy !== "never") {
      throw new Error("전체 권한 실행 정책은 승인 대기와 함께 사용할 수 없습니다");
    }
    if (input.adapterId === "codex") {
      if (policy.approvalPolicy === "on-request") {
        if (!this.permissions.codex) throw new Error("Codex app-server Governance 승인 bridge가 필요합니다");
        return new CodexAppServerSubscriptionConnector(this.permissions.codex, {
          model: input.modelId,
          policy: {
            sandboxMode: policy.sandboxMode as "read-only" | "workspace-write",
            approvalPolicy: "on-request",
            networkAccessEnabled: policy.networkAccessEnabled,
          },
          ...(input.executable
            ? { runtime: () => Promise.resolve({ command: input.executable as string, commandArguments: [] }) }
            : {}),
        });
      }
      return new CodexSubscriptionConnector(undefined, {
        allowedEnvironment: ["PATH", "CODEX_HOME", "LANG", "LC_ALL"],
        managedProfile: true,
        ...(input.executable ? { executable: input.executable } : {}),
        threadPolicy: {
          sandboxMode: policy.sandboxMode,
          approvalPolicy: policy.approvalPolicy,
          networkAccessEnabled: policy.networkAccessEnabled,
          model: input.modelId,
        },
      });
    }
    if (input.adapterId === "claude") {
      if (policy.permissionMode === "full-access") {
        return new ClaudeSubscriptionConnector(undefined, undefined, {
          ...(input.executable ? { executable: input.executable } : {}),
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(input.modelId ? { model: input.modelId } : {}),
        });
      }
      const governedPolicy = policy as SubscriptionAgentExecutionPolicy & {
        readonly permissionMode: "governed";
        readonly sandboxMode: "read-only" | "workspace-write";
        readonly approvalPolicy: "never" | "on-request";
      };
      const sandbox: ClaudeSubscriptionConnectorOptions["sandbox"] = {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: policy.approvalPolicy === "never",
        allowUnsandboxedCommands: false,
        filesystem: {
          allowRead: [input.workspaceRoot, input.profileRoot],
          allowWrite:
            policy.sandboxMode === "workspace-write" ? [input.workspaceRoot, input.profileRoot] : [input.profileRoot],
          allowManagedReadPathsOnly: true,
        },
        network: policy.networkAccessEnabled
          ? { allowManagedDomainsOnly: false, allowAllUnixSockets: false, allowLocalBinding: false }
          : {
              allowedDomains: [],
              allowManagedDomainsOnly: true,
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
      };
      const permissionBridge: SubscriptionPermissionBridge | undefined =
        policy.approvalPolicy === "never"
          ? { request: () => Promise.resolve({ outcome: "allow" }) }
          : this.permissions.claude;
      return new ClaudeSubscriptionConnector(undefined, permissionBridge, {
        ...(input.executable ? { executable: input.executable } : {}),
        permissionMode: governedPolicy.approvalPolicy === "never" ? "auto" : "default",
        sandbox,
        model: input.modelId,
      });
    }
    if (input.adapterId === "gemini-acp") {
      return new GeminiCliAcpConnector({ executable: this.requireExecutable(input) }, undefined, this.permissions.acp);
    }
    if (input.adapterId === "copilot-acp") {
      return new CopilotAcpConnector({ executable: this.requireExecutable(input) }, undefined, this.permissions.acp);
    }
    if (input.adapterId === "grok-acp") {
      return new GrokBuildAcpConnector({ executable: this.requireExecutable(input) }, undefined, this.permissions.acp);
    }
    return new AntigravityCliConnector({ executable: this.requireExecutable(input), model: input.modelId });
  }

  private requireExecutable(input: NativeSubscriptionAgentFactoryInput): string {
    if (!input.executable) throw new Error("이 Connector adapter에는 명시적 실행 파일이 필요합니다");
    return input.executable;
  }
}

function normalizeNativeResult(result: SubscriptionAgentResult): RoutedAgentRuntimeResult {
  if (result.outcome === "completed") {
    const { usage: rawUsage, ...completed } = result;
    const usage = frameRecord(rawUsage ?? {}, "Agent usage");
    const inputTokens = usage.inputTokens ?? usage.input_tokens;
    const outputTokens = usage.outputTokens ?? usage.output_tokens;
    const normalizedUsage =
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : {
            inputTokens: safeInteger(inputTokens, "입력 token"),
            outputTokens: safeInteger(outputTokens, "출력 token"),
          };
    return { ...completed, ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
  }
  if (result.outcome === "cancelled") {
    const { usage: rawUsage, emittedTokens: rawEmittedTokens, ...cancelled } = result;
    const usage = normalizeConfirmedAgentUsage(rawUsage);
    if (rawUsage !== undefined && !usage) {
      throw new ConnectorProtocolError("Native Agent 취소 usage가 유효하지 않습니다");
    }
    return {
      ...cancelled,
      emittedTokens: rawEmittedTokens === undefined ? 0 : safeInteger(rawEmittedTokens, "Native Agent 취소 출력 token"),
      ...(usage ? { usage } : {}),
    };
  }
  if (result.outcome !== "failed") return result;
  const { usage: rawUsage, ...failed } = result;
  const usage = normalizeConfirmedAgentUsage(rawUsage);
  if (rawUsage !== undefined && !usage) throw new ConnectorProtocolError("Native Agent 실패 usage가 유효하지 않습니다");
  return {
    ...failed,
    signal:
      result.signal === undefined ? { kind: result.retryable ? "network" : "unknown" } : failureSignal(result.signal),
    emittedTokens:
      result.emittedTokens === undefined ? 0 : safeInteger(result.emittedTokens, "Native Agent 출력 token"),
    sideEffectsStarted: typeof result.sideEffectsStarted === "boolean" ? result.sideEffectsStarted : true,
    ...(usage ? { usage } : {}),
  };
}

function nativeCancellationFailure(result: RoutedAgentRuntimeResult): RoutedAgentRuntimeResult {
  const sessionId = "sessionId" in result ? result.sessionId : undefined;
  const usage = "usage" in result ? result.usage : undefined;
  const emittedTokens =
    result.outcome === "failed"
      ? result.emittedTokens
      : result.outcome === "cancelled"
        ? (result.emittedTokens ?? 0)
        : result.outcome === "completed" && (usage?.outputTokens ?? 0) > 0
          ? 1
          : 0;
  return {
    outcome: "failed",
    executionId: result.executionId,
    ...(sessionId ? { sessionId } : {}),
    category: "subscription-cancel",
    retryable: false,
    signal: { kind: "cancelled" },
    emittedTokens,
    sideEffectsStarted: true,
    ...(usage ? { usage } : {}),
  };
}

export class MassionSubscriptionRuntimeResolver implements ConnectorRuntimeResolver {
  private readonly nativeFactory: NativeSubscriptionAgentFactory;

  public constructor(private readonly options: SubscriptionRuntimeResolverOptions) {
    requireAbsolutePath(options.profileRoot, "Connector profile root");
    for (const executable of Object.values(options.executableAllowlist)) {
      requireAbsolutePath(executable, "Connector 실행 파일");
    }
    this.nativeFactory = options.nativeFactory ?? new BuiltinNativeSubscriptionAgentFactory(options.permissions);
  }

  public async resolve(
    context: TenantContext,
    input: WorkspaceConnectorRuntimeResolutionInput,
  ): Promise<ConnectorRuntimeBinding> {
    const descriptor = providerDescriptor(input.providerId);
    if (descriptor.availability === "requires-provider-approval") {
      throw new Error("공식 제공자 승인이 확인되지 않은 구독 Provider입니다");
    }
    const [account, connector, lease] = await Promise.all([
      this.options.accounts.requireUsable(context, input.accountId, input.scope),
      this.options.connectors.get(context, input.connectorId),
      this.options.broker.getLease(context, input.sessionLeaseId),
    ]);
    this.validateLineage(context, input, descriptor, account, connector, lease);
    if (descriptor.minimumVersion && !atLeast(connector.version, descriptor.minimumVersion)) {
      throw new Error("Connector가 Provider의 최소 version 요구사항을 충족하지 않습니다");
    }
    const lineage: RemoteBindingLineage = {
      providerId: input.providerId,
      modelId: input.modelId,
      routeAttemptId: input.routeAttemptId,
      sessionLeaseId: input.sessionLeaseId,
      executionId: input.executionId,
      workId: input.workId,
      agentHandle: input.agentHandle,
    };
    if (descriptor.executionKind === "model") {
      if (connector.location === "server") {
        throw new Error("서버 model Connector에는 검증된 provisioning 정본이 필요합니다");
      }
      return {
        kind: "model",
        model: new RemoteConnectorLanguageModel(input.providerId, input.modelId, context, this.options.broker, lineage),
      };
    }
    const adapterId = descriptor.adapterId;
    if (!adapterId) throw new Error("구독 Agent runtime adapter가 없습니다");
    const workspace = await this.workspace(context, input);
    const policy = requirePolicy(
      await this.options.policies.resolve(context, {
        executionId: input.executionId,
        workId: input.workId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        agentHandle: input.agentHandle,
        workspaceAccess: workspace.workspaceAccess,
        providerId: input.providerId,
        accountId: input.accountId,
        connectorId: input.connectorId,
        workspaceRoot: workspace.workspaceRoot,
      }),
    );
    if (policy.approvalPolicy === "deny") {
      throw new Error("구독 Provider의 도구 실행이 조직 정책에서 차단됐습니다");
    }
    if (connector.location === "edge") {
      if (policy.approvalPolicy === "on-request") {
        throw new Error("Edge Connector에는 검증된 승인 transport가 필요합니다");
      }
      const workspaceLineage = {
        organizationId: context.organizationId,
        connectorId: input.connectorId,
        providerId: input.providerId,
        accountId: input.accountId,
        routeAttemptId: input.routeAttemptId,
        sessionLeaseId: input.sessionLeaseId,
        executionId: input.executionId,
        workId: input.workId,
        agentHandle: input.agentHandle,
      };
      const rootCapability = selectEdgeWorkspaceRootCapability(connector.capabilities, workspaceLineage);
      const workspaceCapability = createEdgeWorkspaceExecutionCapability(rootCapability, workspaceLineage);
      return {
        kind: "agent-runtime",
        adapterId,
        executor: new RemoteConnectorAgentExecutor(
          context,
          this.options.broker,
          lineage,
          input.accountId,
          { allowedTools: workspace.allowedTools, disallowedTools: workspace.disallowedTools },
          workspaceCapability,
          policy,
          input.instruction,
        ),
      };
    }
    return await this.nativeBinding(context, input, descriptor, workspace, policy);
  }

  private validateLineage(
    context: TenantContext,
    input: WorkspaceConnectorRuntimeResolutionInput,
    descriptor: ProviderRuntimeDescriptor,
    account: SubscriptionAccount,
    connector: SubscriptionConnector,
    lease: ConnectorSessionLease,
  ): void {
    if (
      account.organization_id !== context.organizationId ||
      account.account_id !== input.accountId ||
      account.provider_id !== input.providerId ||
      account.connector_id !== input.connectorId ||
      account.status !== "active" ||
      (input.scope === "personal" && account.owner_user_id !== context.userId) ||
      (input.scope === "organization" && account.scope !== "organization") ||
      connector.organization_id !== context.organizationId ||
      connector.connector_id !== input.connectorId ||
      connector.owner_user_id !== account.owner_user_id ||
      !new Set<string>(["server", "edge"]).has(connector.location) ||
      connector.status !== "ready" ||
      connector.execution_kind !== descriptor.executionKind ||
      !connector.capabilities.includes(input.providerId) ||
      lease.status !== "active" ||
      lease.leaseId !== input.sessionLeaseId ||
      lease.executionId !== input.executionId ||
      lease.accountId !== input.accountId ||
      lease.connectorId !== input.connectorId ||
      lease.workId !== input.workId ||
      lease.agentHandle !== input.agentHandle ||
      lease.routeAttemptId !== input.routeAttemptId ||
      lease.quotaSnapshotId !== input.quotaSnapshotId
    ) {
      throw new Error("구독 실행 계보가 일치하지 않습니다");
    }
  }

  private async workspace(
    context: TenantContext,
    input: WorkspaceConnectorRuntimeResolutionInput,
  ): Promise<WorkspaceCapabilityView> {
    const requestedWorkspaceRoot = input.workspaceRoot;
    if (!requestedWorkspaceRoot) throw new Error("구독 Agent 실행에는 workspace capability가 필요합니다");
    if (!input.workspaceCapability) throw new Error("구독 Agent 실행에는 서명된 workspace capability가 필요합니다");
    const verified = await this.options.workspaceCapabilities.verify(context, {
      executionId: input.executionId,
      workId: input.workId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentHandle: input.agentHandle,
      ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
      workspaceCapability: input.workspaceCapability,
      providerId: input.providerId,
      accountId: input.accountId,
      connectorId: input.connectorId,
      requestedWorkspaceRoot,
    });
    return {
      workspaceRoot: requireAbsolutePath(verified.workspaceRoot, "승인된 workspace root"),
      workspaceAccess: verified.workspaceAccess,
      allowedTools: safeToolList(verified.allowedTools, "허용 도구"),
      disallowedTools: safeToolList(verified.disallowedTools, "제외 도구"),
    };
  }

  private async nativeBinding(
    context: TenantContext,
    input: ConnectorRuntimeResolutionInput,
    descriptor: ProviderRuntimeDescriptor,
    workspace: WorkspaceCapabilityView,
    policy: SubscriptionAgentExecutionPolicy,
  ): Promise<ConnectorRuntimeBinding> {
    const adapterId = descriptor.adapterId;
    if (!adapterId) throw new Error("구독 Agent runtime adapter가 없습니다");
    if (adapterId === "antigravity") {
      throw new Error("Antigravity는 전용 OS 계정의 Edge Connector에서만 실행할 수 있습니다");
    }
    if (adapterId.endsWith("-acp")) {
      throw new Error("서버 ACP Connector에는 검증된 process sandbox가 필요합니다");
    }
    if (adapterId === "codex" && workspace.allowedTools.length + workspace.disallowedTools.length > 0) {
      throw new Error("현재 Codex SDK 연결기는 Massion 요청별 도구 정책을 지원하지 않습니다");
    }
    const executableId = EXECUTABLE_IDS[adapterId];
    const executable = this.options.executableAllowlist[executableId];
    if (!executable && adapterId !== "codex" && adapterId !== "claude") {
      throw new Error("허용된 Connector 실행 파일이 구성되지 않았습니다");
    }
    const profileRoot = await this.profile(context.organizationId, input.accountId);
    const adapter = this.nativeFactory.create({
      adapterId,
      executable,
      modelId: input.modelId,
      workspaceRoot: workspace.workspaceRoot,
      profileRoot,
      policy,
    });
    const environment = {
      ...(executable ? { PATH: dirname(executable) } : {}),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    const agentInput = (prompt: string): SubscriptionAgentInput => ({
      executionId: input.executionId,
      workId: input.workId,
      agentHandle: input.agentHandle,
      prompt,
      workspaceRoot: workspace.workspaceRoot,
      profileRoot,
      environment,
      allowedTools: workspace.allowedTools,
      disallowedTools: workspace.disallowedTools,
    });
    const executeStructured = adapter.executeStructured?.bind(adapter);
    let resumableInput: SubscriptionAgentInput | undefined;
    const executeWithAbort = async (
      abortSignal: AbortSignal | undefined,
      operation: () => Promise<SubscriptionAgentResult>,
    ): Promise<RoutedAgentRuntimeResult> => {
      if (abortSignal?.aborted) {
        await adapter.cancel(context, input.executionId);
        return { outcome: "cancelled", executionId: input.executionId };
      }
      let cancellation: Promise<void> | undefined;
      const cancel = (): void => {
        cancellation ??= adapter.cancel(context, input.executionId);
        void cancellation.catch(() => undefined);
      };
      abortSignal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = normalizeNativeResult(await operation());
        if (cancellation) {
          try {
            await cancellation;
          } catch {
            return nativeCancellationFailure(result);
          }
        }
        return result;
      } finally {
        abortSignal?.removeEventListener("abort", cancel);
      }
    };
    const executor: RoutedAgentRuntimeExecutor = {
      execute: async ({ executionId, prompt, abortSignal }) => {
        if (executionId !== input.executionId) throw new Error("구독 Agent 실행 계보가 일치하지 않습니다");
        resumableInput = agentInput(prompt);
        return await executeWithAbort(
          abortSignal,
          async () => await adapter.execute(context, resumableInput as SubscriptionAgentInput),
        );
      },
      ...(executeStructured
        ? {
            executeStructured: async (
              {
                executionId,
                prompt,
                abortSignal,
              }: { readonly executionId: string; readonly prompt: string; readonly abortSignal?: AbortSignal },
              output: StructuredOutputSpec,
            ) => {
              if (executionId !== input.executionId) throw new Error("구독 Agent 실행 계보가 일치하지 않습니다");
              resumableInput = agentInput(prompt);
              return await executeWithAbort(
                abortSignal,
                async () => await executeStructured(context, resumableInput as SubscriptionAgentInput, output),
              );
            },
          }
        : {}),
      resume: async ({ executionId, sessionId, approvalId, approved, abortSignal }) => {
        if (executionId !== input.executionId) throw new Error("구독 Agent 실행 계보가 일치하지 않습니다");
        if (!resumableInput) throw new Error("재개할 구독 Agent 입력이 없습니다");
        return await executeWithAbort(
          abortSignal,
          async () =>
            await adapter.resume(context, resumableInput as SubscriptionAgentInput, {
              sessionId,
              approvalId,
              approved,
            }),
        );
      },
      cancel: async () => {
        await adapter.cancel(context, input.executionId);
      },
    };
    return { kind: "agent-runtime", adapterId, executor };
  }

  private async profile(organizationId: string, accountId: string): Promise<string> {
    try {
      return await prepareSubscriptionProfileRoot(this.options.profileRoot, organizationId, accountId);
    } catch (error) {
      throw new Error("계정별 Connector profile을 준비하지 못했습니다", { cause: error });
    }
  }
}
