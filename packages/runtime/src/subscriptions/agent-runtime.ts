import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";
import type { ExecutionEvidence } from "./execution-evidence.js";

export type SubscriptionAgentFailureSignal =
  | { readonly kind: "http"; readonly statusCode: number; readonly retryAfter?: string }
  | { readonly kind: "timeout" | "network" | "input" | "policy" | "cancelled" | "unknown" };

export interface SubscriptionAgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Provider가 두 token 수를 모두 확정한 경우에만 normalized usage를 반환합니다. */
export function normalizeConfirmedAgentUsage(value: unknown): SubscriptionAgentUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Readonly<Record<string, unknown>>;
  const inputTokens = source.inputTokens ?? source.input_tokens;
  const outputTokens = source.outputTokens ?? source.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    Number(inputTokens) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    Number(outputTokens) < 0
  ) {
    return undefined;
  }
  return { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) };
}

/**
 * Provider가 turn을 끝냈지만 구조화 출력만 사용할 수 없을 때 adapter가 던집니다.
 * 호출자가 부작용 관측 사실을 잃지 않고 fallback 여부를 판단할 수 있도록
 * adapter가 실제로 관측한 값을 함께 전달합니다.
 */
export class SubscriptionStructuredOutputError extends Error {
  public readonly sideEffectsStarted: boolean;
  public readonly emittedTokens: number;
  public readonly usage?: SubscriptionAgentUsage;

  public constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly sideEffectsStarted: boolean;
      readonly emittedTokens: number;
      readonly usage?: SubscriptionAgentUsage;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SubscriptionStructuredOutputError";
    this.sideEffectsStarted = options.sideEffectsStarted;
    this.emittedTokens = options.emittedTokens;
    if (options.usage) this.usage = options.usage;
  }
}

export interface SubscriptionAgentInput {
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly sessionId?: string;
}

export type SubscriptionAgentResult =
  | {
      readonly outcome: "completed";
      readonly executionId: string;
      readonly sessionId: string;
      readonly value: unknown;
      readonly usage?: unknown;
      /** Provider가 성공 terminal item으로 관측한 실행 근거입니다. */
      readonly executionEvidence?: ExecutionEvidence;
    }
  | {
      readonly outcome: "suspended";
      readonly executionId: string;
      readonly sessionId: string;
      readonly approvalId: string;
    }
  | {
      readonly outcome: "cancelled";
      readonly executionId: string;
      readonly sessionId?: string;
      /** Provider가 취소 terminal 전에 외부로 내보낸 출력 조각 수입니다. */
      readonly emittedTokens?: number;
      /** Provider가 취소 terminal에서도 두 token 수를 모두 확정한 경우에만 포함합니다. */
      readonly usage?: SubscriptionAgentUsage;
    }
  | {
      readonly outcome: "failed";
      readonly executionId: string;
      readonly sessionId?: string;
      readonly category: string;
      readonly retryable: boolean;
      /** Adapter가 구조적으로 확인한 경우에만 설정합니다. 누락 시 호출자가 fail-closed합니다. */
      readonly signal?: SubscriptionAgentFailureSignal;
      /** Provider가 외부로 내보낸 출력 조각 수입니다. 누락 시 0으로 보되 부작용은 알 수 없음으로 처리합니다. */
      readonly emittedTokens?: number;
      /** false는 Provider 호출 전 또는 부작용 없음이 증명된 경우에만 사용합니다. */
      readonly sideEffectsStarted?: boolean;
      /** Provider가 실패 terminal에서도 두 token 수를 모두 확정한 경우에만 포함합니다. */
      readonly usage?: SubscriptionAgentUsage;
    };

export interface SubscriptionAgentResumeInput {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface SubscriptionAgentAdapter {
  execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult>;
  executeStructured?(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult>;
  resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult>;
  cancel(context: TenantContext, executionId: string): Promise<void>;
}

interface ActiveExecution {
  readonly adapterId: string;
  readonly adapter: SubscriptionAgentAdapter;
  readonly context: TenantContext;
  readonly input: SubscriptionAgentInput;
  result?: SubscriptionAgentResult;
}

function sameTenant(left: TenantContext, right: TenantContext): boolean {
  return left.organizationId === right.organizationId && left.userId === right.userId;
}

export class SubscriptionAgentRuntimeCoordinator {
  private readonly executions = new Map<string, ActiveExecution>();

  public constructor(private readonly adapters: Readonly<Record<string, SubscriptionAgentAdapter>>) {}

  public async execute(
    adapterId: string,
    context: TenantContext,
    input: SubscriptionAgentInput,
  ): Promise<SubscriptionAgentResult> {
    if (this.executions.has(input.executionId)) throw new Error("구독 Agent 실행 ID가 이미 사용 중입니다");
    const adapter = this.adapters[adapterId];
    if (!adapter) throw new Error(`구독 Agent adapter를 찾을 수 없습니다: ${adapterId}`);
    const active: ActiveExecution = { adapterId, adapter, context, input };
    this.executions.set(input.executionId, active);
    try {
      const result = await adapter.execute(context, input);
      active.result = result;
      if (result.outcome !== "suspended") this.executions.delete(input.executionId);
      return result;
    } catch (error) {
      this.executions.delete(input.executionId);
      throw error;
    }
  }

  public async resume(
    context: TenantContext,
    executionId: string,
    approval: { readonly approvalId: string; readonly approved: boolean },
  ): Promise<SubscriptionAgentResult> {
    const active = this.executions.get(executionId);
    if (!active || active.result?.outcome !== "suspended") throw new Error("재개할 구독 Agent 실행이 없습니다");
    if (!sameTenant(active.context, context)) throw new Error("구독 Agent 실행 TenantContext가 일치하지 않습니다");
    if (active.result.approvalId !== approval.approvalId)
      throw new Error("구독 Agent 실행 승인 ID가 일치하지 않습니다");
    const result = await active.adapter.resume(context, active.input, {
      sessionId: active.result.sessionId,
      approvalId: approval.approvalId,
      approved: approval.approved,
    });
    active.result = result;
    if (result.outcome !== "suspended") this.executions.delete(executionId);
    return result;
  }

  public async cancel(context: TenantContext, executionId: string): Promise<void> {
    const active = this.executions.get(executionId);
    if (!active) return;
    if (!sameTenant(active.context, context)) throw new Error("구독 Agent 실행 TenantContext가 일치하지 않습니다");
    await active.adapter.cancel(context, executionId);
    this.executions.delete(executionId);
  }
}
