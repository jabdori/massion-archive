import type { RoomMessageViewV1 } from "@massion/application/client";
import { describe, expect, it } from "vitest";

import { projectRoomActivities, type OrganizationNodeView } from "@/desktop-service";

type MessageProjectionSource = RoomMessageViewV1 & {
  readonly authorDisplayName?: string;
  readonly providerId?: string;
  readonly modelId?: string;
};

const nodes: OrganizationNodeView[] = [
  {
    id: "node-rep",
    handle: "representative",
    builtin: true,
    name: "Representative",
    responsibility: "사용자 요청 접수, 조정, 최종 응답",
    status: "active",
    role: "orchestrator",
    capabilities: ["request-coordination"],
  },
  {
    id: "node-evidence",
    handle: "evidence-research",
    builtin: true,
    name: "Evidence & Research",
    responsibility: "코드·문서·외부 근거 조사, 출처 검증",
    status: "active",
    role: "operator",
    capabilities: ["evidence-research"],
  },
  {
    id: "node-context",
    handle: "context-strategy",
    builtin: true,
    name: "Context & Strategy",
    responsibility: "맥락 구성, 계획, 위험 분석",
    status: "active",
    role: "operator",
    capabilities: ["context-strategy"],
  },
  {
    id: "node-assurance",
    handle: "assurance",
    builtin: true,
    name: "Assurance",
    responsibility: "독립 리뷰, 테스트·보안·운영 검증",
    status: "active",
    role: "operator",
    capabilities: ["assurance"],
  },
];

function message(
  overrides: Partial<MessageProjectionSource> & Pick<RoomMessageViewV1, "messageId" | "sequence">,
): MessageProjectionSource {
  return {
    messageType: "status",
    authorKind: "agent",
    authorId: "representative",
    content: "내용",
    createdAt: "2026-07-21T10:23:00.000Z",
    ...overrides,
  };
}

describe("협업방 투영", () => {
  it("sequence 순서로 정렬하고 화자를 정체성으로 세운다", () => {
    const activities = projectRoomActivities(
      [
        message({ messageId: "b", sequence: 2, messageType: "evidence", authorId: "evidence-research", content: "둘" }),
        message({ messageId: "a", sequence: 1, messageType: "evidence", authorId: "representative", content: "하나" }),
      ],
      nodes,
    );

    expect(activities.map((activity) => activity.id)).toEqual(["a", "b"]);
    const first = activities[0];
    expect(first?.kind).toBe("room");
    if (first?.kind === "room") {
      expect(first.speaker.name).toBe("Atlas");
      // 역할 배지는 조직 노드의 responsibility 첫 마디에서 옵니다.
      expect(first.speaker.role).toBe("사용자 요청 접수");
      expect(first.speaker.provisional).toBeUndefined();
    }
  });

  it("반론은 원본을 인용으로 물고 답변은 들여쓴다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "q",
          sequence: 1,
          messageType: "question",
          authorId: "assurance",
          content: "기준이 뭔가요?",
        }),
        message({
          messageId: "a",
          sequence: 2,
          messageType: "answer",
          authorId: "evidence-research",
          content: "5축입니다.",
          replyToMessageId: "q",
        }),
        message({
          messageId: "c",
          sequence: 3,
          messageType: "challenge",
          authorId: "assurance",
          content: "비교가 성립하지 않습니다.",
          replyToMessageId: "a",
        }),
      ],
      nodes,
    );

    const answer = activities[1];
    if (answer?.kind !== "room") throw new Error("답변이 room 활동이 아닙니다");
    expect(answer.indented).toBe(true);

    const challenge = activities[2];
    if (challenge?.kind !== "room") throw new Error("반론이 room 활동이 아닙니다");
    // 반론은 무엇을 반박하는지 없이 존재할 수 없습니다.
    expect(challenge.quoted).toMatchObject({ author: "Quill", content: "5축입니다." });
  });

  it("계보가 없으면 인용도 들여쓰기도 만들지 않는다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "c",
          sequence: 1,
          messageType: "challenge",
          authorId: "assurance",
          content: "반론만 있음",
        }),
      ],
      nodes,
    );

    const challenge = activities[0];
    if (challenge?.kind !== "room") throw new Error("반론이 room 활동이 아닙니다");
    expect(challenge.quoted).toBeUndefined();
  });

  it("인계는 저장된 내용을 보존하고 다음 발언자를 받는 쪽으로 지어내지 않는다", () => {
    const followedByAnotherSpeaker = projectRoomActivities(
      [
        message({
          messageId: "h",
          sequence: 1,
          messageType: "handoff",
          authorId: "evidence-research",
          content: "검증할 표본과 남은 질문을 넘깁니다.",
        }),
        message({ messageId: "n", sequence: 2, messageType: "evidence", authorId: "assurance" }),
      ],
      nodes,
    );
    const handoff = followedByAnotherSpeaker[0];
    if (handoff?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(handoff.from.name).toBe("Quill");
    expect(handoff.content).toBe("검증할 표본과 남은 질문을 넘깁니다.");
    expect(handoff.to).toBeUndefined();

    const alone = projectRoomActivities(
      [message({ messageId: "h", sequence: 1, messageType: "handoff", authorId: "evidence-research" })],
      nodes,
    );
    const lonely = alone[0];
    if (lonely?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(lonely.to).toBeUndefined();
  });

  it("구조화된 Representative 인계는 내부 실행 요약 대신 실제 받는 Agent만 표시한다", () => {
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: "structured-handoff",
          sequence: 1,
          messageType: "handoff",
          authorId: "representative",
          recipientAgentId: "evidence-research",
          content: JSON.stringify({
            handoffTo: "context-strategy",
            intent: "동적 배치 게이트를 검증합니다.",
            execution: { artifactCount: 1, artifactType: "text" },
            constraints: { criticalRisks: [], fileChanges: false },
            nextAction: "필수 역량을 배치한 뒤 실행과 검증을 진행하세요.",
          }),
        }),
      ],
      nodes,
    );

    if (activity?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(activity.from.name).toBe("Atlas");
    expect(activity.to?.name).toBe("Quill");
    expect(activity.content).toBeUndefined();
  });

  it("실제 collaboration_message의 명시적 handoffTo를 현재 조직의 받는 Agent로 표시한다", () => {
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: "actual-collaboration-handoff",
          sequence: 1,
          messageType: "handoff",
          authorId: "representative",
          content: JSON.stringify({
            handoffTo: "context-strategy",
            intent: "사용자 요청을 실행 가능한 계획으로 전환합니다.",
            nextAction: "위험과 실행 순서를 정리하세요.",
            tasks: [{ title: "실행 계획 작성", status: "pending" }],
          }),
        }),
      ],
      nodes,
    );

    if (activity?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(activity.from.name).toBe("Atlas");
    expect(activity.to?.name).toBe("Lyra");
    expect(activity.content).toBeUndefined();
  });

  it("수신자 없는 과거 인계는 받는 Agent를 추정하지 않고 구조화 payload만 숨긴다", () => {
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: "legacy-structured-handoff",
          sequence: 1,
          messageType: "handoff",
          authorId: "representative",
          content: JSON.stringify({ intent: "내부 의도", nextAction: "내부 다음 단계" }),
        }),
      ],
      nodes,
    );

    if (activity?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(activity.to).toBeUndefined();
    expect(activity.content).toBeUndefined();
  });

  it.each(["", "unknown-agent", 42])("유효하지 않은 handoffTo %j로 받는 Agent를 만들지 않는다", (handoffTo) => {
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: `invalid-handoff-${String(handoffTo)}`,
          sequence: 1,
          messageType: "handoff",
          authorId: "representative",
          content: JSON.stringify({ handoffTo, intent: "내부 의도" }),
        }),
      ],
      nodes,
    );

    if (activity?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(activity.to).toBeUndefined();
    expect(activity.content).toBeUndefined();
  });

  it("배열형 구조화 인계도 내부 실행 정보와 유사 handle을 모두 숨긴다", () => {
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: "array-handoff",
          sequence: 1,
          messageType: "handoff",
          authorId: "representative",
          content: JSON.stringify([
            {
              nextAction: "내부 다음 단계",
              provider: "internal-provider",
              handle: "context-strategy",
            },
          ]),
        }),
      ],
      nodes,
    );

    if (activity?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(activity.to).toBeUndefined();
    expect(activity.content).toBeUndefined();
  });

  it("조직 그래프에 없는 화자는 내부 handle 대신 일반 역할로 표기한다", () => {
    const activities = projectRoomActivities(
      [message({ messageId: "m", sequence: 1, messageType: "evidence", authorId: "quant-analysis" })],
      nodes,
    );
    const activity = activities[0];
    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    // scope:"work" 노드이거나 아직 승인되지 않은 노드입니다. 점선으로 표기됩니다.
    expect(activity.speaker.provisional).toBe(true);
    expect(activity.speaker.role).toBe("작업 담당");
  });

  it("동적 Work Agent의 생성용 task key는 사람용 역할 배지에서 숨긴다", () => {
    const generatedNode: OrganizationNodeView = {
      id: "node-generated",
      handle: "staff-generated",
      builtin: false,
      name: "Generated Worker",
      responsibility: "Work task internal-task-key 실행",
      status: "active",
      role: "operator",
      capabilities: ["specialized-analysis"],
      scope: "work",
      workId: "work-1",
    };
    const [activity] = projectRoomActivities(
      [
        message({
          messageId: "m-generated",
          sequence: 1,
          messageType: "evidence",
          authorId: generatedNode.handle,
        }),
      ],
      [...nodes, generatedNode],
    );

    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    expect(activity.speaker.role).toBe("전문 작업 실행");
    expect(activity.speaker.role).not.toContain("internal-task-key");
  });

  it("의미 없는 UUID handle은 사람용 역할로 가린다", () => {
    const handle = "db06753b-4495-44e0-b16b-c17b9081aa0d";
    const activities = projectRoomActivities(
      [message({ messageId: "m-uuid", sequence: 1, messageType: "evidence", authorId: handle })],
      nodes,
    );
    const activity = activities[0];
    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    expect(activity.speaker.name).not.toBe(handle);
    expect(activity.speaker.role).toBe("작업 담당");
  });

  it("status는 발언이 아니므로 아바타 없는 줄이 된다", () => {
    const activities = projectRoomActivities(
      [message({ messageId: "s", sequence: 1, messageType: "status", content: "라운드 4 / 12" })],
      nodes,
    );
    expect(activities[0]).toMatchObject({ kind: "roomStatus", content: "라운드 4 / 12" });
  });

  it("사람 참가자는 색 슬롯을 쓰지 않는다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "u",
          sequence: 1,
          messageType: "question",
          authorKind: "user",
          authorId: "owner-1",
          authorDisplayName: "외부 사용자 이름",
        }),
      ],
      nodes,
    );
    const activity = activities[0];
    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    expect(activity.speaker.name).toBe("나");
    expect(activity.speaker.human).toBe(true);
    expect(activity.speaker.accentSlot).toBeLessThan(0);
  });

  it("에이전트의 표시 이름과 실제 Provider·모델을 일반 발언과 인계에 보존한다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "a",
          sequence: 1,
          messageType: "answer",
          authorId: "evidence-research",
          authorDisplayName: "Evidence & Research",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
        }),
        message({
          messageId: "h",
          sequence: 2,
          messageType: "handoff",
          authorId: "evidence-research",
          authorDisplayName: "Evidence & Research",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
        }),
      ],
      nodes,
    );

    const answer = activities[0];
    if (answer?.kind !== "room") throw new Error("답변이 room 활동이 아닙니다");
    expect(answer.speaker).toMatchObject({
      name: "Quill",
      role: "코드·문서·외부 근거 조사",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });

    const handoff = activities[1];
    if (handoff?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(handoff.from).toMatchObject({ providerId: "openai-codex", modelId: "gpt-5.6-sol" });
  });

  it("닫힌 방의 마지막 대표 답변만 최종 응답으로 표시한다", () => {
    const messages = [
      message({ messageId: "a", sequence: 1, messageType: "answer", authorId: "representative" }),
      message({ messageId: "s", sequence: 2, messageType: "status", content: "방 종료" }),
    ];

    const active = projectRoomActivities(messages, nodes, "active");
    const closed = projectRoomActivities(messages, nodes, "closed");
    const activeAnswer = active[0];
    const closedAnswer = closed[0];
    if (activeAnswer?.kind !== "room" || closedAnswer?.kind !== "room") throw new Error("답변이 room 활동이 아닙니다");
    expect(activeAnswer.final).toBeUndefined();
    expect(closedAnswer.final).toBe(true);

    const followed = projectRoomActivities(
      [
        message({ messageId: "a", sequence: 1, messageType: "answer", authorId: "representative" }),
        message({ messageId: "e", sequence: 2, messageType: "evidence", authorId: "assurance" }),
      ],
      nodes,
      "closed",
    );
    const followedAnswer = followed[0];
    if (followedAnswer?.kind !== "room") throw new Error("답변이 room 활동이 아닙니다");
    expect(followedAnswer.final).toBeUndefined();
  });
});
