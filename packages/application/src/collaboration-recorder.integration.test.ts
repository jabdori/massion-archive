import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CORE_OFFICE_HANDLES, OrganizationGraphService } from "@massion/organization";
import { runtimeAgentName, type ExecutionDelta } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationRuntimeRecorder } from "./collaboration-recorder.js";

/*
 * 스텁이 아니라 실제 도메인이 이 메시지를 받아들이는지 봅니다.
 *
 * 협업방은 참가자·메시지 타입·round·token·cost 한계를 도메인에서 강제하므로, 기록기가 만드는
 * 모양이 그 계약을 통과하지 못하면 생산에서만 조용히 실패합니다. 이 저장소에서 반복된 결함이
 * 정확히 그것 — 「패키지 테스트는 GREEN인데 실제 배선은 없거나 거부된다」입니다.
 */
describe("Runtime 협업 기록기 · 실제 도메인", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let works: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "collab@example.com", displayName: "Collab" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    works = await WorkService.create(database, organizations, graph);
  });

  afterEach(async () => database.close());

  async function coreOfficeWork() {
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "환불 지연 분석",
      surface: "test",
      organizationVersionId: "org-v1",
    });
    // 파이프라인이 Work마다 보장하는 방과 같은 모양으로 엽니다.
    const opened = await works.openRoom(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        ...CORE_OFFICE_HANDLES.map((handle) => ({
          kind: "agent" as const,
          subjectId: handle,
          role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
        })),
      ],
      limits: { maxParallel: 8, maxTokens: 200_000, maxCostMicros: 1_000_000, maxRounds: 100 },
    });
    return { workId: created.work.work_id, roomId: opened.room.room_id };
  }

  function recorder(workId: string): CollaborationRuntimeRecorder {
    return new CollaborationRuntimeRecorder({
      executions: { get: async () => ({ work_id: workId }) },
      works,
      onFailure: (reason) => {
        throw reason instanceof Error ? reason : new Error(String(reason));
      },
    });
  }

  function delta(partial: Partial<ExecutionDelta> & Pick<ExecutionDelta, "kind" | "sequence">): ExecutionDelta {
    return {
      executionId: "execution-collab-1",
      agentHandle: "representative",
      toolName: "delegate_task",
      toolCallId: "call-1",
      occurredAt: "2026-08-09T00:00:00.000Z",
      ...partial,
    };
  }

  it("위임과 답변이 실제 방에 인과와 함께 남고 재조회에서 보존된다", async () => {
    const { workId, roomId } = await coreOfficeWork();
    const subject = recorder(workId);
    const target = runtimeAgentName(context.organizationId, "context-strategy");

    subject.observe(
      context,
      delta({
        kind: "tool-call",
        sequence: 4,
        toolInput: JSON.stringify({ task: "가장 긴 지연 구간을 계산해 주세요", targetAgents: [target] }),
      }),
    );
    subject.observe(
      context,
      delta({
        kind: "tool-result",
        sequence: 5,
        toolOutput: JSON.stringify([{ response: "검토→batch가 20.54시간으로 가장 깁니다" }]),
      }),
    );
    await subject.drain();

    const messages = await works.listMessages(context, workId, roomId);
    const handoff = messages.find((message) => message.message_type === "handoff");
    const answer = messages.find((message) => message.message_type === "answer");
    if (!handoff || !answer) throw new Error("협업 메시지가 방에 남지 않았습니다");

    expect(handoff).toMatchObject({
      author_kind: "agent",
      author_id: "representative",
      recipient_agent_id: "context-strategy",
      content: "가장 긴 지연 구간을 계산해 주세요",
      execution_id: "execution-collab-1",
    });
    // 4.4가 요구하는 인과 계보. 화면의 들여쓰기와 인용이 이 값에서만 나옵니다.
    expect(answer).toMatchObject({
      author_id: "context-strategy",
      reply_to_message_id: handoff.message_id,
      caused_by_message_id: handoff.message_id,
      execution_id: "execution-collab-1",
    });
    expect(answer.sequence).toBeGreaterThan(handoff.sequence);
  });

  it("같은 delta를 다시 관찰해도 방에 메시지가 늘지 않는다", async () => {
    const { workId, roomId } = await coreOfficeWork();
    const subject = recorder(workId);
    const target = runtimeAgentName(context.organizationId, "evidence-research");
    const observed = delta({
      kind: "tool-call",
      sequence: 2,
      toolInput: JSON.stringify({ task: "근거를 모아 주세요", targetAgents: [target] }),
    });

    subject.observe(context, observed);
    await subject.drain();
    subject.observe(context, observed);
    await subject.drain();

    // commandId 원장이 두 번째를 replay로 흡수합니다. 재시도·복구가 방을 부풀리면 안 됩니다.
    expect(await works.listMessages(context, workId, roomId)).toHaveLength(1);
  });

  it("방 참가자가 아닌 Agent에게 위임하면 실행을 죽이지 않고 기록만 실패한다", async () => {
    const { workId, roomId } = await coreOfficeWork();
    const failures: unknown[] = [];
    const subject = new CollaborationRuntimeRecorder({
      executions: { get: async () => ({ work_id: workId }) },
      works,
      onFailure: (reason) => failures.push(reason),
    });

    expect(() => {
      subject.observe(
        context,
        delta({
          kind: "tool-call",
          sequence: 1,
          toolInput: JSON.stringify({
            task: "임시 팀에게",
            targetAgents: [runtimeAgentName(context.organizationId, "staff-not-a-participant")],
          }),
        }),
      );
    }).not.toThrow();
    await subject.drain();

    expect(failures).toHaveLength(1);
    expect(await works.listMessages(context, workId, roomId)).toHaveLength(0);
  });

  it("같은 Work의 여러 실행이 동시에 기록해도 메시지를 잃지 않는다", async () => {
    // Codex 리뷰가 재현한 결함입니다. 직렬화를 실행 단위로 잡으면 같은 방의 next_sequence를
    // 여러 실행이 동시에 밀어 write conflict가 나고, 저장소 재시도(4회)를 넘긴 기록은 사라집니다.
    // 실측: 32개 동시 실행 → 27건 실패, 5건만 기록. 실제 경합 자원은 실행이 아니라 방입니다.
    const { workId, roomId } = await coreOfficeWork();
    const failures: unknown[] = [];
    const subject = new CollaborationRuntimeRecorder({
      executions: { get: async () => ({ work_id: workId }) },
      works,
      onFailure: (reason) => failures.push(reason),
    });
    const target = runtimeAgentName(context.organizationId, "context-strategy");

    const executions = Array.from({ length: 32 }, (_value, index) => `execution-parallel-${String(index)}`);
    for (const executionId of executions) {
      subject.observe(context, {
        executionId,
        agentHandle: "representative",
        toolName: "delegate_task",
        toolCallId: "call-1",
        kind: "tool-call",
        sequence: 1,
        occurredAt: "2026-08-09T00:00:00.000Z",
        toolInput: JSON.stringify({ task: `동시 위임 ${executionId}`, targetAgents: [target] }),
      });
    }
    await subject.drain();

    expect(failures).toEqual([]);
    expect(await works.listMessages(context, workId, roomId)).toHaveLength(32);
  });

  it("결과가 대상보다 짧아도 없는 답변을 만들지 않는다", async () => {
    const { workId, roomId } = await coreOfficeWork();
    const subject = recorder(workId);
    const first = runtimeAgentName(context.organizationId, "context-strategy");
    const second = runtimeAgentName(context.organizationId, "evidence-research");

    subject.observe(
      context,
      delta({
        kind: "tool-call",
        sequence: 1,
        toolInput: JSON.stringify({ task: "둘에게", targetAgents: [first, second] }),
      }),
    );
    // 대상은 둘인데 결과는 하나입니다. 예전에는 두 번째가 문자열 "null"로 기록됐습니다.
    subject.observe(
      context,
      delta({ kind: "tool-result", sequence: 2, toolOutput: JSON.stringify([{ response: "첫 답변" }]) }),
    );
    await subject.drain();

    const messages = await works.listMessages(context, workId, roomId);
    const answers = messages.filter((message) => message.message_type === "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.content).toBe("첫 답변");
    expect(messages.map((message) => message.content)).not.toContain("null");
  });
});
