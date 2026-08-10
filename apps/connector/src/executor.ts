import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { TenantContext } from "@massion/identity";
import {
  ClaudeSubscriptionConnector,
  CopilotAcpConnector,
  CodexSubscriptionConnector,
  GeminiCliAcpConnector,
  GrokBuildAcpConnector,
  executionEvidenceIsSafe,
  normalizeConfirmedAgentUsage,
  SubscriptionStructuredOutputError,
  type AcpClientFactory,
  type AcpPermissionBridge,
  type ClaudeSubscriptionConnectorOptions,
  type StructuredOutputSpec,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
} from "@massion/runtime";
import { matchesEdgeWorkspaceExecutionCapability } from "@massion/subscriptions";

import {
  edgeManagedWorkspaceForWork,
  edgeWorkspaceRootBindings,
  type ActiveConnectorIdentity,
  type EdgeProviderId,
} from "./identity-store.js";
import {
  PinnedProviderProfileHealthProbe,
  ProviderReauthenticationRequiredError,
  type ProviderProfileHealthProbe,
} from "./profile-health.js";
import {
  CONNECTOR_PROTOCOL,
  type ConnectorCancelFrame,
  type ConnectorEventFrame,
  type ConnectorRequestFrame,
} from "./protocol.js";
import { assertEdgeRuntimeArtifact, type EdgeRuntimeArtifact } from "./runtime-artifact.js";

export interface EdgeExecutionPolicy {
  readonly sandboxMode: "read-only" | "workspace-write";
  readonly approvalPolicy: "never";
  readonly networkAccessEnabled: boolean;
}

export interface EdgeAgentAdapterFactoryInput {
  readonly providerId: EdgeProviderId;
  readonly modelId: string;
  readonly accountId: string;
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly policy: EdgeExecutionPolicy;
  readonly runtimeArtifact?: EdgeRuntimeArtifact;
}

export interface EdgeAgentAdapterFactory {
  create(input: EdgeAgentAdapterFactoryInput): SubscriptionAgentAdapter;
}

interface ValidAgentTurn {
  readonly providerId: EdgeProviderId;
  readonly modelId: string;
  readonly accountId: string;
  readonly routeAttemptId: string;
  readonly sessionLeaseId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly prompt: string;
  readonly instruction?: string;
  readonly workspaceRoot: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly policy: EdgeExecutionPolicy;
  readonly output?: StructuredOutputSpec;
}

interface ActiveRequest {
  readonly requestId: string;
  readonly leaseId: string;
  readonly executionId: string;
  readonly adapter: SubscriptionAgentAdapter;
  readonly context: TenantContext;
}

export interface EdgeRequestExecutorOptions {
  readonly identity: ActiveConnectorIdentity;
  readonly factory?: EdgeAgentAdapterFactory;
  readonly healthProbe?: ProviderProfileHealthProbe;
  readonly maximumConcurrentRequests?: number;
  readonly runtimeAttestor?: (
    providerId: EdgeProviderId,
    artifact: EdgeRuntimeArtifact,
  ) => Promise<EdgeRuntimeArtifact>;
  readonly log?: (message: string) => void;
}

const AGENT_TURN_FIELDS = [
  "providerId",
  "modelId",
  "accountId",
  "routeAttemptId",
  "sessionLeaseId",
  "executionId",
  "workId",
  "agentHandle",
  "prompt",
  "instruction",
  "workspaceCapability",
  "allowedTools",
  "disallowedTools",
  "policy",
  "output",
] as const;
const REQUIRED_AGENT_TURN_FIELDS = AGENT_TURN_FIELDS.filter((field) => field !== "output" && field !== "instruction");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAXIMUM_TEXT_BYTES = 512 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = required.find((key) => value[key] === undefined);
  if (missing) throw new Error(`${label} 필드가 필요합니다: ${missing}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function prompt(value: unknown, label = "Agent prompt"): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function tools(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label}이 유효하지 않습니다`);
  return value.map((tool) => {
    if (typeof tool !== "string" || !tool || tool.length > 512 || /[\0\r\n]/u.test(tool)) {
      throw new Error(`${label} 값이 유효하지 않습니다`);
    }
    return tool;
  });
}

function policy(value: unknown): EdgeExecutionPolicy {
  const source = record(value, "Agent 실행 정책");
  exact(
    source,
    ["sandboxMode", "approvalPolicy", "networkAccessEnabled"],
    ["sandboxMode", "approvalPolicy", "networkAccessEnabled"],
    "Agent 실행 정책",
  );
  if (
    (source.sandboxMode !== "read-only" && source.sandboxMode !== "workspace-write") ||
    source.approvalPolicy !== "never" ||
    typeof source.networkAccessEnabled !== "boolean"
  ) {
    throw new Error("Edge Agent 실행 정책이 유효하지 않습니다");
  }
  return {
    sandboxMode: source.sandboxMode,
    approvalPolicy: source.approvalPolicy,
    networkAccessEnabled: source.networkAccessEnabled,
  };
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("구조화 출력 schema 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("구조화 출력 schema 숫자가 유효하지 않습니다");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error("구조화 출력 schema 배열 상한을 초과했습니다");
    for (const child of value) assertJson(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("구조화 출력 schema가 JSON이 아닙니다");
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("구조화 출력 schema에 금지된 key가 있습니다");
    }
    assertJson(child, depth + 1);
  }
}

function output(value: unknown): StructuredOutputSpec | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "구조화 출력");
  exact(source, ["name", "description", "jsonSchema"], ["name", "description", "jsonSchema"], "구조화 출력");
  const name = identifier(source.name, "구조화 출력 이름");
  if (typeof source.description !== "string" || !source.description || source.description.length > 4096) {
    throw new Error("구조화 출력 설명이 유효하지 않습니다");
  }
  const jsonSchema = record(source.jsonSchema, "구조화 출력 JSON schema");
  assertJson(jsonSchema);
  if (Buffer.byteLength(JSON.stringify(jsonSchema), "utf8") > 256 * 1024) {
    throw new Error("구조화 출력 schema byte 상한을 초과했습니다");
  }
  return { name, description: source.description, jsonSchema };
}

async function workspace(
  value: unknown,
  identity: ActiveConnectorIdentity,
  lineage: {
    readonly providerId: string;
    readonly accountId: string;
    readonly routeAttemptId: string;
    readonly sessionLeaseId: string;
    readonly executionId: string;
    readonly workId: string;
    readonly agentHandle: string;
  },
): Promise<string> {
  if (typeof value !== "string") throw new Error("요청 workspace capability가 유효하지 않습니다");
  const matches = edgeWorkspaceRootBindings(identity).filter(
    ({ capability }) =>
      identity.capabilities.includes(capability) &&
      matchesEdgeWorkspaceExecutionCapability(value, capability, {
        organizationId: identity.organizationId,
        connectorId: identity.connectorId,
        ...lineage,
      }),
  );
  if (matches.length !== 1 || !matches[0]) throw new Error("요청 workspace capability가 유효하지 않습니다");
  return await edgeManagedWorkspaceForWork(matches[0].workspaceRoot, identity.organizationId, lineage.workId);
}

function safeSessionId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("Provider session ID가 유효하지 않습니다");
  return value;
}

function usage(value: unknown): { readonly inputTokens: number; readonly outputTokens: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { inputTokens: 0, outputTokens: 0 };
  const source = value as Record<string, unknown>;
  const input = source.inputTokens ?? source.input_tokens ?? 0;
  const output = source.outputTokens ?? source.output_tokens ?? 0;
  return {
    inputTokens: Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : 0,
    outputTokens: Number.isSafeInteger(output) && Number(output) >= 0 ? Number(output) : 0,
  };
}

function resultText(value: unknown): string {
  let encoded: string;
  if (typeof value === "string") encoded = value;
  else {
    assertJson(value);
    encoded = JSON.stringify(value);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_TEXT_BYTES)
    throw new Error("Provider 출력 byte 상한을 초과했습니다");
  return encoded;
}

function safeFailureSignal(
  value: unknown,
):
  | { readonly valid: true; readonly signal: Record<string, unknown> }
  | { readonly valid: false; readonly signal: { readonly kind: "unknown" } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, signal: { kind: "unknown" } };
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "http") {
    if (
      !Number.isSafeInteger(source.statusCode) ||
      Number(source.statusCode) < 100 ||
      Number(source.statusCode) > 599
    ) {
      return { valid: false, signal: { kind: "unknown" } };
    }
    let retryAfter: string | undefined;
    if (source.retryAfter !== undefined) {
      if (typeof source.retryAfter !== "string" || source.retryAfter.length > 128) {
        return { valid: false, signal: { kind: "unknown" } };
      }
      if (/^(?:0|[1-9][0-9]{0,9})$/u.test(source.retryAfter)) retryAfter = source.retryAfter;
      else {
        const timestamp = Date.parse(source.retryAfter);
        if (!Number.isFinite(timestamp)) return { valid: false, signal: { kind: "unknown" } };
        retryAfter = new Date(timestamp).toISOString();
      }
    }
    return {
      valid: true,
      signal: { kind: "http", statusCode: Number(source.statusCode), ...(retryAfter ? { retryAfter } : {}) },
    };
  }
  if (new Set(["timeout", "network", "input", "policy", "cancelled", "unknown"]).has(String(source.kind))) {
    return { valid: true, signal: { kind: String(source.kind) } };
  }
  return { valid: false, signal: { kind: "unknown" } };
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function safeAcpLocation(workspaceRoot: string, path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.includes("\0")) return false;
  const lexical = resolve(path);
  if (!within(workspaceRoot, lexical)) return false;
  try {
    return within(workspaceRoot, await realpath(lexical));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      return within(workspaceRoot, await realpath(dirname(lexical)));
    } catch {
      return false;
    }
  }
}

function automaticAcpPermissions(input: EdgeAgentAdapterFactoryInput): AcpPermissionBridge {
  return {
    request: async (_context, { request }) => {
      const kind = request.toolCall.kind;
      const locations = request.toolCall.locations ?? [];
      const readKind = kind === "read" || kind === "search";
      const writeKind = kind === "edit" || kind === "delete" || kind === "move";
      const safeKind =
        kind === "think" ||
        kind === "switch_mode" ||
        (kind === "fetch" && input.policy.networkAccessEnabled) ||
        readKind ||
        (writeKind && input.policy.sandboxMode === "workspace-write");
      const requiresLocation = new Set(["read", "edit", "delete", "move", "search"]).has(String(kind));
      const safeLocations =
        (!requiresLocation || locations.length > 0) &&
        (
          await Promise.all(
            locations.map(async (location) => await safeAcpLocation(input.workspaceRoot, location.path)),
          )
        ).every(Boolean);
      const selected =
        safeKind && safeLocations ? request.options.find((option) => option.kind === "allow_once") : undefined;
      return selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
  };
}

export class BuiltinEdgeAgentAdapterFactory implements EdgeAgentAdapterFactory {
  public constructor(private readonly acpFactory?: AcpClientFactory) {}

  public create(input: EdgeAgentAdapterFactoryInput): SubscriptionAgentAdapter {
    if (input.providerId === "openai-codex") {
      return new CodexSubscriptionConnector(undefined, {
        allowedEnvironment: ["CODEX_HOME", "LANG", "LC_ALL"],
        threadPolicy: { ...input.policy, model: input.modelId },
      });
    }
    if (
      input.providerId === "google-gemini-cli-enterprise" ||
      input.providerId === "github-copilot" ||
      input.providerId === "xai-grok-build"
    ) {
      if (!input.runtimeArtifact) throw new Error("외부 ACP Edge Provider runtime artifact가 필요합니다");
      const options = {
        executable: input.runtimeArtifact.executable,
        model: input.modelId,
        workspaceAccess: input.policy.sandboxMode,
      } as const;
      if (input.providerId === "google-gemini-cli-enterprise") {
        return new GeminiCliAcpConnector(
          { ...options, sandbox: true },
          this.acpFactory,
          automaticAcpPermissions(input),
        );
      }
      if (input.providerId === "github-copilot") {
        return new CopilotAcpConnector(options, this.acpFactory, automaticAcpPermissions(input));
      }
      return new GrokBuildAcpConnector(
        { ...options, sandbox: "strict" },
        this.acpFactory,
        automaticAcpPermissions(input),
      );
    }
    const sandbox: ClaudeSubscriptionConnectorOptions["sandbox"] = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [input.workspaceRoot, input.profileRoot],
        allowWrite:
          input.policy.sandboxMode === "workspace-write"
            ? [input.workspaceRoot, input.profileRoot]
            : [input.profileRoot],
        allowManagedReadPathsOnly: true,
      },
      network: input.policy.networkAccessEnabled
        ? { allowManagedDomainsOnly: false, allowAllUnixSockets: false, allowLocalBinding: false }
        : {
            allowedDomains: [],
            allowManagedDomainsOnly: true,
            allowAllUnixSockets: false,
            allowLocalBinding: false,
          },
    };
    return new ClaudeSubscriptionConnector(undefined, undefined, {
      permissionMode: "auto",
      sandbox,
      model: input.modelId,
    });
  }
}

export class EdgeRequestExecutor {
  private readonly identity: ActiveConnectorIdentity;
  private readonly factory: EdgeAgentAdapterFactory;
  private readonly healthProbe: ProviderProfileHealthProbe;
  private readonly maximumConcurrentRequests: number;
  private readonly runtimeAttestor: NonNullable<EdgeRequestExecutorOptions["runtimeAttestor"]>;
  private readonly log: (message: string) => void;
  private readonly active = new Map<string, ActiveRequest>();

  public constructor(options: EdgeRequestExecutorOptions) {
    this.identity = options.identity;
    this.factory = options.factory ?? new BuiltinEdgeAgentAdapterFactory();
    this.healthProbe = options.healthProbe ?? new PinnedProviderProfileHealthProbe();
    this.runtimeAttestor = options.runtimeAttestor ?? assertEdgeRuntimeArtifact;
    this.maximumConcurrentRequests = options.maximumConcurrentRequests ?? 8;
    if (
      !Number.isSafeInteger(this.maximumConcurrentRequests) ||
      this.maximumConcurrentRequests < 1 ||
      this.maximumConcurrentRequests > 64
    ) {
      throw new Error("동시 Connector 요청 상한이 유효하지 않습니다");
    }
    this.log = options.log ?? (() => undefined);
  }

  public get activeRequests(): number {
    return this.active.size;
  }

  public async execute(
    request: ConnectorRequestFrame,
    emit: (event: ConnectorEventFrame) => void | Promise<void>,
  ): Promise<void> {
    let sequence = 0;
    let sideEffectsStarted = false;
    let emittedParts = 0;
    const send = async (kind: ConnectorEventFrame["kind"], payload: unknown): Promise<void> => {
      await emit({
        protocol: CONNECTOR_PROTOCOL,
        type: "event",
        requestId: request.requestId,
        leaseId: request.leaseId,
        sequence,
        kind,
        payload,
      });
      sequence += 1;
      if (kind === "data") emittedParts += 1;
    };
    try {
      if (request.operation !== "agent-turn") {
        await send("error", this.failure("unsupported-operation", { kind: "input" }, false, false, 0));
        return;
      }
      if (this.active.size >= this.maximumConcurrentRequests) throw new Error("동시 요청 상한을 초과했습니다");
      if (this.active.has(request.requestId)) throw new Error("Request ID를 재사용할 수 없습니다");
      const input = await this.validate(request);
      if (this.identity.runtimeArtifact) {
        await this.runtimeAttestor(this.identity.providerId, this.identity.runtimeArtifact);
      }
      await this.healthProbe.verify({
        providerId: this.identity.providerId,
        profileRoot: this.identity.profileRoot,
        expectedAuthKind: this.identity.authKind,
        billingKind: this.identity.billingKind,
        ...(this.identity.runtimeArtifact ? { runtimeArtifact: this.identity.runtimeArtifact } : {}),
      });
      const context: TenantContext = {
        organizationId: this.identity.organizationId,
        userId: this.identity.ownerUserId,
        membershipId: this.identity.membershipId,
        role: this.identity.role,
      };
      const adapter = this.factory.create({
        providerId: input.providerId,
        modelId: input.modelId,
        accountId: input.accountId,
        workspaceRoot: input.workspaceRoot,
        profileRoot: this.identity.profileRoot,
        policy: input.policy,
        ...(this.identity.runtimeArtifact ? { runtimeArtifact: this.identity.runtimeArtifact } : {}),
      });
      this.active.set(request.requestId, {
        requestId: request.requestId,
        leaseId: request.leaseId,
        executionId: input.executionId,
        adapter,
        context,
      });
      const agentInput: SubscriptionAgentInput = {
        executionId: input.executionId,
        workId: input.workId,
        agentHandle: input.agentHandle,
        prompt: input.instruction ? `${input.instruction}\n\n${input.prompt}` : input.prompt,
        workspaceRoot: input.workspaceRoot,
        profileRoot: this.identity.profileRoot,
        environment: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          ...(this.identity.runtimeArtifact
            ? { PATH: `${dirname(this.identity.runtimeArtifact.executable)}:/usr/bin:/bin` }
            : {}),
        },
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
      };
      sideEffectsStarted = true;
      const result = input.output
        ? adapter.executeStructured
          ? await adapter.executeStructured(context, agentInput, input.output)
          : ({
              outcome: "failed",
              executionId: input.executionId,
              category: "structured-output-unsupported",
              retryable: false,
            } satisfies SubscriptionAgentResult)
        : await adapter.execute(context, agentInput);
      await this.emitResult(result, input.output, send);
    } catch (error) {
      if (error instanceof ProviderReauthenticationRequiredError) {
        this.log("Provider profile 재인증이 필요합니다");
        await send("error", this.failure("needs-reauth", { kind: "http", statusCode: 401 }, false, false, 0)).catch(
          () => undefined,
        );
        return;
      }
      this.log("Edge Connector 요청을 안전하게 종료했습니다");
      const structuredOutputFailure = error instanceof SubscriptionStructuredOutputError ? error : undefined;
      const confirmedUsage = normalizeConfirmedAgentUsage(structuredOutputFailure?.usage);
      if (confirmedUsage) await send("usage", confirmedUsage).catch(() => undefined);
      await send(
        "error",
        this.failure(
          sideEffectsStarted ? "provider-runtime-error" : "invalid-request",
          { kind: sideEffectsStarted ? "unknown" : "input" },
          false,
          structuredOutputFailure?.sideEffectsStarted ?? sideEffectsStarted,
          structuredOutputFailure?.emittedTokens ?? emittedParts,
          confirmedUsage,
        ),
      ).catch(() => undefined);
    } finally {
      this.active.delete(request.requestId);
    }
  }

  public async cancel(frame: ConnectorCancelFrame): Promise<void> {
    const active = this.active.get(frame.requestId);
    if (!active || active.leaseId !== frame.leaseId) return;
    await active.adapter.cancel(active.context, active.executionId);
  }

  public async shutdown(): Promise<void> {
    const active = [...this.active.values()];
    await Promise.allSettled(
      active.map(async (request) => request.adapter.cancel(request.context, request.executionId)),
    );
  }

  private async validate(request: ConnectorRequestFrame): Promise<ValidAgentTurn> {
    const source = record(request.payload, "Agent turn payload");
    exact(source, AGENT_TURN_FIELDS, REQUIRED_AGENT_TURN_FIELDS, "Agent turn payload");
    if (source.providerId !== this.identity.providerId)
      throw new Error("Connector Provider capability가 일치하지 않습니다");
    const providerId = source.providerId as EdgeProviderId;
    const allowedTools = tools(source.allowedTools, "허용 도구");
    const disallowedTools = tools(source.disallowedTools, "제외 도구");
    if (providerId === "openai-codex" && allowedTools.length + disallowedTools.length > 0) {
      throw new Error("Codex 요청별 도구 정책은 지원하지 않습니다");
    }
    const sessionLeaseId = identifier(source.sessionLeaseId, "Session Lease ID");
    if (sessionLeaseId !== request.leaseId) throw new Error("Session Lease 계보가 일치하지 않습니다");
    const accountId = identifier(source.accountId, "구독 계정 ID");
    const routeAttemptId = identifier(source.routeAttemptId, "Route Attempt ID");
    const executionId = identifier(source.executionId, "Execution ID");
    const workId = identifier(source.workId, "Work ID");
    const agentHandle = identifier(source.agentHandle, "Agent handle");
    const structuredOutput = output(source.output);
    return {
      providerId,
      modelId: identifier(source.modelId, "Model ID"),
      accountId,
      routeAttemptId,
      sessionLeaseId,
      executionId,
      workId,
      agentHandle,
      prompt: prompt(source.prompt),
      ...(source.instruction === undefined ? {} : { instruction: prompt(source.instruction, "Agent instruction") }),
      workspaceRoot: await workspace(source.workspaceCapability, this.identity, {
        providerId,
        accountId,
        routeAttemptId,
        sessionLeaseId,
        executionId,
        workId,
        agentHandle,
      }),
      allowedTools,
      disallowedTools,
      policy: policy(source.policy),
      ...(structuredOutput ? { output: structuredOutput } : {}),
    };
  }

  private async emitResult(
    result: SubscriptionAgentResult,
    structuredOutput: StructuredOutputSpec | undefined,
    send: (kind: ConnectorEventFrame["kind"], payload: unknown) => Promise<void>,
  ): Promise<void> {
    if (result.outcome === "suspended") {
      await send("error", this.failure("unsupported-terminal", { kind: "policy" }, false, true, 0));
      return;
    }
    if (result.outcome === "cancelled") {
      const confirmedUsage = normalizeConfirmedAgentUsage(result.usage);
      const emittedTokens =
        Number.isSafeInteger(result.emittedTokens) && Number(result.emittedTokens) >= 0
          ? Number(result.emittedTokens)
          : 0;
      if (confirmedUsage) await send("usage", confirmedUsage);
      await send("error", this.failure("cancelled", { kind: "cancelled" }, false, true, emittedTokens, confirmedUsage));
      return;
    }
    if (result.outcome === "failed") {
      const category = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(result.category) ? result.category : "provider-failed";
      const parsedSignal = safeFailureSignal(result.signal);
      const emittedTokens =
        Number.isSafeInteger(result.emittedTokens) && Number(result.emittedTokens) >= 0
          ? Number(result.emittedTokens)
          : 0;
      const sideEffectsStarted =
        parsedSignal.valid &&
        Number.isSafeInteger(result.emittedTokens) &&
        typeof result.sideEffectsStarted === "boolean"
          ? result.sideEffectsStarted
          : true;
      const confirmedUsage = normalizeConfirmedAgentUsage(result.usage);
      if (confirmedUsage) await send("usage", confirmedUsage);
      await send(
        "error",
        this.failure(
          category,
          parsedSignal.valid ? parsedSignal.signal : { kind: result.retryable ? "network" : "unknown" },
          result.retryable,
          sideEffectsStarted,
          emittedTokens,
          confirmedUsage,
        ),
      );
      return;
    }
    const text = resultText(result.value);
    if (result.executionEvidence && !executionEvidenceIsSafe(result.executionEvidence)) {
      throw new Error("Provider 실행 근거가 유효하지 않습니다");
    }
    if (text) await send("data", { type: "text-delta", delta: text });
    await send("usage", usage(result.usage));
    await send("done", {
      outcome: "completed",
      sessionId: safeSessionId(result.sessionId),
      ...(structuredOutput ? { value: result.value } : {}),
      ...(result.executionEvidence ? { executionEvidence: result.executionEvidence } : {}),
    });
  }

  private failure(
    category: string,
    signal: Record<string, unknown>,
    retryable: boolean,
    sideEffectsStarted: boolean,
    emittedTokens: number,
    confirmedUsage?: { readonly inputTokens: number; readonly outputTokens: number },
  ): Record<string, unknown> {
    return {
      category,
      retryable,
      signal,
      emittedTokens,
      sideEffectsStarted,
      ...(confirmedUsage ? { usage: confirmedUsage } : {}),
    };
  }
}
