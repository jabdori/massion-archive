import { ExtensionStore } from "@massion/extension-host";
import { ApprovalStore, createDefaultPolicy, GovernanceService, PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { ApplicationRunStore } from "../run-store.js";
import { SurrealApplicationReadModel } from "./read-model.js";
import { CollaborationGraphSnapshotProjector } from "../snapshot.js";
import { WorkDirectiveStore } from "../work-directive-store.js";

describe("SurrealApplicationReadModel", () => {
  it("실제 공개 domain record를 협업 graph source로 읽고 tenant를 격리한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "read-model@example.com", displayName: "Reader" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const other = await identities.registerPersonalUser({
      email: "read-model-other@example.com",
      displayName: "Other",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    await ExtensionStore.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "read-model-work-0001",
      text: "실제 read model 검증\n목록에 노출하지 않을 상세 요청",
      surface: "test",
      organizationVersionId: core.version.version_id,
    });
    await graph.execute(context, {
      commandId: "read-model-work-agent-0001",
      expectedVersion: core.version.version,
      kind: "install-profile",
      profileId: "read-model-work-profile",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "read-model-specialist",
          name: "Read Model Specialist",
          responsibility: "현재 Work의 읽기 모델 검증",
          outputs: ["ReadModel"],
          capabilities: ["analysis"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: created.work.work_id,
          role: "operator",
        },
      ],
    });
    const plan = await works.addPlan(context, {
      commandId: "read-model-plan-0001",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "read model 검증" },
    });
    const task = await works.addTask(context, {
      commandId: "read-model-task-0001",
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      title: "실제 Task",
      objective: "read model을 검증합니다",
      acceptanceCriteria: ["snapshot에 나타납니다"],
      dependencyIds: [],
    });
    await database.query(
      "UPDATE work_task SET required_capabilities = ['analysis'], recommended_agent_handles = ['analysis'], parallelizable = true WHERE organization_id = $organization_id AND task_id = $task_id;",
      { organization_id: context.organizationId, task_id: task.task.task_id },
    );
    const assignment = await works.assignTask(context, {
      commandId: "read-model-assignment-0001",
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "representative",
    });
    const room = await works.openRoom(context, {
      commandId: "read-model-room-0001",
      workId: created.work.work_id,
      expectedRevision: assignment.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: [
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        { kind: "agent", subjectId: "context-strategy", role: "participant" },
        { kind: "agent", subjectId: "read-model-specialist", role: "participant" },
        { kind: "user", subjectId: context.userId, role: "participant" },
      ],
      limits: { maxParallel: 2, maxTokens: 10_000, maxCostMicros: 1_000_000, maxRounds: 20 },
    });
    const duplicateSubjectId = "00000000-0000-4000-8000-000000000001";
    const legacySubjectId = "00000000-0000-4000-8000-000000000002";
    for (const participant of [
      {
        participantId: "read-model-ordering-user",
        kind: "user",
        subjectId: duplicateSubjectId,
        joinedAt: "2000-01-02T00:00:00.000Z",
      },
      {
        participantId: "read-model-ordering-agent",
        kind: "agent",
        subjectId: duplicateSubjectId,
        joinedAt: "2000-01-02T00:00:00.000Z",
      },
      {
        participantId: "read-model-ordering-legacy",
        kind: "legacy",
        subjectId: legacySubjectId,
        joinedAt: "2000-01-01T00:00:00.000Z",
      },
    ]) {
      await database.query(
        "CREATE collaboration_participant CONTENT { participant_id: $participant_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, kind: $kind, subject_id: $subject_id, role: 'participant', status: 'active', joined_at: <datetime>$joined_at };",
        {
          participant_id: participant.participantId,
          organization_id: context.organizationId,
          work_id: created.work.work_id,
          room_id: room.room.room_id,
          kind: participant.kind,
          subject_id: participant.subjectId,
          joined_at: participant.joinedAt,
        },
      );
    }
    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const execution = await runtime.createExecution(context, {
      commandId: "read-model-execution-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "representative",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "실행" },
    });
    const interruptedExecution = await runtime.createExecution(context, {
      commandId: "read-model-execution-interrupted-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "read-model-specialist",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-interrupted-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "중단 실행" },
    });
    await runtime.transition(context, {
      commandId: "read-model-execution-interrupted-running-0001",
      executionId: interruptedExecution.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await runtime.transition(context, {
      commandId: "read-model-execution-interrupted-done-0001",
      executionId: interruptedExecution.execution.execution_id,
      expectedVersion: 2,
      target: "interrupted",
      payload: { reason: "fixture" },
    });
    const ambiguousExecution = await runtime.createExecution(context, {
      commandId: "read-model-execution-ambiguous-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "read-model-specialist",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-ambiguous-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "다중 모델 실행" },
    });
    await runtime.transition(context, {
      commandId: "read-model-execution-ambiguous-running-0001",
      executionId: ambiguousExecution.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await runtime.transition(context, {
      commandId: "read-model-execution-ambiguous-failed-0001",
      executionId: ambiguousExecution.execution.execution_id,
      expectedVersion: 2,
      target: "failed",
      payload: { reason: "fixture" },
    });
    const mismatchedExecution = await runtime.createExecution(context, {
      commandId: "read-model-execution-mismatched-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "read-model-specialist",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-mismatched-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "불일치 모델 실행" },
    });
    await database.query(
      `DEFINE TABLE model_profile SCHEMALESS;
       DEFINE TABLE route_attempt SCHEMALESS;
       CREATE model_profile CONTENT {
         model_profile_id: 'read-model-profile-openai', organization_id: $organization_id,
         provider_id: 'openai-codex', model_id: 'gpt-5.6-sol'
       };
       CREATE model_profile CONTENT {
         model_profile_id: 'read-model-profile-other', organization_id: $organization_id,
         provider_id: 'zai-coding-plan', model_id: 'glm-5.2'
       };
       CREATE model_profile CONTENT {
         model_profile_id: 'read-model-profile-foreign', organization_id: $other_organization_id,
         provider_id: 'foreign-provider', model_id: 'foreign-model'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-succeeded', organization_id: $organization_id,
         execution_id: $execution_id, model_profile_id: 'read-model-profile-openai', status: 'succeeded'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-foreign', organization_id: $other_organization_id,
         execution_id: $execution_id, model_profile_id: 'read-model-profile-foreign', status: 'succeeded'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-interrupted', organization_id: $organization_id,
         execution_id: $interrupted_execution_id, model_profile_id: 'read-model-profile-openai', status: 'interrupted'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-ambiguous-openai', organization_id: $organization_id,
         execution_id: $ambiguous_execution_id, model_profile_id: 'read-model-profile-openai', status: 'succeeded'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-ambiguous-other', organization_id: $organization_id,
         execution_id: $ambiguous_execution_id, model_profile_id: 'read-model-profile-other', status: 'succeeded'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-mismatched-openai', organization_id: $organization_id,
         execution_id: $mismatched_execution_id, model_profile_id: 'read-model-profile-openai', status: 'interrupted'
       };
       CREATE route_attempt CONTENT {
         attempt_id: 'read-model-attempt-mismatched-foreign', organization_id: $organization_id,
         execution_id: $mismatched_execution_id, model_profile_id: 'read-model-profile-foreign', status: 'interrupted'
       };`,
      {
        organization_id: context.organizationId,
        other_organization_id: otherContext.organizationId,
        execution_id: execution.execution.execution_id,
        interrupted_execution_id: interruptedExecution.execution.execution_id,
        ambiguous_execution_id: ambiguousExecution.execution.execution_id,
        mismatched_execution_id: mismatchedExecution.execution.execution_id,
      },
    );
    const message = await works.postMessage(context, {
      commandId: "read-model-message-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "handoff",
      authorKind: "agent",
      authorId: "representative",
      recipientAgentId: "context-strategy",
      content: "진행 중입니다",
      taskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      tokenCount: 25,
      costMicros: 125,
    });
    const artifact = await works.createArtifactVersion(context, {
      commandId: "read-model-artifact-0001",
      workId: created.work.work_id,
      expectedRevision: (await works.getWork(context, created.work.work_id)).revision,
      kind: "report",
      name: "이탈 분석 보고서",
      mediaType: "application/json",
      content: { privateRawData: "읽기 모델에서 노출하면 안 됩니다" },
    });
    await works.postMessage(context, {
      commandId: "read-model-message-0002",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "evidence",
      authorKind: "agent",
      authorId: "representative",
      content: "산출물 계보를 연결했습니다",
      replyToMessageId: message.message.message_id,
      causedByMessageId: message.message.message_id,
      taskId: task.task.task_id,
      contextVersionId: "read-model-context-version-0001",
      executionId: execution.execution.execution_id,
      artifactVersionId: artifact.artifactVersion.artifact_version_id,
      tokenCount: 0,
      costMicros: 0,
    });
    const workAgentMessage = await works.postMessage(context, {
      commandId: "read-model-message-work-agent-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "status",
      authorKind: "agent",
      authorId: "read-model-specialist",
      content: "Work 범위 에이전트입니다",
      tokenCount: 0,
      costMicros: 0,
    });
    const userMessage = await works.postMessage(context, {
      commandId: "read-model-message-user-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "question",
      authorKind: "user",
      authorId: context.userId,
      content: "현재 모델을 알려주세요",
      tokenCount: 0,
      costMicros: 0,
    });
    const ambiguousMessage = await works.postMessage(context, {
      commandId: "read-model-message-ambiguous-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "status",
      authorKind: "agent",
      authorId: "read-model-specialist",
      content: "모델 계보가 모호합니다",
      executionId: ambiguousExecution.execution.execution_id,
      tokenCount: 0,
      costMicros: 0,
    });
    const wrongAuthorMessage = await works.postMessage(context, {
      commandId: "read-model-message-wrong-author-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "status",
      authorKind: "agent",
      authorId: "read-model-specialist",
      content: "다른 Agent 실행 계보를 참조합니다",
      executionId: execution.execution.execution_id,
      tokenCount: 0,
      costMicros: 0,
    });
    await database.query(
      `CREATE collaboration_message CONTENT {
         message_id: 'read-model-message-wrong-work', organization_id: $organization_id,
         work_id: 'read-model-wrong-work', room_id: $room_id, sequence: 99,
         message_type: 'status', author_kind: 'agent', author_id: 'read-model-specialist',
         content: '다른 Work 실행 계보', execution_id: $execution_id,
         token_count: 0, cost_micros: 0, created_at: time::now()
       };`,
      {
        organization_id: context.organizationId,
        room_id: room.room.room_id,
        execution_id: execution.execution.execution_id,
      },
    );
    await database.query(
      "CREATE work_verification CONTENT { verification_id: 'read-model-verification-0001', organization_id: $organization_id, work_id: $work_id, verifier_id: 'assurance', passed: true, criteria_json: '[\"통계 유의성\"]', evidence_artifact_version_ids: [$artifact_version_id], created_at: time::now() };",
      {
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        artifact_version_id: artifact.artifactVersion.artifact_version_id,
      },
    );
    const applicationRuns = await ApplicationRunStore.create(database, organizations);
    const applicationRun = await applicationRuns.start(context, {
      commandId: "read-model-run-0001",
      correlationId: "read-model-run-correlation-0001",
      request: { text: "실제 read model 검증" },
    });
    const claimedRun = await applicationRuns.claim(context, applicationRun.runId);
    if (claimedRun.outcome !== "claimed") throw new Error("Application run을 claim하지 못했습니다");
    await applicationRuns.advance(context, applicationRun.runId, claimedRun.leaseGeneration, {
      stage: "context-strategy",
      workId: created.work.work_id,
    });
    const directives = await WorkDirectiveStore.create(database, organizations);
    const directive = await directives.submit(context, {
      commandId: "read-model-directive-0001",
      correlationId: "read-model-directive-correlation-0001",
      expectedRevision: (await works.getWork(context, created.work.work_id)).revision,
      workId: created.work.work_id,
      runId: applicationRun.runId,
      content: "표본 구간을 추가해 주세요",
      mode: "next-stage",
    });
    const defaults = createDefaultPolicy("personal");
    const policy = await policies.createDraft(context, {
      commandId: "read-model-policy-0001",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, {
      commandId: "read-model-policy-activate-0001",
      policyVersionId: policy.policy_version_id,
    });
    const decision = await governance.evaluate(context, {
      commandId: "read-model-decision-0001",
      request: {
        principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
        action: "tool.call",
        resource: { type: "Tool", id: "tool-read-model", organizationId: context.organizationId },
        context: { environment: "local", riskClass: "agent-tool", external: false },
      },
    });
    const approval = await approvals.request(context, {
      commandId: "read-model-approval-0001",
      decisionId: decision.decisionId,
      resourceRevision: artifact.work.revision,
      workId: created.work.work_id,
      executionId: execution.execution.execution_id,
      displayPreview: {
        kind: "file-change",
        title: "파일 변경",
        path: "/workspace/src/index.ts",
        summary: "검증 로직 변경",
      },
    });
    const pendingDecision = await governance.evaluate(context, {
      commandId: "read-model-decision-pending-0001",
      request: {
        principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
        action: "tool.call",
        resource: { type: "Tool", id: "tool-read-model-pending", organizationId: context.organizationId },
        context: { environment: "local", riskClass: "agent-tool", external: false },
      },
    });
    const pendingApproval = await approvals.request(context, {
      commandId: "read-model-approval-pending-0001",
      decisionId: pendingDecision.decisionId,
      resourceRevision: artifact.work.revision,
      workId: created.work.work_id,
      executionId: execution.execution.execution_id,
      displayPreview: {
        kind: "file-change",
        title: "파일 변경",
        path: "/workspace/src/index.ts",
        summary: "검증 로직 변경",
      },
    });
    const createStaffingApproval = async (suffix: string) => {
      const staffingDecision = await governance.evaluate(context, {
        commandId: `read-model-decision-staffing-${suffix}`,
        request: {
          principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
          action: "organization.change",
          resource: {
            type: "Organization",
            id: context.organizationId,
            organizationId: context.organizationId,
            revision: 12,
          },
          context: { environment: "local", riskClass: "write", external: false },
        },
      });
      return await approvals.request(context, {
        commandId: `read-model-approval-staffing-${suffix}`,
        decisionId: staffingDecision.decisionId,
        resourceRevision: 12,
        workId: created.work.work_id,
      });
    };
    const staffingApproval = await createStaffingApproval("valid");
    const malformedStaffingApproval = await createStaffingApproval("malformed");
    const wrongPolicyStaffingApproval = await createStaffingApproval("wrong-policy");
    const missingDecisionStaffingApproval = await createStaffingApproval("missing-decision");
    const wrongWorkStaffingApproval = await createStaffingApproval("wrong-work");
    const blankAssignmentStaffingApproval = await createStaffingApproval("blank-assignment");
    const duplicateAgentStaffingApproval = await createStaffingApproval("duplicate-agent");
    await database.query(
      "UPDATE governance_approval SET status = 'consumed' WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: approval.approval_id },
    );
    await database.query(
      "UPDATE governance_approval SET requirement_json = '{' WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: pendingApproval.approval_id },
    );
    await database.query(
      "UPDATE governance_approval SET request_hash = $request_hash, display_preview_json = $display_preview_json WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      {
        organization_id: context.organizationId,
        approval_id: malformedStaffingApproval.approval_id,
        request_hash: "0".repeat(64),
        display_preview_json: JSON.stringify({
          kind: "provider",
          title: "노출되면 안 되는 저장 미리보기",
          reason: "결정 계보가 일치하지 않습니다",
        }),
      },
    );
    await database.query(
      "UPDATE governance_approval SET policy_version_id = 'missing-policy-version', display_preview_json = $display_preview_json WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      {
        organization_id: context.organizationId,
        approval_id: wrongPolicyStaffingApproval.approval_id,
        display_preview_json: JSON.stringify({
          kind: "provider",
          title: "노출되면 안 되는 정책 버전 미리보기",
        }),
      },
    );
    await database.query(
      "UPDATE governance_approval SET decision_id = 'missing-decision', display_preview_json = $display_preview_json WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      {
        organization_id: context.organizationId,
        approval_id: missingDecisionStaffingApproval.approval_id,
        display_preview_json: JSON.stringify({
          kind: "provider",
          title: "노출되면 안 되는 결정 미리보기",
        }),
      },
    );

    const validStaffingMessage = await works.postMessage(context, {
      commandId: "read-model-staffing-message-valid",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "proposal",
      authorKind: "agent",
      authorId: "context-strategy",
      content: "두 개의 Work 전용 Agent를 적용했습니다.",
      tokenCount: 0,
      costMicros: 0,
    });
    const invalidStaffingMessages = [];
    for (const suffix of [
      "tenant",
      "work",
      "room",
      "type",
      "duplicate",
      "malformed",
      "empty",
      "duplicate-node",
      "mismatched-node",
      "stale-version",
      "author",
      "human-author",
      "pending-approval",
    ] as const) {
      invalidStaffingMessages.push(
        await works.postMessage(context, {
          commandId: `read-model-staffing-message-${suffix}`,
          workId: created.work.work_id,
          roomId: room.room.room_id,
          messageType: suffix === "type" ? "status" : "proposal",
          authorKind: suffix === "human-author" ? "user" : "agent",
          authorId:
            suffix === "human-author" ? context.userId : suffix === "author" ? "representative" : "context-strategy",
          content: `${suffix} 계보 검증`,
          tokenCount: 0,
          costMicros: 0,
        }),
      );
    }
    const staffingNodes = [
      {
        taskKey: "analysis",
        taskId: "task-analysis",
        agentHandle: "staff-analysis",
        node: {
          handle: "staff-analysis",
          name: "분석 담당",
          responsibility: "분석",
          outputs: ["분석 결과"],
          capabilities: ["analysis", "statistics"],
          parentHandle: "delivery-coordination",
          scope: "work",
          builtin: false,
          workId: created.work.work_id,
          role: "operator",
        },
      },
      {
        taskKey: "review",
        taskId: "task-review",
        agentHandle: "staff-review",
        node: {
          handle: "staff-review",
          name: "검토 담당",
          responsibility: "검토",
          outputs: ["검토 결과"],
          capabilities: ["review"],
          parentHandle: "assurance",
          scope: "work",
          builtin: false,
          workId: created.work.work_id,
          role: "coordinator",
        },
      },
    ];
    const proposalRecord = (
      proposalId: string,
      messageId: string,
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      proposal_id: proposalId,
      organization_id: context.organizationId,
      created_by_user_id: context.userId,
      command_id: `command-${proposalId}`,
      request_hash: "a".repeat(64),
      intent_hash: "b".repeat(64),
      work_id: created.work.work_id,
      plan_version_id: "plan-staffing",
      strategy_generation_id: "strategy-staffing",
      assessment_id: "assessment-staffing",
      graph_command_json: '{"secret":"graph-command-secret"}',
      expected_organization_version: 12,
      expected_work_revision: 1,
      nodes_json: JSON.stringify(staffingNodes),
      assignments_json: '[{"secret":"assignment-secret"}]',
      core_office_room_id: room.room.room_id,
      ux_metadata_json: '{"secret":"metadata-secret"}',
      status: "applied",
      applied_organization_version: 13,
      applied_organization_version_id: "organization-version-secret",
      impact_json: JSON.stringify({
        nodeHandles: ["delivery-coordination", "assurance"],
        references: [{ secret: "reference-secret-1" }, { secret: "reference-secret-2" }],
      }),
      message_id: messageId,
      revision: 2,
      created_at: new Date("2026-07-31T00:00:00.000Z"),
      updated_at: new Date("2026-07-31T00:00:01.000Z"),
      ...overrides,
    });
    const [
      wrongTenantMessage,
      wrongWorkMessage,
      wrongRoomMessage,
      wrongTypeMessage,
      duplicateMessage,
      malformedMessage,
      emptyMessage,
      duplicateNodeMessage,
      mismatchedNodeMessage,
      staleVersionMessage,
      staffingWrongAuthorMessage,
      humanAuthorMessage,
      pendingApprovalMessage,
    ] = invalidStaffingMessages;
    if (
      !wrongTenantMessage ||
      !wrongWorkMessage ||
      !wrongRoomMessage ||
      !wrongTypeMessage ||
      !duplicateMessage ||
      !malformedMessage ||
      !emptyMessage ||
      !duplicateNodeMessage ||
      !mismatchedNodeMessage ||
      !staleVersionMessage ||
      !staffingWrongAuthorMessage ||
      !humanAuthorMessage ||
      !pendingApprovalMessage
    )
      throw new Error("잘못된 Staffing 계보 fixture가 필요합니다");
    const staffingProposalRecords = [
      proposalRecord("proposal-valid", validStaffingMessage.message.message_id, {
        approval_id: approval.approval_id,
      }),
      proposalRecord("proposal-wrong-tenant", wrongTenantMessage.message.message_id, {
        organization_id: otherContext.organizationId,
        created_by_user_id: otherContext.userId,
        approval_id: staffingApproval.approval_id,
      }),
      proposalRecord("proposal-wrong-work", wrongWorkMessage.message.message_id, { work_id: "other-work" }),
      proposalRecord("proposal-wrong-room", wrongRoomMessage.message.message_id, {
        core_office_room_id: "other-room",
      }),
      proposalRecord("proposal-wrong-type", wrongTypeMessage.message.message_id),
      proposalRecord("proposal-duplicate-a", duplicateMessage.message.message_id),
      proposalRecord("proposal-duplicate-b", duplicateMessage.message.message_id),
      proposalRecord("proposal-malformed", malformedMessage.message.message_id, { nodes_json: "{" }),
      proposalRecord("proposal-empty", emptyMessage.message.message_id, { nodes_json: "[]" }),
      proposalRecord("proposal-duplicate-node", duplicateNodeMessage.message.message_id, {
        nodes_json: JSON.stringify([staffingNodes[0], staffingNodes[0]]),
      }),
      proposalRecord("proposal-mismatched-node", mismatchedNodeMessage.message.message_id, {
        nodes_json: JSON.stringify([{ ...staffingNodes[0], agentHandle: "staff-other" }]),
      }),
      proposalRecord("proposal-stale-version", staleVersionMessage.message.message_id, {
        applied_organization_version: 12,
      }),
      proposalRecord("proposal-wrong-author", staffingWrongAuthorMessage.message.message_id),
      proposalRecord("proposal-human-author", humanAuthorMessage.message.message_id),
      proposalRecord("proposal-pending-approval", pendingApprovalMessage.message.message_id, {
        approval_id: pendingApproval.approval_id,
      }),
      proposalRecord("proposal-approval-valid", "staffing-approval-message-valid", {
        approval_id: staffingApproval.approval_id,
        status: "awaiting-approval",
        ux_metadata_json: JSON.stringify({
          kind: "dynamic-staffing-proposal",
          title: "동적 Staffing 제안",
          workId: created.work.work_id,
          strategyGenerationId: "provider-secret",
          taskCount: 2,
          proposedAgentCount: 2,
          assignments: [
            { taskKey: "task-key-secret-1", agentHandle: "provider-handle-secret-1", source: "proposal" },
            { taskKey: "task-key-secret-2", agentHandle: "provider-handle-secret-2", source: "proposal" },
          ],
        }),
      }),
      proposalRecord("proposal-approval-malformed", "staffing-approval-message-malformed", {
        approval_id: malformedStaffingApproval.approval_id,
        status: "awaiting-approval",
        ux_metadata_json: "{",
      }),
      proposalRecord("proposal-approval-wrong-work", "staffing-approval-message-wrong-work", {
        approval_id: wrongWorkStaffingApproval.approval_id,
        status: "awaiting-approval",
        work_id: "other-work",
        ux_metadata_json: JSON.stringify({
          kind: "dynamic-staffing-proposal",
          title: "동적 Staffing 제안",
          workId: "other-work",
          strategyGenerationId: "strategy-other-work",
          taskCount: 1,
          proposedAgentCount: 1,
          assignments: [{ taskKey: "other-task", agentHandle: "other-agent", source: "proposal" }],
        }),
      }),
      proposalRecord("proposal-approval-blank-assignment", "staffing-approval-message-blank-assignment", {
        approval_id: blankAssignmentStaffingApproval.approval_id,
        status: "awaiting-approval",
        ux_metadata_json: JSON.stringify({
          kind: "dynamic-staffing-proposal",
          title: "동적 Staffing 제안",
          workId: created.work.work_id,
          strategyGenerationId: "strategy-blank-assignment",
          taskCount: 1,
          proposedAgentCount: 1,
          assignments: [{ taskKey: "  ", agentHandle: "  ", source: "proposal" }],
        }),
      }),
      proposalRecord("proposal-approval-duplicate-agent", "staffing-approval-message-duplicate-agent", {
        approval_id: duplicateAgentStaffingApproval.approval_id,
        status: "awaiting-approval",
        ux_metadata_json: JSON.stringify({
          kind: "dynamic-staffing-proposal",
          title: "동적 Staffing 제안",
          workId: created.work.work_id,
          strategyGenerationId: "strategy-duplicate-agent",
          taskCount: 2,
          proposedAgentCount: 2,
          assignments: [
            { taskKey: "task-duplicate-agent-1", agentHandle: "same-agent", source: "proposal" },
            { taskKey: "task-duplicate-agent-2", agentHandle: " same-agent ", source: "proposal" },
          ],
        }),
      }),
    ];
    for (const record of staffingProposalRecords) {
      await database.query("CREATE dynamic_staffing_proposal CONTENT $record;", { record });
    }

    const readModel = new SurrealApplicationReadModel(database, organizations);
    const organization = await readModel.organization(context);
    expect(organization.nodes.find((node) => node.handle === "context-strategy")).toMatchObject({
      nodeId: expect.any(String),
      parentHandle: "representative",
      scope: "persistent",
      // Core Office 여덟은 builtin입니다. 화면이 이 값으로 편성 조작을 미리 막습니다.
      builtin: true,
    });
    expect(organization.nodes.find((node) => node.handle === "context-strategy")).not.toHaveProperty("workId");
    const snapshot = await new CollaborationGraphSnapshotProjector(readModel).project(context);
    expect(snapshot.works[0]).toMatchObject({
      workId: created.work.work_id,
      taskIds: [task.task.task_id],
      roomIds: [room.room.room_id],
    });
    expect(snapshot.nodes.find((node) => node.handle === "representative")).toMatchObject({
      currentTaskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      inputTokens: 25,
      costMicros: 125,
    });
    expect(snapshot.rooms[0]).toMatchObject({
      participantIds: expect.arrayContaining([context.userId, "representative"]),
    });
    const [projectedRoom] = await readModel.rooms(context);
    expect(projectedRoom?.participantIds.slice(0, 3)).toEqual([
      legacySubjectId,
      duplicateSubjectId,
      duplicateSubjectId,
    ]);
    expect(projectedRoom?.participants?.slice(0, 3)).toEqual([
      { subjectId: legacySubjectId, kind: "agent" },
      { subjectId: duplicateSubjectId, kind: "agent" },
      { subjectId: duplicateSubjectId, kind: "user" },
    ]);
    expect(projectedRoom?.participants).toEqual(
      expect.arrayContaining([
        { subjectId: context.userId, kind: "user" },
        { subjectId: "read-model-specialist", kind: "agent" },
      ]),
    );
    expect(snapshot.pendingApprovals[0]?.displayPreview).toEqual({
      kind: "file-change",
      path: "/workspace/src/index.ts",
      summary: "검증 로직 변경",
      title: "파일 변경",
    });
    await expect(readModel.works(context)).resolves.toEqual([
      expect.objectContaining({
        workId: created.work.work_id,
        title: "실제 read model 검증",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    ]);
    await expect(readModel.tasks(context)).resolves.toEqual([
      expect.objectContaining({
        taskId: task.task.task_id,
        objective: "read model을 검증합니다",
        acceptanceCriteria: ["snapshot에 나타납니다"],
        dependencyIds: [],
        requiredCapabilities: ["analysis"],
        recommendedAgentHandles: ["analysis"],
        parallelizable: true,
      }),
    ]);
    await expect(readModel.assignments(context)).resolves.toEqual([
      expect.objectContaining({ assignmentId: assignment.assignment.assignment_id }),
    ]);
    await expect(readModel.artifacts?.(context)).resolves.toEqual([
      expect.objectContaining({
        artifactId: artifact.artifact.artifact_id,
        artifactVersionId: artifact.artifactVersion.artifact_version_id,
        name: "이탈 분석 보고서",
        mediaType: "application/json",
      }),
    ]);
    expect(JSON.stringify(await readModel.artifacts?.(context))).not.toContain("privateRawData");
    const projectedMessages = await readModel.messages(context);
    expect(projectedMessages.find((item) => item.messageId === message.message.message_id)).toMatchObject({
      taskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      recipientAgentId: "context-strategy",
      authorDisplayName: "Representative",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(projectedMessages[1]).toMatchObject({
      taskId: task.task.task_id,
      contextVersionId: "read-model-context-version-0001",
      executionId: execution.execution.execution_id,
      artifactVersionId: artifact.artifactVersion.artifact_version_id,
      replyToMessageId: message.message.message_id,
      causedByMessageId: message.message.message_id,
      authorDisplayName: "Representative",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(projectedMessages.find((item) => item.messageId === workAgentMessage.message.message_id)).toMatchObject({
      authorKind: "agent",
      authorId: "read-model-specialist",
      authorDisplayName: "Read Model Specialist",
    });
    expect(projectedMessages.find((item) => item.messageId === userMessage.message.message_id)).toMatchObject({
      authorKind: "user",
      authorId: context.userId,
      authorDisplayName: "Reader",
    });
    expect(projectedMessages.find((item) => item.messageId === validStaffingMessage.message.message_id)).toMatchObject({
      staffingProposal: {
        proposalId: "proposal-valid",
        status: "applied",
        approvalId: approval.approval_id,
        nodes: [
          {
            handle: "staff-analysis",
            name: "분석 담당",
            scope: "work",
            workId: created.work.work_id,
            parentHandle: "delivery-coordination",
            role: "operator",
            capabilities: ["analysis", "statistics"],
          },
          {
            handle: "staff-review",
            name: "검토 담당",
            scope: "work",
            workId: created.work.work_id,
            parentHandle: "assurance",
            role: "coordinator",
            capabilities: ["review"],
          },
        ],
        impactNodeHandles: ["delivery-coordination", "assurance"],
        impactReferenceCount: 2,
        fromOrganizationVersion: 12,
        toOrganizationVersion: 13,
      },
    });
    for (const invalid of invalidStaffingMessages) {
      expect(projectedMessages.find((item) => item.messageId === invalid.message.message_id)).not.toHaveProperty(
        "staffingProposal",
      );
    }
    const staffingProjection = JSON.stringify(
      projectedMessages.find((item) => item.messageId === validStaffingMessage.message.message_id),
    );
    for (const secret of [
      "graph-command-secret",
      "assignment-secret",
      "metadata-secret",
      "organization-version-secret",
      "reference-secret-1",
      "reference-secret-2",
    ]) {
      expect(staffingProjection).not.toContain(secret);
    }
    expect(projectedMessages.find((item) => item.messageId === ambiguousMessage.message.message_id)).not.toHaveProperty(
      "providerId",
    );
    expect(projectedMessages.find((item) => item.messageId === ambiguousMessage.message.message_id)).not.toHaveProperty(
      "modelId",
    );
    expect(
      projectedMessages.find((item) => item.messageId === wrongAuthorMessage.message.message_id),
    ).not.toHaveProperty("providerId");
    expect(
      projectedMessages.find((item) => item.messageId === wrongAuthorMessage.message.message_id),
    ).not.toHaveProperty("modelId");
    expect(projectedMessages.find((item) => item.messageId === "read-model-message-wrong-work")).not.toHaveProperty(
      "providerId",
    );
    expect(projectedMessages.find((item) => item.messageId === "read-model-message-wrong-work")).not.toHaveProperty(
      "modelId",
    );
    expect(projectedMessages.find((item) => item.messageId === "read-model-message-wrong-work")).not.toHaveProperty(
      "authorDisplayName",
    );
    const projectedExecutions = await readModel.executions(context);
    expect(
      projectedExecutions.find((item) => item.executionId === interruptedExecution.execution.execution_id),
    ).toMatchObject({
      status: "interrupted",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(
      projectedExecutions.find((item) => item.executionId === ambiguousExecution.execution.execution_id),
    ).not.toHaveProperty("providerId");
    expect(
      projectedExecutions.find((item) => item.executionId === ambiguousExecution.execution.execution_id),
    ).not.toHaveProperty("modelId");
    expect(
      projectedExecutions.find((item) => item.executionId === mismatchedExecution.execution.execution_id),
    ).not.toHaveProperty("providerId");
    expect(
      projectedExecutions.find((item) => item.executionId === mismatchedExecution.execution.execution_id),
    ).not.toHaveProperty("modelId");
    await expect(readModel.verifications?.(context)).resolves.toEqual([
      expect.objectContaining({
        verificationId: "read-model-verification-0001",
        workId: created.work.work_id,
        passed: true,
        criteria: ["통계 유의성"],
        evidenceArtifactVersionIds: [artifact.artifactVersion.artifact_version_id],
      }),
    ]);
    await expect(readModel.directives?.(context)).resolves.toEqual([
      expect.objectContaining({
        directiveId: directive.directiveId,
        workId: created.work.work_id,
        runId: applicationRun.runId,
        sequence: 1,
        content: "표본 구간을 추가해 주세요",
        mode: "next-stage",
        submittedStage: "context-strategy",
        status: "queued",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    ]);
    const projectedApprovals = await readModel.approvals(context);
    expect(projectedApprovals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approvalId: approval.approval_id,
          action: "tool.call",
          workId: created.work.work_id,
          executionId: execution.execution.execution_id,
          resourceRevision: artifact.work.revision,
          revision: 1,
        }),
        expect.objectContaining({
          approvalId: staffingApproval.approval_id,
          action: "organization.change",
          displayPreview: {
            kind: "provider",
            title: "동적 Staffing 제안",
            reason: "전문 Agent 2명을 추가하고 2개 Task의 담당을 정하는 조직 변경입니다.",
          },
        }),
      ]),
    );
    for (const lineageMismatch of [
      malformedStaffingApproval,
      wrongPolicyStaffingApproval,
      missingDecisionStaffingApproval,
    ]) {
      const failedClosed = projectedApprovals.find((item) => item.approvalId === lineageMismatch.approval_id);
      expect(failedClosed).toMatchObject({ action: "unknown" });
      expect(failedClosed).not.toHaveProperty("displayPreview");
    }
    expect(
      projectedApprovals.find((item) => item.approvalId === wrongWorkStaffingApproval.approval_id),
    ).not.toHaveProperty("displayPreview");
    expect(
      projectedApprovals.find((item) => item.approvalId === blankAssignmentStaffingApproval.approval_id),
    ).not.toHaveProperty("displayPreview");
    expect(
      projectedApprovals.find((item) => item.approvalId === duplicateAgentStaffingApproval.approval_id),
    ).not.toHaveProperty("displayPreview");
    const staffingApprovalProjection = JSON.stringify(
      projectedApprovals.find((item) => item.approvalId === staffingApproval.approval_id),
    );
    for (const internal of ["task-key-secret", "provider-handle-secret", "provider-secret"]) {
      expect(staffingApprovalProjection).not.toContain(internal);
    }

    await expect(readModel.works(otherContext)).resolves.toEqual([]);
    await expect(readModel.messages(otherContext)).resolves.toEqual([]);
    await expect(readModel.executions(otherContext)).resolves.toEqual([]);
    await expect(readModel.artifacts?.(otherContext)).resolves.toEqual([]);
    await expect(readModel.verifications?.(otherContext)).resolves.toEqual([]);
    await expect(readModel.directives?.(otherContext)).resolves.toEqual([]);
    await expect(readModel.approvals(otherContext)).resolves.toEqual([]);
  }, 15_000);
});
