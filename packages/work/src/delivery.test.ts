import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type Work } from "./work.js";

describe("Task DAG, Assignment와 Session", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let graph: OrganizationGraphService;
  let graphVersion: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    graphVersion = bootstrapped.version.version;
    service = await WorkService.create(database, organizations, graph);
    expect(graphVersion).toBe(1);
  });

  afterEach(async () => database.close());

  async function plannedWork(label = "work"): Promise<Work> {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: label,
      surface: "test",
      organizationVersionId: "org-v1",
    });
    const plan = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: label },
    });
    return (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: plan.work.revision,
        target: "planned",
      })
    ).work;
  }

  async function readyTask(label: string) {
    const planned = await plannedWork(label);
    const added = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: planned.work_id,
      expectedRevision: planned.revision,
      title: label,
      objective: label,
      acceptanceCriteria: ["완료"],
      dependencyIds: [],
    });
    const assigned = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: planned.work_id,
      expectedRevision: added.work.revision,
      taskId: added.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const ready = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: planned.work_id,
      expectedRevision: assigned.work.revision,
      target: "ready",
    });
    const running = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: planned.work_id,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    return { work: running.work, task: added.task };
  }

  async function runningTask(label: string) {
    const ready = await readyTask(label);
    return await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: ready.work.work_id,
      expectedRevision: ready.work.revision,
      taskId: ready.task.task_id,
      expectedTaskRevision: ready.task.revision,
      target: "running",
    });
  }

  it("Work 범위 Agent는 다른 Work에 배정하거나 참여시킬 수 없다", async () => {
    const ownerWork = await plannedWork("owner-work");
    const ownerTask = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: ownerWork.work_id,
      expectedRevision: ownerWork.revision,
      title: "소유 Work Task",
      objective: "소유 Work만 처리",
      acceptanceCriteria: ["격리"],
      dependencyIds: [],
    });
    const otherWork = await plannedWork("other-work");
    const otherTask = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: otherWork.work_id,
      expectedRevision: otherWork.revision,
      title: "다른 Work Task",
      objective: "다른 Work 처리",
      acceptanceCriteria: ["격리"],
      dependencyIds: [],
    });
    const scopedHandle = "owner-work-specialist";
    const createdAgent = await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: graphVersion,
      kind: "create",
      handle: scopedHandle,
      name: "Owner Work Specialist",
      responsibility: "한 Work만 처리합니다",
      parentHandle: "delivery-coordination",
      scope: "work",
      workId: ownerWork.work_id,
    });
    graphVersion = createdAgent.version.version;

    await expect(
      service.assignTask(context, {
        commandId: crypto.randomUUID(),
        workId: otherWork.work_id,
        expectedRevision: otherTask.work.revision,
        taskId: otherTask.task.task_id,
        agentHandle: scopedHandle,
      }),
    ).rejects.toThrow("Work 범위");
    await expect(
      service.openRoom(context, {
        commandId: crypto.randomUUID(),
        workId: otherWork.work_id,
        expectedRevision: otherTask.work.revision,
        title: "잘못된 Work 방",
        coordinatorHandle: scopedHandle,
        participants: [
          { kind: "user", subjectId: context.userId, role: "participant" },
          { kind: "agent", subjectId: scopedHandle, role: "coordinator" },
        ],
        limits: { maxParallel: 1, maxTokens: 100, maxCostMicros: 0, maxRounds: 2 },
      }),
    ).rejects.toThrow("Work 범위");

    await expect(
      service.assignTask(context, {
        commandId: crypto.randomUUID(),
        workId: ownerWork.work_id,
        expectedRevision: ownerTask.work.revision,
        taskId: ownerTask.task.task_id,
        agentHandle: scopedHandle,
      }),
    ).resolves.toMatchObject({ assignment: { agent_handle: scopedHandle } });
  });

  it("cycle 없는 DAG와 모든 Assignment가 있어야 Work를 ready로 전이한다", async () => {
    let work = await plannedWork();
    const first = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "설계",
      objective: "설계",
      acceptanceCriteria: ["승인됨"],
      dependencyIds: [],
    });
    const second = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: first.work.revision,
      title: "구현",
      objective: "구현",
      acceptanceCriteria: ["테스트 통과"],
      dependencyIds: [first.task.task_id],
    });
    work = second.work;

    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "ready",
      }),
    ).rejects.toThrow("모든 실행 Task의 Assignment");
    const assignedFirst = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      taskId: first.task.task_id,
      agentHandle: "context-strategy",
    });
    const assignedSecond = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: assignedFirst.work.revision,
      taskId: second.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const ready = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: assignedSecond.work.revision,
      target: "ready",
    });

    expect(ready.work.status).toBe("ready");
    expect((await service.listTasks(context, work.work_id)).map((task) => task.status)).toEqual(["ready", "blocked"]);
    const runningTask = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: ready.work.revision,
      taskId: first.task.task_id,
      expectedTaskRevision: 1,
      target: "running",
    });
    const completedTask = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: runningTask.work.revision,
      taskId: first.task.task_id,
      expectedTaskRevision: runningTask.task.revision,
      target: "completed",
    });

    expect(completedTask.unblockedTasks.map((task) => task.task_id)).toEqual([second.task.task_id]);
    expect((await service.listTasks(context, work.work_id)).map((task) => task.status)).toEqual(["completed", "ready"]);
  });

  it("cycle과 다른 Work의 dependency를 거부한다", async () => {
    let firstWork = await plannedWork("first");
    const first = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: firstWork.work_id,
      expectedRevision: firstWork.revision,
      title: "A",
      objective: "A",
      acceptanceCriteria: ["A"],
      dependencyIds: [],
    });
    const second = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: firstWork.work_id,
      expectedRevision: first.work.revision,
      title: "B",
      objective: "B",
      acceptanceCriteria: ["B"],
      dependencyIds: [first.task.task_id],
    });
    firstWork = second.work;

    await expect(
      service.setTaskDependencies(context, {
        commandId: crypto.randomUUID(),
        workId: firstWork.work_id,
        expectedRevision: firstWork.revision,
        taskId: first.task.task_id,
        dependencyIds: [second.task.task_id],
      }),
    ).rejects.toThrow("cycle");
    const other = await plannedWork("other");
    await expect(
      service.addTask(context, {
        commandId: crypto.randomUUID(),
        workId: other.work_id,
        expectedRevision: other.revision,
        title: "Cross",
        objective: "Cross",
        acceptanceCriteria: ["Cross"],
        dependencyIds: [first.task.task_id],
      }),
    ).rejects.toThrow("같은 Work");
  });

  it("같은 Work revision의 동시 Assignment는 하나만 commit한다", async () => {
    const work = await plannedWork("assignment race");
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "경쟁",
      objective: "경쟁",
      acceptanceCriteria: ["한 명"],
      dependencyIds: [],
    });
    const results = await Promise.allSettled(
      ["delivery-coordination", "assurance"].map((agentHandle) =>
        service.assignTask(context, {
          commandId: crypto.randomUUID(),
          workId: work.work_id,
          expectedRevision: task.work.revision,
          taskId: task.task.task_id,
          agentHandle,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (await service.listAssignments(context, work.work_id)).filter((assignment) => assignment.status === "assigned"),
    ).toHaveLength(1);
  });

  it("실행 중 Task 실패는 같은 transaction에서 Work도 failed로 전이한다", async () => {
    const running = await runningTask("terminal delivery failure");

    const failed = await service.transitionTask(context, {
      commandId: "delivery-terminal-failure-command-0001",
      workId: running.work.work_id,
      expectedRevision: running.work.revision,
      taskId: running.task.task_id,
      expectedTaskRevision: running.task.revision,
      target: "failed",
    });

    expect(failed).toMatchObject({ work: { status: "failed" }, task: { status: "failed" } });
    await expect(service.getWork(context, running.work.work_id)).resolves.toMatchObject({ status: "failed" });
    await expect(service.listTasks(context, running.work.work_id)).resolves.toEqual([
      expect.objectContaining({ task_id: running.task.task_id, status: "failed" }),
    ]);
  });

  it("Delivery 조정이 Task 실행 전 실패해도 ready→running→failed를 같은 transaction에서 수렴시킨다", async () => {
    const ready = await readyTask("coordination failure");

    const failed = await service.transitionTask(context, {
      commandId: "delivery-coordination-failure-command-0001",
      workId: ready.work.work_id,
      expectedRevision: ready.work.revision,
      taskId: ready.task.task_id,
      expectedTaskRevision: ready.task.revision,
      target: "failed",
    });

    expect(failed).toMatchObject({
      work: { status: "failed" },
      task: { status: "failed", revision: ready.task.revision + 2 },
    });
    const failureEvents = (await service.listEvents(context, ready.work.work_id)).filter((event) =>
      event.command_id.startsWith("delivery-coordination-failure-command-0001"),
    );
    expect(failureEvents.map((event) => event.command_id)).toEqual([
      "delivery-coordination-failure-command-0001:started",
      "delivery-coordination-failure-command-0001",
    ]);
    expect(failureEvents[1]?.sequence).toBe((failureEvents[0]?.sequence ?? 0) + 1);
    expect(JSON.parse(failureEvents[0]?.payload_json ?? "null")).toMatchObject({
      from: "ready",
      to: "running",
      reason: "delivery-failure-convergence",
    });
    expect(JSON.parse(failureEvents[1]?.request_json ?? "null")).toMatchObject({ target: "failed" });
  });

  it("ready→running→failed 수렴이 Work revision과 Event 수의 일치를 깨지 않는다", async () => {
    const ready = await readyTask("convergence revision");

    const failed = await service.transitionTask(context, {
      commandId: "delivery-convergence-revision-command-0001",
      workId: ready.work.work_id,
      expectedRevision: ready.work.revision,
      taskId: ready.task.task_id,
      expectedTaskRevision: ready.task.revision,
      target: "failed",
    });

    // 이 전이만 WorkEvent를 2건 만든다. revision이 1만 오르면 auditWork의 불변량이 깨지고,
    // recoverWork가 fail-closed라 이후 Records·Assurance 단계가 통째로 멈춘다.
    const events = await service.listEvents(context, ready.work.work_id);
    expect(failed.work.revision).toBe(ready.work.revision + 2);
    expect(failed.work.revision).toBe(events.length);
    await expect(service.auditWork(context, ready.work.work_id)).resolves.not.toContainEqual(
      expect.objectContaining({ code: "revision" }),
    );
  });

  it("상위 Application run 실패가 중단되면 같은 transaction의 Task·Work 실패도 모두 rollback한다", async () => {
    const ready = await readyTask("application failure rollback");
    const commandId = "delivery-application-failure-rollback-command-0001";

    await expect(
      database.transaction(async (transaction) => {
        await service.transitionTask(
          context,
          {
            commandId,
            workId: ready.work.work_id,
            expectedRevision: ready.work.revision,
            taskId: ready.task.task_id,
            expectedTaskRevision: ready.task.revision,
            target: "failed",
          },
          transaction,
        );
        throw new Error("Application run failure write failed");
      }),
    ).rejects.toThrow("Application run failure write failed");

    await expect(service.getWork(context, ready.work.work_id)).resolves.toMatchObject({ status: "running" });
    await expect(service.listTasks(context, ready.work.work_id)).resolves.toEqual([
      expect.objectContaining({ task_id: ready.task.task_id, status: "ready", revision: ready.task.revision }),
    ]);
    expect(
      (await service.listEvents(context, ready.work.work_id)).filter((event) => event.command_id.startsWith(commandId)),
    ).toHaveLength(0);
  });

  it("Work를 함께 실패시킬 수 없으면 Task 실패도 남기지 않는다", async () => {
    const running = await runningTask("atomic delivery failure");
    const awaiting = await service.transition(context, {
      commandId: "delivery-terminal-failure-awaiting-command-0001",
      workId: running.work.work_id,
      expectedRevision: running.work.revision,
      target: "waiting_approval",
    });

    await expect(
      service.transitionTask(context, {
        commandId: "delivery-terminal-failure-rejected-command-0001",
        workId: running.work.work_id,
        expectedRevision: awaiting.work.revision,
        taskId: running.task.task_id,
        expectedTaskRevision: running.task.revision,
        target: "failed",
      }),
    ).rejects.toThrow("Work 상태");
    await expect(service.getWork(context, running.work.work_id)).resolves.toMatchObject({ status: "waiting_approval" });
    await expect(service.listTasks(context, running.work.work_id)).resolves.toEqual([
      expect.objectContaining({ task_id: running.task.task_id, status: "running" }),
    ]);
  });

  it("재배정 계보를 보존하고 Agent Session과 checkpoint를 Work별로 격리한다", async () => {
    const work = await plannedWork();
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "실행",
      objective: "실행",
      acceptanceCriteria: ["완료"],
      dependencyIds: [],
    });
    const first = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const reassigned = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: first.work.revision,
      taskId: task.task.task_id,
      agentHandle: "assurance",
    });

    expect(reassigned.assignment.supersedes_assignment_id).toBe(first.assignment.assignment_id);
    expect((await service.listAssignments(context, work.work_id)).map((assignment) => assignment.status)).toEqual([
      "released",
      "assigned",
    ]);
    const session = await service.openSession(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: reassigned.work.revision,
      agentHandle: "assurance",
    });
    const checkpoint = await service.saveCheckpoint(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: session.work.revision,
      sessionId: session.session.session_id,
      expectedSessionRevision: 1,
      data: { cursor: 10 },
    });

    expect(checkpoint.checkpoint.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.session.revision).toBe(2);
    const otherWork = await plannedWork("other session");
    const otherTask = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: otherWork.work_id,
      expectedRevision: otherWork.revision,
      title: "다른 실행",
      objective: "다른 실행",
      acceptanceCriteria: ["완료"],
      dependencyIds: [],
    });
    const otherAssignment = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: otherWork.work_id,
      expectedRevision: otherTask.work.revision,
      taskId: otherTask.task.task_id,
      agentHandle: "assurance",
    });
    const otherSession = await service.openSession(context, {
      commandId: crypto.randomUUID(),
      workId: otherWork.work_id,
      expectedRevision: otherAssignment.work.revision,
      agentHandle: "assurance",
    });
    expect(otherSession.session.session_id).not.toBe(session.session.session_id);
    expect(otherSession.session.work_id).toBe(otherWork.work_id);
  });
});
