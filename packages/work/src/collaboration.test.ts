import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type CollaborationMessageType, type CreateWorkResult } from "./work.js";
import {
  WORK_ASSURANCE_LINK_MIGRATION,
  WORK_COLLABORATION_MIGRATION,
  WORK_HANDOFF_RECIPIENT_MIGRATION,
} from "./schema.js";

const MESSAGE_TYPES: readonly CollaborationMessageType[] = [
  "question",
  "answer",
  "proposal",
  "challenge",
  "review_request",
  "change_request",
  "evidence",
  "decision",
  "handoff",
  "status",
];

describe("Work collaboration migration upgrade", () => {
  it("기존 collaboration migration을 유지하고 handoff recipient 필드만 추가한다", async () => {
    const database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });

    try {
      expect(WORK_COLLABORATION_MIGRATION.id).toBe("0006-work-collaboration");
      expect(WORK_COLLABORATION_MIGRATION.checksum).toBe(
        "ca89d2dee193e4b4d8c152213b4e15bac652ffef93d80b68c100c9a433e94ce5",
      );
      expect(WORK_COLLABORATION_MIGRATION.surql).not.toContain("recipient_agent_id");
      expect(WORK_HANDOFF_RECIPIENT_MIGRATION.id).toBe("0117-work-handoff-recipient");
      await expect(applyMigrations(database, [WORK_COLLABORATION_MIGRATION])).resolves.toEqual([
        "0006-work-collaboration",
      ]);
      await expect(
        applyMigrations(database, [WORK_COLLABORATION_MIGRATION, WORK_HANDOFF_RECIPIENT_MIGRATION]),
      ).resolves.toEqual(["0117-work-handoff-recipient"]);
    } finally {
      await database.close();
    }
  });
});

describe("Collaboration Room과 resource lease", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let graph: OrganizationGraphService;
  let created: CreateWorkResult;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    service = await WorkService.create(database, organizations, graph);
    created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "협업",
      surface: "test",
      organizationVersionId: "org-v1",
    });
  });

  afterEach(async () => database.close());

  async function openRoom(maxRounds = 30, maxTokens = 10_000, deadline?: string) {
    return await service.openRoom(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: (await service.getWork(context, created.work.work_id)).revision,
      title: "Delivery Room",
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        { kind: "agent", subjectId: "assurance", role: "participant" },
      ],
      limits: { maxParallel: 2, maxTokens, maxCostMicros: 1_000_000, maxRounds, ...(deadline ? { deadline } : {}) },
    });
  }

  async function prepareAtomicStaffing() {
    const plan = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "원자적 staffing" },
    });
    const planned = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      title: "원자적 staffing",
      objective: "메시지와 배정을 함께 기록합니다",
      acceptanceCriteria: ["모두 commit되거나 모두 rollback됩니다"],
      dependencyIds: [],
    });
    const opened = await service.openRoom(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: [{ kind: "agent", subjectId: "representative", role: "coordinator" }],
      limits: { maxParallel: 2, maxTokens: 10_000, maxCostMicros: 1_000_000, maxRounds: 10 },
    });
    return { plan: plan.plan, task: task.task, opened };
  }

  it("외부 transaction 실패 시 message와 assignment의 모든 변경을 rollback한다", async () => {
    const { task, opened } = await prepareAtomicStaffing();
    const messageCommandId = "atomic-staffing-message-rollback";
    const assignmentCommandId = "atomic-staffing-assignment-rollback";
    const eventCount = (await service.listEvents(context, created.work.work_id)).length;

    await expect(
      database.transaction(async (transaction) => {
        const posted = await service.postMessage(
          context,
          {
            commandId: messageCommandId,
            workId: created.work.work_id,
            roomId: opened.room.room_id,
            messageType: "handoff",
            authorKind: "agent",
            authorId: "representative",
            content: "Assurance에 배정합니다.",
            tokenCount: 0,
            costMicros: 0,
          },
          transaction,
        );
        const assigned = await service.assignTask(
          context,
          {
            commandId: assignmentCommandId,
            workId: created.work.work_id,
            expectedRevision: posted.work.revision,
            taskId: task.task_id,
            agentHandle: "assurance",
          },
          transaction,
        );
        expect(
          (await service.listAssignments(context, created.work.work_id, transaction)).map(
            (assignment) => assignment.assignment_id,
          ),
        ).toEqual([assigned.assignment.assignment_id]);
        throw new Error("상위 Dynamic Staffing 실패");
      }),
    ).rejects.toThrow("상위 Dynamic Staffing 실패");

    expect((await service.getWork(context, created.work.work_id)).revision).toBe(opened.work.revision);
    expect(await service.listMessages(context, created.work.work_id, opened.room.room_id)).toEqual([]);
    expect(await service.listAssignments(context, created.work.work_id)).toEqual([]);
    expect(await service.listEvents(context, created.work.work_id)).toHaveLength(eventCount);
    const [participants] = await database.query<[Array<{ readonly subject_id: string }>]>(
      "SELECT subject_id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id ORDER BY subject_id ASC;",
      { organization_id: context.organizationId, room_id: opened.room.room_id },
    );
    expect(participants).toEqual([{ subject_id: "representative" }]);
  });

  it("외부 transaction commit 후 기존 공개 호출을 replay해도 message와 assignment를 한 번만 기록한다", async () => {
    const { plan, task, opened } = await prepareAtomicStaffing();
    const messageInput = {
      commandId: "atomic-staffing-message-commit",
      workId: created.work.work_id,
      roomId: opened.room.room_id,
      messageType: "handoff" as const,
      authorKind: "agent" as const,
      authorId: "representative",
      content: "Assurance에 배정합니다.",
      tokenCount: 0,
      costMicros: 0,
    };
    const assignmentInput = {
      commandId: "atomic-staffing-assignment-commit",
      workId: created.work.work_id,
      expectedRevision: opened.work.revision + 1,
      taskId: task.task_id,
      agentHandle: "assurance",
    };

    const defaultQuery = vi.spyOn(database, "query");
    const committed = await database.transaction(async (transaction) => {
      expect((await service.getActivePlan(context, created.work.work_id, transaction))?.plan_version_id).toBe(
        plan.plan_version_id,
      );
      const posted = await service.postMessage(context, messageInput, transaction);
      const assigned = await service.assignTask(context, assignmentInput, transaction);
      return { posted, assigned };
    });
    expect(defaultQuery).not.toHaveBeenCalled();
    defaultQuery.mockRestore();
    const replayedMessage = await service.postMessage(context, messageInput);
    const replayedAssignment = await service.assignTask(context, assignmentInput);

    expect(replayedMessage.message.message_id).toBe(committed.posted.message.message_id);
    expect(replayedAssignment.assignment.assignment_id).toBe(committed.assigned.assignment.assignment_id);
    expect((await service.getWork(context, created.work.work_id)).revision).toBe(opened.work.revision + 2);
    expect(await service.listMessages(context, created.work.work_id, opened.room.room_id)).toHaveLength(1);
    expect(await service.listAssignments(context, created.work.work_id)).toHaveLength(1);
    expect(
      (await service.listEvents(context, created.work.work_id)).filter((event) =>
        [messageInput.commandId, assignmentInput.commandId].includes(event.command_id),
      ),
    ).toHaveLength(2);
    const [participants] = await database.query<[Array<{ readonly subject_id: string }>]>(
      "SELECT subject_id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND subject_id = 'assurance';",
      { organization_id: context.organizationId, room_id: opened.room.room_id },
    );
    expect(participants).toEqual([{ subject_id: "assurance" }]);
  });

  it("모든 구조화 message type과 reply·causation을 순서대로 기록한다", async () => {
    const opened = await openRoom();
    let previousMessageId: string | undefined;
    for (const messageType of MESSAGE_TYPES) {
      const result = await service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType,
        authorKind: messageType === "answer" ? "agent" : "user",
        authorId: messageType === "answer" ? "assurance" : context.userId,
        content: messageType,
        ...(previousMessageId ? { replyToMessageId: previousMessageId, causedByMessageId: previousMessageId } : {}),
        tokenCount: 10,
        costMicros: 100,
      });
      previousMessageId = result.message.message_id;
    }

    const messages = await service.listMessages(context, created.work.work_id, opened.room.room_id);
    expect(messages.map((message) => message.message_type)).toEqual(MESSAGE_TYPES);
    expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(messages[1]?.reply_to_message_id).toBe(messages[0]?.message_id);
  });

  it("Agent 인계는 같은 방의 실제 수신 Agent를 구조적으로 기록한다", async () => {
    const opened = await openRoom();
    await expect(
      service.postMessage(context, {
        commandId: "handoff-self-recipient",
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "handoff",
        authorKind: "agent",
        authorId: "representative",
        recipientAgentId: "representative",
        content: "자기 자신에게 넘길 수 없습니다",
        tokenCount: 0,
        costMicros: 0,
      }),
    ).rejects.toThrow("달라야");
    await expect(
      service.postMessage(context, {
        commandId: "handoff-missing-recipient",
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "handoff",
        authorKind: "agent",
        authorId: "representative",
        recipientAgentId: "not-in-room",
        content: "내부 실행 요약",
        tokenCount: 0,
        costMicros: 0,
      }),
    ).rejects.toThrow("수신 Agent");

    const posted = await service.postMessage(context, {
      commandId: "handoff-real-recipient",
      workId: created.work.work_id,
      roomId: opened.room.room_id,
      messageType: "handoff",
      authorKind: "agent",
      authorId: "representative",
      recipientAgentId: "assurance",
      content: "내부 실행 요약",
      tokenCount: 0,
      costMicros: 0,
    });

    expect(posted.message.recipient_agent_id).toBe("assurance");
    expect(await service.listMessages(context, created.work.work_id, opened.room.room_id)).toMatchObject([
      { author_id: "representative", recipient_agent_id: "assurance", message_type: "handoff" },
    ]);
  });

  it("동시 message를 모두 commit하되 고유 sequence로 직렬화한다", async () => {
    const opened = await openRoom();
    const inputs = ["one", "two", "three"].map((content) =>
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "proposal",
        authorKind: "agent",
        authorId: "assurance",
        content,
        tokenCount: 1,
        costMicros: 1,
      }),
    );

    const results = await Promise.all(inputs);

    expect(results).toHaveLength(3);
    expect(
      (await service.listMessages(context, created.work.work_id, opened.room.room_id)).map(
        (message) => message.sequence,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("Delivery Artifact·Task·Runtime·Collaboration 계보를 한 revision에 원자 기록하고 replay에서 중복하지 않는다", async () => {
    await database.query("DEFINE TABLE runtime_execution SCHEMALESS;");
    await applyMigrations(database, [WORK_ASSURANCE_LINK_MIGRATION]);
    await graph.execute(context, {
      commandId: "delivery-lineage-dynamic-agent",
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "delivery-lineage-dynamic",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "work-quant-specialist",
          name: "Work Quant Specialist",
          responsibility: "현재 Work의 계량 분석",
          outputs: ["Delivery"],
          capabilities: ["quant-analysis"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: created.work.work_id,
          role: "operator",
        },
      ],
    });
    const opened = await service.openRoom(context, {
      commandId: "delivery-lineage-room",
      workId: created.work.work_id,
      expectedRevision: (await service.getWork(context, created.work.work_id)).revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: [{ kind: "agent", subjectId: "representative", role: "coordinator" }],
      limits: { maxParallel: 2, maxTokens: 10_000, maxCostMicros: 1_000_000, maxRounds: 10 },
    });
    const handoff = await service.postMessage(context, {
      commandId: "delivery-lineage-handoff",
      workId: created.work.work_id,
      roomId: opened.room.room_id,
      messageType: "handoff",
      authorKind: "agent",
      authorId: "representative",
      content: "Delivery로 전달합니다.",
      tokenCount: 0,
      costMicros: 0,
    });
    const plan = await service.addPlan(context, {
      commandId: "delivery-lineage-plan",
      workId: created.work.work_id,
      expectedRevision: handoff.work.revision,
      content: { objective: "Delivery lineage" },
    });
    const planned = await service.transition(context, {
      commandId: "delivery-lineage-planned",
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    const task = await service.addTask(context, {
      commandId: "delivery-lineage-task",
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      title: "원자 Delivery",
      objective: "계보를 원자 기록합니다",
      acceptanceCriteria: ["Artifact와 메시지가 함께 생성됩니다"],
      dependencyIds: [],
    });
    const assigned = await service.assignTask(context, {
      commandId: "delivery-lineage-assignment",
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "work-quant-specialist",
    });
    const [joined] = await database.query<[Array<{ readonly subject_id: string; readonly status: string }>]>(
      "SELECT subject_id, status FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND subject_id = 'work-quant-specialist';",
      { organization_id: context.organizationId, room_id: opened.room.room_id },
    );
    expect(joined).toEqual([{ subject_id: "work-quant-specialist", status: "active" }]);
    const ready = await service.transition(context, {
      commandId: "delivery-lineage-ready",
      workId: created.work.work_id,
      expectedRevision: assigned.work.revision,
      target: "ready",
    });
    const running = await service.transition(context, {
      commandId: "delivery-lineage-running",
      workId: created.work.work_id,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    const taskRunning = await service.transitionTask(context, {
      commandId: "delivery-lineage-task-running",
      workId: created.work.work_id,
      expectedRevision: running.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: task.task.revision,
      target: "running",
    });
    const executionId = "delivery-lineage-execution";
    await database.query(
      "CREATE runtime_execution CONTENT { execution_id: $execution_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: 'work-quant-specialist', status: 'succeeded' };",
      {
        execution_id: executionId,
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        task_id: task.task.task_id,
      },
    );
    const artifactInput = {
      commandId: "delivery-lineage-artifact",
      workId: created.work.work_id,
      expectedRevision: taskRunning.work.revision,
      kind: "task-output",
      name: `task-${task.task.task_id}`,
      mediaType: "application/json",
      content: "DELIVERY_ATOMIC_RESULT",
      creatorAgentHandle: "work-quant-specialist",
      creatorExecutionId: executionId,
      creatorTaskId: task.task.task_id,
    };
    const artifact = await service.createArtifactVersion(context, artifactInput);
    const replayed = await service.createArtifactVersion(context, artifactInput);
    expect(artifact.work.revision).toBe(taskRunning.work.revision + 1);
    expect(replayed.artifactVersion.artifact_version_id).toBe(artifact.artifactVersion.artifact_version_id);
    expect(await service.listMessages(context, created.work.work_id, opened.room.room_id)).toEqual([
      expect.objectContaining({ message_id: handoff.message.message_id }),
      expect.objectContaining({
        sequence: 2,
        message_type: "evidence",
        author_id: "work-quant-specialist",
        reply_to_message_id: handoff.message.message_id,
        caused_by_message_id: handoff.message.message_id,
        task_id: task.task.task_id,
        execution_id: executionId,
        artifact_version_id: artifact.artifactVersion.artifact_version_id,
      }),
    ]);

    const reassigned = await service.assignTask(context, {
      commandId: "delivery-lineage-reassigned",
      workId: created.work.work_id,
      expectedRevision: artifact.work.revision,
      taskId: task.task.task_id,
      agentHandle: "assurance",
    });
    const messagesBeforeLateResult = await service.listMessages(context, created.work.work_id, opened.room.room_id);
    await expect(
      service.createArtifactVersion(context, {
        ...artifactInput,
        commandId: "delivery-lineage-late-artifact",
        expectedRevision: reassigned.work.revision,
      }),
    ).rejects.toThrow("현재 Task assignment");
    expect((await service.getWork(context, created.work.work_id)).revision).toBe(reassigned.work.revision);
    expect(await service.listMessages(context, created.work.work_id, opened.room.room_id)).toEqual(
      messagesBeforeLateResult,
    );
    const [artifactVersions] = await database.query<[Array<{ readonly artifact_version_id: string }>]>(
      "SELECT artifact_version_id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(artifactVersions).toHaveLength(1);
  });

  it("참여자와 round·token·deadline 한계를 강제한다", async () => {
    const opened = await openRoom(1, 2);
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "agent",
        authorId: "growth",
        content: "unauthorized",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("participant");
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: "another-user",
        content: "impersonated",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("다른 사용자");
    await service.postMessage(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      roomId: opened.room.room_id,
      messageType: "status",
      authorKind: "user",
      authorId: context.userId,
      content: "first",
      tokenCount: 2,
      costMicros: 0,
    });
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: context.userId,
        content: "second",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("round 한도");
    const expired = await openRoom(5, 100, new Date(Date.now() - 1_000).toISOString());
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: expired.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: context.userId,
        content: "late",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("deadline");
  });

  it("조직 사용자가 revision을 확인해 협업방에 참여하고 나간다", async () => {
    const opened = await openRoom();
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const member = await identities.registerPersonalUser({ email: "room-member@example.com", displayName: "Member" });
    await organizations.addMember(context, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    const joined = await service.joinRoom(memberContext, {
      commandId: "join-room-member-0001",
      workId: created.work.work_id,
      expectedRevision: (await service.getWork(memberContext, created.work.work_id)).revision,
      roomId: opened.room.room_id,
      expectedRoomRevision: opened.room.revision,
      kind: "user",
      subjectId: member.user.user_id,
      role: "participant",
    });
    expect(joined.participant).toMatchObject({ subject_id: member.user.user_id, status: "active" });
    expect(joined.room.revision).toBe(opened.room.revision + 1);

    const left = await service.leaveRoom(memberContext, {
      commandId: "leave-room-member-0001",
      workId: created.work.work_id,
      expectedRevision: joined.work.revision,
      roomId: opened.room.room_id,
      expectedRoomRevision: joined.room.revision,
      kind: "user",
      subjectId: member.user.user_id,
    });
    expect(left.participant.status).toBe("left");
    await expect(
      service.postMessage(memberContext, {
        commandId: "left-member-message-0001",
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: member.user.user_id,
        content: "나간 뒤 메시지",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("participant");
  });

  it("불변 Shared Context Reference와 versioned lease를 관리한다", async () => {
    const opened = await openRoom();
    let work = await service.getWork(context, created.work.work_id);
    const checksum = createHash("sha256").update("context-v1").digest("hex");
    const shared = await service.addSharedContext(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      roomId: opened.room.room_id,
      sourceKind: "context",
      sourceId: "context-1",
      versionId: "v1",
      checksum,
    });
    work = shared.work;
    const acquired = await service.acquireLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      ttlMs: 60_000,
    });

    await expect(
      service.acquireLease(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: acquired.work.revision,
        resourceKey: "artifact:file-1",
        holderId: "representative",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("이미 활성");
    const renewed = await service.renewLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: acquired.work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      expectedLeaseVersion: 1,
      ttlMs: 120_000,
    });
    const released = await service.releaseLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: renewed.work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      expectedLeaseVersion: renewed.lease.version,
    });

    expect(shared.reference).toMatchObject({ source_id: "context-1", version_id: "v1", checksum });
    await expect(service.listSharedContexts(context, work.work_id, opened.room.room_id)).resolves.toMatchObject([
      {
        organization_id: context.organizationId,
        work_id: work.work_id,
        room_id: opened.room.room_id,
        shared_context_reference_id: shared.reference.shared_context_reference_id,
        source_kind: "context",
        source_id: "context-1",
        version_id: "v1",
        checksum,
      },
    ]);
    expect(released.lease.status).toBe("released");
    expect(released.lease.version).toBe(3);
  });
});
