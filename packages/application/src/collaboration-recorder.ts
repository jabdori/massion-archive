import type { TenantContext } from "@massion/identity";
import { runtimeAgentHandle, type ExecutionDelta, type ExecutionDeltaObserver } from "@massion/runtime";
import type { CollaborationRoom, WorkService } from "@massion/work";

/*
 * ── Runtime 협업을 협업방에 영속 ─────────────────────────────────
 *
 * VoltAgent의 `delegate_task`는 supervisor가 subAgent에게 일을 넘기는 유일한 경로이고,
 * 그 위임과 답변은 지금까지 VoltAgent 메모리에서 끝났습니다. 헌법 4.4는 «모델 transcript만으로
 * 조직 상태나 완료를 복원하지 않는다»고 정하므로, 그 대화는 Work에 귀속된 사실로 남아야 합니다.
 *
 * 내구성 경계는 ADR-004가 소유합니다. 요약하면:
 *   - 관찰자 계약이 «동기 fire-and-forget, 예외·배압을 실행 경로에 전파하지 않음»이라 여기서
 *     await하지 않습니다. 기록 실패가 에이전트 실행을 죽이면 안 됩니다.
 *   - 커밋은 제품의 추적된 background 작업으로 나가고, `drain()`이 그것을 기다립니다.
 *   - commandId가 execution·sequence로 결정되므로 재시도·복구에서 중복 커밋이 없습니다.
 *   - 커밋 실패는 삼키지 않고 `onFailure`로 올려 로그·event가 됩니다.
 */

/** `core-pipeline`이 Work마다 보장하는 방. 같은 규칙으로 찾습니다. */
const CORE_OFFICE_ROOM_TITLE = "Core Office";
const DELEGATE_TOOL = "delegate_task";

/** 방 메시지 본문 상한. 도메인이 더 큰 값을 받더라도 대화 한 줄이 화면을 삼키면 안 됩니다. */
const CONTENT_LIMIT = 4_000;

export interface CollaborationRecorderExecutionSource {
  get(context: TenantContext, executionId: string): Promise<{ readonly work_id: string } | undefined>;
}

export interface CollaborationRuntimeRecorderDependencies {
  readonly executions: CollaborationRecorderExecutionSource;
  readonly works: Pick<WorkService, "listRooms" | "postMessage">;
  readonly onFailure?: (reason: unknown, delta: ExecutionDelta) => void;
}

interface DelegationRequest {
  readonly task: string;
  readonly targets: readonly string[];
}

/** VoltAgent `delegate_task` 인자에서 대상 handle과 과제를 꺼냅니다. 모양이 다르면 기록하지 않습니다. */
function parseDelegation(toolInput: string | undefined): DelegationRequest | undefined {
  if (toolInput === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  const names = Array.isArray(record.targetAgents) ? record.targetAgents : [];
  const targets = names
    .map((name) => (typeof name === "string" ? runtimeAgentHandle(name) : undefined))
    .filter((handle): handle is string => handle !== undefined);
  if (task.length === 0 || targets.length === 0) return undefined;
  return { task, targets };
}

/**
 * `delegate_task` 결과에서 대상별 답변을 꺼냅니다. VoltAgent는 대상 순서대로 배열을 돌려주므로
 * 인덱스로 맞춥니다. 모양이 다르면 답변을 지어내지 않고 전체를 한 줄로 요약합니다.
 */
function parseAnswers(toolOutput: string | undefined, targets: readonly string[]): readonly string[] {
  if (toolOutput === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolOutput);
  } catch {
    return [];
  }
  const textOf = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["response", "result", "text", "output", "content"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
      }
    }
    return JSON.stringify(value ?? null);
  };
  if (Array.isArray(parsed)) return targets.map((_target, index) => textOf(parsed[index]));
  const single = textOf(parsed);
  return targets.map(() => single);
}

export class CollaborationRuntimeRecorder implements ExecutionDeltaObserver {
  /** 실행별 커밋 직렬화. 답변이 인계보다 먼저 커밋되면 replyToMessageId를 채울 수 없습니다. */
  private readonly chains = new Map<string, Promise<void>>();
  /** `${executionId}:${toolCallId}:${handle}` → 인계 메시지 ID. 답변이 이 값을 인용합니다. */
  private readonly handoffs = new Map<string, string>();
  private readonly delegations = new Map<string, DelegationRequest>();
  private readonly rooms = new Map<string, CollaborationRoom>();
  /** 아직 커밋되지 않은 기록. 종료·테스트가 `drain()`으로 기다립니다. */
  private readonly pending = new Set<Promise<void>>();

  public constructor(private readonly dependencies: CollaborationRuntimeRecorderDependencies) {}

  public observe(context: TenantContext, delta: ExecutionDelta): void {
    if (delta.toolName !== DELEGATE_TOOL) return;
    if (delta.kind !== "tool-call" && delta.kind !== "tool-result") return;
    // 계약상 여기서 던지거나 기다리면 안 됩니다. 판단만 하고 커밋은 밖으로 넘깁니다.
    this.enqueue(
      delta.executionId,
      async () => {
        await this.record(context, delta);
      },
      delta,
    );
  }

  /** 커밋이 끝날 때까지 기다립니다. 정상 종료와 테스트가 조용한 유실을 만들지 않도록 하는 지점입니다. */
  public async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private enqueue(executionId: string, operation: () => Promise<void>, delta: ExecutionDelta): void {
    const previous = this.chains.get(executionId) ?? Promise.resolve();
    const next = previous
      .then(operation, () => undefined)
      .catch((reason: unknown) => {
        this.dependencies.onFailure?.(reason, delta);
      });
    this.chains.set(executionId, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.chains.get(executionId) === next) this.chains.delete(executionId);
    });
  }

  private async record(context: TenantContext, delta: ExecutionDelta): Promise<void> {
    const callKey = `${delta.executionId}:${delta.toolCallId ?? String(delta.sequence)}`;
    if (delta.kind === "tool-call") {
      const delegation = parseDelegation(delta.toolInput);
      if (!delegation) return;
      this.delegations.set(callKey, delegation);
      const room = await this.room(context, delta.executionId);
      if (!room) return;
      for (const [index, target] of delegation.targets.entries()) {
        const posted = await this.dependencies.works.postMessage(context, {
          commandId: `${delta.executionId}:collab:${String(delta.sequence)}:${String(index)}`,
          workId: room.work_id,
          roomId: room.room_id,
          messageType: "handoff",
          authorKind: "agent",
          authorId: delta.agentHandle,
          recipientAgentId: target,
          content: delegation.task.slice(0, CONTENT_LIMIT),
          executionId: delta.executionId,
          tokenCount: estimateTokens(delegation.task),
          costMicros: 0,
        });
        this.handoffs.set(`${callKey}:${target}`, posted.message.message_id);
      }
      return;
    }
    const delegation = this.delegations.get(callKey);
    if (!delegation) return;
    this.delegations.delete(callKey);
    const room = await this.room(context, delta.executionId);
    if (!room) return;
    const answers = parseAnswers(delta.toolOutput, delegation.targets);
    for (const [index, target] of delegation.targets.entries()) {
      const body = (answers[index] ?? "").slice(0, CONTENT_LIMIT);
      if (body.length === 0) continue;
      const replyTo = this.handoffs.get(`${callKey}:${target}`);
      this.handoffs.delete(`${callKey}:${target}`);
      await this.dependencies.works.postMessage(context, {
        commandId: `${delta.executionId}:collab:${String(delta.sequence)}:${String(index)}`,
        workId: room.work_id,
        roomId: room.room_id,
        messageType: "answer",
        authorKind: "agent",
        authorId: target,
        // 수신 Agent는 도메인이 handoff에만 허용합니다. 답변의 수신자는 아래 인용이 이미 말합니다.
        content: body,
        // 화면은 답변 들여쓰기와 인용을 이 둘로만 그립니다. 없으면 대화가 평평해집니다.
        ...(replyTo === undefined ? {} : { replyToMessageId: replyTo, causedByMessageId: replyTo }),
        executionId: delta.executionId,
        tokenCount: estimateTokens(body),
        costMicros: 0,
      });
    }
  }

  private async room(context: TenantContext, executionId: string): Promise<CollaborationRoom | undefined> {
    const execution = await this.dependencies.executions.get(context, executionId);
    if (!execution) return undefined;
    const cached = this.rooms.get(execution.work_id);
    if (cached) return cached;
    const room = (await this.dependencies.works.listRooms(context, execution.work_id)).find(
      (candidate) => candidate.title === CORE_OFFICE_ROOM_TITLE && candidate.coordinator_handle === "representative",
    );
    // 방을 여기서 만들지 않습니다. 방 생성은 파이프라인이 Work revision과 함께 소유합니다.
    if (room) this.rooms.set(execution.work_id, room);
    return room;
  }
}

/** 방 예산은 메시지 합으로 계산되므로 0을 넣으면 소비가 보이지 않습니다. 4 byte/token 근사입니다. */
function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
}
