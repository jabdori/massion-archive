import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  query as officialQuery,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKAssistantMessageError,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";
import {
  normalizeConfirmedAgentUsage,
  SubscriptionStructuredOutputError,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentFailureSignal,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
  type SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export interface SubscriptionPermissionBridge {
  request(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly toolName: string;
      readonly toolInput: Readonly<Record<string, unknown>>;
      readonly toolUseId: string;
      readonly permissionRequestId: string;
      readonly title?: string;
      readonly decisionReason?: string;
    },
  ): Promise<
    | { readonly outcome: "allow" }
    | { readonly outcome: "deny"; readonly reason: string }
    | { readonly outcome: "suspend"; readonly approvalId: string }
  >;
  interrupt?(
    context: TenantContext,
    input: { readonly executionId: string; readonly approvalId: string },
  ): Promise<void>;
}

export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage | Record<string, unknown>> {
  interrupt?(): Promise<unknown>;
  close?(): void;
}

export type ClaudeAgentQuery = (input: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}) => ClaudeQueryHandle;

export type ClaudeSubscriptionConnectorOptions =
  | {
      readonly executable?: string;
      readonly permissionMode: Extract<NonNullable<Options["permissionMode"]>, "default" | "auto" | "dontAsk" | "plan">;
      readonly sandbox: NonNullable<Options["sandbox"]>;
      readonly model?: string;
      readonly allowDangerouslySkipPermissions?: never;
    }
  | {
      readonly executable?: string;
      readonly permissionMode: "bypassPermissions";
      readonly allowDangerouslySkipPermissions: true;
      readonly sandbox?: never;
      readonly model?: string;
    };

const OFFICIAL_QUERY: ClaudeAgentQuery = (input) => officialQuery(input);

interface PendingPermission {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly permissionRequestId: string;
  readonly inputDigest: string;
  readonly output?: StructuredOutputSpec;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("Claude 도구 입력 JSON 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child, depth + 1)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child, depth + 1)}`)
      .join(",")}}`;
  }
  throw new Error("Claude 도구 입력은 JSON-safe 값이어야 합니다");
}

function toolInputDigest(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function hookPermissionRequestId(sessionId: string, toolUseId: string, inputDigest: string): string {
  return `claude-hook-${createHash("sha256").update(`${sessionId}\0${toolUseId}\0${inputDigest}`).digest("hex")}`;
}

function toolAuthorizationKey(toolName: string, toolUseId: string, inputDigest: string): string {
  return `${toolUseId}\0${toolName}\0${inputDigest}`;
}

function sameTenant(context: TenantContext, pending: PendingPermission): boolean {
  return context.organizationId === pending.organizationId && context.userId === pending.userId;
}

async function* emptyResumePrompt(): AsyncIterable<SDKUserMessage> {
  // 지연된 도구 호출은 새 사용자 turn 없이 --resume 자체로 다시 평가해야 합니다.
}

function resultMessage(message: SDKMessage | Record<string, unknown>): SDKResultMessage | undefined {
  return message.type === "result" ? (message as SDKResultMessage) : undefined;
}

function assistantFailureSignal(error: SDKAssistantMessageError): SubscriptionAgentFailureSignal | undefined {
  if (error === "authentication_failed") return { kind: "http", statusCode: 401 };
  if (error === "billing_error") return { kind: "http", statusCode: 402 };
  if (error === "rate_limit") return { kind: "http", statusCode: 429 };
  if (error === "overloaded" || error === "server_error") return { kind: "http", statusCode: 503 };
  return undefined;
}

function httpFailureSignal(statusCode: unknown): SubscriptionAgentFailureSignal | undefined {
  if (!Number.isSafeInteger(statusCode) || Number(statusCode) < 100 || Number(statusCode) > 599) return undefined;
  return { kind: "http", statusCode: Number(statusCode) };
}

export class ClaudeSubscriptionConnector implements SubscriptionAgentAdapter {
  private readonly active = new Map<string, ClaudeQueryHandle>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly cancelled = new Set<string>();

  public constructor(
    private readonly query: ClaudeAgentQuery = OFFICIAL_QUERY,
    private readonly permissions: SubscriptionPermissionBridge = {
      request: () => Promise.resolve({ outcome: "deny", reason: "Governance permission bridge가 연결되지 않았습니다" }),
    },
    private readonly options?: ClaudeSubscriptionConnectorOptions,
  ) {
    if (!options) return;
    if (options.executable !== undefined && !isAbsolute(options.executable)) {
      throw new Error("Claude SDK 실행 파일은 절대 경로여야 합니다");
    }
    if (options.permissionMode === "bypassPermissions") {
      // options는 타입상 이 분기에서 allowDangerouslySkipPermissions가 항상 true지만, 이 필드는
      // "전체 권한 우회"라는 위험 옵션에 대한 런타임 방어선이다: 호출부가 `as` 캐스트나 타입 체크를
      // 우회한 값으로 이 생성자를 호출하면 컴파일 타임 내로잉이 보장하지 못하므로 가드를 유지한다.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare, @typescript-eslint/no-unnecessary-condition
      if (options.allowDangerouslySkipPermissions !== true) {
        throw new Error("Claude 전체 권한에는 allowDangerouslySkipPermissions 확인이 필요합니다");
      }
    } else if (
      options.sandbox.enabled !== true ||
      options.sandbox.failIfUnavailable !== true ||
      options.sandbox.allowUnsandboxedCommands !== false
    ) {
      throw new Error("Claude SDK sandbox는 우회할 수 없습니다");
    }
    if (options.model !== undefined && !options.model.trim()) throw new Error("Claude SDK model이 유효하지 않습니다");
  }

  public async execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    return await this.run(context, input);
  }

  public async executeStructured(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult> {
    return await this.run(context, input, output);
  }

  public async resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult> {
    const pending = this.pending.get(input.executionId);
    if (!pending) throw new Error("재개할 Claude 실행 승인이 없습니다");
    if (pending.approvalId !== approval.approvalId) throw new Error("Claude 실행 승인 ID가 일치하지 않습니다");
    if (pending.sessionId !== approval.sessionId) throw new Error("Claude 실행 session ID가 일치하지 않습니다");
    if (!sameTenant(context, pending)) throw new Error("Claude 실행 TenantContext가 일치하지 않습니다");
    // 같은 승인을 동시에 두 번 재개해 도구 부작용이 중복되지 않도록 query 시작 전에 소비합니다.
    this.pending.delete(input.executionId);
    if (!approval.approved) {
      return { outcome: "cancelled", executionId: input.executionId, sessionId: approval.sessionId };
    }
    return await this.run(context, { ...input, sessionId: approval.sessionId }, pending.output, pending);
  }

  public async cancel(context: TenantContext, executionId: string): Promise<void> {
    const pending = this.pending.get(executionId);
    this.pending.delete(executionId);
    await this.interruptDeferred(context, executionId, pending);
    const active = this.active.get(executionId);
    if (!active) return;
    this.cancelled.add(executionId);
    if (active.interrupt) await active.interrupt();
    active.close?.();
  }

  private async run(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output?: StructuredOutputSpec,
    approvedPermission?: PendingPermission,
  ): Promise<SubscriptionAgentResult> {
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error("Claude workspace와 profile root는 절대 경로여야 합니다");
    }
    const abortController = new AbortController();
    const approvalState: {
      deferredPermission?: PendingPermission;
      deferredConflict: boolean;
      approvedConsumed: boolean;
      approvedMismatch: boolean;
      approvedHookReplay: boolean;
      providerPermissionReplay: boolean;
    } = {
      deferredConflict: false,
      approvedConsumed: false,
      approvedMismatch: false,
      approvedHookReplay: false,
      providerPermissionReplay: false,
    };
    const providerAuthorizations = new Set<string>();
    const consumedProviderAuthorizations = new Set<string>();
    let hookDecisionTail: Promise<void> = Promise.resolve();
    const serializeHookDecision = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = hookDecisionTail.then(operation);
      hookDecisionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "LANG", "LC_ALL"]) {
      const value = input.environment[key];
      if (value !== undefined) environment[key] = value;
    }
    environment.CLAUDE_CONFIG_DIR = input.profileRoot;
    environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = "massion/1.0.0";
    const fullAccess = this.options?.permissionMode === "bypassPermissions";
    const options: Options = {
      cwd: input.workspaceRoot,
      env: environment,
      abortController,
      allowedTools: [...input.allowedTools],
      disallowedTools: [...input.disallowedTools],
      permissionMode: this.options?.permissionMode ?? "default",
      ...(fullAccess ? { allowDangerouslySkipPermissions: true } : {}),
      settingSources: [],
      ...(this.options
        ? {
            ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
            ...(!fullAccess ? { sandbox: this.options.sandbox } : {}),
            ...(this.options.model ? { model: this.options.model } : {}),
          }
        : {}),
      ...(input.sessionId ? { resume: input.sessionId } : {}),
      ...(output ? { outputFormat: { type: "json_schema", schema: output.jsonSchema } } : {}),
      ...(!fullAccess
        ? {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async (hookInput, hookToolUseId) => {
                      const deny = (reason: string) => ({
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: "deny" as const,
                          permissionDecisionReason: reason,
                        },
                      });
                      if (hookInput.hook_event_name !== "PreToolUse") {
                        return deny("Massion PreToolUse hook 입력이 아닙니다");
                      }
                      const preToolUse = hookInput;
                      if (
                        !preToolUse.session_id ||
                        !preToolUse.tool_use_id ||
                        !hookToolUseId ||
                        hookToolUseId !== preToolUse.tool_use_id ||
                        !preToolUse.tool_name ||
                        !plainRecord(preToolUse.tool_input)
                      ) {
                        return deny("Claude PreToolUse 도구 식별 정보가 유효하지 않습니다");
                      }
                      const toolInput = preToolUse.tool_input;
                      let inputDigest: string;
                      try {
                        inputDigest = toolInputDigest(toolInput);
                      } catch {
                        return deny("Claude PreToolUse 도구 입력을 안전하게 검증할 수 없습니다");
                      }
                      const permissionRequestId = hookPermissionRequestId(
                        preToolUse.session_id,
                        preToolUse.tool_use_id,
                        inputDigest,
                      );
                      const authorizationKey = toolAuthorizationKey(
                        preToolUse.tool_name,
                        preToolUse.tool_use_id,
                        inputDigest,
                      );
                      return await serializeHookDecision(async () => {
                        if (
                          approvedPermission &&
                          approvalState.approvedConsumed &&
                          preToolUse.tool_use_id === approvedPermission.toolUseId
                        ) {
                          approvalState.approvedHookReplay = true;
                          return deny("승인된 원래 Claude 도구 호출이 두 번 전달되었습니다");
                        }
                        if (approvedPermission && !approvalState.approvedConsumed) {
                          if (
                            preToolUse.session_id !== approvedPermission.sessionId ||
                            preToolUse.tool_name !== approvedPermission.toolName ||
                            preToolUse.tool_use_id !== approvedPermission.toolUseId ||
                            permissionRequestId !== approvedPermission.permissionRequestId ||
                            inputDigest !== approvedPermission.inputDigest
                          ) {
                            approvalState.approvedMismatch = true;
                            return deny("승인된 원래 Claude 도구 호출과 일치하지 않습니다");
                          }
                          approvalState.approvedConsumed = true;
                          providerAuthorizations.add(authorizationKey);
                          return {
                            hookSpecificOutput: {
                              hookEventName: "PreToolUse" as const,
                              permissionDecision: "allow" as const,
                              permissionDecisionReason: "Massion Governance에서 원 도구 호출을 승인했습니다",
                            },
                          };
                        }
                        if (approvalState.deferredPermission) {
                          approvalState.deferredConflict = true;
                          return deny("Claude defer는 한 turn의 단일 도구 호출만 지원합니다");
                        }
                        let decision: Awaited<ReturnType<SubscriptionPermissionBridge["request"]>>;
                        try {
                          decision = await this.permissions.request(context, {
                            executionId: input.executionId,
                            workId: input.workId,
                            agentHandle: input.agentHandle,
                            toolName: preToolUse.tool_name,
                            toolInput,
                            toolUseId: preToolUse.tool_use_id,
                            permissionRequestId,
                          });
                        } catch {
                          return deny("Governance 도구 승인 상태를 확인할 수 없습니다");
                        }
                        if (decision.outcome === "allow") {
                          providerAuthorizations.add(authorizationKey);
                          return {
                            hookSpecificOutput: {
                              hookEventName: "PreToolUse" as const,
                              permissionDecision: "allow" as const,
                              permissionDecisionReason: "Massion Governance 정책이 허용했습니다",
                            },
                          };
                        }
                        if (decision.outcome === "deny") return deny(decision.reason);
                        approvalState.deferredPermission = {
                          approvalId: decision.approvalId,
                          sessionId: preToolUse.session_id,
                          organizationId: context.organizationId,
                          userId: context.userId,
                          toolName: preToolUse.tool_name,
                          toolUseId: preToolUse.tool_use_id,
                          permissionRequestId,
                          inputDigest,
                          ...(output ? { output } : {}),
                        };
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: "defer" as const,
                          },
                        };
                      });
                    },
                  ],
                },
              ],
            },
          }
        : {}),
      ...(!fullAccess
        ? {
            canUseTool: (
              toolName: string,
              toolInput: Readonly<Record<string, unknown>>,
              permissionContext: { toolUseID: string },
            ): Promise<PermissionResult> => {
              let inputDigest: string;
              try {
                inputDigest = toolInputDigest(toolInput);
              } catch {
                return Promise.resolve({
                  behavior: "deny",
                  message: "Claude provider 권한 요청 입력을 안전하게 검증할 수 없습니다",
                  decisionClassification: "user_reject",
                });
              }
              const authorizationKey = toolAuthorizationKey(toolName, permissionContext.toolUseID, inputDigest);
              if (providerAuthorizations.has(authorizationKey)) {
                if (consumedProviderAuthorizations.has(authorizationKey)) {
                  approvalState.providerPermissionReplay = true;
                  return Promise.resolve({
                    behavior: "deny",
                    message: "같은 Claude provider 권한 요청이 두 번 전달되었습니다",
                    decisionClassification: "user_reject",
                  });
                }
                consumedProviderAuthorizations.add(authorizationKey);
                return Promise.resolve({ behavior: "allow", decisionClassification: "user_temporary" });
              }
              return Promise.resolve({
                behavior: "deny",
                message: "Massion PreToolUse 승인이 없는 provider 권한 요청입니다",
                decisionClassification: "user_reject",
              });
            },
          }
        : {}),
    };
    const handle = this.query({ prompt: approvedPermission ? emptyResumePrompt() : input.prompt, options });
    this.active.set(input.executionId, handle);
    let result: SDKResultMessage | undefined;
    let sessionId = input.sessionId;
    let emittedTokens = 0;
    let sideEffectsStarted = false;
    let observedFailure: SubscriptionAgentFailureSignal | undefined;
    const cancelledResult = (usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    }): SubscriptionAgentResult => ({
      outcome: "cancelled",
      executionId: input.executionId,
      ...(sessionId ? { sessionId } : {}),
      emittedTokens: Math.max(emittedTokens, (usage?.outputTokens ?? 0) > 0 ? 1 : 0),
      ...(usage ? { usage } : {}),
    });
    const failedResult = (
      category: string,
      error?: unknown,
      usage?: { readonly inputTokens: number; readonly outputTokens: number },
    ): SubscriptionAgentResult => {
      const signal: SubscriptionAgentFailureSignal | undefined =
        observedFailure ?? (error instanceof TypeError ? { kind: "network" } : undefined);
      const knownBeforeSideEffects = signal !== undefined && emittedTokens === 0 && !sideEffectsStarted;
      return {
        outcome: "failed",
        executionId: input.executionId,
        ...(sessionId ? { sessionId } : {}),
        category,
        retryable:
          signal?.kind === "network" ||
          signal?.kind === "timeout" ||
          (signal?.kind === "http" &&
            (signal.statusCode === 401 ||
              signal.statusCode === 408 ||
              signal.statusCode === 429 ||
              signal.statusCode >= 500)),
        ...(signal ? { signal } : {}),
        emittedTokens,
        sideEffectsStarted: knownBeforeSideEffects ? false : true,
        ...(usage ? { usage } : {}),
      };
    };
    try {
      for await (const message of handle) {
        if (typeof message.session_id === "string") sessionId = message.session_id;
        if (message.type === "assistant") {
          if (message.error) observedFailure = assistantFailureSignal(message.error) ?? observedFailure;
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.length > 0) emittedTokens += 1;
            if (block.type === "tool_use") sideEffectsStarted = true;
          }
        }
        if (message.type === "system" && message.subtype === "api_retry") {
          observedFailure =
            httpFailureSignal(message.error_status) ??
            (message.error_status === null ? { kind: "network" } : observedFailure);
        }
        if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
          observedFailure = { kind: "http", statusCode: 429 };
        }
        result = resultMessage(message) ?? result;
      }
    } catch (error) {
      if (this.cancelled.delete(input.executionId)) {
        await this.interruptDeferred(context, input.executionId, approvalState.deferredPermission).catch(
          () => undefined,
        );
        return cancelledResult();
      }
      await this.interruptDeferred(context, input.executionId, approvalState.deferredPermission).catch(() => undefined);
      if (emittedTokens > 0 || sideEffectsStarted || observedFailure) {
        return failedResult("error_during_execution", error);
      }
      throw error;
    } finally {
      this.active.delete(input.executionId);
    }
    const confirmedUsage = normalizeConfirmedAgentUsage(result?.usage);
    if (this.cancelled.delete(input.executionId)) {
      await this.interruptDeferred(context, input.executionId, approvalState.deferredPermission);
      return cancelledResult(confirmedUsage);
    }
    try {
      if (approvalState.approvedHookReplay) {
        throw new Error("승인된 원래 Claude 도구 호출이 두 번 평가되었습니다");
      }
      if (approvalState.providerPermissionReplay) {
        throw new Error("같은 Claude provider 권한 요청이 두 번 전달되었습니다");
      }
      if (approvedPermission && !approvalState.approvedConsumed) {
        throw new Error(
          approvalState.approvedMismatch
            ? "승인된 원래 도구 호출과 일치하지 않습니다"
            : "Claude --resume에서 원래 PreToolUse 도구 호출이 다시 평가되지 않았습니다",
        );
      }
      const hasDeferredResult =
        result?.subtype === "success" &&
        (result.stop_reason === "tool_deferred" ||
          result.terminal_reason === "tool_deferred" ||
          result.deferred_tool_use !== undefined);
      if (approvalState.deferredPermission || hasDeferredResult) {
        if (approvalState.deferredConflict) {
          await this.interruptDeferred(context, input.executionId, approvalState.deferredPermission);
          throw new Error("Claude defer는 한 turn의 단일 도구 호출만 지원합니다");
        }
        const deferredResultMatches = (() => {
          try {
            return (
              approvalState.deferredPermission !== undefined &&
              result?.subtype === "success" &&
              result.stop_reason === "tool_deferred" &&
              (result.terminal_reason === undefined || result.terminal_reason === "tool_deferred") &&
              result.deferred_tool_use !== undefined &&
              result.session_id === approvalState.deferredPermission.sessionId &&
              result.deferred_tool_use.id === approvalState.deferredPermission.toolUseId &&
              result.deferred_tool_use.name === approvalState.deferredPermission.toolName &&
              plainRecord(result.deferred_tool_use.input) &&
              toolInputDigest(result.deferred_tool_use.input) === approvalState.deferredPermission.inputDigest
            );
          } catch {
            return false;
          }
        })();
        if (!deferredResultMatches || !approvalState.deferredPermission) {
          await this.interruptDeferred(context, input.executionId, approvalState.deferredPermission);
          throw new Error("Claude deferred_tool_use가 원래 PreToolUse 도구 호출과 일치하지 않습니다");
        }
        this.pending.set(input.executionId, approvalState.deferredPermission);
        return {
          outcome: "suspended",
          executionId: input.executionId,
          sessionId: approvalState.deferredPermission.sessionId,
          approvalId: approvalState.deferredPermission.approvalId,
        };
      }
      if (!result || !sessionId) throw new Error("Claude Agent SDK terminal result가 없습니다");
    } catch (error) {
      if (confirmedUsage || emittedTokens > 0 || sideEffectsStarted) {
        return failedResult("error_during_execution", error, confirmedUsage);
      }
      throw error;
    }
    if (result.subtype !== "success") {
      if (abortController.signal.aborted) {
        return cancelledResult(confirmedUsage);
      }
      return failedResult(result.subtype, undefined, confirmedUsage);
    }
    let value = output ? result.structured_output : result.result;
    if (output?.validate) {
      const validation = output.validate(value);
      if (!validation.success) {
        throw new SubscriptionStructuredOutputError("Claude 구조화 출력 검증에 실패했습니다", {
          cause: validation.error,
          sideEffectsStarted,
          emittedTokens: Math.max(emittedTokens, (confirmedUsage?.outputTokens ?? 0) > 0 ? 1 : 0),
          ...(confirmedUsage ? { usage: confirmedUsage } : {}),
        });
      }
      value = validation.value;
    }
    return {
      outcome: "completed",
      executionId: input.executionId,
      sessionId,
      value,
      usage: result.usage,
    };
  }

  private async interruptDeferred(
    context: TenantContext,
    executionId: string,
    pending: PendingPermission | undefined,
  ): Promise<void> {
    if (!pending || !this.permissions.interrupt) return;
    await this.permissions.interrupt(context, { executionId, approvalId: pending.approvalId });
  }
}
