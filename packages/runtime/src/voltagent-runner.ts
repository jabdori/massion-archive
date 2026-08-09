import { createHash, randomUUID } from "node:crypto";

import { Agent, type DynamicValue } from "@voltagent/core";
import { jsonSchema, Output, type LanguageModel } from "ai";

import type { TenantContext } from "@massion/identity";
import type { FailureSignal } from "@massion/router";

import type {
  AgentExecutionEvent,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentRunner,
  ExecutionDelta,
  ExecutionDeltaObserver,
  StructuredAgentRunner,
  StructuredOutputSpec,
} from "./contracts.js";
import { MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, MASSION_TENANT_CONTEXT_KEY } from "./agent-configuration.js";
import { runtimeAgentName } from "./agent-topology.js";
import {
  runtimeErrorFromFailureSignal,
  runtimeErrorFromStructuredFailure,
  runtimeExecutionResult,
  type RuntimeEvent,
  type RuntimeExecution,
  RuntimeExecutionStore,
} from "./execution-store.js";
import {
  RoutedExecutionSettlementError,
  type AcquireModelInput,
  type RoutedAgentRuntimeLease,
  type RoutedAgentRuntimeResult,
  type RoutedLanguageModelLease,
  type RoutedModelFactory,
  type RoutedModelLease,
  type RoutedModelSelectionLease,
} from "./model-factory.js";
import type {
  JsonValue,
  SubscriptionExecutionReceiptCoordinator,
  SubscriptionReceiptLineage,
} from "./subscriptions/execution-receipt.js";
import type { ExecutionEvidence } from "./subscriptions/execution-evidence.js";
import { SubscriptionStructuredOutputError } from "./subscriptions/agent-runtime.js";

const MAX_FALLBACKS = 16;
const MODEL_ROUTE_EVENT_CAS_RETRIES = 3;
const MINIMUM_SESSION_RENEW_DELAY_MS = 1_000;
// 모델 제공자가 응답을 끝내지 않아도 Work가 영구 실행 상태에 남지 않도록 합니다.
// 로컬 Connector의 기본 요청 기한(120초)과 맞춰, 모델 호출도 같은 상한을 사용합니다.
const MODEL_TOTAL_TIMEOUT_MS = 120_000;
const MODEL_STREAM_CHUNK_TIMEOUT_MS = 30_000;
const AGENT_RUNTIME_TOTAL_TIMEOUT_MS = 300_000;
const MODEL_ACQUIRE_TIMEOUT_MS = 30_000;

export interface SessionRenewalClock {
  now(): number;
  schedule(delayMs: number, task: () => Promise<void>): () => void;
}

export interface VoltAgentRunnerOptions {
  readonly sessionRenewalClock?: SessionRenewalClock;
  /** 테스트에서만 짧게 검증할 수 있는 Provider 응답 상한입니다. 운영 기본값은 300초입니다. */
  readonly agentRuntimeTimeoutMs?: number;
  /** Router reservation과 Connector session 확보를 포함한 모델 임대 상한입니다. */
  readonly modelAcquireTimeoutMs?: number;
  readonly deltaObserver?: ExecutionDeltaObserver;
  readonly subscriptionReceipts?: Pick<
    SubscriptionExecutionReceiptCoordinator,
    | "read"
    | "recover"
    | "interruptSuspended"
    | "recordRouteSessionAcquired"
    | "recordInvocationStarted"
    | "recordCheckpointObserved"
    | "recordTerminalObserved"
    | "recordSettlementCompleted"
  >;
  readonly subscriptionApprovals?: {
    consume(
      context: TenantContext,
      input: { readonly executionId: string; readonly approvalId: string },
    ): Promise<"approved" | "rejected">;
    interrupt?(
      context: TenantContext,
      input: { readonly executionId: string; readonly approvalId: string },
    ): Promise<void>;
  };
}

class SessionLeaseRenewalError extends Error {
  public constructor(options: { readonly cause: unknown }) {
    super("Connector Session Lease 갱신에 실패했습니다", options);
    this.name = "SessionLeaseRenewalError";
  }
}

const DEFAULT_SESSION_RENEWAL_CLOCK: SessionRenewalClock = {
  now: () => Date.now(),
  schedule(delayMs, task) {
    const timer = setTimeout(() => void task(), delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

interface ActiveExecution {
  readonly context: TenantContext;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly detachAbortSignal: () => void;
  cancellation?: Promise<void>;
}

interface SuspendedSubscriptionExecution {
  readonly context: TenantContext;
  readonly lease: RoutedAgentRuntimeLease;
  readonly sessionId: string;
  readonly approvalId: string;
  approvalDecision?: "approved" | "rejected";
  resumeExpectedVersion?: number;
  resumeAttempt?: Promise<AgentExecutionResult>;
}

type AgentRuntimeAttemptOutcome =
  { readonly kind: "terminal"; readonly result: AgentExecutionResult } | { readonly kind: "fallback" };

type ReceiptTerminalDetails =
  | {
      readonly outcome: "completed";
      readonly providerExecutionId: string;
      readonly providerSessionId?: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly output: { readonly kind: "inline"; readonly value: JsonValue };
      readonly executionEvidence?: ExecutionEvidence;
    }
  | {
      readonly outcome: "failed" | "cancelled" | "interrupted";
      readonly providerExecutionId: string;
      readonly providerSessionId?: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly emittedTokens: number;
      readonly sideEffectsStarted: boolean;
      readonly category?: string;
      readonly retryable?: boolean;
      readonly signal: FailureSignal;
    };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function eventView(event: RuntimeEvent): AgentExecutionEvent {
  return {
    executionId: event.execution_id,
    sequence: event.sequence,
    type: event.event_type,
    payload: JSON.parse(event.payload_json) as unknown,
    createdAt: event.created_at,
  };
}

function prompt(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function jsonOutputPrompt(input: unknown, output: StructuredOutputSpec): string {
  return [
    prompt(input),
    "",
    `Massion JSON output schema (${output.name}):`,
    JSON.stringify(output.jsonSchema),
    "응답은 위 schema를 만족하는 JSON object 하나만 반환하세요. Markdown code fence나 설명을 포함하지 마세요.",
  ].join("\n");
}

function validateJsonOutput(value: unknown, output: StructuredOutputSpec): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("구조화 출력은 JSON object여야 합니다");
  if (!output.validate) return value;
  const validated = output.validate(value);
  if (!validated.success) throw new Error("구조화 출력 검증에 실패했습니다", { cause: validated.error });
  return validated.value;
}

function nonNativeStructuredGenerationOptions(lease: RoutedLanguageModelLease) {
  const provider =
    lease.model &&
    typeof lease.model === "object" &&
    "provider" in lease.model &&
    typeof lease.model.provider === "string"
      ? lease.model.provider
      : undefined;
  if (provider !== "zai-coding-plan.chat") return {};
  return {
    providerOptions: {
      "zai-coding-plan": { thinking: { type: "disabled" as const } },
    },
  };
}

/**
 * adapter가 부작용 관측 사실을 실어 보낸 경우 그 값을 쓰고,
 * 그렇지 않으면 lease 종류에 따라 fail-closed로 가정합니다.
 */
function observedSideEffects(error: unknown, fallbackAssumption: boolean): boolean {
  return error instanceof SubscriptionStructuredOutputError ? error.sideEffectsStarted : fallbackAssumption;
}

export function failureSignal(error: unknown): FailureSignal {
  if (error instanceof SubscriptionStructuredOutputError) return { kind: "output" };
  if (
    error instanceof Error &&
    (error.message.startsWith("No object generated:") ||
      error.message === "Invalid JSON response" ||
      error.message === "Model text output is empty" ||
      error.message.toLowerCase().includes("structured output") ||
      error.message.includes("구조화 출력"))
  ) {
    return { kind: "output" };
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("operation aborted") &&
    error.message.toLowerCase().includes("timeout")
  ) {
    return { kind: "timeout" };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const statusCode = record.statusCode;
    if (Number.isSafeInteger(statusCode) && Number(statusCode) >= 100 && Number(statusCode) <= 599) {
      return { kind: "http", statusCode: Number(statusCode) };
    }
    const name = record.name;
    if (name === "TimeoutError") return { kind: "timeout" };
  }
  return error instanceof TypeError ? { kind: "network" } : { kind: "unknown" };
}

function isModelUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("blocked_model_unavailable:");
}

function isRuntimeExecutionVersionConflict(error: unknown): boolean {
  return error instanceof Error && /^현재 Runtime Execution version은 \d+입니다$/u.test(error.message);
}

/** 모든 모델 호출은 상위 취소를 보존하면서도 외부 응답 대기를 유한하게 제한합니다. */
function modelAbortSignal(parent: AbortSignal, timeoutMs = MODEL_TOTAL_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

export function normalizeVoltAgentStreamPart(
  part: { readonly type: string } & Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { type: part.type };
  for (const key of ["id", "text", "delta", "toolName", "toolCallId", "finishReason", "usage"] as const) {
    if (part[key] !== undefined) safe[key] = part[key];
  }
  return safe;
}

export class RoutedModelRegistry {
  private readonly leases = new Map<string, RoutedLanguageModelLease>();

  public readonly resolve: DynamicValue<LanguageModel> = ({ context }) => {
    const executionId = context.get(MASSION_RUNTIME_EXECUTION_CONTEXT_KEY);
    if (typeof executionId !== "string") throw new Error("VoltAgent context에 Massion execution ID가 없습니다");
    const lease = this.leases.get(executionId);
    if (!lease) throw new Error(`Runtime model lease를 찾을 수 없습니다: ${executionId}`);
    return lease.model;
  };

  public set(executionId: string, lease: RoutedLanguageModelLease): void {
    if (this.leases.has(executionId)) throw new Error(`Runtime model lease가 이미 등록됐습니다: ${executionId}`);
    this.leases.set(executionId, lease);
  }

  public delete(executionId: string): void {
    this.leases.delete(executionId);
  }

  public get size(): number {
    return this.leases.size;
  }
}

interface VoltAgentReader {
  getAgents(): Agent[];
}

export interface AgentExecutionLifecycle {
  suspend(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult>;
  recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult>;
}

export interface RoutedExecutionContextResolver {
  resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
      readonly workspaceAccess?: import("./contracts.js").WorkspaceAccess;
    },
  ): Promise<{
    readonly workspaceRoot?: string;
    readonly workspaceAccess?: import("./contracts.js").WorkspaceAccess;
    readonly workspaceCapability?: string;
    readonly instruction?: string;
  }>;
}

/**
 * Tool 인자·결과를 협업 기록이 읽을 수 있는 크기로 자릅니다. 상한을 넘으면 잘린 문자열이 아니라
 * 필드 자체를 비웁니다 — 반쪽 JSON을 넘기면 읽는 쪽이 파싱에 실패하고 그 이유를 알 수 없습니다.
 */
const TOOL_PAYLOAD_LIMIT = 8_000;

function boundedToolPayload(field: "toolInput" | "toolOutput", value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  let encoded: string;
  try {
    // 위에서 undefined·null을 걸렀으므로 여기 결과는 언제나 문자열입니다.
    encoded = JSON.stringify(value);
  } catch {
    return {};
  }
  if (encoded.length === 0 || encoded.length > TOOL_PAYLOAD_LIMIT) return {};
  return { [field]: encoded };
}

export class VoltAgentRunner implements AgentRunner, StructuredAgentRunner {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly deltaSequences = new Map<string, number>();
  private readonly suspendedSubscriptions = new Map<string, SuspendedSubscriptionExecution>();
  private readonly subscriptionReceipts: VoltAgentRunnerOptions["subscriptionReceipts"];
  private accepting = true;
  private intakeOperations = 0;
  private intakeSettled: ReturnType<typeof deferred> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(
    private readonly voltAgent: VoltAgentReader,
    private readonly store: RuntimeExecutionStore,
    private readonly models: RoutedModelFactory,
    private readonly registry: RoutedModelRegistry,
    private readonly lifecycle?: AgentExecutionLifecycle,
    private readonly executionContext?: RoutedExecutionContextResolver,
    private readonly options: VoltAgentRunnerOptions = {},
  ) {
    this.subscriptionReceipts = options.subscriptionReceipts ?? models.createSubscriptionReceipts?.(store);
  }

  public async execute(context: TenantContext, input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const { signal, ...executionInput } = input;
    const releaseIntake = this.beginIntake();
    let active: ActiveExecution | undefined;
    let running: { readonly execution: RuntimeExecution } | undefined;
    try {
      const created = await this.store.createExecution(context, executionInput);
      if (created.execution.status !== "queued") return this.resultFromExecution(created.execution);
      if (signal?.aborted)
        return await this.cancelBeforeProvider(context, created.execution.execution_id, signal.reason as unknown);
      running = await this.store.transition(context, {
        commandId: `${created.execution.execution_id}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: { agentHandle: input.agentHandle },
      });
      active = this.activate(context, running.execution.execution_id, signal);
    } finally {
      releaseIntake();
    }
    try {
      if (this.isAborted(active))
        return await this.cancelBeforeProvider(
          context,
          running.execution.execution_id,
          active.controller.signal.reason as unknown,
        );
      return await this.generateWithFallback(context, input, running.execution, active.controller.signal);
    } finally {
      this.finish(running.execution.execution_id);
    }
  }

  public async executeStructured(
    context: TenantContext,
    input: AgentExecutionInput,
    output: StructuredOutputSpec,
  ): Promise<AgentExecutionResult> {
    const { signal, ...executionInput } = input;
    const releaseIntake = this.beginIntake();
    let active: ActiveExecution | undefined;
    let running: { readonly execution: RuntimeExecution } | undefined;
    try {
      const created = await this.store.createExecution(context, executionInput);
      if (created.execution.status !== "queued") return this.resultFromExecution(created.execution);
      if (signal?.aborted)
        return await this.cancelBeforeProvider(context, created.execution.execution_id, signal.reason as unknown);
      running = await this.store.transition(context, {
        commandId: `${created.execution.execution_id}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: { agentHandle: input.agentHandle, outputName: output.name },
      });
      active = this.activate(context, running.execution.execution_id, signal);
    } finally {
      releaseIntake();
    }
    try {
      if (this.isAborted(active))
        return await this.cancelBeforeProvider(
          context,
          running.execution.execution_id,
          active.controller.signal.reason as unknown,
        );
      return await this.generateStructuredWithFallback(
        context,
        input,
        output,
        running.execution,
        active.controller.signal,
      );
    } finally {
      this.finish(running.execution.execution_id);
    }
  }

  public async *stream(context: TenantContext, input: AgentExecutionInput): AsyncIterable<AgentExecutionEvent> {
    const releaseIntake = this.beginIntake();
    try {
      const created = await this.store.createExecution(context, input);
      yield eventView(created.event);
      if (created.execution.status !== "queued") return;
      let state = await this.store.transition(context, {
        commandId: `${created.execution.execution_id}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: { agentHandle: input.agentHandle },
      });
      const executionId = created.execution.execution_id;
      const active = this.activate(context, executionId);
      try {
        yield eventView(state.event);
        if (this.isAborted(active)) {
          state = await this.toTerminalIfRunning(context, executionId, "cancelled", {
            reason: active.controller.signal.reason as unknown,
          });
          this.finish(executionId);
          yield eventView(state.event);
          return;
        }
        releaseIntake();
        let fallbackFromAttemptId: string | undefined;
        let fallbackFromLeaseId: string | undefined;
        let emittedTokens = 0;
        for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
          let lease: RoutedModelLease | undefined;
          try {
            lease = await this.acquireModel(
              context,
              await this.acquireInput(context, input, executionId, attempt, fallbackFromAttemptId, fallbackFromLeaseId),
              active.controller.signal,
            );
            state = await this.recordModelRouteSelected(context, executionId, input.modelRoute, lease);
            if (lease.kind === "agent-runtime") {
              await this.recordSubscriptionInvocationStarted(context, executionId, lease);
              const runtimeResult = await this.executeAgentRuntime(
                context,
                input,
                executionId,
                lease,
                prompt(input.input),
                active.controller.signal,
              );
              const outcome = await this.settleAgentRuntimeResult(context, executionId, lease, runtimeResult);
              if (outcome.kind === "fallback") {
                fallbackFromAttemptId = lease.attemptId;
                fallbackFromLeaseId = lease.sessionLeaseId;
                continue;
              }
              const recovery = await this.store.getRecovery(context, executionId);
              const terminalEvent = recovery.events.at(-1);
              if (!terminalEvent) throw new Error("Agent runtime terminal Event를 찾을 수 없습니다");
              this.finish(executionId);
              yield eventView(terminalEvent);
              return;
            }
            this.registry.set(executionId, lease);
            const agent = this.agent(context, input.workId, input.agentHandle);
            const result = await agent.streamText(prompt(input.input), {
              abortSignal: modelAbortSignal(active.controller.signal),
              timeout: {
                totalMs: MODEL_TOTAL_TIMEOUT_MS,
                chunkMs: MODEL_STREAM_CHUNK_TIMEOUT_MS,
              },
              context: new Map<string | symbol, unknown>([
                [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, executionId],
                [MASSION_TENANT_CONTEXT_KEY, context],
              ]),
            });
            for await (const raw of result.fullStream) {
              const part = raw as { readonly type: string } & Record<string, unknown>;
              const text = typeof part.text === "string" ? part.text : part.delta;
              this.emitStreamDelta(
                context,
                executionId,
                input.agentHandle,
                part,
                typeof text === "string" ? text : undefined,
              );
              if (part.type === "text-delta" && typeof text === "string" && text.length > 0) {
                emittedTokens += 1;
              }
              state = await this.store.appendEvent(context, {
                commandId: `${executionId}:stream:${String(state.execution.event_sequence + 1)}`,
                executionId,
                expectedVersion: state.execution.version,
                eventType: `model_${part.type.replaceAll("-", "_")}`,
                payload: normalizeVoltAgentStreamPart(part),
              });
              yield eventView(state.event);
              if (part.type === "error") {
                throw part.error instanceof Error
                  ? part.error
                  : new Error("Model stream에서 오류가 발생했습니다", { cause: part.error });
              }
            }
            const [output, usage] = await Promise.all([result.text, result.usage]);
            await lease.complete({
              commandId: `${executionId}:model:${String(attempt)}:complete`,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            });
            state = await this.store.transition(context, {
              commandId: `${executionId}:succeeded`,
              executionId,
              expectedVersion: state.execution.version,
              target: "succeeded",
              payload: { output, attemptId: lease.attemptId },
            });
            this.finish(executionId);
            yield eventView(state.event);
            return;
          } catch (error) {
            this.registry.delete(executionId);
            if (error instanceof RoutedExecutionSettlementError) {
              state = await this.toTerminalIfRunning(context, executionId, "interrupted", {
                category: "settlement",
              });
              this.finish(executionId);
              yield eventView(state.event);
              return;
            }
            if (this.isAborted(active)) {
              const reason = active.controller.signal.reason as unknown;
              state = await this.toTerminalIfRunning(context, executionId, "cancelled", {
                reason,
              });
              this.finish(executionId);
              yield eventView(state.event);
              return;
            }
            if (lease) {
              const failed = await lease.fail({
                commandId: `${executionId}:model:${String(attempt)}:fail`,
                signal: failureSignal(error),
                emittedTokens,
                sideEffectsStarted: observedSideEffects(error, lease.kind === "agent-runtime") || emittedTokens > 0,
                inputTokens: 0,
                outputTokens: emittedTokens,
              });
              if (failed.fallbackAllowed && emittedTokens === 0) {
                fallbackFromAttemptId = lease.attemptId;
                fallbackFromLeaseId = lease.sessionLeaseId;
                continue;
              }
            }
            const target = isModelUnavailable(error)
              ? "blocked_model_unavailable"
              : emittedTokens > 0 || error instanceof SessionLeaseRenewalError
                ? "interrupted"
                : "failed";
            state = await this.toTerminalIfRunning(context, executionId, target, this.errorPayload(error));
            this.finish(executionId);
            yield eventView(state.event);
            return;
          } finally {
            this.registry.delete(executionId);
          }
        }
        state = await this.toTerminalIfRunning(context, executionId, "failed", { message: "Model fallback 한도 초과" });
        this.finish(executionId);
        yield eventView(state.event);
      } finally {
        this.registry.delete(executionId);
        this.finish(executionId);
      }
    } finally {
      releaseIntake();
    }
  }

  public async cancel(context: TenantContext, executionId: string, reason = "cancelled"): Promise<void> {
    const active = this.active.get(executionId);
    if (active) {
      if (active.context.organizationId !== context.organizationId) {
        throw new Error("Runtime Execution 조직이 일치하지 않습니다");
      }
      active.cancellation ??= this.cancelActive(active, reason);
      await active.cancellation;
      return;
    }
    const recovery = await this.store.getRecovery(context, executionId);
    if (
      ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(
        recovery.execution.status,
      )
    ) {
      return;
    }
    const suspendedSubscription = this.suspendedSubscriptions.get(executionId);
    if (suspendedSubscription) {
      if (suspendedSubscription.context.organizationId !== context.organizationId) {
        throw new Error("구독 Agent 실행 조직이 일치하지 않습니다");
      }
      const running = await this.store.transition(suspendedSubscription.context, {
        commandId: `${executionId}:subscription:cancel-running`,
        executionId,
        expectedVersion: recovery.execution.version,
        target: "running",
        payload: { reason },
      });
      try {
        await suspendedSubscription.lease.executor.cancel?.();
        await this.settleAgentRuntimeResult(
          suspendedSubscription.context,
          executionId,
          suspendedSubscription.lease,
          {
            outcome: "cancelled",
            executionId,
            sessionId: suspendedSubscription.sessionId,
          },
          false,
        );
      } catch (error) {
        await this.toTerminalIfRunning(suspendedSubscription.context, executionId, "interrupted", {
          reason,
          category: "subscription-cancel",
          message: error instanceof Error ? error.message : "구독 Agent 취소 정산 실패",
          version: running.execution.version,
        });
        this.suspendedSubscriptions.delete(executionId);
        throw error;
      }
      return;
    }
    await this.store.transition(context, {
      commandId: `${executionId}:cancelled`,
      executionId,
      expectedVersion: recovery.execution.version,
      target: "cancelled",
      payload: { reason },
    });
  }

  public async cancelOrganization(context: TenantContext, reason = "organization_cancelled"): Promise<void> {
    const executionIds = this.activeExecutionIds().filter((executionId) => {
      const active = this.active.get(executionId);
      if (active) return active.context.organizationId === context.organizationId;
      const suspended = this.suspendedSubscriptions.get(executionId);
      return suspended?.context.organizationId === context.organizationId;
    });
    const settled = await Promise.allSettled(
      executionIds.map((executionId) => this.cancel(context, executionId, reason)),
    );
    // PromiseRejectedResult.reason은 표준 lib 타입상 any이므로 unknown으로 좁혀 no-unsafe-return을 해소합니다.
    const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    if (failures.length > 0) throw new AggregateError(failures, "조직 실행 취소에 실패했습니다");
    const remaining = this.activeExecutionIds().filter((executionId) => {
      const active = this.active.get(executionId);
      if (active) return active.context.organizationId === context.organizationId;
      return this.suspendedSubscriptions.get(executionId)?.context.organizationId === context.organizationId;
    });
    if (remaining.length > 0) throw new AggregateError(remaining, "조직 실행이 남아 있습니다");
  }

  public async suspend(context: TenantContext, executionId: string, reason?: string): Promise<void> {
    await this.requireLifecycle().suspend(context, executionId, reason);
  }

  public async resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult> {
    const releaseIntake = this.beginIntake();
    try {
      const suspended = this.suspendedSubscriptions.get(executionId);
      if (suspended) return await this.resumeSubscription(context, executionId, input, suspended, releaseIntake);
      releaseIntake();
      return await this.requireLifecycle().resume(context, executionId, input);
    } finally {
      releaseIntake();
    }
  }

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    const receipts = this.subscriptionReceipts;
    if (receipts) {
      const snapshot = await receipts.read(context, executionId);
      if (snapshot.attempts.length > 0) {
        if (snapshot.execution.status === "suspended" && !this.suspendedSubscriptions.has(executionId)) {
          const checkpoint = snapshot.attempts.at(-1)?.checkpoint;
          if (checkpoint && this.options.subscriptionApprovals?.interrupt) {
            await this.options.subscriptionApprovals.interrupt(context, {
              executionId,
              approvalId: checkpoint.approvalId,
            });
          }
          return this.resultFromExecution(await receipts.interruptSuspended(context, executionId));
        }
        return this.resultFromExecution(
          await receipts.recover(context, executionId),
          snapshot.terminal?.executionEvidence,
        );
      }
    }
    const selection = await this.models.recoverReservedSelection?.(context, executionId);
    if (selection) {
      const snapshot = await this.store.getRecovery(context, executionId);
      const commandId = `${executionId}:model:${selection.attemptId}:selected`;
      const alreadyRecorded = snapshot.events.some((event) => event.command_id === commandId);
      await this.recordModelRouteSelected(context, executionId, snapshot.execution.model_route, selection);
      await selection.fail({
        commandId: `${commandId}:recovery-release`,
        signal: { kind: "cancelled" },
        emittedTokens: 0,
        sideEffectsStarted: alreadyRecorded,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    return await this.requireLifecycle().recover(context, executionId);
  }

  public stopAccepting(): void {
    this.accepting = false;
  }

  public activeExecutionIds(): readonly string[] {
    return [...new Set([...this.active.keys(), ...this.suspendedSubscriptions.keys()])].sort();
  }

  public shutdown(reason = "runtime_shutdown"): Promise<void> {
    this.stopAccepting();
    this.shutdownPromise ??= this.shutdownOnce(reason);
    return this.shutdownPromise;
  }

  public get activeCount(): number {
    return this.active.size;
  }

  private async generateWithFallback(
    context: TenantContext,
    input: AgentExecutionInput,
    running: RuntimeExecution,
    abortSignal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    let fallbackFromAttemptId: string | undefined;
    let fallbackFromLeaseId: string | undefined;
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
      let lease: RoutedModelLease | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        lease = await this.acquireModel(
          context,
          await this.acquireInput(
            context,
            input,
            running.execution_id,
            attempt,
            fallbackFromAttemptId,
            fallbackFromLeaseId,
          ),
          abortSignal,
        );
        await this.recordModelRouteSelected(context, running.execution_id, input.modelRoute, lease);
        if (abortSignal.aborted) {
          return await this.cancelAcquiredLease(
            context,
            running.execution_id,
            attempt,
            lease,
            abortSignal.reason as unknown,
          );
        }
        if (lease.kind === "agent-runtime") {
          await this.recordSubscriptionInvocationStarted(context, running.execution_id, lease);
          const runtimeResult = await this.executeAgentRuntime(
            context,
            input,
            running.execution_id,
            lease,
            prompt(input.input),
            abortSignal,
          );
          const outcome = await this.settleAgentRuntimeResult(context, running.execution_id, lease, runtimeResult);
          if (outcome.kind === "fallback") {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
          return outcome.result;
        }
        this.registry.set(running.execution_id, lease);
        const result = await this.agent(context, input.workId, input.agentHandle).generateText(prompt(input.input), {
          abortSignal: modelAbortSignal(abortSignal),
          context: new Map<string | symbol, unknown>([
            [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, running.execution_id],
            [MASSION_TENANT_CONTEXT_KEY, context],
          ]),
        });
        inputTokens = result.usage.inputTokens ?? 0;
        outputTokens = result.usage.outputTokens ?? 0;
        if (!result.text.trim()) throw new Error("Model text output is empty");
        await lease.complete({
          commandId: `${running.execution_id}:model:${String(attempt)}:complete`,
          inputTokens,
          outputTokens,
        });
        const current = await this.store.getRecovery(context, running.execution_id);
        await this.store.transition(context, {
          commandId: `${running.execution_id}:succeeded`,
          executionId: running.execution_id,
          expectedVersion: current.execution.version,
          target: "succeeded",
          payload: { output: result.text, attemptId: lease.attemptId },
        });
        return { executionId: running.execution_id, status: "succeeded", output: result.text };
      } catch (error) {
        this.registry.delete(running.execution_id);
        if (error instanceof RoutedExecutionSettlementError) {
          const interrupted = await this.toTerminalIfRunning(context, running.execution_id, "interrupted", {
            category: "settlement",
          });
          return this.resultFromExecution(interrupted.execution);
        }
        if (abortSignal.aborted) {
          const reason = abortSignal.reason as unknown;
          await this.toTerminalIfRunning(context, running.execution_id, "cancelled", { reason });
          return { executionId: running.execution_id, status: "cancelled" };
        }
        if (lease) {
          const failed = await lease.fail({
            commandId: `${running.execution_id}:model:${String(attempt)}:fail`,
            signal: failureSignal(error),
            emittedTokens: 0,
            sideEffectsStarted: observedSideEffects(error, lease.kind === "agent-runtime"),
            inputTokens,
            outputTokens,
          });
          if (failed.fallbackAllowed) {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
        }
        const target = isModelUnavailable(error)
          ? "blocked_model_unavailable"
          : error instanceof SessionLeaseRenewalError
            ? "interrupted"
            : "failed";
        const failed = await this.toTerminalIfRunning(context, running.execution_id, target, this.errorPayload(error));
        return this.resultFromExecution(failed.execution);
      } finally {
        this.registry.delete(running.execution_id);
      }
    }
    const failed = await this.toTerminalIfRunning(context, running.execution_id, "failed", {
      message: "Model fallback 한도 초과",
    });
    return this.resultFromExecution(failed.execution);
  }

  private async generateStructuredWithFallback(
    context: TenantContext,
    input: AgentExecutionInput,
    output: StructuredOutputSpec,
    running: RuntimeExecution,
    abortSignal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    let fallbackFromAttemptId: string | undefined;
    let fallbackFromLeaseId: string | undefined;
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
      let lease: RoutedModelLease | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        lease = await this.acquireModel(
          context,
          await this.acquireInput(
            context,
            input,
            running.execution_id,
            attempt,
            fallbackFromAttemptId,
            fallbackFromLeaseId,
          ),
          abortSignal,
        );
        await this.recordModelRouteSelected(context, running.execution_id, input.modelRoute, lease);
        if (abortSignal.aborted) {
          return await this.cancelAcquiredLease(
            context,
            running.execution_id,
            attempt,
            lease,
            abortSignal.reason as unknown,
          );
        }
        if (lease.kind === "agent-runtime") {
          await this.recordSubscriptionInvocationStarted(context, running.execution_id, lease);
          const runtimeResult = await this.executeAgentRuntime(
            context,
            input,
            running.execution_id,
            lease,
            prompt(input.input),
            abortSignal,
            output,
          );
          const outcome = await this.settleAgentRuntimeResult(context, running.execution_id, lease, runtimeResult);
          if (outcome.kind === "fallback") {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
          return outcome.result;
        }
        this.registry.set(running.execution_id, lease);
        const generationOptions = {
          abortSignal: modelAbortSignal(abortSignal),
          context: new Map<string | symbol, unknown>([
            [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, running.execution_id],
            [MASSION_TENANT_CONTEXT_KEY, context],
          ]),
        };
        let structuredOutput: unknown;
        if (lease.supportsStructuredOutput) {
          const schema = jsonSchema(
            output.jsonSchema as Parameters<typeof jsonSchema>[0],
            output.validate ? { validate: output.validate } : undefined,
          );
          const result = await this.agent(context, input.workId, input.agentHandle).generateText(prompt(input.input), {
            ...generationOptions,
            output: Output.object({ schema, name: output.name, description: output.description }),
          });
          structuredOutput = result.output;
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
        } else {
          const result = await this.agent(context, input.workId, input.agentHandle).generateText(
            jsonOutputPrompt(input.input, output),
            {
              ...generationOptions,
              ...nonNativeStructuredGenerationOptions(lease),
              output: Output.json({ name: output.name, description: output.description }),
            },
          );
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
          structuredOutput = validateJsonOutput(result.output, output);
        }
        await lease.complete({
          commandId: `${running.execution_id}:model:${String(attempt)}:complete`,
          inputTokens,
          outputTokens,
        });
        const current = await this.store.getRecovery(context, running.execution_id);
        await this.store.transition(context, {
          commandId: `${running.execution_id}:succeeded`,
          executionId: running.execution_id,
          expectedVersion: current.execution.version,
          target: "succeeded",
          payload: { output: structuredOutput, attemptId: lease.attemptId },
        });
        return { executionId: running.execution_id, status: "succeeded", output: structuredOutput };
      } catch (error) {
        this.registry.delete(running.execution_id);
        if (error instanceof RoutedExecutionSettlementError) {
          const interrupted = await this.toTerminalIfRunning(context, running.execution_id, "interrupted", {
            category: "settlement",
          });
          return this.resultFromExecution(interrupted.execution);
        }
        if (abortSignal.aborted) {
          await this.toTerminalIfRunning(context, running.execution_id, "cancelled", {
            reason: abortSignal.reason as unknown,
          });
          return { executionId: running.execution_id, status: "cancelled" };
        }
        if (lease) {
          const failed = await lease.fail({
            commandId: `${running.execution_id}:model:${String(attempt)}:fail`,
            signal: failureSignal(error),
            emittedTokens: 0,
            sideEffectsStarted: observedSideEffects(error, lease.kind === "agent-runtime"),
            inputTokens,
            outputTokens,
          });
          if (failed.fallbackAllowed) {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
        }
        const target = isModelUnavailable(error)
          ? "blocked_model_unavailable"
          : error instanceof SessionLeaseRenewalError
            ? "interrupted"
            : "failed";
        const failed = await this.toTerminalIfRunning(context, running.execution_id, target, this.errorPayload(error));
        return this.resultFromExecution(failed.execution);
      } finally {
        this.registry.delete(running.execution_id);
      }
    }
    const failed = await this.toTerminalIfRunning(context, running.execution_id, "failed", {
      message: "Model fallback 한도 초과",
    });
    return this.resultFromExecution(failed.execution);
  }

  private async executeAgentRuntime(
    context: TenantContext,
    input: AgentExecutionInput,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    inputPrompt: string,
    abortSignal: AbortSignal,
    output?: StructuredOutputSpec,
  ): Promise<RoutedAgentRuntimeResult> {
    this.agent(context, input.workId, input.agentHandle);
    const renewal = this.startSessionRenewal(executionId, lease, abortSignal);
    // timeout 신호 자체를 보존해야 뒤늦은 부모 취소와 구분할 수 있습니다.
    const timeoutSignal = AbortSignal.timeout(this.options.agentRuntimeTimeoutMs ?? AGENT_RUNTIME_TOTAL_TIMEOUT_MS);
    const boundedSignal = AbortSignal.any([renewal.signal, timeoutSignal]);
    const timeoutWon = () => timeoutSignal.aborted && boundedSignal.reason === timeoutSignal.reason;
    // ponytail: timeout 실패는 공통 Provider 정산 경로가 요구하는 최소 구조만 만듭니다.
    const timeoutResult = (sessionId?: string): RoutedAgentRuntimeResult => ({
      outcome: "failed",
      executionId,
      ...(sessionId === undefined ? {} : { sessionId }),
      category: "timeout",
      retryable: true,
      signal: { kind: "timeout" },
      emittedTokens: 0,
      sideEffectsStarted: true,
    });
    try {
      let result: RoutedAgentRuntimeResult;
      if (output) {
        if (!lease.executor.executeStructured) {
          throw new Error("선택한 Agent runtime은 구조화 출력을 지원하지 않습니다");
        }
        result = await lease.executor.executeStructured(
          { executionId, prompt: inputPrompt, abortSignal: boundedSignal },
          output,
        );
      } else {
        result = await lease.executor.execute({ executionId, prompt: inputPrompt, abortSignal: boundedSignal });
      }
      const lateRenewalError = renewal.error();
      if (lateRenewalError) throw lateRenewalError;
      if (result.outcome === "cancelled" && timeoutWon()) return timeoutResult(result.sessionId);
      return result;
    } catch (error) {
      const renewalError = renewal.error();
      if (renewalError) throw renewalError;
      if (timeoutWon()) return timeoutResult();
      throw error;
    } finally {
      renewal.stop();
    }
  }

  private startSessionRenewal(
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    parentSignal: AbortSignal,
  ): {
    readonly signal: AbortSignal;
    readonly error: () => SessionLeaseRenewalError | undefined;
    readonly stop: () => void;
  } {
    const clock = this.options.sessionRenewalClock ?? DEFAULT_SESSION_RENEWAL_CLOCK;
    const controller = new AbortController();
    let expectedExpiresAt = lease.sessionExpiresAt;
    let renewalError: SessionLeaseRenewalError | undefined;
    let cancelTimer: () => void = () => undefined;
    let stopped = false;
    const parentAbort = () => {
      controller.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) parentAbort();
    else parentSignal.addEventListener("abort", parentAbort, { once: true });
    const schedule = () => {
      const expiry = Date.parse(expectedExpiresAt);
      if (!Number.isFinite(expiry)) {
        renewalError = new SessionLeaseRenewalError({
          cause: new Error("Session Lease 만료 시각이 유효하지 않습니다"),
        });
        controller.abort(renewalError);
        return;
      }
      const delay = Math.max(MINIMUM_SESSION_RENEW_DELAY_MS, Math.floor((expiry - clock.now()) / 2));
      cancelTimer = clock.schedule(delay, async () => {
        if (stopped) return;
        try {
          expectedExpiresAt = await lease.renewSession({
            commandId: `${executionId}:subscription:${lease.attemptId}:renew:${expectedExpiresAt}`,
            expectedExpiresAt,
          });
          const shouldContinue = (): boolean => !stopped;
          if (shouldContinue()) schedule();
        } catch (error) {
          renewalError = new SessionLeaseRenewalError({ cause: error });
          controller.abort(renewalError);
        }
      });
    };
    schedule();
    return {
      signal: controller.signal,
      error: () => renewalError,
      stop: () => {
        stopped = true;
        cancelTimer();
        parentSignal.removeEventListener("abort", parentAbort);
      },
    };
  }

  private async settleAgentRuntimeResult(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    result: RoutedAgentRuntimeResult,
    allowFallback = true,
  ): Promise<AgentRuntimeAttemptOutcome> {
    const settlementCommand = this.subscriptionSettlementCommand(executionId, lease);
    if (result.executionId !== executionId) {
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "interrupted",
        providerExecutionId: executionId,
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "unknown" },
      });
      await lease.fail({
        commandId: settlementCommand,
        signal: { kind: "unknown" },
        emittedTokens: 0,
        sideEffectsStarted: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const interrupted = await this.toTerminalIfRunning(context, executionId, "interrupted", {
        category: "provider-execution-mismatch",
        attemptId: lease.attemptId,
        sessionLeaseId: lease.sessionLeaseId,
      });
      return { kind: "terminal", result: this.resultFromExecution(interrupted.execution) };
    }
    if (result.outcome === "completed") {
      this.suspendedSubscriptions.delete(executionId);
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "completed",
        providerExecutionId: executionId,
        providerSessionId: result.sessionId,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        },
        output: { kind: "inline", value: result.value as JsonValue },
        ...(result.executionEvidence ? { executionEvidence: result.executionEvidence } : {}),
      });
      await lease.complete({
        commandId: settlementCommand,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const current = await this.store.getRecovery(context, executionId);
      await this.store.transition(context, {
        commandId: `${executionId}:succeeded`,
        executionId,
        expectedVersion: current.execution.version,
        target: "succeeded",
        payload: {
          output: result.value,
          attemptId: lease.attemptId,
          sessionLeaseId: lease.sessionLeaseId,
          providerSessionId: result.sessionId,
        },
      });
      return {
        kind: "terminal",
        result: {
          executionId,
          status: "succeeded",
          output: result.value,
          ...(result.executionEvidence ? { executionEvidence: result.executionEvidence } : {}),
        },
      };
    }
    if (result.outcome === "suspended") {
      this.suspendedSubscriptions.set(executionId, {
        context,
        lease,
        sessionId: result.sessionId,
        approvalId: result.approvalId,
      });
      await this.recordSubscriptionCheckpoint(context, executionId, lease, result.sessionId, result.approvalId);
      const current = await this.store.getRecovery(context, executionId);
      await this.store.transition(context, {
        commandId: `${executionId}:suspended`,
        executionId,
        expectedVersion: current.execution.version,
        target: "suspended",
        payload: {
          attemptId: lease.attemptId,
          sessionLeaseId: lease.sessionLeaseId,
          providerSessionId: result.sessionId,
          approvalId: result.approvalId,
        },
      });
      return { kind: "terminal", result: { executionId, status: "suspended" } };
    }
    if (result.outcome === "cancelled") {
      this.suspendedSubscriptions.delete(executionId);
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "cancelled",
        providerExecutionId: executionId,
        ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "cancelled" },
      });
      await lease.fail({
        commandId: settlementCommand,
        signal: { kind: "cancelled" },
        emittedTokens: 0,
        sideEffectsStarted: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const cancelled = await this.toTerminalIfRunning(context, executionId, "cancelled", {
        attemptId: lease.attemptId,
        sessionLeaseId: lease.sessionLeaseId,
        ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
      });
      return { kind: "terminal", result: this.resultFromExecution(cancelled.execution) };
    }
    await this.recordSubscriptionTerminal(context, executionId, lease, {
      outcome: "failed",
      providerExecutionId: executionId,
      ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
      usage: { inputTokens: 0, outputTokens: result.emittedTokens },
      emittedTokens: result.emittedTokens,
      sideEffectsStarted: result.sideEffectsStarted,
      category: result.category,
      retryable: result.retryable,
      signal: result.signal,
    });
    const failed = await lease.fail({
      commandId: settlementCommand,
      signal: result.signal,
      emittedTokens: result.emittedTokens,
      sideEffectsStarted: result.sideEffectsStarted,
      inputTokens: 0,
      outputTokens: result.emittedTokens,
    });
    await this.recordSubscriptionSettled(context, executionId, lease);
    this.suspendedSubscriptions.delete(executionId);
    if (allowFallback && failed.fallbackAllowed && result.emittedTokens === 0 && !result.sideEffectsStarted) {
      return { kind: "fallback" };
    }
    const target = result.emittedTokens > 0 || result.sideEffectsStarted ? "interrupted" : "failed";
    const terminal = await this.toTerminalIfRunning(
      context,
      executionId,
      target,
      runtimeErrorFromStructuredFailure(result),
    );
    return { kind: "terminal", result: this.resultFromExecution(terminal.execution) };
  }

  private subscriptionLineage(executionId: string, lease: RoutedAgentRuntimeLease): SubscriptionReceiptLineage {
    return {
      executionId,
      workId: lease.subscription.workId,
      agentHandle: lease.subscription.agentHandle,
      routeAttemptId: lease.attemptId,
      leaseId: lease.sessionLeaseId,
      accountId: lease.subscription.accountId,
      connectorId: lease.subscription.connectorId,
      adapterId: lease.subscription.adapterId,
      ...(lease.subscription.quotaSnapshotId ? { quotaSnapshotId: lease.subscription.quotaSnapshotId } : {}),
    };
  }

  private async recordModelRouteSelected(
    context: TenantContext,
    executionId: string,
    routeName: string,
    lease: RoutedModelSelectionLease,
  ): Promise<{ readonly execution: RuntimeExecution; readonly event: RuntimeEvent }> {
    const commandId = `${executionId}:model:${lease.attemptId}:selected`;
    try {
      if (!lease.modelProfileId) throw new Error("선택된 Model Profile 계보가 없습니다");
      const payload = {
        executionId,
        attemptId: lease.attemptId,
        modelProfileId: lease.modelProfileId,
        routeName,
        ...(lease.optimizationBatchId !== undefined ? { batchId: lease.optimizationBatchId } : {}),
        preferenceApplied: lease.preferenceApplied ?? false,
      };
      const replay = (snapshot: {
        readonly execution: RuntimeExecution;
        readonly events: readonly RuntimeEvent[];
      }): { readonly execution: RuntimeExecution; readonly event: RuntimeEvent } | undefined => {
        const event = snapshot.events.find((candidate) => candidate.command_id === commandId);
        if (!event) return undefined;
        let stored: unknown;
        try {
          stored = JSON.parse(event.payload_json) as unknown;
        } catch (cause) {
          throw new Error("기존 Model Route 선택 사건 payload가 유효하지 않습니다", { cause });
        }
        const expectedEntries = Object.entries(payload);
        if (
          event.organization_id !== context.organizationId ||
          event.execution_id !== executionId ||
          event.event_type !== "model.route.selected" ||
          !stored ||
          typeof stored !== "object" ||
          Array.isArray(stored) ||
          Object.keys(stored).length !== expectedEntries.length ||
          expectedEntries.some(([key, value]) => (stored as Record<string, unknown>)[key] !== value)
        ) {
          throw new Error("기존 Model Route 선택 사건 계보가 일치하지 않습니다");
        }
        return { execution: snapshot.execution, event };
      };
      for (let retry = 0; retry <= MODEL_ROUTE_EVENT_CAS_RETRIES; retry += 1) {
        const current = await this.store.getRecovery(context, executionId);
        const repeated = replay(current);
        if (repeated) return repeated;
        try {
          return await this.store.appendEvent(context, {
            commandId,
            executionId,
            expectedVersion: current.execution.version,
            eventType: "model.route.selected",
            payload,
          });
        } catch (error) {
          const latest = await this.store.getRecovery(context, executionId);
          const committed = replay(latest);
          if (committed) return committed;
          if (
            retry < MODEL_ROUTE_EVENT_CAS_RETRIES &&
            isRuntimeExecutionVersionConflict(error) &&
            latest.execution.status === "running" &&
            latest.execution.version > current.execution.version
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new Error("Model Route 선택 사건 CAS 재시도 상한을 초과했습니다");
    } catch (error) {
      try {
        await lease.fail({
          commandId: `${commandId}:release`,
          signal: { kind: "unknown" },
          emittedTokens: 0,
          sideEffectsStarted: false,
          inputTokens: 0,
          outputTokens: 0,
        });
      } catch (settlementError) {
        throw new RoutedExecutionSettlementError("Model Route 선택 사건 실패 뒤 lease 정산을 완료하지 못했습니다", {
          cause: new AggregateError([error, settlementError]),
        });
      }
      throw new RoutedExecutionSettlementError("Model Route 선택 사건을 기록하지 못해 lease를 정리했습니다", {
        cause: error,
      });
    }
  }

  private async recordSubscriptionInvocationStarted(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    const lineage = this.subscriptionLineage(executionId, lease);
    await receipts.recordRouteSessionAcquired(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:acquired`,
      ...lineage,
    });
    await receipts.recordInvocationStarted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:started`,
      ...lineage,
    });
  }

  private async recordSubscriptionCheckpoint(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    sessionId: string,
    approvalId: string,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordCheckpointObserved(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:checkpoint:${digestCommandId(approvalId)}`,
      ...this.subscriptionLineage(executionId, lease),
      sessionId,
      approvalId,
    });
  }

  private async recordSubscriptionTerminal(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    terminal: ReceiptTerminalDetails,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    const input = {
      commandId: `${executionId}:subscription:${lease.attemptId}:terminal`,
      ...this.subscriptionLineage(executionId, lease),
      ...terminal,
    };
    if (terminal.outcome === "completed") await receipts.recordTerminalObserved(context, input);
    else await receipts.recordTerminalObserved(context, input);
  }

  private async recordSubscriptionSettled(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordSettlementCompleted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:settled`,
      ...this.subscriptionLineage(executionId, lease),
    });
  }

  private subscriptionSettlementCommand(executionId: string, lease: RoutedAgentRuntimeLease): string {
    return `${executionId}:subscription:${lease.attemptId}:settlement:router`;
  }

  private async acquireModel(
    context: TenantContext,
    input: AcquireModelInput,
    parentSignal: AbortSignal,
  ): Promise<RoutedModelLease> {
    const timeoutSignal = AbortSignal.timeout(this.options.modelAcquireTimeoutMs ?? MODEL_ACQUIRE_TIMEOUT_MS);
    const signal = AbortSignal.any([parentSignal, timeoutSignal]);
    if (signal.aborted) throw signal.reason;
    const pending = this.models.acquire(context, input);
    let onAbort: (() => void) | undefined;
    let abortError: Error | undefined;
    let acquiredFailureSignal: FailureSignal | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        acquiredFailureSignal = parentSignal.aborted
          ? { kind: "cancelled" }
          : timeoutSignal.aborted
            ? { kind: "timeout" }
            : failureSignal(signal.reason);
        abortError = new Error("Model acquire가 중단됐습니다", { cause: signal.reason });
        abortError.name = acquiredFailureSignal.kind === "timeout" ? "TimeoutError" : "AbortError";
        reject(abortError);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const capturedFailureSignal = () =>
      acquiredFailureSignal ?? this.acquireFailureSignal(parentSignal, timeoutSignal, signal.reason);
    let acquiredLease: RoutedModelLease | undefined;
    try {
      const lease = await Promise.race([pending, aborted]);
      acquiredLease = lease;
      signal.throwIfAborted();
      return lease;
    } catch (error) {
      if (!acquiredLease && error !== abortError) throw error;
      if (acquiredLease) {
        this.settleLateAcquire(input, acquiredLease, capturedFailureSignal());
      } else {
        void pending
          .then((lease) => {
            this.settleLateAcquire(input, lease, capturedFailureSignal());
          })
          .catch(() => {
            process.emitWarning("기한 종료 후 Model acquire가 실패했습니다", {
              code: "MASSION_LATE_MODEL_ACQUIRE_FAILED",
            });
          });
      }
      throw abortError ?? (error instanceof Error ? error : new Error("Model acquire가 중단됐습니다"));
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private acquireFailureSignal(parentSignal: AbortSignal, timeoutSignal: AbortSignal, reason: unknown): FailureSignal {
    if (parentSignal.aborted) return { kind: "cancelled" };
    if (timeoutSignal.aborted) return { kind: "timeout" };
    return failureSignal(reason);
  }

  private settleLateAcquire(input: AcquireModelInput, lease: RoutedModelLease, signal: FailureSignal): void {
    void (async () => {
      const commandId = `${input.commandId}:late-acquire-fail`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await lease.fail({
            commandId,
            signal,
            emittedTokens: 0,
            sideEffectsStarted: false,
            inputTokens: 0,
            outputTokens: 0,
          });
          return;
        } catch {
          // 같은 command ID의 정산은 멱등이므로 한 번 재시도합니다.
        }
      }
      process.emitWarning("늦게 반환된 Model lease 정산에 실패했습니다", {
        code: "MASSION_LATE_MODEL_LEASE_SETTLEMENT_FAILED",
      });
    })();
  }

  private async acquireInput(
    context: TenantContext,
    input: AgentExecutionInput,
    executionId: string,
    attempt: number,
    fallbackFromAttemptId?: string,
    fallbackFromLeaseId?: string,
  ): Promise<AcquireModelInput> {
    const resolved = await this.executionContext?.resolve(context, {
      executionId,
      workId: input.workId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentHandle: input.agentHandle,
      ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
    });
    return {
      commandId: `${executionId}:model:${String(attempt)}:reserve`,
      executionId,
      workId: input.workId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentHandle: input.agentHandle,
      ...(resolved?.workspaceAccess ? { workspaceAccess: resolved.workspaceAccess } : {}),
      ...(resolved?.workspaceCapability ? { workspaceCapability: resolved.workspaceCapability } : {}),
      ...(resolved?.workspaceRoot ? { workspaceRoot: resolved.workspaceRoot } : {}),
      ...(resolved?.instruction ? { instruction: resolved.instruction } : {}),
      ...(input.requiredExecutionKind ? { requiredExecutionKind: input.requiredExecutionKind } : {}),
      routeName: input.modelRoute,
      estimatedTokens: input.estimatedTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      stickyKey: `${input.workId}:${input.agentHandle}`,
      ...(fallbackFromAttemptId ? { fallbackFromAttemptId } : {}),
      ...(fallbackFromLeaseId ? { fallbackFromLeaseId } : {}),
    };
  }

  private agent(context: TenantContext, workId: string, handle: string): Agent {
    const scopedName = runtimeAgentName(context.organizationId, handle, workId);
    const persistentName = runtimeAgentName(context.organizationId, handle);
    const agent = this.voltAgent
      .getAgents()
      .find((candidate) => candidate.name === scopedName || candidate.name === persistentName);
    if (!agent) throw new Error(`활성 Runtime Agent를 찾을 수 없습니다: ${handle}`);
    return agent;
  }

  private async cancelActive(active: ActiveExecution, reason: string): Promise<void> {
    if (!active.controller.signal.aborted) active.controller.abort(reason);
    await active.done;
  }

  private isAborted(active: ActiveExecution): boolean {
    return active.controller.signal.aborted;
  }

  private activate(context: TenantContext, executionId: string, signal?: AbortSignal): ActiveExecution {
    if (this.active.has(executionId)) throw new Error(`Runtime Execution이 이미 활성 상태입니다: ${executionId}`);
    const completion = deferred();
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal?.reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const active = {
      context,
      controller,
      done: completion.promise,
      resolveDone: completion.resolve,
      detachAbortSignal: () => signal?.removeEventListener("abort", abort),
    };
    this.active.set(executionId, active);
    return active;
  }

  private finish(executionId: string): void {
    this.deltaSequences.delete(executionId);
    const active = this.active.get(executionId);
    if (!active) return;
    this.active.delete(executionId);
    active.detachAbortSignal();
    active.resolveDone();
  }

  // 휘발성 실행 델타: 저장소에 기록하지 않고 관찰자에게만 전달합니다. 관찰자 오류는 실행에 전파하지 않습니다.
  private emitDelta(
    context: TenantContext,
    executionId: string,
    agentHandle: string,
    partial: Omit<ExecutionDelta, "executionId" | "agentHandle" | "sequence" | "occurredAt">,
  ): void {
    const observer = this.options.deltaObserver;
    if (!observer) return;
    const sequence = (this.deltaSequences.get(executionId) ?? 0) + 1;
    this.deltaSequences.set(executionId, sequence);
    try {
      observer.observe(context, {
        executionId,
        agentHandle,
        sequence,
        occurredAt: new Date().toISOString(),
        ...partial,
      });
    } catch {
      // 관찰자 예외는 무시합니다.
    }
  }

  private emitStreamDelta(
    context: TenantContext,
    executionId: string,
    agentHandle: string,
    part: { readonly type: string } & Record<string, unknown>,
    text: string | undefined,
  ): void {
    if (!this.options.deltaObserver) return;
    const toolName = typeof part.toolName === "string" ? part.toolName : undefined;
    const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : undefined;
    if (part.type === "text-delta" && text !== undefined && text.length > 0)
      this.emitDelta(context, executionId, agentHandle, { kind: "output-text", text });
    else if (part.type === "reasoning-delta" && text !== undefined && text.length > 0)
      this.emitDelta(context, executionId, agentHandle, { kind: "reasoning", text });
    else if (part.type === "tool-call")
      this.emitDelta(context, executionId, agentHandle, {
        kind: "tool-call",
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...boundedToolPayload("toolInput", part.input ?? part.args),
      });
    else if (part.type === "tool-result")
      this.emitDelta(context, executionId, agentHandle, {
        kind: "tool-result",
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        summary: JSON.stringify(part.output ?? part.result ?? null).slice(0, 500),
        ...boundedToolPayload("toolOutput", part.output ?? part.result),
      });
    else if (part.type === "error") this.emitDelta(context, executionId, agentHandle, { kind: "error" });
    else if (part.type === "finish")
      this.emitDelta(context, executionId, agentHandle, { kind: "lifecycle", summary: "finish" });
  }

  private async cancelBeforeProvider(
    context: TenantContext,
    executionId: string,
    reason: unknown,
  ): Promise<AgentExecutionResult> {
    const current = await this.store.getRecovery(context, executionId);
    if (!["queued", "running"].includes(current.execution.status)) return this.resultFromExecution(current.execution);
    try {
      const cancelled = await this.store.transition(context, {
        commandId: `${executionId}:cancelled`,
        executionId,
        expectedVersion: current.execution.version,
        target: "cancelled",
        payload: { reason },
      });
      return this.resultFromExecution(cancelled.execution);
    } catch (error) {
      const recovered = await this.store.getRecovery(context, executionId);
      if (recovered.execution.status === "cancelled") return this.resultFromExecution(recovered.execution);
      throw error;
    }
  }

  private async cancelAcquiredLease(
    context: TenantContext,
    executionId: string,
    attempt: number,
    lease: RoutedModelLease,
    reason: unknown,
  ): Promise<AgentExecutionResult> {
    await lease.fail({
      commandId: `${executionId}:model:${String(attempt)}:cancel`,
      signal: { kind: "cancelled" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    return await this.cancelBeforeProvider(context, executionId, reason);
  }

  private async toTerminalIfRunning(
    context: TenantContext,
    executionId: string,
    target: "failed" | "cancelled" | "interrupted" | "blocked_model_unavailable",
    payload: unknown,
  ) {
    const current = await this.store.getRecovery(context, executionId);
    if (current.execution.status !== "running") {
      const event = current.events.at(-1);
      if (!event) throw new Error("Runtime terminal Event를 찾을 수 없습니다");
      return { execution: current.execution, event };
    }
    return await this.store.transition(context, {
      commandId: `${executionId}:${target}`,
      executionId,
      expectedVersion: current.execution.version,
      target,
      payload,
    });
  }

  private resultFromExecution(
    execution: RuntimeExecution,
    executionEvidence?: ExecutionEvidence,
  ): AgentExecutionResult {
    const result = runtimeExecutionResult(execution);
    return executionEvidence ? { ...result, executionEvidence } : result;
  }

  private errorPayload(error: unknown): Record<string, unknown> {
    return runtimeErrorFromFailureSignal(failureSignal(error), randomUUID());
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error("Runtime이 종료 중이어서 새 실행을 받을 수 없습니다");
  }

  private beginIntake(): () => void {
    this.requireAccepting();
    this.intakeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.intakeOperations -= 1;
      if (this.intakeOperations === 0) {
        this.intakeSettled?.resolve();
        this.intakeSettled = undefined;
      }
    };
  }

  private async waitForIntake(): Promise<void> {
    if (this.intakeOperations === 0) return;
    this.intakeSettled ??= deferred();
    await this.intakeSettled.promise;
  }

  private async shutdownOnce(reason: string): Promise<void> {
    await this.waitForIntake();
    while (this.active.size > 0 || this.suspendedSubscriptions.size > 0) {
      const contexts = new Map<string, TenantContext>();
      for (const [executionId, active] of this.active) contexts.set(executionId, active.context);
      for (const [executionId, suspended] of this.suspendedSubscriptions) {
        contexts.set(executionId, suspended.context);
      }
      const settled = await Promise.allSettled(
        [...contexts].map(async ([executionId, context]) => {
          await this.cancel(context, executionId, reason);
        }),
      );
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (failures.length > 0) throw new AggregateError(failures, "Runtime 실행 종료에 실패했습니다");
    }
  }

  private requireLifecycle(): AgentExecutionLifecycle {
    if (!this.lifecycle) throw new Error("Runtime workflow lifecycle이 구성되지 않았습니다");
    return this.lifecycle;
  }

  private async resumeSubscription(
    context: TenantContext,
    executionId: string,
    input: unknown,
    suspended: SuspendedSubscriptionExecution,
    releaseIntake: () => void,
  ): Promise<AgentExecutionResult> {
    const approvalId = this.subscriptionApprovalId(input);
    if (approvalId !== suspended.approvalId) throw new Error("구독 Agent 실행 승인 ID가 일치하지 않습니다");
    if (suspended.context.organizationId !== context.organizationId) {
      throw new Error("구독 Agent 실행 조직이 일치하지 않습니다");
    }
    const approvals = this.options.subscriptionApprovals;
    if (!approvals) throw new Error("구독 승인 정본 consumer가 구성되지 않았습니다");
    if (!suspended.lease.executor.resume) {
      throw new Error("선택한 구독 Agent runtime은 승인 재개를 지원하지 않습니다");
    }
    if (suspended.resumeAttempt) {
      releaseIntake();
      return await suspended.resumeAttempt;
    }
    const attempt = this.continueSubscriptionResume(context, executionId, suspended, approvals, releaseIntake);
    suspended.resumeAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (suspended.resumeAttempt === attempt) delete suspended.resumeAttempt;
    }
  }

  private async continueSubscriptionResume(
    context: TenantContext,
    executionId: string,
    suspended: SuspendedSubscriptionExecution,
    approvals: NonNullable<VoltAgentRunnerOptions["subscriptionApprovals"]>,
    releaseIntake: () => void,
  ): Promise<AgentExecutionResult> {
    const approvalId = suspended.approvalId;
    const resume = suspended.lease.executor.resume?.bind(suspended.lease.executor);
    if (!resume) throw new Error("선택한 구독 Agent runtime은 승인 재개를 지원하지 않습니다");
    const decision = suspended.approvalDecision ?? (await approvals.consume(context, { executionId, approvalId }));
    suspended.approvalDecision = decision;
    if (suspended.resumeExpectedVersion === undefined) {
      const current = await this.store.getRecovery(suspended.context, executionId);
      if (current.execution.status !== "suspended") {
        throw new Error("suspended 구독 Agent 실행만 재개할 수 있습니다");
      }
      suspended.resumeExpectedVersion = current.execution.version;
    }
    await this.store.transition(suspended.context, {
      commandId: `${executionId}:approval:${digestCommandId(approvalId)}:running`,
      executionId,
      expectedVersion: suspended.resumeExpectedVersion,
      target: "running",
      payload: { approvalId, approved: decision === "approved" },
    });
    await this.recordSubscriptionInvocationResumed(suspended.context, executionId, suspended.lease, approvalId);
    const active = this.activate(suspended.context, executionId);
    releaseIntake();
    const renewal = this.startSessionRenewal(executionId, suspended.lease, active.controller.signal);
    try {
      let result: RoutedAgentRuntimeResult;
      try {
        result = await resume({
          executionId,
          sessionId: suspended.sessionId,
          approvalId,
          approved: decision === "approved",
          abortSignal: renewal.signal,
        });
        const renewalError = renewal.error();
        if (renewalError) throw renewalError;
      } catch (error) {
        result = {
          outcome: "failed",
          executionId,
          sessionId: suspended.sessionId,
          category: error instanceof SessionLeaseRenewalError ? "session-renewal" : "resume",
          retryable: false,
          signal: failureSignal(error),
          emittedTokens: 0,
          sideEffectsStarted: true,
        };
      }
      const outcome = await this.settleAgentRuntimeResult(
        suspended.context,
        executionId,
        suspended.lease,
        result,
        false,
      );
      if (outcome.kind === "fallback") throw new Error("승인 재개 뒤에는 자동 fallback할 수 없습니다");
      return outcome.result;
    } finally {
      renewal.stop();
      this.finish(executionId);
    }
  }

  private subscriptionApprovalId(input: unknown): string {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error("구독 Agent 재개 입력에는 approvalId object가 필요합니다");
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.approvalId !== "string" || !record.approvalId.trim()) {
      throw new Error("구독 Agent 재개 입력은 approvalId만 허용합니다");
    }
    return record.approvalId;
  }

  private async recordSubscriptionInvocationResumed(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    approvalId: string,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordInvocationStarted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:resumed:${digestCommandId(approvalId)}`,
      ...this.subscriptionLineage(executionId, lease),
    });
  }
}

function digestCommandId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
