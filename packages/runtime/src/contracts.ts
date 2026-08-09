import type { TenantContext } from "@massion/identity";
import type { ExecutionEvidence } from "./subscriptions/execution-evidence.js";

export type RuntimeExecutionStatus =
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked_model_unavailable";

export type WorkspaceAccess = "isolated" | "read-only" | "workspace-write";
export type ExecutionKind = "model" | "agent-runtime";

export interface AgentExecutionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly requiredExecutionKind?: ExecutionKind;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly correlationId: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

export interface AgentExecutionResult {
  readonly executionId: string;
  readonly status: RuntimeExecutionStatus;
  readonly output?: unknown;
  /** 최종 모델 출력과 분리된, 공급자 관측 실행 근거입니다. */
  readonly executionEvidence?: ExecutionEvidence;
  readonly error?: RuntimeExecutionError;
}

export interface StructuredOutputSpec {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly validate?: (value: unknown) => StructuredOutputValidationResult;
}

export type StructuredOutputValidationResult =
  { readonly success: true; readonly value: unknown } | { readonly success: false; readonly error: Error };

export interface AgentExecutionEvent {
  readonly executionId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: unknown;
}

// 실행 델타는 Surface 체감용 휘발성 신호입니다. 도메인 정본이 아니므로 저장소에 기록하지 않고,
// 재연결 복구는 work.timeline 재조회가 담당합니다.
export type ExecutionDeltaKind = "output-text" | "reasoning" | "tool-call" | "tool-result" | "lifecycle" | "error";

export interface ExecutionDelta {
  readonly executionId: string;
  readonly agentHandle: string;
  readonly sequence: number;
  readonly kind: ExecutionDeltaKind;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly summary?: string;
  /**
   * Tool 호출 인자와 결과의 canonical JSON입니다. `summary`는 화면이 흘려보는 미리보기라 짧게
   * 자르지만, 협업 기록기는 위임 대상과 답변 본문을 여기서 읽으므로 더 넉넉한 상한을 씁니다.
   * 이 둘이 없으면 `delegate_task`에서 «누구에게 무엇을 시켰는지»를 알 수 없습니다.
   */
  readonly toolInput?: string;
  readonly toolOutput?: string;
  readonly occurredAt: string;
}

export interface ExecutionDeltaObserver {
  // 동기 fire-and-forget: 예외·배압을 실행 경로에 전파하지 않습니다.
  observe(context: TenantContext, delta: ExecutionDelta): void;
}

export interface RuntimeExecutionError {
  readonly category: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly causeId?: string;
}

export interface AgentRunner {
  execute(context: TenantContext, input: AgentExecutionInput): Promise<AgentExecutionResult>;
  stream(context: TenantContext, input: AgentExecutionInput): AsyncIterable<AgentExecutionEvent>;
  cancel(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  /** 한 조직의 현재 프로세스 실행을 모두 취소합니다. 새 실행 수락은 유지합니다. */
  cancelOrganization(context: TenantContext, reason?: string): Promise<void>;
  suspend(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult>;
  recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult>;
}

export interface StructuredAgentRunner {
  executeStructured(
    context: TenantContext,
    input: AgentExecutionInput,
    output: StructuredOutputSpec,
  ): Promise<AgentExecutionResult>;
  findResultByCommand?(context: TenantContext, commandId: string): Promise<AgentExecutionResult | undefined>;
}
