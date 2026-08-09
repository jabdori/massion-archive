import type { TenantContext } from "@massion/identity";
import { runtimeAgentName, type ExecutionDelta } from "@massion/runtime";
import { describe, expect, it, vi } from "vitest";

import { CollaborationRuntimeRecorder } from "./collaboration-recorder.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const ROOM = {
  room_id: "room-1",
  work_id: "work-1",
  title: "Core Office",
  coordinator_handle: "representative",
};

function harness(overrides: { readonly postMessage?: ReturnType<typeof vi.fn> } = {}) {
  let posted = 0;
  const postMessage =
    overrides.postMessage ??
    vi.fn(async () => {
      posted += 1;
      return { message: { message_id: `message-${String(posted)}` } };
    });
  const listRooms = vi.fn(async () => [ROOM]);
  const onFailure = vi.fn();
  const recorder = new CollaborationRuntimeRecorder({
    executions: { get: async () => ({ work_id: "work-1" }) },
    works: { listRooms, postMessage } as never,
    onFailure,
  });
  return { recorder, postMessage, listRooms, onFailure };
}

function delta(partial: Partial<ExecutionDelta> & Pick<ExecutionDelta, "kind" | "sequence">): ExecutionDelta {
  return {
    executionId: "execution-1",
    agentHandle: "representative",
    toolName: "delegate_task",
    toolCallId: "call-1",
    occurredAt: "2026-08-09T00:00:00.000Z",
    ...partial,
  };
}

const CONTEXT_STRATEGY = runtimeAgentName("organization-1", "context-strategy");
const EVIDENCE = runtimeAgentName("organization-1", "evidence-research");

describe("Runtime 협업 기록기", () => {
  it("delegate_task 위임과 답변을 협업방에 인계·답변 두 메시지로 남긴다", async () => {
    const { recorder, postMessage } = harness();

    recorder.observe(
      context,
      delta({
        kind: "tool-call",
        sequence: 4,
        toolInput: JSON.stringify({ task: "환불 지연 구간을 계산해 주세요", targetAgents: [CONTEXT_STRATEGY] }),
      }),
    );
    recorder.observe(
      context,
      delta({
        kind: "tool-result",
        sequence: 5,
        toolOutput: JSON.stringify([{ response: "검토→batch 구간이 20.54시간으로 가장 깁니다" }]),
      }),
    );
    await recorder.drain();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0]?.[1]).toMatchObject({
      messageType: "handoff",
      authorKind: "agent",
      authorId: "representative",
      recipientAgentId: "context-strategy",
      content: "환불 지연 구간을 계산해 주세요",
      executionId: "execution-1",
    });
    expect(postMessage.mock.calls[1]?.[1]).toMatchObject({
      messageType: "answer",
      authorId: "context-strategy",
      content: "검토→batch 구간이 20.54시간으로 가장 깁니다",
      // 화면은 답변 들여쓰기와 인용을 이 둘로만 그립니다.
      replyToMessageId: "message-1",
      causedByMessageId: "message-1",
    });
  });

  it("방 예산이 보이도록 메시지마다 token을 센다", async () => {
    const { recorder, postMessage } = harness();

    recorder.observe(
      context,
      delta({ kind: "tool-call", sequence: 1, toolInput: JSON.stringify({ task: "조사", targetAgents: [EVIDENCE] }) }),
    );
    await recorder.drain();

    // 0을 넣으면 방 소비량이 메시지 합으로 계산되는 구조에서 영원히 0으로 보입니다.
    expect(postMessage.mock.calls[0]?.[1]).toMatchObject({ tokenCount: expect.any(Number) });
    expect((postMessage.mock.calls[0]?.[1] as { tokenCount: number }).tokenCount).toBeGreaterThan(0);
  });

  it("여러 대상 위임은 대상마다 인계와 답변을 짝지어 남긴다", async () => {
    const { recorder, postMessage } = harness();

    recorder.observe(
      context,
      delta({
        kind: "tool-call",
        sequence: 2,
        toolInput: JSON.stringify({ task: "병렬 조사", targetAgents: [CONTEXT_STRATEGY, EVIDENCE] }),
      }),
    );
    recorder.observe(
      context,
      delta({ kind: "tool-result", sequence: 3, toolOutput: JSON.stringify([{ text: "계획" }, { text: "근거" }]) }),
    );
    await recorder.drain();

    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(postMessage.mock.calls.map((call) => (call[1] as { authorId: string }).authorId)).toEqual([
      "representative",
      "representative",
      "context-strategy",
      "evidence-research",
    ]);
    expect(postMessage.mock.calls[2]?.[1]).toMatchObject({ content: "계획", replyToMessageId: "message-1" });
    expect(postMessage.mock.calls[3]?.[1]).toMatchObject({ content: "근거", replyToMessageId: "message-2" });
  });

  it("같은 실행·sequence는 같은 commandId를 써서 재시도가 중복을 만들지 않는다", async () => {
    const { recorder, postMessage } = harness();
    const input = JSON.stringify({ task: "재시도", targetAgents: [CONTEXT_STRATEGY] });

    recorder.observe(context, delta({ kind: "tool-call", sequence: 7, toolInput: input }));
    await recorder.drain();
    recorder.observe(context, delta({ kind: "tool-call", sequence: 7, toolInput: input }));
    await recorder.drain();

    const commandIds = postMessage.mock.calls.map((call) => (call[1] as { commandId: string }).commandId);
    expect(new Set(commandIds).size).toBe(1);
    // 도메인의 commandId 원장이 두 번째를 replay로 흡수합니다. 기록기가 새 ID를 만들면 그 방어가 무의미해집니다.
    expect(commandIds[0]).toBe("execution-1:collab:7:0");
  });

  it("delegate_task 가 아닌 tool 과 형태가 다른 인자는 기록하지 않는다", async () => {
    const { recorder, postMessage } = harness();

    recorder.observe(context, delta({ kind: "tool-call", sequence: 1, toolName: "read_file", toolInput: "{}" }));
    recorder.observe(context, delta({ kind: "tool-call", sequence: 2, toolInput: "not json" }));
    recorder.observe(context, delta({ kind: "tool-call", sequence: 3, toolInput: JSON.stringify({ task: "" }) }));
    recorder.observe(context, delta({ kind: "output-text", sequence: 4, text: "본문" }));
    await recorder.drain();

    // 없는 것을 추측해서 만들지 않습니다.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("기록 실패가 실행 경로로 새지 않고 관측 가능하게 남는다", async () => {
    const postMessage = vi.fn(async () => {
      throw new Error("방 한도를 넘었습니다");
    });
    const { recorder, onFailure } = harness({ postMessage });

    // 관찰자 계약은 동기 fire-and-forget입니다. 여기서 던지면 에이전트 실행이 죽습니다.
    expect(() => {
      recorder.observe(
        context,
        delta({
          kind: "tool-call",
          sequence: 1,
          toolInput: JSON.stringify({ task: "실패", targetAgents: [CONTEXT_STRATEGY] }),
        }),
      );
    }).not.toThrow();
    await recorder.drain();

    // 그러나 삼키지도 않습니다.
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("협업방이 아직 없으면 만들지 않고 조용히 지나간다", async () => {
    const { recorder, postMessage, listRooms, onFailure } = harness();
    listRooms.mockResolvedValueOnce([]);

    recorder.observe(
      context,
      delta({
        kind: "tool-call",
        sequence: 1,
        toolInput: JSON.stringify({ task: "방 없음", targetAgents: [CONTEXT_STRATEGY] }),
      }),
    );
    await recorder.drain();

    // 방 생성은 파이프라인이 Work revision과 함께 소유합니다. 기록기가 끼어들면 revision 경쟁이 됩니다.
    expect(postMessage).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
