import { StaffingAdvisor, type StrategyPlan } from "@massion/context-strategy";
import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { CORE_OFFICE_HANDLES, OrganizationGraphService, type OrganizationProfileNode } from "@massion/organization";
import { type AgentExecutionInput, RuntimeExecutionStore } from "@massion/runtime";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { WORK_ASSURANCE_LINK_MIGRATION, WorkService } from "@massion/work";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CoreDeliveryStage } from "./core-delivery-stage.js";
import { DynamicStaffingCoordinator } from "./core-staffing.js";

function canonicalTestJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalTestJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function dynamicStaffHandle(
  organizationId: string,
  workId: string,
  strategyGenerationId: string,
  taskKey: string,
): string {
  return `staff-${createHash("sha256")
    .update(canonicalTestJson({ organizationId, workId, strategyGenerationId, taskKey }))
    .digest("hex")}`;
}

function dynamicStaffingIntentHash(proposal: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(
      canonicalTestJson({
        proposalId: proposal.proposal_id,
        organizationId: proposal.organization_id,
        createdByUserId: proposal.created_by_user_id,
        commandId: proposal.command_id,
        requestHash: proposal.request_hash,
        workId: proposal.work_id,
        planVersionId: proposal.plan_version_id,
        contextVersionId: proposal.context_version_id,
        strategyGenerationId: proposal.strategy_generation_id,
        assessmentId: proposal.assessment_id,
        graphCommandJson: proposal.graph_command_json,
        expectedOrganizationVersion: proposal.expected_organization_version,
        expectedWorkRevision: proposal.expected_work_revision,
        nodesJson: proposal.nodes_json,
        assignmentsJson: proposal.assignments_json,
        coreOfficeRoomId: proposal.core_office_room_id,
        uxMetadataJson: proposal.ux_metadata_json,
      }),
    )
    .digest("hex");
}

function strategyPlan(
  taskKey: string,
  requiredCapabilities: readonly string[],
  recommendedAgentHandles: readonly string[] = [],
): StrategyPlan {
  return {
    objective: "전문 Task를 완료한다",
    summary: "필요한 전문 역량으로 실행한다",
    scopeIn: ["구현"],
    scopeOut: [],
    assumptions: [],
    unknowns: [],
    acceptanceCriteria: [
      {
        key: "done",
        statement: "Task 산출물이 생성된다",
        method: "evidence",
        evidenceKinds: ["artifact-version"],
        planLevel: false,
      },
    ],
    risks: [],
    tasks: [
      {
        key: taskKey,
        title: "전문 분석",
        objective: "전문 역량으로 분석한다",
        criterionKeys: ["done"],
        dependencyKeys: [],
        requiredCapabilities: [...requiredCapabilities],
        recommendedAgentHandles: [...recommendedAgentHandles],
        parallelizable: false,
      },
    ],
    evidenceRequests: [],
  };
}

async function plannedFixture(
  database: MassionDatabase,
  suffix: string,
  plan: StrategyPlan,
  options: {
    readonly nodes?: readonly Omit<OrganizationProfileNode, "scope" | "role">[];
    readonly withRoom?: boolean;
  } = {},
) {
  const identities = await IdentityService.create(database);
  const organizations = await OrganizationService.create(database);
  const owner = await identities.registerPersonalUser({
    email: `dynamic-staffing-${suffix}@example.com`,
    displayName: `Dynamic Staffing ${suffix}`,
  });
  const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  const graph = await OrganizationGraphService.create(database, organizations);
  await graph.bootstrap(context);
  if (options.nodes && options.nodes.length > 0) {
    await graph.execute(context, {
      commandId: `dynamic-staffing-${suffix}-nodes`,
      expectedVersion: 1,
      kind: "install-profile",
      profileId: `dynamic-staffing-${suffix}`,
      profileVersion: "1",
      nodes: options.nodes.map((node) => ({ ...node, scope: "persistent" as const, role: "operator" as const })),
    });
  }
  const organization = await graph.getCurrentSnapshot(context);
  const works = await WorkService.create(database, organizations, graph);
  const created = await works.createWork(context, {
    commandId: `dynamic-staffing-${suffix}-work`,
    text: `${suffix} Work를 수행해주세요`,
    surface: "test",
    organizationVersionId: organization.version.version_id,
  });
  const opened =
    options.withRoom === false
      ? undefined
      : await works.openRoom(context, {
          commandId: `dynamic-staffing-${suffix}-room`,
          workId: created.work.work_id,
          expectedRevision: created.work.revision,
          title: "Core Office",
          coordinatorHandle: "representative",
          participants: CORE_OFFICE_HANDLES.map((handle) => ({
            kind: "agent" as const,
            subjectId: handle,
            role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
          })),
          limits: { maxParallel: 8, maxTokens: 100_000, maxCostMicros: 1_000_000, maxRounds: 100 },
        });
  const projected = await works.applyStrategyProjection(context, {
    commandId: `dynamic-staffing-${suffix}-plan`,
    workId: created.work.work_id,
    expectedRevision: opened?.work.revision ?? created.work.revision,
    contextVersionId: `context-${suffix}`,
    strategyGenerationId: `strategy-${suffix}`,
    strategyChecksum: "c".repeat(64),
    plan,
  });
  const advisor = await StaffingAdvisor.create(database, organizations, graph);
  const staffing = await DynamicStaffingCoordinator.create(database, { advisor, graph, organizations, works });
  return {
    organizations,
    context,
    graph,
    works,
    work: projected.work,
    tasks: projected.tasks,
    room: opened?.room,
    advisor,
    staffing,
  };
}

describe("DynamicStaffingCoordinator", () => {
  it("역량 공백을 Work Agent로 채우고 CoreDelivery가 그 Agent로 실행·산출한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "dynamic-staffing@example.com",
      displayName: "Dynamic Staffing",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const bootstrap = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "dynamic-staffing-work-create-0001",
      text: "계량 분석을 수행해주세요",
      surface: "test",
      organizationVersionId: bootstrap.version.version_id,
    });
    const room = await works.openRoom(context, {
      commandId: "dynamic-staffing-room-open-0001",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: CORE_OFFICE_HANDLES.map((handle) => ({
        kind: "agent" as const,
        subjectId: handle,
        role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
      })),
      limits: { maxParallel: 8, maxTokens: 100_000, maxCostMicros: 1_000_000, maxRounds: 100 },
    });
    const basePlan = strategyPlan("quant-analysis", ["quant-analysis"]);
    const secret = "api_key=dynamic-staffing-secret-never-publish";
    const plan: StrategyPlan = {
      ...basePlan,
      tasks: basePlan.tasks.map((task) => ({
        ...task,
        title: `전문 분석 ${secret}\u0001\u007f`,
        objective: `전문 역량으로 분석한다 ${secret}\u0085`,
      })),
    };
    const projected = await works.applyStrategyProjection(context, {
      commandId: "dynamic-staffing-plan-0001",
      workId: created.work.work_id,
      expectedRevision: room.work.revision,
      contextVersionId: "context-dynamic-staffing-0001",
      strategyGenerationId: "strategy-dynamic-staffing-0001",
      strategyChecksum: "a".repeat(64),
      plan,
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const staffing = await DynamicStaffingCoordinator.create(database, { advisor, graph, organizations, works });

    const runtimeAgentHandles: string[] = [];
    const runtimeExecutions = await RuntimeExecutionStore.create(database, organizations);
    await applyMigrations(database, [WORK_ASSURANCE_LINK_MIGRATION]);
    const delivery = new CoreDeliveryStage({
      works,
      staffing,
      runner: {
        execute: async (_tenant: typeof context, input: AgentExecutionInput) => {
          runtimeAgentHandles.push(input.agentHandle);
          const queued = await runtimeExecutions.createExecution(context, input);
          const running = await runtimeExecutions.transition(context, {
            commandId: `${input.commandId}:running`,
            executionId: queued.execution.execution_id,
            expectedVersion: queued.execution.version,
            target: "running",
            payload: {},
          });
          const succeeded = await runtimeExecutions.transition(context, {
            commandId: `${input.commandId}:succeeded`,
            executionId: queued.execution.execution_id,
            expectedVersion: running.execution.version,
            target: "succeeded",
            payload: { output: { result: "done" } },
          });
          return {
            executionId: succeeded.execution.execution_id,
            status: "succeeded" as const,
            output: { result: "done" },
          };
        },
        recover: async () => {
          throw new Error("복구 대상이 아닙니다");
        },
        cancel: async () => undefined,
      },
      runtimeExecutions,
    });

    await expect(
      delivery.execute(context, {
        runId: "dynamic-staffing-run-0001",
        workId: created.work.work_id,
        commandId: "dynamic-staffing-run-0001:delivery",
        correlationId: "dynamic-staffing-correlation-0001",
        request: {},
      }),
    ).resolves.toMatchObject({ outcome: "advanced", data: { artifactVersionIds: [expect.any(String)] } });

    const [[proposal]] = await database.query<
      [
        {
          status: string;
          expected_organization_version: number;
          expected_work_revision: number;
          applied_organization_version?: number;
          nodes_json: string;
          assessment_id: string;
          graph_command_json: string;
          impact_json?: string;
          ux_metadata_json: string;
          revision: number;
        }[],
      ]
    >(
      "SELECT * OMIT id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: "dynamic-staffing-run-0001:delivery:staffing" },
    );
    expect(proposal).toMatchObject({
      status: "applied",
      expected_organization_version: 1,
      expected_work_revision: projected.work.revision,
      applied_organization_version: 2,
      assessment_id: expect.any(String),
      revision: expect.any(Number),
    });
    expect(proposal).not.toHaveProperty("assessment_json");
    expect(JSON.parse(proposal?.graph_command_json ?? "null")).toMatchObject({
      kind: "install-profile",
      expectedVersion: 1,
    });
    expect(JSON.parse(proposal?.impact_json ?? "null")).toMatchObject({ nodeHandles: [expect.any(String)] });
    expect(JSON.parse(proposal?.ux_metadata_json ?? "null")).toMatchObject({
      kind: "dynamic-staffing-proposal",
      taskCount: 1,
      proposedAgentCount: 1,
    });
    const [proposedNode] = JSON.parse(proposal?.nodes_json ?? "[]") as Array<{
      taskKey: string;
      agentHandle: string;
    }>;
    expect(proposedNode).toMatchObject({ taskKey: "quant-analysis", agentHandle: expect.any(String) });
    expect(proposedNode?.agentHandle).toMatch(/^[a-z0-9][a-z0-9.-]{0,99}$/u);
    const installedNode = (await graph.listNodes(context)).find((node) => node.handle === proposedNode?.agentHandle);
    expect(installedNode).toMatchObject({
      status: "active",
      scope: "work",
      builtin: false,
      work_id: created.work.work_id,
      parent_handle: "delivery-coordination",
      role: "operator",
      capabilities: ["quant-analysis"],
    });
    expect(installedNode?.name.length).toBeLessThanOrEqual(100);
    expect(installedNode?.responsibility.length).toBeLessThanOrEqual(500);
    expect(installedNode?.outputs.every((output) => output.length <= 200)).toBe(true);
    expect(JSON.stringify(installedNode)).not.toContain(secret);
    expect(runtimeAgentHandles).toEqual([proposedNode?.agentHandle]);
    const delivered = await works.recoverWork(context, created.work.work_id);
    expect(delivered.work.status).toBe("verifying");
    expect(delivered.assignments).toEqual([
      expect.objectContaining({
        task_id: projected.tasks[0]?.task_id,
        agent_handle: proposedNode?.agentHandle,
        status: "assigned",
      }),
    ]);
    const [participants] = await database.query<
      [{ readonly room_id: string; readonly subject_id: string; readonly status: string }[]]
    >(
      "SELECT room_id, subject_id, status FROM collaboration_participant WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          room_id: room.room.room_id,
          subject_id: proposedNode?.agentHandle,
          status: "active",
        }),
      ]),
    );
    expect(delivered.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          room_id: room.room.room_id,
          message_type: "proposal",
          author_id: "context-strategy",
        }),
      ]),
    );
    const proposalMessage = delivered.messages.find((message) => message.message_type === "proposal")?.content ?? "";
    expect(proposalMessage).not.toContain(secret);
    expect(
      Array.from(proposalMessage).some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f));
      }),
    ).toBe(false);
    expect(proposalMessage.length).toBeLessThanOrEqual(4_000);
    expect(delivered.artifactVersions).toEqual([
      expect.objectContaining({ creator_agent_handle: proposedNode?.agentHandle }),
    ]);
  });

  it("승인 전 Work를 건드리지 않고 재시도 command도 원래 approval proposal을 원자 재개한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "dynamic-staffing-approval@example.com",
      displayName: "Dynamic Staffing Approval",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const approver = await identities.registerPersonalUser({
      email: "dynamic-staffing-approver@example.com",
      displayName: "Dynamic Staffing Approver",
    });
    await organizations.addMember(context, approver.user.user_id, "admin");
    const approverContext = await organizations.resolveTenantContext(
      approver.user.user_id,
      owner.organization.organization_id,
    );
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const defaults = createDefaultPolicy("personal");
    const policy = await policies.createDraft(context, {
      commandId: "dynamic-staffing-approval-policy-draft-0001",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, {
      commandId: "dynamic-staffing-approval-policy-activate-0001",
      policyVersionId: policy.policy_version_id,
    });
    const graph = await OrganizationGraphService.create(
      database,
      organizations,
      new GovernanceGate(governance, approvals, permits, emergency),
    );
    const bootstrap = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "dynamic-staffing-approval-work-0001",
      text: "승인 후 전문 Agent를 구성해주세요",
      surface: "test",
      organizationVersionId: bootstrap.version.version_id,
    });
    const opened = await works.openRoom(context, {
      commandId: "dynamic-staffing-approval-room-0001",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: CORE_OFFICE_HANDLES.map((handle) => ({
        kind: "agent" as const,
        subjectId: handle,
        role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
      })),
      limits: { maxParallel: 8, maxTokens: 100_000, maxCostMicros: 1_000_000, maxRounds: 100 },
    });
    await works.applyStrategyProjection(context, {
      commandId: "dynamic-staffing-approval-plan-0001",
      workId: created.work.work_id,
      expectedRevision: opened.work.revision,
      contextVersionId: "context-dynamic-staffing-approval-0001",
      strategyGenerationId: "strategy-dynamic-staffing-approval-0001",
      strategyChecksum: "b".repeat(64),
      plan: strategyPlan("governed-analysis", ["governed-analysis"]),
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const staffing = await DynamicStaffingCoordinator.create(database, { advisor, graph, organizations, works });
    const command = {
      commandId: "dynamic-staffing-approval-prepare-0001",
      workId: created.work.work_id,
    };
    const before = await works.getWork(context, created.work.work_id);

    const waiting = await staffing.prepare(context, command);

    expect(waiting).toMatchObject({
      outcome: "awaiting-approval",
      approvalId: expect.any(String),
      proposalId: expect.any(String),
    });
    if (waiting.outcome !== "awaiting-approval") throw new Error("Dynamic Staffing approval이 필요하지 않습니다");
    expect(await works.getWork(context, created.work.work_id)).toEqual(before);
    expect(await works.listAssignments(context, created.work.work_id)).toEqual([]);
    expect((await works.recoverWork(context, created.work.work_id)).messages).toEqual([]);
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);
    const [[storedWaiting]] = await database.query<
      [{ readonly status: string; readonly approval_id?: string; readonly graph_command_json: string }[]]
    >(
      "SELECT status, approval_id, graph_command_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: command.commandId },
    );
    expect(storedWaiting).toMatchObject({ status: "awaiting-approval", approval_id: waiting.approvalId });
    const originalGraphCommand = storedWaiting?.graph_command_json;

    await expect(
      staffing.prepare(approverContext, {
        commandId: "dynamic-staffing-approval-unknown-retry-0001",
        workId: command.workId,
        approvalId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    const [afterUnknownApproval] = await database.query<[{ readonly command_id: string }[]]>(
      "SELECT command_id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(afterUnknownApproval).toEqual([{ command_id: command.commandId }]);
    expect(await works.getWork(context, created.work.work_id)).toEqual(before);
    expect(await works.listAssignments(context, created.work.work_id)).toEqual([]);
    expect((await works.recoverWork(context, created.work.work_id)).messages).toEqual([]);
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);

    const unresolvedActor = await DynamicStaffingCoordinator.create(database, {
      advisor,
      graph,
      organizations: {
        resolveTenantContext: async () => {
          throw new Error("원 요청자의 활성 Membership이 없습니다");
        },
      },
      works,
    });
    await expect(
      unresolvedActor.prepare(approverContext, { ...command, approvalId: waiting.approvalId }),
    ).rejects.toThrow("원 요청자의 활성 Membership이 없습니다");
    await expect(staffing.prepare(approverContext, { ...command, approvalId: waiting.approvalId })).rejects.toThrow();
    expect(await works.getWork(context, created.work.work_id)).toEqual(before);
    expect(await works.listAssignments(context, created.work.work_id)).toEqual([]);
    expect((await works.recoverWork(context, created.work.work_id)).messages).toEqual([]);
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);

    const rejectedCreated = await works.createWork(context, {
      commandId: "dynamic-staffing-rejected-work-0001",
      text: "거절된 동적 Staffing은 적용하지 마세요",
      surface: "test",
      organizationVersionId: bootstrap.version.version_id,
    });
    const rejectedRoom = await works.openRoom(context, {
      commandId: "dynamic-staffing-rejected-room-0001",
      workId: rejectedCreated.work.work_id,
      expectedRevision: rejectedCreated.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: CORE_OFFICE_HANDLES.map((handle) => ({
        kind: "agent" as const,
        subjectId: handle,
        role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
      })),
      limits: { maxParallel: 8, maxTokens: 100_000, maxCostMicros: 1_000_000, maxRounds: 100 },
    });
    await works.applyStrategyProjection(context, {
      commandId: "dynamic-staffing-rejected-plan-0001",
      workId: rejectedCreated.work.work_id,
      expectedRevision: rejectedRoom.work.revision,
      contextVersionId: "context-dynamic-staffing-rejected-0001",
      strategyGenerationId: "strategy-dynamic-staffing-rejected-0001",
      strategyChecksum: "d".repeat(64),
      plan: strategyPlan("rejected-analysis", ["rejected-analysis"]),
    });
    const rejectedWaiting = await staffing.prepare(context, {
      commandId: "dynamic-staffing-rejected-prepare-0001",
      workId: rejectedCreated.work.work_id,
    });
    if (rejectedWaiting.outcome !== "awaiting-approval") {
      throw new Error("거절 검증용 Dynamic Staffing approval이 필요하지 않습니다");
    }
    await approvals.vote(approverContext, {
      commandId: "dynamic-staffing-rejected-vote-0001",
      approvalId: rejectedWaiting.approvalId,
      vote: "reject",
      reason: "이 동적 Staffing 제안은 적용하지 않습니다",
    });
    await expect(
      staffing.prepare(approverContext, {
        commandId: "dynamic-staffing-rejected-retry-0001",
        workId: rejectedCreated.work.work_id,
        approvalId: rejectedWaiting.approvalId,
      }),
    ).rejects.toThrow();
    const [[rejectedProposal]] = await database.query<[{ readonly status: string }[]]>(
      "SELECT status FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND proposal_id = $proposal_id;",
      { organization_id: context.organizationId, proposal_id: rejectedWaiting.proposalId },
    );
    expect(rejectedProposal?.status).toBe("awaiting-approval");
    expect(await works.listAssignments(context, rejectedCreated.work.work_id)).toEqual([]);
    expect((await works.recoverWork(context, rejectedCreated.work.work_id)).messages).toEqual([]);
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);

    await approvals.vote(approverContext, {
      commandId: "dynamic-staffing-approval-vote-0001",
      approvalId: waiting.approvalId,
      vote: "approve",
      reason: "동적 Staffing 제안을 검토했습니다",
    });
    const [resumed, concurrentReplay] = await Promise.all([
      staffing.prepare(approverContext, {
        commandId: "dynamic-staffing-approval-retry-0001",
        workId: command.workId,
        approvalId: waiting.approvalId,
      }),
      staffing.prepare(approverContext, {
        commandId: "dynamic-staffing-approval-retry-0002",
        workId: command.workId,
        approvalId: waiting.approvalId,
      }),
    ]);

    expect(resumed).toMatchObject({ outcome: "ready", proposalId: waiting.proposalId });
    expect(concurrentReplay).toEqual(resumed);
    const [[storedApplied]] = await database.query<
      [{ readonly status: string; readonly graph_command_json: string }[]]
    >(
      "SELECT status, graph_command_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: command.commandId },
    );
    expect(storedApplied).toEqual({ status: "applied", graph_command_json: originalGraphCommand });
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(2);
    expect(await works.listAssignments(context, created.work.work_id)).toHaveLength(1);
    expect((await works.recoverWork(context, created.work.work_id)).messages).toEqual([
      expect.objectContaining({ message_type: "proposal", author_id: "context-strategy" }),
    ]);
    const [afterRetry] = await database.query<[{ readonly command_id: string }[]]>(
      "SELECT command_id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(afterRetry).toEqual([{ command_id: command.commandId }]);
    await expect(staffing.prepare(approverContext, { ...command, approvalId: waiting.approvalId })).resolves.toEqual(
      resumed,
    );
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(2);
    expect(await works.listAssignments(context, created.work.work_id)).toHaveLength(1);
    expect((await works.recoverWork(context, created.work.work_id)).messages).toHaveLength(1);
  });

  it("적격 기존 추천 중 handle 순서의 첫 Agent를 정확한 task_key WorkTask에 배정한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "eligible",
      strategyPlan("eligible-task", ["quant-analysis"], ["eligible-z", "eligible-a"]),
      {
        nodes: [
          {
            handle: "eligible-z",
            name: "Eligible Z",
            responsibility: "계량 분석",
            outputs: ["Analysis"],
            capabilities: ["quant-analysis"],
            parentHandle: "delivery-coordination",
          },
          {
            handle: "eligible-a",
            name: "Eligible A",
            responsibility: "계량 분석",
            outputs: ["Analysis"],
            capabilities: ["quant-analysis"],
            parentHandle: "delivery-coordination",
          },
        ],
      },
    );

    await expect(
      fixture.staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-eligible-prepare",
        workId: fixture.work.work_id,
      }),
    ).resolves.toEqual({ outcome: "ready" });

    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([
      expect.objectContaining({ task_id: fixture.tasks[0]?.task_id, agent_handle: "eligible-a", status: "assigned" }),
    ]);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(2);
    const [[proposalCount]] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() AS count FROM dynamic_staffing_proposal WHERE organization_id = $organization_id GROUP ALL;",
      { organization_id: fixture.context.organizationId },
    );
    expect(proposalCount?.count ?? 0).toBe(0);
  });

  it("같은 Task의 유효·무효 추천이 섞여도 유효 추천을 우선하고 추천 없는 Task만 Work Agent를 만든다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const base = strategyPlan("mixed-valid", ["mixed-capability"], ["mixed-valid-agent", "mixed-missing-agent"]);
    const plan: StrategyPlan = {
      ...base,
      tasks: [
        ...(base.tasks ?? []),
        {
          key: "mixed-gap",
          title: "공백 Task",
          objective: "새 Work Agent로 실행한다",
          criterionKeys: ["done"],
          dependencyKeys: [],
          requiredCapabilities: ["gap-capability"],
          recommendedAgentHandles: ["gap-missing-agent"],
          parallelizable: false,
        },
        {
          key: "mixed-empty",
          title: "무역량 추천 Task",
          objective: "유효 추천으로 실행한다",
          criterionKeys: ["done"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["empty-valid-agent"],
          parallelizable: false,
        },
      ],
    };
    const fixture = await plannedFixture(database, "mixed-truth-table", plan, {
      nodes: [
        {
          handle: "mixed-valid-agent",
          name: "Mixed Valid Agent",
          responsibility: "혼합 추천 Task",
          outputs: ["Result"],
          capabilities: ["mixed-capability"],
          parentHandle: "delivery-coordination",
        },
        {
          handle: "empty-valid-agent",
          name: "Empty Valid Agent",
          responsibility: "무역량 Task",
          outputs: ["Result"],
          capabilities: ["general-delivery"],
          parentHandle: "delivery-coordination",
        },
      ],
    });

    await expect(
      fixture.staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-mixed-truth-table-prepare",
        workId: fixture.work.work_id,
      }),
    ).resolves.toMatchObject({ outcome: "ready", proposalId: expect.any(String) });

    const [[proposal]] = await database.query<[{ readonly nodes_json: string; readonly assignments_json: string }[]]>(
      "SELECT nodes_json, assignments_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      {
        organization_id: fixture.context.organizationId,
        command_id: "dynamic-staffing-mixed-truth-table-prepare",
      },
    );
    expect(JSON.parse(proposal?.nodes_json ?? "[]")).toEqual([
      expect.objectContaining({ taskKey: "mixed-gap", agentHandle: expect.any(String) }),
    ]);
    expect(JSON.parse(proposal?.assignments_json ?? "[]")).toEqual([
      {
        taskKey: "mixed-valid",
        taskId: fixture.tasks.find((task) => task.task_key === "mixed-valid")?.task_id,
        agentHandle: "mixed-valid-agent",
        source: "recommendation",
      },
      {
        taskKey: "mixed-gap",
        taskId: fixture.tasks.find((task) => task.task_key === "mixed-gap")?.task_id,
        agentHandle: expect.any(String),
        source: "proposal",
      },
      {
        taskKey: "mixed-empty",
        taskId: fixture.tasks.find((task) => task.task_key === "mixed-empty")?.task_id,
        agentHandle: "empty-valid-agent",
        source: "recommendation",
      },
    ]);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent_handle: "mixed-valid-agent" }),
        expect.objectContaining({ agent_handle: "empty-valid-agent" }),
      ]),
    );
  });

  it("assessment 뒤 현재 조직 그래프에서 비활성화된 추천은 공백으로 바꾸고 Work Agent를 제안한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "stale-recommendation",
      strategyPlan("stale-recommendation-task", ["stale-capability"], ["stale-agent"]),
      {
        nodes: [
          {
            handle: "stale-agent",
            name: "Stale Agent",
            responsibility: "곧 비활성화되는 추천",
            outputs: ["Result"],
            capabilities: ["stale-capability"],
            parentHandle: "delivery-coordination",
          },
        ],
      },
    );
    const graph = {
      getCurrentSnapshot: async (...args: Parameters<OrganizationGraphService["getCurrentSnapshot"]>) => {
        const snapshot = await fixture.graph.getCurrentSnapshot(...args);
        return {
          ...snapshot,
          nodes: snapshot.nodes.map((node) =>
            node.handle === "stale-agent" ? { ...node, status: "inactive" as const } : node,
          ),
        };
      },
      execute: fixture.graph.execute.bind(fixture.graph),
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor: fixture.advisor,
      graph,
      organizations: fixture.organizations,
      works: fixture.works,
    });

    await expect(
      staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-stale-recommendation-prepare",
        workId: fixture.work.work_id,
      }),
    ).resolves.toMatchObject({ outcome: "ready", proposalId: expect.any(String) });

    const assignments = await fixture.works.listAssignments(fixture.context, fixture.work.work_id);
    expect(assignments).toEqual([
      expect.objectContaining({
        task_id: fixture.tasks[0]?.task_id,
        agent_handle: expect.not.stringMatching(/^stale-agent$/u),
      }),
    ]);
    const [[proposal]] = await database.query<[{ readonly nodes_json: string }[]]>(
      "SELECT nodes_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      {
        organization_id: fixture.context.organizationId,
        command_id: "dynamic-staffing-stale-recommendation-prepare",
      },
    );
    expect(JSON.parse(proposal?.nodes_json ?? "[]")).toEqual([
      expect.objectContaining({ taskKey: "stale-recommendation-task" }),
    ]);
  });

  it.each(["graph-command", "nodes", "assignments", "expected-work-revision", "malformed"] as const)(
    "저장 proposal의 %s 변조는 graph 전에 닫힌 실패로 차단한다",
    async (tamper) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const fixture = await plannedFixture(
        database,
        `tamper-${tamper}`,
        strategyPlan(`tamper-${tamper}-task`, [`tamper-${tamper}-capability`]),
      );
      let paused = true;
      let executeCalls = 0;
      const graph = {
        getCurrentSnapshot: fixture.graph.getCurrentSnapshot.bind(fixture.graph),
        execute: async (...args: Parameters<OrganizationGraphService["execute"]>) => {
          executeCalls += 1;
          if (paused) throw new Error("proposal-persisted-before-graph");
          return await fixture.graph.execute(...args);
        },
      };
      const staffing = await DynamicStaffingCoordinator.create(database, {
        advisor: fixture.advisor,
        graph,
        organizations: fixture.organizations,
        works: fixture.works,
      });
      const input = {
        commandId: `dynamic-staffing-tamper-${tamper}-prepare`,
        workId: fixture.work.work_id,
      };
      await expect(staffing.prepare(fixture.context, input)).rejects.toThrow("proposal-persisted-before-graph");
      const [[stored]] = await database.query<
        [
          {
            readonly graph_command_json: string;
            readonly nodes_json: string;
            readonly assignments_json: string;
            readonly expected_work_revision: number;
          }[],
        ]
      >(
        "SELECT graph_command_json, nodes_json, assignments_json, expected_work_revision FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
        { organization_id: fixture.context.organizationId, command_id: input.commandId },
      );
      if (!stored) throw new Error("변조할 Dynamic Staffing proposal이 없습니다");
      if (tamper === "graph-command") {
        const command = JSON.parse(stored.graph_command_json) as Record<string, unknown>;
        await database.query(
          "UPDATE dynamic_staffing_proposal SET graph_command_json = $value WHERE organization_id = $organization_id AND command_id = $command_id;",
          {
            value: JSON.stringify({ ...command, profileId: "forged-profile" }),
            organization_id: fixture.context.organizationId,
            command_id: input.commandId,
          },
        );
      } else if (tamper === "nodes") {
        const nodes = JSON.parse(stored.nodes_json) as Array<Record<string, unknown>>;
        await database.query(
          "UPDATE dynamic_staffing_proposal SET nodes_json = $value WHERE organization_id = $organization_id AND command_id = $command_id;",
          {
            value: JSON.stringify(nodes.map((candidate) => ({ ...candidate, taskId: "forged-task" }))),
            organization_id: fixture.context.organizationId,
            command_id: input.commandId,
          },
        );
      } else if (tamper === "assignments") {
        const assignments = JSON.parse(stored.assignments_json) as Array<Record<string, unknown>>;
        await database.query(
          "UPDATE dynamic_staffing_proposal SET assignments_json = $value WHERE organization_id = $organization_id AND command_id = $command_id;",
          {
            value: JSON.stringify(
              assignments.map((assignment) => ({
                ...assignment,
                agentHandle: "delivery-coordination",
                source: "recommendation",
              })),
            ),
            organization_id: fixture.context.organizationId,
            command_id: input.commandId,
          },
        );
      } else if (tamper === "expected-work-revision") {
        await database.query(
          "UPDATE dynamic_staffing_proposal SET expected_work_revision = $value WHERE organization_id = $organization_id AND command_id = $command_id;",
          {
            value: stored.expected_work_revision + 1,
            organization_id: fixture.context.organizationId,
            command_id: input.commandId,
          },
        );
      } else {
        await database.query(
          "UPDATE dynamic_staffing_proposal SET nodes_json = '{' WHERE organization_id = $organization_id AND command_id = $command_id;",
          { organization_id: fixture.context.organizationId, command_id: input.commandId },
        );
      }
      paused = false;
      executeCalls = 0;

      await expect(staffing.prepare(fixture.context, input)).rejects.toThrow(
        "Dynamic Staffing proposal 저장 payload가 유효하지 않습니다",
      );

      expect(executeCalls).toBe(0);
      expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
      expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(fixture.work);
      expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
      expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
    },
  );

  it("같은 Task를 nodes·assignments·graph command·UX에서 함께 삭제해도 원래 계획과 달라 거부한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const first = strategyPlan("immutable-first", ["immutable-first-capability"]);
    const plan: StrategyPlan = {
      ...first,
      tasks: [
        ...first.tasks,
        {
          key: "immutable-second",
          title: "두 번째 불변 Task",
          objective: "두 번째 불변 Task를 실행한다",
          criterionKeys: ["done"],
          dependencyKeys: [],
          requiredCapabilities: ["immutable-second-capability"],
          recommendedAgentHandles: [],
          parallelizable: false,
        },
      ],
    };
    const fixture = await plannedFixture(database, "immutable-plan", plan);
    let paused = true;
    let executeCalls = 0;
    const graph = {
      getCurrentSnapshot: fixture.graph.getCurrentSnapshot.bind(fixture.graph),
      execute: async (...args: Parameters<OrganizationGraphService["execute"]>) => {
        executeCalls += 1;
        if (paused) throw new Error("immutable-proposal-persisted");
        return await fixture.graph.execute(...args);
      },
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor: fixture.advisor,
      graph,
      organizations: fixture.organizations,
      works: fixture.works,
    });
    const input = {
      commandId: "dynamic-staffing-immutable-plan-prepare",
      workId: fixture.work.work_id,
    };
    await expect(staffing.prepare(fixture.context, input)).rejects.toThrow("immutable-proposal-persisted");
    const [[stored]] = await database.query<
      [
        (Record<string, unknown> & {
          readonly nodes_json: string;
          readonly assignments_json: string;
          readonly graph_command_json: string;
          readonly ux_metadata_json: string;
        })[],
      ]
    >(
      "SELECT * OMIT id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: fixture.context.organizationId, command_id: input.commandId },
    );
    if (!stored) throw new Error("불변성 검증용 proposal을 찾을 수 없습니다");
    const keepTask = "immutable-first";
    const nodes = (
      JSON.parse(stored.nodes_json) as Array<{ readonly taskKey: string; readonly agentHandle: string }>
    ).filter((candidate) => candidate.taskKey === keepTask);
    const assignments = (JSON.parse(stored.assignments_json) as Array<{ readonly taskKey: string }>).filter(
      (candidate) => candidate.taskKey === keepTask,
    );
    const graphCommand = JSON.parse(stored.graph_command_json) as Record<string, unknown> & {
      readonly nodes: readonly { readonly handle: string }[];
    };
    const keptHandles = new Set(nodes.map((candidate) => candidate.agentHandle));
    const ux = JSON.parse(stored.ux_metadata_json) as Record<string, unknown> & {
      readonly assignments: readonly { readonly taskKey: string }[];
    };
    const tamperedIntent = {
      ...stored,
      nodes_json: JSON.stringify(nodes),
      assignments_json: JSON.stringify(assignments),
      graph_command_json: JSON.stringify({
        ...graphCommand,
        nodes: graphCommand.nodes.filter((node) => keptHandles.has(node.handle)),
      }),
      ux_metadata_json: JSON.stringify({
        ...ux,
        taskCount: assignments.length,
        proposedAgentCount: nodes.length,
        assignments: ux.assignments.filter((assignment) => assignment.taskKey === keepTask),
      }),
    };
    await database.query(
      "UPDATE dynamic_staffing_proposal SET nodes_json = $nodes_json, assignments_json = $assignments_json, graph_command_json = $graph_command_json, ux_metadata_json = $ux_metadata_json, intent_hash = $intent_hash WHERE organization_id = $organization_id AND command_id = $command_id;",
      {
        nodes_json: tamperedIntent.nodes_json,
        assignments_json: tamperedIntent.assignments_json,
        graph_command_json: tamperedIntent.graph_command_json,
        ux_metadata_json: tamperedIntent.ux_metadata_json,
        intent_hash: dynamicStaffingIntentHash(tamperedIntent),
        organization_id: fixture.context.organizationId,
        command_id: input.commandId,
      },
    );
    paused = false;
    executeCalls = 0;

    await expect(staffing.prepare(fixture.context, input)).rejects.toThrow(
      "Dynamic Staffing proposal 저장 payload가 유효하지 않습니다",
    );

    expect(executeCalls).toBe(0);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
  });

  it("저장 proposal의 status만 applied로 뒤집어도 실제 checkpoint가 없어 ready로 재생하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "forged-applied",
      strategyPlan("forged-applied-task", ["forged-applied-capability"]),
    );
    let paused = true;
    let executeCalls = 0;
    const graph = {
      getCurrentSnapshot: fixture.graph.getCurrentSnapshot.bind(fixture.graph),
      execute: async (...args: Parameters<OrganizationGraphService["execute"]>) => {
        executeCalls += 1;
        if (paused) throw new Error("forged-applied-proposal-persisted");
        return await fixture.graph.execute(...args);
      },
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor: fixture.advisor,
      graph,
      organizations: fixture.organizations,
      works: fixture.works,
    });
    const input = {
      commandId: "dynamic-staffing-forged-applied-prepare",
      workId: fixture.work.work_id,
    };
    await expect(staffing.prepare(fixture.context, input)).rejects.toThrow("forged-applied-proposal-persisted");
    await database.query(
      "UPDATE dynamic_staffing_proposal SET status = 'applied' WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: fixture.context.organizationId, command_id: input.commandId },
    );
    paused = false;
    executeCalls = 0;

    await expect(staffing.prepare(fixture.context, input)).rejects.toThrow(
      "Dynamic Staffing proposal 저장 payload가 유효하지 않습니다",
    );

    expect(executeCalls).toBe(0);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
  });

  it.each(["organization-version", "message", "assignment", "participant"] as const)(
    "applied proposal의 실제 %s checkpoint가 달라지면 ready replay를 거부한다",
    async (checkpoint) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const fixture = await plannedFixture(
        database,
        `applied-checkpoint-${checkpoint}`,
        strategyPlan(`applied-checkpoint-${checkpoint}-task`, [`applied-checkpoint-${checkpoint}-capability`]),
      );
      const input = {
        commandId: `dynamic-staffing-applied-checkpoint-${checkpoint}-prepare`,
        workId: fixture.work.work_id,
      };
      await expect(fixture.staffing.prepare(fixture.context, input)).resolves.toMatchObject({
        outcome: "ready",
        proposalId: expect.any(String),
      });
      const [[proposal]] = await database.query<
        [
          {
            readonly applied_organization_version: number;
            readonly message_id: string;
            readonly assignments_json: string;
          }[],
        ]
      >(
        "SELECT applied_organization_version, message_id, assignments_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: fixture.context.organizationId, command_id: input.commandId },
      );
      if (!proposal) throw new Error("applied checkpoint 검증용 proposal이 없습니다");
      const [assignment] = JSON.parse(proposal.assignments_json) as Array<{
        readonly taskId: string;
        readonly agentHandle: string;
      }>;
      if (!assignment) throw new Error("applied checkpoint 검증용 assignment가 없습니다");
      if (checkpoint === "organization-version") {
        await database.query(
          "UPDATE dynamic_staffing_proposal SET applied_organization_version = $version WHERE organization_id = $organization_id AND command_id = $command_id;",
          {
            version: proposal.applied_organization_version + 1,
            organization_id: fixture.context.organizationId,
            command_id: input.commandId,
          },
        );
      } else if (checkpoint === "message") {
        await database.query(
          "UPDATE collaboration_message SET content = 'forged proposal message' WHERE organization_id = $organization_id AND message_id = $message_id;",
          { organization_id: fixture.context.organizationId, message_id: proposal.message_id },
        );
      } else if (checkpoint === "assignment") {
        await database.query(
          "UPDATE task_assignment SET status = 'released' WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id AND agent_handle = $agent_handle;",
          {
            organization_id: fixture.context.organizationId,
            work_id: fixture.work.work_id,
            task_id: assignment.taskId,
            agent_handle: assignment.agentHandle,
          },
        );
      } else {
        await database.query(
          "UPDATE collaboration_participant SET status = 'left' WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id AND kind = 'agent' AND subject_id = $subject_id;",
          {
            organization_id: fixture.context.organizationId,
            work_id: fixture.work.work_id,
            room_id: fixture.room?.room_id,
            subject_id: assignment.agentHandle,
          },
        );
      }
      const beforeVersion = (await fixture.graph.getCurrentSnapshot(fixture.context)).version.version;

      await expect(fixture.staffing.prepare(fixture.context, input)).rejects.toThrow(
        "Dynamic Staffing proposal 저장 payload가 유효하지 않습니다",
      );

      expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(beforeVersion);
      const [[proposalMessages]] = await database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'proposal' GROUP ALL;",
        { organization_id: fixture.context.organizationId, work_id: fixture.work.work_id },
      );
      expect(proposalMessages?.count ?? 0).toBe(1);
    },
  );

  it("취소된 Task는 Work Agent·proposal mapping·participant·assignment에서 모두 제외한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const first = strategyPlan("cancelled-staffing-task", ["cancelled-staffing-capability"]);
    const plan: StrategyPlan = {
      ...first,
      tasks: [
        ...first.tasks,
        {
          key: "active-staffing-task",
          title: "활성 Staffing Task",
          objective: "활성 Task만 실행한다",
          criterionKeys: ["done"],
          dependencyKeys: [],
          requiredCapabilities: ["active-staffing-capability"],
          recommendedAgentHandles: [],
          parallelizable: false,
        },
      ],
    };
    const fixture = await plannedFixture(database, "cancelled-task", plan);
    const cancelledTask = fixture.tasks.find((task) => task.task_key === "cancelled-staffing-task");
    if (!cancelledTask) throw new Error("취소할 Staffing Task가 없습니다");
    await fixture.works.transitionTask(fixture.context, {
      commandId: "dynamic-staffing-cancelled-task-transition",
      workId: fixture.work.work_id,
      expectedRevision: fixture.work.revision,
      taskId: cancelledTask.task_id,
      expectedTaskRevision: cancelledTask.revision,
      target: "cancelled",
    });

    await expect(
      fixture.staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-cancelled-task-prepare",
        workId: fixture.work.work_id,
      }),
    ).resolves.toMatchObject({ outcome: "ready", proposalId: expect.any(String) });

    const cancelledHandle = dynamicStaffHandle(
      fixture.context.organizationId,
      fixture.work.work_id,
      `strategy-cancelled-task`,
      "cancelled-staffing-task",
    );
    const [workNodes] = await database.query<[{ readonly handle: string; readonly capabilities: readonly string[] }[]]>(
      "SELECT handle, capabilities FROM organization_node WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: fixture.context.organizationId, work_id: fixture.work.work_id },
    );
    expect(workNodes).toEqual([expect.objectContaining({ capabilities: ["active-staffing-capability"] })]);
    expect(workNodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ handle: cancelledHandle })]));
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([
      expect.objectContaining({ task_id: expect.not.stringMatching(cancelledTask.task_id) }),
    ]);
    const recovered = await fixture.works.recoverWork(fixture.context, fixture.work.work_id);
    expect(recovered.messages).toEqual([
      expect.objectContaining({
        message_type: "proposal",
        content: expect.not.stringContaining("cancelled-staffing-task"),
      }),
    ]);
    const [cancelledParticipants] = await database.query<[{ readonly participant_id: string }[]]>(
      "SELECT participant_id FROM collaboration_participant WHERE organization_id = $organization_id AND work_id = $work_id AND subject_id = $subject_id;",
      {
        organization_id: fixture.context.organizationId,
        work_id: fixture.work.work_id,
        subject_id: cancelledHandle,
      },
    );
    expect(cancelledParticipants).toEqual([]);
  });

  it("이미 취소된 signal은 assessment와 모든 write 전에 중단한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(database, "aborted-entry", strategyPlan("aborted-entry-task", ["abort-cap"]));
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-aborted-entry-prepare",
        workId: fixture.work.work_id,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Application run cancelled");

    const [[[assessmentCount]], [[proposalCount]]] = await Promise.all([
      database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM staffing_assessment WHERE organization_id = $organization_id GROUP ALL;",
        { organization_id: fixture.context.organizationId },
      ),
      database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM dynamic_staffing_proposal WHERE organization_id = $organization_id GROUP ALL;",
        { organization_id: fixture.context.organizationId },
      ),
    ]);
    expect([assessmentCount?.count ?? 0, proposalCount?.count ?? 0]).toEqual([0, 0]);
    expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(fixture.work);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
  });

  it("graph 직후 취소되면 proposal만 prepared로 남기고 원자 적용 전체를 rollback한 뒤 재개한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "abort-after-graph",
      strategyPlan("abort-graph-task", ["abort-cap"]),
    );
    const controller = new AbortController();
    const graph = {
      getCurrentSnapshot: fixture.graph.getCurrentSnapshot.bind(fixture.graph),
      execute: async (...args: Parameters<OrganizationGraphService["execute"]>) => {
        const result = await fixture.graph.execute(...args);
        controller.abort();
        return result;
      },
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor: fixture.advisor,
      graph,
      organizations: fixture.organizations,
      works: fixture.works,
    });
    const input = {
      commandId: "dynamic-staffing-abort-after-graph-prepare",
      workId: fixture.work.work_id,
    };

    await expect(staffing.prepare(fixture.context, { ...input, signal: controller.signal })).rejects.toThrow(
      "Application run cancelled",
    );

    const [[checkpoint]] = await database.query<[{ readonly status: string }[]]>(
      "SELECT status FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: fixture.context.organizationId, command_id: input.commandId },
    );
    expect(checkpoint?.status).toBe("prepared");
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
    expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(fixture.work);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);

    await expect(staffing.prepare(fixture.context, input)).resolves.toMatchObject({ outcome: "ready" });
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toHaveLength(1);
  });

  it("assessment 도중 Work revision이 바뀌면 저장한 revision과 graph 전 검증이 어긋나므로 차단한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "stale-work-revision",
      strategyPlan("stale-work-task", ["stale-cap"]),
    );
    const advisor = {
      assess: async (...args: Parameters<StaffingAdvisor["assess"]>) => {
        const assessment = await fixture.advisor.assess(...args);
        await fixture.works.postMessage(fixture.context, {
          commandId: "dynamic-staffing-stale-work-external-message",
          workId: fixture.work.work_id,
          roomId: fixture.room?.room_id ?? "",
          messageType: "status",
          authorKind: "agent",
          authorId: "context-strategy",
          content: "외부 상태 변경",
          tokenCount: 1,
          costMicros: 0,
        });
        return assessment;
      },
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor,
      graph: fixture.graph,
      organizations: fixture.organizations,
      works: fixture.works,
    });

    await expect(
      staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-stale-work-revision-prepare",
        workId: fixture.work.work_id,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "staffing-work-revision-stale" });

    const [[proposal]] = await database.query<[{ readonly status: string; readonly expected_work_revision: number }[]]>(
      "SELECT status, expected_work_revision FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
      {
        organization_id: fixture.context.organizationId,
        command_id: "dynamic-staffing-stale-work-revision-prepare",
      },
    );
    expect(proposal).toEqual({ status: "prepared", expected_work_revision: fixture.work.revision });
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([
      expect.objectContaining({ message_type: "status", content: "외부 상태 변경" }),
    ]);
  });

  it("같은 Task의 활성 Assignment handle이 계획과 다르면 기존 배정을 보존한 채 안전하게 거부한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "assigned",
      strategyPlan("assigned-task", ["quant-analysis"], ["eligible-agent"]),
      {
        nodes: [
          {
            handle: "eligible-agent",
            name: "Eligible Agent",
            responsibility: "계량 분석",
            outputs: ["Analysis"],
            capabilities: ["quant-analysis"],
            parentHandle: "delivery-coordination",
          },
        ],
      },
    );
    const assigned = await fixture.works.assignTask(fixture.context, {
      commandId: "dynamic-staffing-assigned-existing",
      workId: fixture.work.work_id,
      expectedRevision: fixture.work.revision,
      taskId: fixture.tasks[0]?.task_id ?? "",
      agentHandle: "delivery-coordination",
    });

    const before = await fixture.works.getWork(fixture.context, fixture.work.work_id);

    await expect(
      fixture.staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-assigned-prepare",
        workId: fixture.work.work_id,
      }),
    ).rejects.toThrow("활성 Assignment Agent가 계획과 다릅니다");

    expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(before);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([
      expect.objectContaining({
        assignment_id: assigned.assignment.assignment_id,
        agent_handle: "delivery-coordination",
        status: "assigned",
      }),
    ]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
  });

  it("추천 전용 다중 Task의 두 번째 배정 실패는 첫 배정·participant·Work revision을 함께 rollback한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const first = strategyPlan("atomic-recommendation-first", ["atomic-first-capability"], ["atomic-first-agent"]);
    const plan: StrategyPlan = {
      ...first,
      tasks: [
        ...first.tasks,
        {
          key: "atomic-recommendation-second",
          title: "두 번째 추천 Task",
          objective: "두 번째 추천 배정을 실행한다",
          criterionKeys: ["done"],
          dependencyKeys: [],
          requiredCapabilities: ["atomic-second-capability"],
          recommendedAgentHandles: ["atomic-second-agent"],
          parallelizable: false,
        },
      ],
    };
    const fixture = await plannedFixture(database, "atomic-recommendations", plan, {
      nodes: [
        {
          handle: "atomic-first-agent",
          name: "Atomic First Agent",
          responsibility: "첫 번째 추천 Task",
          outputs: ["First Result"],
          capabilities: ["atomic-first-capability"],
          parentHandle: "delivery-coordination",
        },
        {
          handle: "atomic-second-agent",
          name: "Atomic Second Agent",
          responsibility: "두 번째 추천 Task",
          outputs: ["Second Result"],
          capabilities: ["atomic-second-capability"],
          parentHandle: "delivery-coordination",
        },
      ],
    });
    const works = {
      getWork: fixture.works.getWork.bind(fixture.works),
      getActivePlan: fixture.works.getActivePlan.bind(fixture.works),
      listTasks: fixture.works.listTasks.bind(fixture.works),
      listAssignments: fixture.works.listAssignments.bind(fixture.works),
      listRooms: fixture.works.listRooms.bind(fixture.works),
      postMessage: fixture.works.postMessage.bind(fixture.works),
      assignTask: async (...args: Parameters<WorkService["assignTask"]>) => {
        if (args[1].agentHandle === "atomic-second-agent") throw new Error("second-recommendation-assignment-failed");
        return await fixture.works.assignTask(...args);
      },
    };
    const staffing = await DynamicStaffingCoordinator.create(database, {
      advisor: fixture.advisor,
      graph: fixture.graph,
      organizations: fixture.organizations,
      works,
    });
    const before = await fixture.works.getWork(fixture.context, fixture.work.work_id);

    await expect(
      staffing.prepare(fixture.context, {
        commandId: "dynamic-staffing-atomic-recommendations-prepare",
        workId: fixture.work.work_id,
      }),
    ).rejects.toThrow("second-recommendation-assignment-failed");

    expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(before);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    const [participants] = await database.query<[{ readonly subject_id: string }[]]>(
      "SELECT subject_id FROM collaboration_participant WHERE organization_id = $organization_id AND work_id = $work_id AND subject_id IN ['atomic-first-agent', 'atomic-second-agent'];",
      { organization_id: fixture.context.organizationId, work_id: fixture.work.work_id },
    );
    expect(participants).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
    const [[proposalCount]] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() AS count FROM dynamic_staffing_proposal WHERE organization_id = $organization_id GROUP ALL;",
      { organization_id: fixture.context.organizationId },
    );
    expect(proposalCount?.count ?? 0).toBe(0);
  });

  it("동일 command 동시 실행은 proposal·graph·message·assignment를 각각 한 번만 적용한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      "concurrent",
      strategyPlan("concurrent-task", ["concurrent-capability"]),
    );
    const input = { commandId: "dynamic-staffing-concurrent-prepare", workId: fixture.work.work_id };

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => await fixture.staffing.prepare(fixture.context, input)),
    );

    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({
        outcome: "ready",
        proposalId: (results[0] as { readonly proposalId?: string }).proposalId,
      })),
    );
    const [[[proposalCount]], [[nodeCount]], [[messageCount]]] = await Promise.all([
      database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id GROUP ALL;",
        { organization_id: fixture.context.organizationId, command_id: input.commandId },
      ),
      database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM organization_node WHERE organization_id = $organization_id AND scope = 'work' AND work_id = $work_id GROUP ALL;",
        { organization_id: fixture.context.organizationId, work_id: fixture.work.work_id },
      ),
      database.query<[{ readonly count: number }[]]>(
        "SELECT count() AS count FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'proposal' GROUP ALL;",
        { organization_id: fixture.context.organizationId, work_id: fixture.work.work_id },
      ),
    ]);
    expect([proposalCount?.count, nodeCount?.count, messageCount?.count]).toEqual([1, 1, 1]);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(2);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toHaveLength(1);
  });

  it.each(["graph", "message", "assignment"] as const)(
    "%s side effect 직후 crash는 graph·message·assignment·checkpoint를 모두 rollback하고 같은 command로 복구한다",
    async (checkpoint) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const fixture = await plannedFixture(
        database,
        `crash-${checkpoint}`,
        strategyPlan(`crash-${checkpoint}-task`, [`crash-${checkpoint}-capability`]),
      );
      let authorizationCount = 0;
      const authorizedGraph = await OrganizationGraphService.create(database, fixture.organizations, {
        authorize: async () => {
          authorizationCount += 1;
          return { outcome: "allow" };
        },
      });
      let crash = true;
      let assignmentPersisted = false;
      const graph = {
        getCurrentSnapshot: authorizedGraph.getCurrentSnapshot.bind(authorizedGraph),
        authorizeExecution: authorizedGraph.authorizeExecution.bind(authorizedGraph),
        execute: async (...args: Parameters<OrganizationGraphService["execute"]>) => {
          const result = await authorizedGraph.execute(...args);
          if (checkpoint === "graph" && crash) {
            crash = false;
            throw new Error("graph checkpoint crash");
          }
          return result;
        },
      };
      const works = {
        getWork: fixture.works.getWork.bind(fixture.works),
        getActivePlan: fixture.works.getActivePlan.bind(fixture.works),
        listTasks: fixture.works.listTasks.bind(fixture.works),
        listAssignments: async (...args: Parameters<WorkService["listAssignments"]>) => {
          if (checkpoint === "assignment" && assignmentPersisted && crash) {
            crash = false;
            throw new Error("assignment checkpoint crash");
          }
          return await fixture.works.listAssignments(...args);
        },
        listRooms: fixture.works.listRooms.bind(fixture.works),
        postMessage: async (...args: Parameters<WorkService["postMessage"]>) => {
          const result = await fixture.works.postMessage(...args);
          if (checkpoint === "message" && crash) {
            crash = false;
            throw new Error("message checkpoint crash");
          }
          return result;
        },
        assignTask: async (...args: Parameters<WorkService["assignTask"]>) => {
          const result = await fixture.works.assignTask(...args);
          if (checkpoint === "assignment" && crash) {
            assignmentPersisted = true;
            throw new Error("assignment checkpoint crash");
          }
          return result;
        },
      };
      const staffing = await DynamicStaffingCoordinator.create(database, {
        advisor: fixture.advisor,
        graph,
        organizations: fixture.organizations,
        works,
      });
      const input = {
        commandId: `dynamic-staffing-crash-${checkpoint}-prepare`,
        workId: fixture.work.work_id,
      };

      await expect(staffing.prepare(fixture.context, input)).rejects.toThrow(`${checkpoint} checkpoint crash`);

      const [[checkpointProposal]] = await database.query<
        [{ readonly status: string; readonly expected_organization_version: number }[]]
      >(
        "SELECT status, expected_organization_version FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
        { organization_id: fixture.context.organizationId, command_id: input.commandId },
      );
      expect(checkpointProposal).toEqual({ status: "prepared", expected_organization_version: 1 });
      expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
      expect(
        (await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages.filter(
          (message) => message.message_type === "proposal",
        ),
      ).toHaveLength(0);
      expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toHaveLength(0);

      await expect(staffing.prepare(fixture.context, input)).resolves.toMatchObject({ outcome: "ready" });

      const [[appliedProposal]] = await database.query<[{ readonly status: string }[]]>(
        "SELECT status FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id;",
        { organization_id: fixture.context.organizationId, command_id: input.commandId },
      );
      expect(appliedProposal?.status).toBe("applied");
      expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(2);
      expect(
        (await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages.filter(
          (message) => message.message_type === "proposal",
        ),
      ).toHaveLength(1);
      expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toHaveLength(1);
      expect(authorizationCount).toBe(2);
    },
  );

  it.each([
    ["core-office", "staffing-core-office-room-missing"],
    ["malformed-plan", "staffing-plan-invalid"],
    ["strategy-generation", "staffing-plan-lineage-invalid"],
    ["task-key", "staffing-task-lineage-invalid"],
  ] as const)("%s 계보 오류는 모든 side effect 전에 %s로 차단한다", async (boundary, reason) => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const fixture = await plannedFixture(
      database,
      `invalid-${boundary}`,
      strategyPlan(`invalid-${boundary}-task`, [`invalid-${boundary}-capability`]),
      { withRoom: boundary !== "core-office" },
    );
    if (boundary === "malformed-plan") {
      await database.query(
        "UPDATE plan_version SET content_json = $content_json WHERE organization_id = $organization_id AND plan_version_id = $plan_version_id;",
        {
          content_json: '{"apiKey":"secret-never-return"',
          organization_id: fixture.context.organizationId,
          plan_version_id: fixture.work.active_plan_version_id,
        },
      );
    } else if (boundary === "strategy-generation") {
      await database.query(
        "UPDATE plan_version SET strategy_generation_id = NONE WHERE organization_id = $organization_id AND plan_version_id = $plan_version_id;",
        {
          organization_id: fixture.context.organizationId,
          plan_version_id: fixture.work.active_plan_version_id,
        },
      );
    } else if (boundary === "task-key") {
      await database.query(
        "UPDATE work_task SET task_key = 'forged-task-key' WHERE organization_id = $organization_id AND task_id = $task_id;",
        { organization_id: fixture.context.organizationId, task_id: fixture.tasks[0]?.task_id },
      );
    }
    const before = await fixture.works.getWork(fixture.context, fixture.work.work_id);

    const result = await fixture.staffing.prepare(fixture.context, {
      commandId: `dynamic-staffing-invalid-${boundary}-prepare`,
      workId: fixture.work.work_id,
    });

    expect(result).toEqual({ outcome: "blocked", reason });
    expect(JSON.stringify(result)).not.toContain("secret-never-return");
    expect(await fixture.works.getWork(fixture.context, fixture.work.work_id)).toEqual(before);
    expect(await fixture.works.listAssignments(fixture.context, fixture.work.work_id)).toEqual([]);
    expect((await fixture.works.recoverWork(fixture.context, fixture.work.work_id)).messages).toEqual([]);
    expect((await fixture.graph.getCurrentSnapshot(fixture.context)).version.version).toBe(1);
    const [[assessments], [proposals]] = await Promise.all([
      database.query<[{ readonly assessment_id: string }[]]>(
        "SELECT assessment_id FROM staffing_assessment WHERE organization_id = $organization_id;",
        { organization_id: fixture.context.organizationId },
      ),
      database.query<[{ readonly proposal_id: string }[]]>(
        "SELECT proposal_id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id;",
        { organization_id: fixture.context.organizationId },
      ),
    ]);
    expect(assessments).toEqual([]);
    expect(proposals).toEqual([]);
  });

  it("같은 commandId를 tenant별로 격리하고 같은 tenant의 다른 Work payload는 거부한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const first = await plannedFixture(database, "tenant-first", strategyPlan("first-task", ["first-capability"]));
    const second = await plannedFixture(database, "tenant-second", strategyPlan("second-task", ["second-capability"]));
    const sharedCommandId = "dynamic-staffing-tenant-shared-command";

    await expect(
      first.staffing.prepare(first.context, { commandId: sharedCommandId, workId: first.work.work_id }),
    ).resolves.toMatchObject({ outcome: "ready" });
    await expect(
      second.staffing.prepare(second.context, { commandId: sharedCommandId, workId: second.work.work_id }),
    ).resolves.toMatchObject({ outcome: "ready" });

    const [firstProposals] = await database.query<[{ readonly organization_id: string }[]]>(
      "SELECT organization_id FROM dynamic_staffing_proposal WHERE command_id = $command_id;",
      { command_id: sharedCommandId },
    );
    expect(firstProposals.map((proposal) => proposal.organization_id).sort()).toEqual(
      [first.context.organizationId, second.context.organizationId].sort(),
    );
    await expect(
      first.staffing.prepare(first.context, {
        commandId: "dynamic-staffing-cross-tenant-command",
        workId: second.work.work_id,
      }),
    ).rejects.toThrow("Work를 찾을 수 없습니다");

    const firstSnapshot = await first.graph.getCurrentSnapshot(first.context);
    const another = await first.works.createWork(first.context, {
      commandId: "dynamic-staffing-tenant-first-another-work",
      text: "같은 tenant의 다른 Work",
      surface: "test",
      organizationVersionId: firstSnapshot.version.version_id,
    });
    const anotherRoom = await first.works.openRoom(first.context, {
      commandId: "dynamic-staffing-tenant-first-another-room",
      workId: another.work.work_id,
      expectedRevision: another.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: CORE_OFFICE_HANDLES.map((handle) => ({
        kind: "agent" as const,
        subjectId: handle,
        role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
      })),
      limits: { maxParallel: 8, maxTokens: 100_000, maxCostMicros: 1_000_000, maxRounds: 100 },
    });
    const anotherPlan = await first.works.applyStrategyProjection(first.context, {
      commandId: "dynamic-staffing-tenant-first-another-plan",
      workId: another.work.work_id,
      expectedRevision: anotherRoom.work.revision,
      contextVersionId: "context-tenant-first-another",
      strategyGenerationId: "strategy-tenant-first-another",
      strategyChecksum: "d".repeat(64),
      plan: strategyPlan("another-task", ["another-capability"]),
    });
    const before = await first.works.getWork(first.context, another.work.work_id);

    await expect(
      first.staffing.prepare(first.context, { commandId: sharedCommandId, workId: another.work.work_id }),
    ).rejects.toThrow("같은 commandId에 다른 Dynamic Staffing payload");

    expect(await first.works.getWork(first.context, another.work.work_id)).toEqual(before);
    expect(await first.works.listAssignments(first.context, another.work.work_id)).toEqual([]);
    expect((await first.works.recoverWork(first.context, another.work.work_id)).messages).toEqual([]);
    expect(anotherPlan.tasks).toHaveLength(1);
    expect((await first.graph.getCurrentSnapshot(first.context)).version.version).toBe(2);
  });
});
