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
 *   - 커밋은 조직 단위 큐로 직렬화됩니다. 경합 자원은 실행이 아니라 방입니다.
 *   - 미완 커밋은 `drain()`이 기다리고, daemon 종료가 Runner 정지 뒤에 그것을 부릅니다.
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
 * 인덱스로 맞춥니다.
 *
 * 값이 없으면 `undefined`를 돌려줍니다. 예전에는 `JSON.stringify(undefined ?? null)`이 걸려
 * 문자열 `"null"`이 실제 답변처럼 기록됐습니다 — 배열이 대상보다 짧을 때 그렇습니다.
 * 「없는 것을 지어내지 않는다」가 여기서 깨지고 있었습니다.
 */
function parseAnswers(toolOutput: string | undefined, targets: readonly string[]): readonly (string | undefined)[] {
  if (toolOutput === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolOutput);
  } catch {
    return [];
  }
  const textOf = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return value.trim() || undefined;
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["response", "result", "text", "output", "content"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
      }
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined || encoded === "null" ? undefined : encoded;
  };
  if (Array.isArray(parsed)) return targets.map((_target, index) => textOf(parsed[index]));
  const single = textOf(parsed);
  return targets.map(() => single);
}

export class CollaborationRuntimeRecorder implements ExecutionDeltaObserver {
  /**
   * 커밋 직렬화 큐. 실행이 아니라 **조직** 단위입니다.
   *
   * 실제 경합 자원은 실행이 아니라 방입니다 — `postMessage`가 방의 `next_sequence`를 읽고 올리며
   * 메시지 sequence에 고유 인덱스가 걸려 있습니다. 실행별로만 직렬화하면 같은 Work를 쓰는 여러
   * 실행이 동시에 같은 방을 밀어 write conflict가 나고, 저장소의 재시도(4회)를 넘기면 기록이
   * 통째로 사라집니다. 실측: 같은 Work 32개 동시 실행 → 27건 실패, 5건만 기록.
   *
   * ponytail: 조직 단위 직렬화. 방 단위로 좁히려면 방을 먼저 알아야 하는데 그 조회 자체가 이미
   * 직렬화 대상입니다. 위임은 Work당 몇 건이라 지금은 이 상한이 싸고, 병목이 되면 방 단위 큐로 좁힙니다.
   */
  private readonly chains = new Map<string, Promise<void>>();
  /** `${executionId}:${toolCallId}:${handle}` → 인계 메시지 ID. 답변이 이 값을 인용합니다. */
  private readonly handoffs = new Map<string, string>();
  private readonly delegations = new Map<string, DelegationRequest>();
  /** 아직 커밋되지 않은 기록. 종료·테스트가 `drain()`으로 기다립니다. */
  private readonly pending = new Set<Promise<void>>();

  public constructor(private readonly dependencies: CollaborationRuntimeRecorderDependencies) {}

  public observe(context: TenantContext, delta: ExecutionDelta): void {
    if (delta.toolName !== DELEGATE_TOOL) return;
    if (delta.kind !== "tool-call" && delta.kind !== "tool-result") return;
    // 계약상 여기서 던지거나 기다리면 안 됩니다. 판단만 하고 커밋은 밖으로 넘깁니다.
    // 큐 키는 실행이 아니라 조직입니다 — 경합하는 것은 실행이 아니라 방이기 때문입니다.
    this.enqueue(
      context.organizationId,
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

  private enqueue(key: string, operation: () => Promise<void>, delta: ExecutionDelta): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(operation, () => undefined)
      .catch((reason: unknown) => {
        this.dependencies.onFailure?.(reason, delta);
      });
    this.chains.set(key, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private async record(context: TenantContext, delta: ExecutionDelta): Promise<void> {
    const callKey = `${delta.executionId}:${delta.toolCallId ?? String(delta.sequence)}`;
    if (delta.kind === "tool-call") {
      const delegation = parseDelegation(delta.toolInput);
      if (!delegation) return;
      const room = await this.room(context, delta.executionId);
      // 방이 아직 없으면 위임도 기억하지 않습니다. 기억해 두면 나중에 방이 생겼을 때 인계 없는
      // 답변만 남아, ADR-004가 정한 「대상마다 정확히 한 쌍」이 깨집니다.
      if (!room) return;
      this.delegations.set(callKey, delegation);
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
    // tool-result는 위임당 한 번입니다. 성공하든 실패하든 이 호출의 기억은 여기서 놓습니다 —
    // 예전에는 본문이 비면 handoff 항목이 남아 프로세스 수명 내내 쌓였습니다.
    this.delegations.delete(callKey);
    try {
      await this.recordAnswers(context, delta, callKey, delegation);
    } finally {
      for (const target of delegation.targets) this.handoffs.delete(`${callKey}:${target}`);
    }
  }

  private async recordAnswers(
    context: TenantContext,
    delta: ExecutionDelta,
    callKey: string,
    delegation: DelegationRequest,
  ): Promise<void> {
    const room = await this.room(context, delta.executionId);
    if (!room) return;
    const answers = parseAnswers(delta.toolOutput, delegation.targets);
    for (const [index, target] of delegation.targets.entries()) {
      const body = (answers[index] ?? "").slice(0, CONTENT_LIMIT);
      if (body.length === 0) continue;
      const replyTo = this.handoffs.get(`${callKey}:${target}`);
      // 인계 없는 답변은 남기지 않습니다. 질문 없는 대답은 화면에서 고아가 되고,
      // 「대상마다 정확히 한 쌍」이라는 불변식을 깹니다.
      if (replyTo === undefined) continue;
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
        replyToMessageId: replyTo,
        causedByMessageId: replyTo,
        executionId: delta.executionId,
        tokenCount: estimateTokens(body),
        costMicros: 0,
      });
    }
  }

  private async room(context: TenantContext, executionId: string): Promise<CollaborationRoom | undefined> {
    const execution = await this.dependencies.executions.get(context, executionId);
    if (!execution) return undefined;
    // 캐시하지 않습니다. Work 수만큼 무한히 자라면서 정작 동시 쓰기는 막아 주지 못했습니다.
    // 위임은 Work당 몇 건이라 조회 한 번이 캐시 수명 관리보다 쌉니다.
    // 방을 여기서 만들지도 않습니다. 방 생성은 파이프라인이 Work revision과 함께 소유합니다.
    return (await this.dependencies.works.listRooms(context, execution.work_id)).find(
      (candidate) => candidate.title === CORE_OFFICE_ROOM_TITLE && candidate.coordinator_handle === "representative",
    );
  }
}

/** 방 예산은 메시지 합으로 계산되므로 0을 넣으면 소비가 보이지 않습니다. 4 byte/token 근사입니다. */
function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
}
