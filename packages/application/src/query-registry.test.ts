import type { TenantContext } from "@massion/identity";
import { describe, expect, it, vi } from "vitest";

import { ApplicationEventCursorExpiredError } from "./event-store.js";
import type { ApplicationReadModel } from "./read-model.js";
import {
  ApplicationQueryRegistry,
  registerApplicationQueries,
  type ApplicationQueryDependencies,
} from "./query-registry.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";

const context: TenantContext = {
  userId: "query-user",
  organizationId: "query-organization",
  membershipId: "query-membership",
  role: "member",
};

const readModel: ApplicationReadModel = {
  watermarks: async () => ({ work: 1 }),
  organization: async () => ({
    organizationId: context.organizationId,
    version: 1,
    nodes: [
      {
        nodeId: "node-representative",
        handle: "representative",
        name: "Iris",
        responsibility: "사용자 요청 조정",
        capabilities: ["request-coordination"],
        status: "active",
        role: "orchestrator",
        scope: "persistent",
        builtin: false,
      },
      {
        nodeId: "node-strategy",
        handle: "strategy",
        name: "Lyra",
        responsibility: "맥락 구성",
        capabilities: ["analysis"],
        parentHandle: "representative",
        status: "active",
        role: "coordinator",
        scope: "persistent",
        builtin: false,
      },
    ],
  }),
  works: async () => [
    { organizationId: context.organizationId, workId: "query-work", status: "running", revision: 2, artifactIds: [] },
    {
      organizationId: context.organizationId,
      workId: "workspace-work",
      status: "running",
      revision: 1,
      artifactIds: [],
      workspaceId: "workspace-shop-api",
    },
  ],
  tasks: async () => [
    {
      organizationId: context.organizationId,
      workId: "query-work",
      taskId: "query-task",
      title: "조회",
      status: "ready",
      revision: 1,
    },
  ],
  assignments: async () => [],
  executions: async () => [],
  rooms: async () => [],
  approvals: async () => [
    {
      organizationId: context.organizationId,
      approvalId: "query-approval",
      action: "tool.call",
      status: "pending",
      requestedBy: "agent",
      expiresAt: "2026-07-11T05:00:00.000Z",
      displayPreview: {
        kind: "command",
        title: "명령 실행",
        executable: "git",
        arguments: ["status", "--short"],
        cwd: "/workspace/project",
      },
    },
  ],
  extensions: async () => [],
};

describe("ApplicationQueryRegistry", () => {
  it("공개 read model 조회를 allowlist·scope로 제공한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["work:read"], "work.list", {})).resolves.toMatchObject({
      operation: "work.list",
      data: [
        { workId: "query-work", status: "running", revision: 2, artifactIds: [] },
        {
          workId: "workspace-work",
          status: "running",
          revision: 1,
          artifactIds: [],
          workspaceId: "workspace-shop-api",
        },
      ],
    });
    await expect(registry.query(context, ["work:read"], "work.tasks", { workId: "query-work" })).resolves.toMatchObject(
      {
        data: [{ taskId: "query-task" }],
      },
    );
    await expect(registry.query(context, ["work:read"], "governance.approval.list", {})).rejects.toMatchObject({
      category: "authorization",
    });
  });

  it("조직 graph snapshot을 안정된 공개 DTO로 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      snapshot: new CollaborationGraphSnapshotProjector(readModel),
    });

    const result = await registry.query(context, ["organization:read"], "organization.graph.snapshot", {});

    expect(result.data).toMatchObject({
      version: { version: 1 },
      nodes: [
        { node_id: "node-representative", scope: "persistent" },
        {
          node_id: "node-strategy",
          handle: "strategy",
          parent_handle: "representative",
          scope: "persistent",
          builtin: false,
        },
      ],
    });
  });

  it("work.provenance는 코드 변경 계보(브랜치·commit)를 반환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      provenance: {
        listByWork: async () => [
          {
            deliveryId: "delivery-1",
            taskId: "task-1",
            agentHandle: "backend-specialist",
            status: "committed",
            branchRef: "massion/work-1",
            commitSha: "abc1234def",
            createdAt: "2026-07-21T09:00:00.000Z",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.provenance", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [{ deliveryId: "delivery-1", commitSha: "abc1234def", branchRef: "massion/work-1", status: "committed" }],
    });
  });

  it("work.timeline은 event·메시지를 병합한 셀 목록을 반환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workTimeline: {
        events: async () => [
          {
            event_id: "event-1",
            sequence: 1,
            event_type: "work_created",
            actor_user_id: "query-user",
            payload_json: "{}",
            created_at: "2026-07-21T09:00:00.000Z",
          },
        ],
        rooms: async () => [{ room_id: "room-1" }],
        messages: async () => [
          {
            message_id: "message-1",
            room_id: "room-1",
            sequence: 1,
            author_kind: "user" as const,
            author_id: "query-user",
            content: "진행 상황 알려주세요",
            created_at: "2026-07-21T09:01:00.000Z",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.timeline", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        { cellId: "event:event-1", kind: "stage" },
        { cellId: "message:message-1", kind: "user-message", detail: "진행 상황 알려주세요" },
      ],
    });
  });

  it("workspace.list와 workspace.get을 workspace:read scope로 제공한다", async () => {
    const registry = new ApplicationQueryRegistry();
    const workspaceView = {
      workspaceId: "workspace-shop-api",
      organizationId: context.organizationId,
      name: "shop-api",
      path: "/home/owner/projects/shop-api",
      kind: "local-directory",
      trust: "trusted",
      status: "active",
      revision: 1,
      createdAt: "2026-07-21T00:00:00.000Z",
      lastUsedAt: "2026-07-21T00:00:00.000Z",
    } as const;
    registerApplicationQueries(registry, {
      readModel,
      workspaces: {
        list: async () => [workspaceView],
        get: async () => workspaceView,
      } as never,
    });
    await expect(registry.query(context, ["workspace:read"], "workspace.list", {})).resolves.toMatchObject({
      data: [{ workspaceId: "workspace-shop-api", path: "/home/owner/projects/shop-api", trust: "trusted" }],
    });
    const got = await registry.query(context, ["workspace:read"], "workspace.get", {
      workspaceId: "workspace-shop-api",
    });
    expect((got as { data: { organizationId?: string } }).data.organizationId).toBeUndefined();
    await expect(registry.query(context, ["work:read"], "workspace.list", {})).rejects.toMatchObject({
      category: "authorization",
    });
  });

  it("work.list는 workspaceId filter를 지원하고 응답에 workspaceId를 포함한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(
      registry.query(context, ["work:read"], "work.list", { workspaceId: "workspace-shop-api" }),
    ).resolves.toMatchObject({
      data: [{ workId: "workspace-work", workspaceId: "workspace-shop-api" }],
    });
    const unfiltered = await registry.query(context, ["work:read"], "work.list", {});
    expect((unfiltered as { data: unknown[] }).data).toHaveLength(2);
  });

  it("work.index를 검색·상태·cursor로 페이지하고 Work detail을 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        works: async () => [
          {
            organizationId: context.organizationId,
            workId: "work-retention",
            title: "고객 이탈 원인 분석",
            status: "running",
            revision: 3,
            artifactIds: ["artifact-version-1"],
            workspaceId: "workspace-shop-api",
            createdAt: "2026-07-21T09:00:00.000Z",
            updatedAt: "2026-07-21T10:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            workId: "work-contract",
            title: "파트너 계약서 검토",
            status: "running",
            revision: 2,
            artifactIds: [],
            createdAt: "2026-07-21T08:00:00.000Z",
            updatedAt: "2026-07-21T09:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            workId: "work-complete",
            title: "주간 운영 보고서",
            status: "completed",
            revision: 5,
            artifactIds: [],
            createdAt: "2026-07-20T08:00:00.000Z",
            updatedAt: "2026-07-20T09:00:00.000Z",
          },
        ],
      },
    } as never);

    const first = await registry.query(context, ["work:read"], "work.index", {
      status: "running",
      limit: 1,
    });
    expect(first).toMatchObject({
      data: {
        items: [{ workId: "work-retention", title: "고객 이탈 원인 분석", status: "running" }],
        nextCursor: "1",
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.index", {
        status: "running",
        cursor: "1",
        limit: 1,
      }),
    ).resolves.toMatchObject({ data: { items: [{ workId: "work-contract" }] } });
    await expect(registry.query(context, ["work:read"], "work.index", { search: "이탈" })).resolves.toMatchObject({
      data: { items: [{ workId: "work-retention" }] },
    });
    await expect(
      registry.query(context, ["work:read"], "work.detail", { workId: "work-retention" }),
    ).resolves.toMatchObject({
      data: {
        workId: "work-retention",
        title: "고객 이탈 원인 분석",
        artifactIds: ["artifact-version-1"],
        artifactVersionIds: ["artifact-version-1"],
        createdAt: "2026-07-21T09:00:00.000Z",
      },
    });
  });

  it("전역 Inbox는 Work 검색·상태·50개 페이지와 무관하게 정본 미해결 항목을 반환한다", async () => {
    const works = Array.from({ length: 51 }, (_, index) => ({
      organizationId: context.organizationId,
      workId: `inbox-work-${String(index).padStart(3, "0")}`,
      title: index === 50 ? "검색 밖 차단 업무" : `일반 업무 ${String(index)}`,
      status: index === 50 ? "running" : "completed",
      revision: 1,
      artifactIds: [],
      updatedAt: `2026-07-21T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const listSuggestionDetails = vi.fn(async () => [
      {
        suggestion: {
          suggestion_id: "suggestion-global-inbox",
          organization_id: context.organizationId,
          work_id: "inbox-work-001",
          target_kind: "memory",
          operation: "add-entry",
          patch_json: "{}",
          summary: "정본 개선 검토",
          rationale: "반복 누락을 줄입니다",
          expected_effect: "누락 감소",
          risk_summary: "검토 필요",
          status: "awaiting-review" as const,
          revision: 4,
          reflection_run_id: "reflection-global-inbox",
          source_reference_ids: [],
        },
      },
    ]);
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        works: async () => works,
        approvals: async () => [
          {
            organizationId: context.organizationId,
            approvalId: "approval-global-inbox",
            action: "tool.call",
            status: "pending",
            requestedBy: "representative",
            workId: "inbox-work-000",
            revision: 2,
            expiresAt: "2026-07-21T10:00:00.000Z",
            displayPreview: { kind: "provider", title: "정본 승인", reason: "실행 전에 확인합니다" },
          },
        ],
      },
      runs: {
        get: async () => {
          throw new Error("사용하지 않음");
        },
        listByWork: async () => [],
        listBlocked: async () => [
          {
            runId: "run-global-inbox",
            organizationId: context.organizationId,
            commandId: "command-global-inbox",
            correlationId: "correlation-global-inbox",
            request: { text: "원문은 Inbox에 노출하지 않습니다" },
            workId: "inbox-work-050",
            stage: "delivery",
            status: "blocked",
            blockedReason: "model-unavailable",
            leaseGeneration: 3,
          },
        ],
      },
      growth: {
        listSuggestions: async () => [],
        listSuggestionDetails,
      } as never,
    } as never);

    await expect(
      registry.query(context, ["work:read", "approval:read", "growth:read"], "inbox.list", {}),
    ).resolves.toMatchObject({
      data: [
        {
          kind: "blocked",
          id: "blocked:run-global-inbox",
          runId: "run-global-inbox",
          workId: "inbox-work-050",
          title: "검색 밖 차단 업무",
          blockedReason: "model-unavailable",
        },
        {
          kind: "approval",
          id: "approval-global-inbox",
          workTitle: "일반 업무 0",
          approval: { approvalId: "approval-global-inbox", revision: 2 },
        },
        {
          kind: "growth",
          id: "growth:suggestion-global-inbox",
          suggestionId: "suggestion-global-inbox",
          workId: "inbox-work-001",
          workTitle: "일반 업무 1",
        },
      ],
    });
    await expect(
      registry.query(context, ["work:read", "approval:read", "growth:read"], "inbox.list", {
        search: "일치하지 않음",
      }),
    ).rejects.toThrow("알 수 없는 필드");
    expect(listSuggestionDetails).toHaveBeenCalledWith(context, {
      status: "awaiting-review",
      limit: 1_000,
      oldestFirst: true,
    });
  });

  it("전역 Inbox는 1001번째 Growth 검토까지 완전 조회하고 연결 Approval을 중복 노출하지 않는다", async () => {
    const createdAt = "2026-07-21T09:00:00.000Z";
    const details = Array.from({ length: 1_001 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return {
        suggestion: {
          suggestion_id: `suggestion-inbox-${suffix}`,
          organization_id: context.organizationId,
          work_id: "query-work",
          target_kind: "memory" as const,
          operation: "add-entry",
          patch_json: "{}",
          summary: `${suffix}번째 개선 검토`,
          rationale: "검토가 필요합니다",
          expected_effect: "누락 감소",
          risk_summary: "검토 필요",
          status: "awaiting-review" as const,
          revision: 1,
          reflection_run_id: `reflection-inbox-${suffix}`,
          source_reference_ids: [],
          created_at: createdAt,
        },
        ...(index === 1_000
          ? {
              adoption: {
                adoptionId: "adoption-inbox-1000",
                status: "awaiting-review" as const,
                commandId: "adoption-command-inbox-1000",
                approvalId: "approval-growth-inbox-1000",
                evaluationRunId: "evaluation-inbox-1000",
                evaluationInputHash: "e".repeat(64),
                beforeVersionId: "memory-before-inbox-1000",
                beforeChecksum: "b".repeat(64),
              },
            }
          : {}),
      };
    });
    const listSuggestionDetails = vi.fn(
      async (_context: TenantContext, input: { readonly after?: { readonly suggestionId: string } }) =>
        input.after === undefined ? details.slice(0, 1_000) : details.slice(1_000),
    );
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        approvals: async () => [
          {
            organizationId: context.organizationId,
            approvalId: "approval-growth-inbox-1000",
            action: "growth.adopt",
            status: "pending",
            requestedBy: "growth",
            workId: "query-work",
            revision: 1,
            expiresAt: "2026-07-22T09:00:00.000Z",
          },
        ],
      },
      growth: { listSuggestions: async () => [], listSuggestionDetails } as never,
    });

    const response = await registry.query(context, ["work:read", "approval:read", "growth:read"], "inbox.list", {});
    const items = response.data as Array<{ readonly kind: string; readonly id: string }>;
    expect(items.filter((item) => item.kind === "approval")).toEqual([]);
    expect(items).toContainEqual(expect.objectContaining({ kind: "growth", id: "growth:suggestion-inbox-1000" }));
    expect(items.filter((item) => item.kind === "growth")).toHaveLength(1_001);
    expect(listSuggestionDetails).toHaveBeenNthCalledWith(2, context, {
      status: "awaiting-review",
      limit: 1_000,
      oldestFirst: true,
      after: { createdAt, suggestionId: "suggestion-inbox-0999" },
    });
  });

  it("Work inspector 조회는 연결 필드만 공개하고 artifact content는 노출하지 않는다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        executions: async () => [
          {
            organizationId: context.organizationId,
            executionId: "execution-work-1",
            workId: "query-work",
            taskId: "query-task",
            agentHandle: "representative",
            modelRoute: "balanced",
            status: "running",
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            inputTokens: 10,
            outputTokens: 20,
            costMicros: 30,
            createdAt: "2026-07-21T09:02:00.000Z",
            credentialId: "credential-secret",
            lease: "lease-secret",
            prompt: "prompt-secret",
            input: "input-secret",
            output: "output-secret",
            explanation: "explanation-secret",
            receipt: "receipt-secret",
          },
        ],
        artifacts: async () => [
          {
            organizationId: context.organizationId,
            artifactId: "artifact-1",
            artifactVersionId: "artifact-version-1",
            workId: "query-work",
            name: "이탈 분석 보고서",
            kind: "report",
            version: 1,
            mediaType: "application/pdf",
            checksum: "a".repeat(64),
            createdBy: "analysis",
            createdAt: "2026-07-21T09:03:00.000Z",
            contentJson: '{"secret":"노출 금지"}',
          },
        ],
        verifications: async () => [
          {
            organizationId: context.organizationId,
            verificationId: "verification-1",
            workId: "query-work",
            verifierId: "assurance",
            passed: true,
            criteria: ["통계 유의성"],
            evidenceArtifactVersionIds: ["artifact-version-1"],
            createdAt: "2026-07-21T09:04:00.000Z",
          },
        ],
        directives: async () => [
          {
            organizationId: context.organizationId,
            directiveId: "directive-1",
            workId: "query-work",
            runId: "run-work-1",
            sequence: 1,
            content: "표본 구간을 추가해 주세요",
            mode: "next-stage",
            submittedStage: "delivery",
            status: "queued",
            revision: 9,
            leaseGeneration: 4,
            createdAt: "2026-07-21T09:05:00.000Z",
            updatedAt: "2026-07-21T09:05:00.000Z",
          },
        ],
        approvals: async () => [
          {
            organizationId: context.organizationId,
            approvalId: "approval-work-1",
            workId: "query-work",
            executionId: "execution-work-1",
            action: "tool.call",
            status: "pending",
            requestedBy: "representative",
            revision: 2,
            expiresAt: "2026-07-21T10:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            approvalId: "approval-other",
            workId: "other-work",
            action: "tool.call",
            status: "pending",
            requestedBy: "representative",
            revision: 1,
            expiresAt: "2026-07-21T10:00:00.000Z",
          },
        ],
      },
      runs: {
        get: async () => {
          throw new Error("사용하지 않음");
        },
        listByWork: async () => [
          {
            runId: "run-work-1",
            organizationId: context.organizationId,
            commandId: "command-run-work-1",
            correlationId: "correlation-run-work-1",
            request: { text: "원문 노출 금지" },
            workId: "query-work",
            stage: "delivery",
            status: "running",
            leaseGeneration: 2,
            createdAt: "2026-07-21T09:00:00.000Z",
            updatedAt: "2026-07-21T09:01:00.000Z",
          },
        ],
      },
    } as never);

    const results = await Promise.all([
      registry.query(context, ["work:read"], "run.list", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.executions", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.artifacts", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.artifact.get", {
        workId: "query-work",
        artifactVersionId: "artifact-version-1",
      }),
      registry.query(context, ["work:read"], "work.verifications", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.directive.list", { workId: "query-work" }),
      registry.query(context, ["approval:read"], "governance.approval.list", {
        workId: "query-work",
        status: "pending",
      }),
    ]);
    expect(results[0]).toMatchObject({ data: [{ runId: "run-work-1", workId: "query-work" }] });
    expect(results[1]).toMatchObject({
      data: [
        {
          executionId: "execution-work-1",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
        },
      ],
    });
    expect(results[2]).toMatchObject({ data: [{ artifactVersionId: "artifact-version-1", name: "이탈 분석 보고서" }] });
    expect(results[3]).toMatchObject({ data: { artifactId: "artifact-1" } });
    expect(results[4]).toMatchObject({ data: [{ verificationId: "verification-1", passed: true }] });
    expect(results[5]).toMatchObject({
      data: [{ directiveId: "directive-1", status: "queued", revision: 9 }],
    });
    expect(results[6]).toMatchObject({
      data: [
        {
          approvalId: "approval-work-1",
          workId: "query-work",
          executionId: "execution-work-1",
          revision: 2,
        },
      ],
    });
    expect(JSON.stringify(results)).not.toContain("원문 노출 금지");
    expect(JSON.stringify(results)).not.toContain("contentJson");
    expect(JSON.stringify(results)).not.toContain("노출 금지");
    for (const secret of [
      "credential-secret",
      "lease-secret",
      "prompt-secret",
      "input-secret",
      "output-secret",
      "explanation-secret",
      "receipt-secret",
    ]) {
      expect(JSON.stringify(results)).not.toContain(secret);
    }
  });

  it("work.activity.list는 최신 활동부터 cursor로 이전 활동을 페이지한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workTimeline: {
        events: async () => [
          {
            event_id: "event-1",
            sequence: 1,
            event_type: "work_created",
            actor_user_id: "query-user",
            payload_json: "{}",
            created_at: "2026-07-21T09:00:00.000Z",
          },
          {
            event_id: "event-2",
            sequence: 2,
            event_type: "task_created",
            actor_user_id: "query-user",
            payload_json: '{"title":"원인 분석"}',
            created_at: "2026-07-21T09:01:00.000Z",
          },
        ],
        rooms: async () => [{ room_id: "room-1" }],
        messages: async () => [
          {
            message_id: "message-1",
            room_id: "room-1",
            sequence: 1,
            message_type: "handoff",
            author_kind: "agent" as const,
            author_id: "analysis",
            content: "분석을 시작했습니다",
            created_at: "2026-07-21T09:02:00.000Z",
          },
        ],
      },
    });

    const latest = await registry.query(context, ["work:read"], "work.activity.list", {
      workId: "query-work",
      limit: 2,
    });
    expect(latest).toMatchObject({
      data: {
        items: [
          { activityId: "message:message-1", kind: "message", authorKind: "agent", messageType: "handoff" },
          { activityId: "event:event-2", kind: "task" },
        ],
        nextCursor: "2",
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.activity.list", {
        workId: "query-work",
        cursor: "2",
        limit: 2,
      }),
    ).resolves.toMatchObject({ data: { items: [{ activityId: "event:event-1" }] } });
  });

  it("unknown operation·payload field와 role을 거부한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["application:*"], "unknown.read", {})).rejects.toMatchObject({
      category: "validation",
    });
    await expect(registry.query(context, ["work:read"], "work.list", { injected: true })).rejects.toThrow("알 수 없는");
  });

  it("진행 중인 Application run은 요청 원문 없이 현재 Work 연결만 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      runs: {
        get: async () => ({
          runId: "query-run-0001",
          organizationId: context.organizationId,
          commandId: "query-run-command-0001",
          correlationId: "query-run-correlation-0001",
          request: { text: "공개하면 안 되는 요청 원문" },
          workId: "query-work",
          stage: "delivery",
          status: "running",
          leaseGeneration: 3,
        }),
      },
    } as never);

    const result = await registry.query(context, ["work:read"], "run.get", { runId: "query-run-0001" });

    expect(result).toMatchObject({
      operation: "run.get",
      data: {
        runId: "query-run-0001",
        workId: "query-work",
        stage: "delivery",
        status: "running",
        leaseGeneration: 3,
      },
    });
    expect(JSON.stringify(result)).not.toContain("공개하면 안 되는 요청 원문");
  });

  it("차단 상세는 exact bounded result만 공개하고 arbitrary result는 노출하지 않는다", async () => {
    const cases = [
      {
        name: "valid",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "산출물의 모순을 보완해야 합니다." },
        expected: "산출물의 모순을 보완해야 합니다.",
      },
      {
        name: "extra-key",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "노출 금지", secret: "arbitrary-result-secret" },
      },
      {
        name: "oversize",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "x".repeat(2_049) },
      },
      {
        name: "control",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "숨은\u0001문자" },
      },
      {
        name: "tab-control",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "탭\t문자" },
      },
      {
        name: "lf-control",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "줄\n바꿈" },
      },
      {
        name: "cr-control",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "캐리지\r리턴" },
      },
      {
        name: "malformed",
        status: "blocked",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: 42 },
      },
      {
        name: "wrong-reason",
        status: "blocked",
        blockedReason: "model-unavailable",
        result: { blockedDetail: "노출 금지" },
      },
      {
        name: "wrong-status",
        status: "running",
        blockedReason: "assurance-verifier-rejected",
        result: { blockedDetail: "노출 금지" },
      },
    ];

    for (const candidate of cases) {
      const registry = new ApplicationQueryRegistry();
      registerApplicationQueries(registry, {
        readModel,
        runs: {
          get: async () => ({
            runId: `query-run-detail-${candidate.name}`,
            organizationId: context.organizationId,
            commandId: `query-run-detail-command-${candidate.name}`,
            correlationId: `query-run-detail-correlation-${candidate.name}`,
            request: {},
            workId: "query-work",
            stage: "assurance",
            status: candidate.status,
            blockedReason: candidate.blockedReason,
            result: candidate.result,
            leaseGeneration: 3,
          }),
        },
      } as never);

      const queried = await registry.query(context, ["work:read"], "run.get", {
        runId: `query-run-detail-${candidate.name}`,
      });
      if (candidate.expected === undefined) expect(queried.data).not.toHaveProperty("blockedDetail");
      else expect(queried.data).toMatchObject({ blockedDetail: candidate.expected });
      expect(JSON.stringify(queried)).not.toContain("arbitrary-result-secret");
    }
  });

  it("감사 사건 cursor가 보존 범위 밖이면 snapshot 재동기화가 가능한 공개 오류로 변환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      audit: {
        read: async () => {
          throw new ApplicationEventCursorExpiredError(50);
        },
      },
    });

    await expect(
      registry.query(context, ["audit:read"], "application.audit", { after: 1, limit: 1000 }),
    ).rejects.toMatchObject({
      category: "conflict",
      operatorCode: "APP_EVENT_CURSOR_EXPIRED",
      retryable: true,
    });
  });

  it("승인 목록과 단건 조회에 비밀 제거 표시 미리보기만 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });

    await expect(registry.query(context, ["approval:read"], "governance.approval.list", {})).resolves.toMatchObject({
      data: [
        {
          approvalId: "query-approval",
          displayPreview: {
            kind: "command",
            title: "명령 실행",
            executable: "git",
            arguments: ["status", "--short"],
            cwd: "/workspace/project",
          },
        },
      ],
    });
    await expect(
      registry.query(context, ["approval:read"], "governance.approval.get", { approvalId: "query-approval" }),
    ).resolves.toMatchObject({
      data: {
        approvalId: "query-approval",
        displayPreview: {
          kind: "command",
          executable: "git",
          arguments: ["status", "--short"],
        },
      },
    });
  });

  it("성장 제안 목록을 secret patch 없이 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      growth: {
        resolveConfiguration: async () => ({}),
        getActiveEvaluationStrategy: async () => ({}),
        listSuggestions: async () => [
          {
            suggestion_id: "suggestion-1",
            work_id: "query-work",
            target_kind: "prompt",
            operation: "replace-instruction",
            summary: "검증 강화",
            rationale: "반복 오류 감소",
            expected_effect: "회귀 감소",
            risk_summary: "지시문 증가",
            status: "proposed",
            patch_json: '{"secret":"공개 금지"}',
          },
        ],
        listEffectEvaluations: async () => [
          {
            effectEvaluationId: "effect-1",
            adoptionId: "adoption-1",
            result: "improved",
            rawDelta: 0.1,
            directionalDelta: 0.1,
            contractChecksum: "a".repeat(64),
          },
        ],
      } as never,
    });
    await expect(registry.query(context, ["growth:read"], "growth.suggestions", {})).resolves.toMatchObject({
      data: [{ suggestionId: "suggestion-1", summary: "검증 강화", status: "proposed" }],
    });
    expect(JSON.stringify(await registry.query(context, ["growth:read"], "growth.suggestions", {}))).not.toContain(
      "공개 금지",
    );
    await expect(registry.query(context, ["growth:read"], "growth.effects", { limit: 10 })).resolves.toMatchObject({
      data: [{ effectEvaluationId: "effect-1", result: "improved" }],
    });
  });

  it("실제 Growth 상세 조회의 평가·계보·patch를 개선 화면 계약으로 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      growth: {
        resolveConfiguration: async () => ({}),
        getActiveEvaluationStrategy: async () => ({}),
        listSuggestions: async () => [],
        listSuggestionDetails: async () => [
          {
            suggestion: {
              suggestion_id: "suggestion-detail",
              work_id: "query-work",
              target_kind: "prompt",
              operation: "replace-instruction",
              summary: "실제 근거 연결",
              rationale: "완료 Work에서 반복된 근거",
              expected_effect: "재작업 감소",
              risk_summary: "지시문이 길어짐",
              status: "awaiting-review",
              revision: 2,
              reflection_run_id: "reflection-detail",
              source_reference_ids: ["work:query-work"],
              patch_json: "{}",
              created_at: { toISOString: () => "2026-07-26T06:00:00.000Z" },
            },
            patch: { agentHandle: "context", instruction: "근거를 먼저 확인합니다" },
            evaluation: {
              evaluationRunId: "evaluation-detail",
              outcome: "eligible",
              strategyVersionId: "strategy-detail",
              signals: [
                {
                  signalId: "lineage",
                  group: "required",
                  origin: "deterministic",
                  outcome: "passed",
                  score: 1,
                  adapterId: "lineage",
                  adapterVersion: "1",
                  unit: "boolean",
                },
              ],
            },
          },
        ],
        getSuggestionDetails: async () =>
          ({
            suggestion: {
              suggestion_id: "suggestion-detail",
              work_id: "query-work",
              target_kind: "prompt",
              operation: "replace-instruction",
              summary: "실제 근거 연결",
              rationale: "완료 Work에서 반복된 근거",
              expected_effect: "재작업 감소",
              risk_summary: "지시문이 길어짐",
              status: "awaiting-review",
              revision: 2,
              reflection_run_id: "reflection-detail",
              source_reference_ids: ["work:query-work"],
              patch_json: "{}",
            },
            patch: { instruction: "근거를 먼저 확인합니다" },
          }) as never,
        listEffectEvaluations: async () => [],
      } as never,
    });

    await expect(registry.query(context, ["growth:read"], "growth.suggestions", {})).resolves.toMatchObject({
      data: [
        {
          suggestionId: "suggestion-detail",
          createdAt: "2026-07-26T06:00:00.000Z",
          revision: 2,
          sourceReferenceIds: ["work:query-work"],
          patch: { instruction: "근거를 먼저 확인합니다" },
          evaluation: {
            evaluationRunId: "evaluation-detail",
            outcome: "eligible",
            signals: [{ signalId: "lineage", note: "boolean" }],
          },
        },
      ],
    });
    await expect(
      registry.query(context, ["growth:read"], "growth.suggestion.get", { suggestionId: "suggestion-detail" }),
    ).resolves.toMatchObject({
      data: { suggestionId: "suggestion-detail", patch: { instruction: "근거를 먼저 확인합니다" } },
    });
  });

  it("모델 route의 운영 상태와 예산만 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listRoutes: async () => [
          {
            route_id: "route-1",
            name: "coding-balanced",
            route_kind: "chat",
            credential_policy: "weighted",
            data_policy: "external-allowed",
            equivalence_group: "coding",
            spent_micros: 10,
            total_budget_micros: 100,
            enabled: true,
          },
        ],
      } as never,
    });
    await expect(registry.query(context, ["router:read"], "router.routes", {})).resolves.toMatchObject({
      data: [{ routeId: "route-1", name: "coding-balanced", credentialPolicy: "weighted" }],
    });
  });

  it("제공자 구성과 발견한 모델 카탈로그를 공개 필드만 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      providers: {
        listProviders: async () => [
          { provider_id: "openai", display_name: "OpenAI", adapter_kind: "openai-compatible", enabled: true },
        ],
        listEndpoints: async () => [
          {
            endpoint_id: "endpoint-1",
            provider_id: "openai",
            name: "API",
            base_url: "https://api.openai.com/v1",
            local: false,
            enabled: true,
          },
        ],
        listModelCatalog: async () => ({
          models: [
            {
              catalog_entry_id: "catalog-entry-1",
              organization_id: context.organizationId,
              provider_id: "openai",
              endpoint_id: "endpoint-1",
              model_id: "gpt-5",
              metadata: {
                id: "gpt-5",
                ownedBy: "private-owner-detail",
                canonicalId: "openai/gpt-5",
                displayName: "GPT-5",
                contextWindow: 128_000,
                supportsTools: true,
                supportsStructuredOutput: true,
                supportsVision: true,
                supportsStreaming: true,
                inputCostMicrosPerMillion: 1_250_000,
                outputCostMicrosPerMillion: 10_000_000,
                expirationDate: "2027-01-01",
                privateToken: "must-not-leak",
              },
              metadata_json: '{"privateToken":"must-not-leak"}',
              metadata_digest: "private-metadata-digest",
              state: "active",
              snapshot_id: "private-snapshot-id",
              first_seen_at: "2026-08-10T01:00:00.000Z",
              last_seen_at: "2026-08-10T02:00:00.000Z",
              created_at: "2026-08-10T01:00:00.000Z",
              updated_at: "2026-08-10T02:00:00.000Z",
            },
          ],
          statuses: [
            {
              organization_id: context.organizationId,
              provider_id: "openai",
              endpoint_id: "endpoint-1",
              sync_sequence: 3,
              status: "available",
              authentication_scope: "credential",
              credential_id: "private-credential-id",
              credential_version: 7,
              credential_secret_version: 4,
              active_count: 1,
              invalid_count: 2,
              duplicate_count: 1,
              catalog_digest: "catalog-digest",
              diagnostic_reason: "partial-source-data",
              retry_at: "2026-08-10T03:00:00.000Z",
              last_attempted_at: "2026-08-10T02:00:00.000Z",
              last_successful_at: "2026-08-10T02:00:01.000Z",
              created_at: "2026-08-10T01:00:00.000Z",
              updated_at: "2026-08-10T02:00:01.000Z",
            },
          ],
        }),
      },
      router: {
        listModels: async () => [
          {
            model_profile_id: "profile-1",
            provider_id: "openai",
            endpoint_id: "endpoint-1",
            model_id: "gpt",
            route_kind: "chat",
            equivalence_group: "general",
            verified: true,
            enabled: true,
          },
        ],
        listCandidates: async () => [
          {
            candidate_id: "candidate-1",
            route_id: "route-1",
            model_profile_id: "profile-1",
            priority: 1,
            enabled: true,
          },
        ],
      },
    } as never);
    await expect(registry.query(context, ["router:read"], "router.catalog", {})).resolves.toEqual({
      schemaVersion: "massion.application.v1",
      operation: "router.catalog",
      data: {
        providers: [{ providerId: "openai", displayName: "OpenAI", adapterKind: "openai-compatible", enabled: true }],
        endpoints: [
          {
            endpointId: "endpoint-1",
            providerId: "openai",
            name: "API",
            baseUrl: "https://api.openai.com/v1",
            local: false,
            gatewayKind: undefined,
            enabled: true,
          },
        ],
        models: [
          {
            modelProfileId: "profile-1",
            providerId: "openai",
            endpointId: "endpoint-1",
            modelId: "gpt",
            routeKind: "chat",
            equivalenceGroup: "general",
            verified: true,
            enabled: true,
          },
        ],
        candidates: [
          { candidateId: "candidate-1", routeId: "route-1", modelProfileId: "profile-1", priority: 1, enabled: true },
        ],
        discoveredModels: [
          {
            catalogEntryId: "catalog-entry-1",
            providerId: "openai",
            endpointId: "endpoint-1",
            modelId: "gpt-5",
            state: "active",
            canonicalId: "openai/gpt-5",
            displayName: "GPT-5",
            contextWindow: 128_000,
            supportsTools: true,
            supportsStructuredOutput: true,
            supportsVision: true,
            supportsStreaming: true,
            inputCostMicrosPerMillion: 1_250_000,
            outputCostMicrosPerMillion: 10_000_000,
            expirationDate: "2027-01-01",
            firstSeenAt: "2026-08-10T01:00:00.000Z",
            lastSeenAt: "2026-08-10T02:00:00.000Z",
          },
        ],
        catalogStatuses: [
          {
            providerId: "openai",
            endpointId: "endpoint-1",
            status: "available",
            authenticationScope: "credential",
            activeCount: 1,
            invalidCount: 2,
            duplicateCount: 1,
            catalogDigest: "catalog-digest",
            diagnosticReason: "partial-source-data",
            retryAt: "2026-08-10T03:00:00.000Z",
            lastAttemptedAt: "2026-08-10T02:00:00.000Z",
            lastSuccessfulAt: "2026-08-10T02:00:01.000Z",
          },
        ],
      },
    });
  });

  it("모델 호출 기록은 scope·role·strict limit 계약을 지킨다", async () => {
    const calls: Array<{ context: TenantContext; limit: number }> = [];
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listAttempts: async (queryContext: TenantContext, limit: number) => {
          calls.push({ context: queryContext, limit });
          return [];
        },
      } as never,
    });

    await expect(registry.query(context, [], "router.attempts", {})).rejects.toMatchObject({
      category: "authorization",
    });
    await expect(
      registry.query({ ...context, role: "guest" as never }, ["router:read"], "router.attempts", {}),
    ).rejects.toMatchObject({ category: "authorization" });
    await expect(registry.query(context, ["router:read"], "router.attempts", { cursor: "0" })).rejects.toThrow(
      "알 수 없는 필드",
    );
    await expect(registry.query(context, ["router:read"], "router.attempts", { limit: 0 })).rejects.toThrow("limit");
    await expect(registry.query(context, ["router:read"], "router.attempts", { limit: Number.NaN })).rejects.toThrow(
      "limit",
    );
    await expect(registry.query(context, ["router:read"], "router.attempts", { limit: 201 })).rejects.toThrow("limit");
    await expect(registry.query(context, ["router:read"], "router.attempts", {})).resolves.toMatchObject({
      data: [],
    });
    await expect(registry.query(context, ["router:read"], "router.attempts", { limit: 200 })).resolves.toMatchObject({
      data: [],
    });
    expect(calls).toEqual([
      { context, limit: 50 },
      { context, limit: 200 },
    ]);
  });

  it("모델 호출 기록은 실행·Work 계보만 사람용 view로 공개하고 내부 선택 재료를 redaction한다", async () => {
    const hasBatch = vi.fn(async (_context: TenantContext, batchId: string) => batchId === "batch-attempt-1");
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        executions: async () => [
          {
            organizationId: context.organizationId,
            executionId: "execution-attempt-1",
            workId: "query-work",
            agentHandle: "representative",
            modelRoute: "coding-balanced",
            status: "succeeded",
            inputTokens: 13,
            outputTokens: 8,
            costMicros: 21,
          },
        ],
        works: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            title: "고객 이탈 원인 분석",
            status: "completed",
            revision: 3,
            artifactIds: [],
          },
        ],
      },
      router: {
        listAttempts: async () => [
          {
            attempt_id: "attempt-public-1",
            route_id: "route-reasoning",
            model_profile_id: "profile-gpt-coding",
            model_id: "gpt-coding",
            provider_id: "openai",
            execution_id: "execution-attempt-1",
            optimization_batch_id: "batch-attempt-1",
            status: "succeeded",
            status_code: 200,
            actual_input_tokens: 13,
            actual_output_tokens: 8,
            actual_cost_micros: 21,
            fallback_from_attempt_id: "attempt-public-0",
            created_at: new Date("2026-07-30T01:00:00.000Z"),
            credential_id: "credential-private",
            credential_secret_version: 7,
            sticky_key_hash: "sticky-private",
            effective_credential_policy: "weighted",
            explanation_json: '{"secret":"unsafe-explanation"}',
          },
        ],
      } as never,
      optimization: {
        evaluations: { hasEvaluationRun: async () => false } as never,
        batches: { hasBatch } as never,
      },
    });

    const result = await registry.query(context, ["router:read"], "router.attempts", {});

    expect(result.data).toEqual([
      {
        attemptId: "attempt-public-1",
        at: "2026-07-30T01:00:00.000Z",
        routeId: "route-reasoning",
        // ADR-003 §4가 잇는 계보 사슬의 연결 고리입니다. 등록이 제거돼도 남으므로
        // 이름을 잃은 과거 호출도 서로 구분됩니다. 비밀이 아니라 조회의 join key입니다.
        modelProfileId: "profile-gpt-coding",
        modelId: "gpt-coding",
        providerId: "openai",
        executionId: "execution-attempt-1",
        optimizationBatchId: "batch-attempt-1",
        status: "succeeded",
        statusCode: 200,
        inputTokens: 13,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costMicros: 21,
        fallbackFrom: "attempt-public-0",
        workId: "query-work",
        workTitle: "고객 이탈 원인 분석",
      },
    ]);
    expect(hasBatch).toHaveBeenCalledWith(context, "batch-attempt-1");
    expect(JSON.stringify(result.data)).not.toMatch(/credential|sticky|policy|explanation|unsafe/iu);
  });

  it("중단 상태와 신규·기존 모델 평가 run 계보를 runtime Work 없이 명시적으로 투영한다", async () => {
    const hasEvaluationRun = vi.fn(async (_context: TenantContext, runId: string) =>
      ["optimization-run-new", "optimization-run-legacy"].includes(runId),
    );
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listAttempts: async () => [
          {
            attempt_id: "attempt-interrupted",
            route_id: "route-1",
            model_profile_id: "profile-gpt",
            model_id: "gpt",
            provider_id: "openai",
            optimization_run_id: "optimization-run-new",
            status: "interrupted",
            failure_class: "network",
            actual_input_tokens: 3,
            actual_output_tokens: 1,
            actual_cost_micros: 4,
            created_at: "2026-07-30T03:00:00.000Z",
          },
          {
            attempt_id: "attempt-legacy-evaluation",
            route_id: "route-1",
            model_profile_id: "profile-gpt",
            model_id: "gpt",
            provider_id: "openai",
            execution_id: "optimization-run-legacy",
            status: "succeeded",
            actual_input_tokens: 2,
            actual_output_tokens: 1,
            actual_cost_micros: 3,
            created_at: "2026-07-30T02:00:00.000Z",
          },
        ],
      } as never,
      optimization: {
        evaluations: { hasEvaluationRun } as never,
        batches: {} as never,
      },
    });

    await expect(registry.query(context, ["router:read"], "router.attempts", {})).resolves.toMatchObject({
      data: [
        {
          attemptId: "attempt-interrupted",
          optimizationRunId: "optimization-run-new",
          status: "interrupted",
        },
        {
          attemptId: "attempt-legacy-evaluation",
          optimizationRunId: "optimization-run-legacy",
          status: "succeeded",
        },
      ],
    });
    expect(hasEvaluationRun).toHaveBeenCalledWith(context, "optimization-run-new");
    expect(hasEvaluationRun).toHaveBeenCalledWith(context, "optimization-run-legacy");
  });

  it("runtime·optimization 어느 정본에도 없는 기존 execution 계보는 fail-closed한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listAttempts: async () => [
          {
            attempt_id: "attempt-orphan-lineage",
            route_id: "route-1",
            model_profile_id: "profile-gpt",
            model_id: "gpt",
            provider_id: "openai",
            execution_id: "orphan-lineage",
            status: "succeeded",
            actual_input_tokens: 1,
            actual_output_tokens: 1,
            actual_cost_micros: 1,
            created_at: "2026-07-30T01:00:00.000Z",
          },
        ],
      } as never,
      optimization: {
        evaluations: { hasEvaluationRun: async () => false } as never,
        batches: {} as never,
      },
    });

    await expect(registry.query(context, ["router:read"], "router.attempts", {})).rejects.toThrow("계보");
  });

  it("Route Attempt 시각은 유효한 UTC instant를 밀리초 ISO로 정규화한다", async () => {
    const attempt = (createdAt: unknown) => ({
      attempt_id: "attempt-time",
      route_id: "route-1",
      model_profile_id: "profile-gpt",
      model_id: "gpt",
      provider_id: "openai",
      status: "succeeded",
      actual_input_tokens: 1,
      actual_output_tokens: 1,
      actual_cost_micros: 1,
      created_at: createdAt,
    });
    const query = async (createdAt: unknown) => {
      const registry = new ApplicationQueryRegistry();
      registerApplicationQueries(registry, {
        readModel,
        router: { listAttempts: async () => [attempt(createdAt)] } as never,
      });
      return await registry.query(context, ["router:read"], "router.attempts", {});
    };

    await expect(query(0)).rejects.toThrow("시각");
    await expect(query("2026-02-30T00:00:00.000Z")).rejects.toThrow("시각");
    await expect(query(new Date(Number.NaN))).rejects.toThrow("시각");
    await expect(query({ toISOString: () => "2026-07-30T01:02:03.004Z" })).resolves.toMatchObject({
      data: [{ at: "2026-07-30T01:02:03.004Z" }],
    });
    await expect(query({ toISOString: () => "2026-07-30T01:02:03.004567Z" })).resolves.toMatchObject({
      data: [{ at: "2026-07-30T01:02:03.004Z" }],
    });
  });

  it("손상된 모델 호출 기록을 빈 값으로 숨기지 않고 fail-closed한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listAttempts: async () => [
          {
            attempt_id: "attempt-malformed",
            route_id: "route-1",
            model_profile_id: "profile-gpt",
            model_id: "gpt",
            provider_id: "openai",
            status: "succeeded",
            actual_input_tokens: "13",
            actual_output_tokens: 8,
            actual_cost_micros: 21,
            created_at: "2026-07-30T01:00:00.000Z",
          },
        ],
      } as never,
    });

    await expect(registry.query(context, ["router:read"], "router.attempts", {})).rejects.toThrow("Route Attempt");
  });

  it("모델 최적화 조회는 adapter가 덧붙인 prompt·credential 필드를 redaction한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      optimization: {
        evaluations: {
          getActivePolicy: async () => ({
            policyVersionId: "policy-1",
            organizationId: context.organizationId,
            version: 1,
            policy: "quality",
            autoOptimize: false,
            productionLearning: false,
            shadowEnabled: false,
            minimumSampleCount: 3,
            improvementThreshold: 0.05,
            observationBudgetMicros: 100,
            observationRetentionDays: 7,
            status: "active",
            checksum: "a".repeat(64),
            prompt: "prompt-secret",
          }),
          previewEvaluation: async () => ({
            bundleId: "bundle-1",
            bundleVersion: 1,
            modelProfileId: "profile-1",
            runtimeVersion: "runtime-1",
            configurationChecksum: "d".repeat(64),
            expectedCallCount: 3,
            maximumCostMicros: 30,
            providerId: "provider-1",
            dataKinds: ["evaluation-prompt"],
            checksum: "e".repeat(64),
            credential: "preflight-credential-secret",
          }),
          listReceipts: async () => [
            {
              receiptId: "receipt-1",
              runId: "run-1",
              organizationId: context.organizationId,
              roleKey: "assurance",
              modelProfileId: "profile-1",
              bundleId: "bundle-1",
              bundleVersion: 1,
              sampleCount: 1,
              qualityScore: 0.9,
              latencyMs: 10,
              costMicros: 1,
              privacyAllowed: true,
              completed: true,
              inputChecksum: "b".repeat(64),
              receiptChecksum: "c".repeat(64),
              credential: "credential-secret",
            },
          ],
          listRecommendations: async () => [],
        } as never,
        batches: { getActiveBatch: async () => undefined, listObservations: async () => [] } as never,
      },
    });

    const policy = await registry.query(context, ["optimization:read"], "optimization.policy", {});
    const preflight = await registry.query(context, ["optimization:read"], "optimization.evaluation.preflight", {
      roleKey: "assurance",
      bundleId: "bundle-1",
      modelProfileId: "profile-1",
      runtimeVersion: "runtime-1",
    });
    const receipts = await registry.query(context, ["optimization:read"], "optimization.receipts", {});
    expect(JSON.stringify(policy)).not.toContain("prompt-secret");
    expect(JSON.stringify(preflight)).not.toContain("preflight-credential-secret");
    expect(preflight.data).toEqual([
      expect.objectContaining({ expectedCallCount: 3, maximumCostMicros: 30, providerId: "provider-1" }),
    ]);
    expect(JSON.stringify(receipts)).not.toContain("credential-secret");
    expect(receipts.data).toEqual([expect.objectContaining({ bundleId: "bundle-1" })]);
    expect(policy.data).toEqual([expect.objectContaining({ policyVersionId: "policy-1", checksum: "a".repeat(64) })]);
  });

  it("Assurance 계보는 Runtime check의 durable Route Attempt와 system adapter를 안전하게 투영한다", async () => {
    const listAttemptLineagesByExecution = vi.fn(async (_context: TenantContext, executionId: string) => {
      if (executionId !== "execution-assurance-check") throw new Error("예상하지 않은 실행 ID");
      return [
        {
          attemptId: "attempt-assurance-first",
          executionId,
          modelProfileId: "profile-assurance-first",
          status: "failed" as const,
          placementReceipt: {
            workId: "query-work",
            taskId: "query-task",
            taskAxis: "code-understanding" as const,
            reasoningDifficulty: "high" as const,
            selectionBasis: "task-axis-evidence-available" as const,
            axisEvidence: {
              bundleId: "bundle-assurance",
              bundleVersion: 1,
              receiptIds: ["receipt-assurance"],
              rankedModelProfileIds: ["profile-assurance-first"],
            },
          },
          explanation: "explanation-secret",
          credentialId: "credential-secret",
          usage: { inputTokens: 91 },
        },
        {
          attemptId: "attempt-assurance-fallback",
          executionId,
          modelProfileId: "profile-assurance-fallback",
          fallbackFromAttemptId: "attempt-assurance-first",
          status: "succeeded" as const,
          placementReceipt: {
            workId: "query-work",
            taskId: "query-task",
            taskAxis: "code-understanding" as const,
            reasoningDifficulty: "high" as const,
            selectionBasis: "task-axis-evidence-available" as const,
            axisEvidence: {
              bundleId: "bundle-assurance",
              bundleVersion: 1,
              receiptIds: ["receipt-assurance"],
              rankedModelProfileIds: ["profile-assurance-first"],
            },
          },
          explanation: "explanation-secret",
        },
      ];
    });
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        executions: async () => [
          {
            organizationId: context.organizationId,
            executionId: "execution-assurance-check",
            workId: "query-work",
            taskId: "query-task",
            agentHandle: "assurance",
            modelRoute: "assurance-balanced",
            status: "succeeded",
            inputTokens: 12,
            outputTokens: 8,
            costMicros: 20,
            prompt: "prompt-secret",
          },
        ],
      },
      assurance: {
        get: async () => ({
          assuranceRunId: "assurance-run-public",
          organizationId: context.organizationId,
          workId: "query-work",
          status: "passed",
          verifierExecutionId: "verifier-execution-secret",
          snapshotHash: "snapshot-secret",
          createdByUserId: "creator-secret",
        }),
      } as never,
      assuranceChecks: {
        listByRun: async () => [
          {
            checkId: "check-runtime",
            organizationId: context.organizationId,
            workId: "query-work",
            assuranceRunId: "assurance-run-public",
            criterionId: "criterion-runtime",
            kind: "inspection",
            executorHandle: "assurance",
            executorExecutionId: "execution-assurance-check",
            commandKey: "command-secret",
            inputHash: "input-hash-secret",
            outputHash: "output-hash-secret",
            outputSummary: "output-summary-secret",
            artifactVersionIds: ["artifact-secret"],
            evidenceBriefIds: ["brief-secret"],
            metricObservationIds: ["metric-secret"],
            humanAttestationIds: ["human-secret"],
            status: "passed",
          },
          {
            checkId: "check-system",
            organizationId: context.organizationId,
            workId: "query-work",
            assuranceRunId: "assurance-run-public",
            criterionId: "criterion-system",
            kind: "command",
            systemAdapterId: "adapter-public",
            commandKey: "command-secret",
            inputHash: "input-hash-secret",
            outputHash: "output-hash-secret",
            outputSummary: "output-summary-secret",
            artifactVersionIds: ["artifact-secret"],
            evidenceBriefIds: ["brief-secret"],
            metricObservationIds: ["metric-secret"],
            humanAttestationIds: ["human-secret"],
            status: "passed",
          },
        ],
      } as never,
      router: { listAttemptLineagesByExecution } as never,
    });

    const result = await registry.query(context, ["assurance:read"], "assurance.lineage.get", {
      workId: "query-work",
      assuranceRunId: "assurance-run-public",
    });

    expect(result.data).toEqual({
      run: { assuranceRunId: "assurance-run-public", workId: "query-work", status: "passed" },
      checks: [
        {
          checkId: "check-runtime",
          criterionId: "criterion-runtime",
          status: "passed",
          executorHandle: "assurance",
          runtime: { executionId: "execution-assurance-check", taskId: "query-task", status: "succeeded" },
          routeSelections: [
            {
              attemptId: "attempt-assurance-first",
              modelProfileId: "profile-assurance-first",
              status: "failed",
              placementReceipt: {
                taskAxis: "code-understanding",
                reasoningDifficulty: "high",
                selectionBasis: "task-axis-evidence-available",
                axisEvidence: {
                  bundleId: "bundle-assurance",
                  bundleVersion: 1,
                  receiptIds: ["receipt-assurance"],
                  rankedModelProfileIds: ["profile-assurance-first"],
                },
              },
            },
            {
              attemptId: "attempt-assurance-fallback",
              modelProfileId: "profile-assurance-fallback",
              fallbackFromAttemptId: "attempt-assurance-first",
              status: "succeeded",
              placementReceipt: {
                taskAxis: "code-understanding",
                reasoningDifficulty: "high",
                selectionBasis: "task-axis-evidence-available",
                axisEvidence: {
                  bundleId: "bundle-assurance",
                  bundleVersion: 1,
                  receiptIds: ["receipt-assurance"],
                  rankedModelProfileIds: ["profile-assurance-first"],
                },
              },
            },
          ],
        },
        {
          checkId: "check-system",
          criterionId: "criterion-system",
          status: "passed",
          systemAdapterId: "adapter-public",
          routeSelections: [],
        },
      ],
    });
    expect(listAttemptLineagesByExecution).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.data)).not.toMatch(
      /secret|hash|summary|artifact|brief|metric|human|credential|explanation|usage|prompt/iu,
    );
  });

  it("Assurance 계보는 권한·payload·Work 및 fallback 불일치를 fail-closed한다", async () => {
    const runtimeCheck = {
      checkId: "check-guard",
      organizationId: context.organizationId,
      workId: "query-work",
      assuranceRunId: "assurance-run-guard",
      criterionId: "criterion-guard",
      kind: "inspection" as const,
      executorHandle: "assurance",
      executorExecutionId: "execution-assurance-guard",
      commandKey: "safe",
      inputHash: "safe",
      artifactVersionIds: [],
      evidenceBriefIds: [],
      metricObservationIds: [],
      humanAttestationIds: [],
      status: "passed" as const,
    };
    const register = (
      input: {
        readonly runWorkId?: string;
        readonly checkWorkId?: string;
        readonly attempts?: readonly unknown[];
        readonly check?: Record<string, unknown>;
        readonly executionAgentHandle?: string;
      } = {},
    ) => {
      const registry = new ApplicationQueryRegistry();
      registerApplicationQueries(registry, {
        readModel: {
          ...readModel,
          executions: async () => [
            {
              organizationId: context.organizationId,
              executionId: "execution-assurance-guard",
              workId: "query-work",
              taskId: "query-task",
              agentHandle: input.executionAgentHandle ?? "assurance",
              modelRoute: "assurance-balanced",
              status: "succeeded",
              inputTokens: 0,
              outputTokens: 0,
              costMicros: 0,
            },
          ],
        },
        assurance: {
          get: async () => ({
            assuranceRunId: "assurance-run-guard",
            organizationId: context.organizationId,
            workId: input.runWorkId ?? "query-work",
            status: "passed",
          }),
        } as never,
        assuranceChecks: {
          listByRun: async () => [
            { ...runtimeCheck, ...input.check, workId: input.checkWorkId ?? runtimeCheck.workId },
          ],
        } as never,
        router: {
          listAttemptLineagesByExecution: async () =>
            input.attempts ?? [
              {
                attemptId: "attempt-guard",
                executionId: "execution-assurance-guard",
                modelProfileId: "profile-guard",
                fallbackFromAttemptId: "missing-parent",
                status: "failed",
              },
            ],
        } as never,
      });
      return registry;
    };

    await expect(
      register().query(context, [], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
      }),
    ).rejects.toMatchObject({ category: "authorization" });
    await expect(
      register().query(context, ["assurance:read"], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
        unknown: true,
      }),
    ).rejects.toThrow("알 수 없는 필드");
    await expect(
      register({ runWorkId: "other-work" }).query(context, ["assurance:read"], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
      }),
    ).rejects.toThrow("Assurance run 계보");
    await expect(
      register({ checkWorkId: "other-work" }).query(context, ["assurance:read"], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
      }),
    ).rejects.toThrow("Assurance check 계보");
    await expect(
      register().query(context, ["assurance:read"], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
      }),
    ).rejects.toThrow("fallback Route Attempt가 없습니다");
    await expect(
      register({ check: { systemAdapterId: "adapter-guard" } }).query(
        context,
        ["assurance:read"],
        "assurance.lineage.get",
        {
          workId: "query-work",
          assuranceRunId: "assurance-run-guard",
        },
      ),
    ).rejects.toThrow("system adapter와 Runtime 실행이 동시에 존재합니다");
    await expect(
      register({ check: { executorHandle: undefined } }).query(context, ["assurance:read"], "assurance.lineage.get", {
        workId: "query-work",
        assuranceRunId: "assurance-run-guard",
      }),
    ).rejects.toThrow("Runtime 실행자 handle이 일치하지 않습니다");
    await expect(
      register({ executionAgentHandle: "different-agent" }).query(
        context,
        ["assurance:read"],
        "assurance.lineage.get",
        {
          workId: "query-work",
          assuranceRunId: "assurance-run-guard",
        },
      ),
    ).rejects.toThrow("Runtime 실행자 handle이 일치하지 않습니다");
  });

  it("웹 운영 화면용 구성원·개인 기억·감사·session을 필요한 범위로 조회한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      memberships: {
        listMembers: async () => [
          {
            membershipId: "query-membership",
            userId: "query-user",
            email: "member@example.com",
            displayName: "Member",
            role: "member",
            status: "active",
            revision: 0,
            createdAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      },
      growth: {
        getActiveExplicitMemory: async () => ({
          memoryVersionId: "memory-1",
          organizationId: context.organizationId,
          scope: "user",
          subjectId: context.userId,
          version: 1,
          status: "active",
          entries: [
            { kind: "preference", key: "answer-style", value: "결론부터 답한다", sourceReferenceIds: ["command-1"] },
          ],
          checksum: "a".repeat(64),
        }),
        resolveConfiguration: async () => ({}),
        getActiveEvaluationStrategy: async () => ({}),
        listSuggestions: async () => [],
        listEffectEvaluations: async () => [],
      } as never,
      audit: {
        read: async () => ({ events: [{ type: "work.created", sequence: 1 }], cursor: 1, snapshotRequired: false }),
      } as never,
    });

    const members = await registry.query(context, ["identity:read"], "identity.memberships", {});
    expect(members).toMatchObject({ data: [{ userId: "query-user", displayName: "Member" }] });
    expect(JSON.stringify(members)).not.toContain("member@example.com");
    const memories = await registry.query(context, ["growth:read"], "growth.memories", {});
    expect(memories).toMatchObject({
      data: [
        {
          memoryVersionId: "memory-1",
          revision: 1,
          entries: [{ key: "answer-style", kind: "preference", value: "결론부터 답한다", authority: "explicit" }],
        },
      ],
    });
    await expect(registry.query(context, ["audit:read"], "application.audit", {})).resolves.toMatchObject({
      data: { events: [{ type: "work.created" }], cursor: 1 },
    });
  });

  it("구독 제공자·계정·Quota·정책·진단을 공개 필드만으로 조회한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      subscriptionProviders: {
        list: async () => [
          {
            providerId: "verified-provider",
            displayName: "검증된 제공자",
            authKinds: ["device-code"],
            executionKind: "agent-runtime",
            connectionSurface: "edge-only",
            billingKinds: ["subscription"],
            modelDiscovery: "protocol",
            quotaDiscovery: "none",
            protocol: "acp",
            protocols: ["acp"],
            availability: "supported",
            officialDocumentation: "https://example.com/provider",
            credentialPolicies: ["adaptive", "quota-headroom"],
            verified: true,
            runtimeCapabilities: {
              accountIsolation: "single-os-keyring-account",
              output: "final-text-only",
              cancellation: "protocol",
              session: "protocol",
              permissionBridge: "protocol",
              multipleAccounts: "one-account-per-connector",
              maturity: "experimental",
              approvalModes: ["automatic", "deny"],
              approvalModesBySurface: {
                server: ["automatic", "review", "deny"],
                edge: ["automatic", "deny"],
              },
            },
            clientSecret: "provider-client-secret",
          },
        ],
      },
      subscriptionAccounts: {
        list: async () => [
          {
            account_id: "subscription-account-1",
            organization_id: "organization-secret",
            owner_user_id: context.userId,
            provider_id: "verified-provider",
            alias: "업무 계정",
            scope: "personal",
            connector_id: "connector-1",
            profile_fingerprint: "profile-fingerprint-secret",
            billing_kind: "subscription",
            status: "active",
            consent_version: 0,
            version: 3,
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          },
          {
            account_id: "shared-account-1",
            organization_id: "organization-secret",
            owner_user_id: "owner-secret",
            provider_id: "verified-provider",
            alias: "공유 계정",
            scope: "organization",
            connector_id: "connector-shared",
            profile_fingerprint: "shared-profile-fingerprint-secret",
            billing_kind: "subscription",
            status: "active",
            consent_version: 1,
            version: 2,
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          },
        ],
      },
      subscriptionConnectors: {
        get: async (_context: unknown, connectorId: string) => ({
          connector_id: connectorId,
          organization_id: "organization-secret",
          owner_user_id: "owner-secret",
          location: connectorId === "connector-1" ? "edge" : "server",
          execution_kind: "agent-runtime",
          protocol: "massion-connector-v1",
          version: "1.0.0",
          public_key: "connector-public-key-secret",
          capabilities: ["session.execute"],
          status: "ready",
          expires_at: "2026-07-12T00:05:00.000Z",
          created_at: "2026-07-12T00:00:00.000Z",
          updated_at: "2026-07-12T00:00:00.000Z",
        }),
      },
      subscriptionQuota: {
        current: async (_context: unknown, accountId: string) => {
          if (accountId === "shared-account-1") throw new Error("다른 소유자의 공유 계정 Quota 조회 금지");
          return {
            accountId,
            snapshotId: "quota-snapshot-secret",
            windows: [
              {
                kind: "monthly",
                limit: 100,
                remaining: 75,
                remainingRatio: 0.75,
                resetsAt: "2026-08-01T00:00:00.000Z",
                observedAt: "2026-07-12T00:00:00.000Z",
                source: "private-quota-endpoint",
                confidence: "reported",
              },
            ],
            minimumRemainingRatio: 0.75,
            earliestResetAt: "2026-08-01T00:00:00.000Z",
            exhausted: false,
            observedAt: "2026-07-12T00:00:00.000Z",
          };
        },
      },
      subscriptionPolicy: {
        configure: async () => ({
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          version: 2,
          source: "configured",
        }),
        list: async () => [
          {
            providerId: "verified-provider",
            credentialPolicy: "quota-headroom",
            approvalMode: "deny",
            version: 2,
            source: "configured",
            updatedAt: "2026-07-12T00:00:00.000Z",
            token: "policy-token-secret",
          },
        ],
      },
    } as never);

    const providers = await registry.query(context, ["subscription:read"], "subscription.providers", {});
    const accounts = await registry.query(context, ["subscription:read"], "subscription.accounts", {});
    const quota = await registry.query(context, ["subscription:read"], "subscription.quota", {});
    const policy = await registry.query(context, ["subscription:read"], "subscription.policy", {
      providerId: "verified-provider",
    });
    expect(policy).toMatchObject({
      data: [expect.objectContaining({ providerId: "verified-provider", approvalMode: "deny" })],
    });
    const doctor = await registry.query(context, ["subscription:read"], "subscription.doctor", {
      accountId: "subscription-account-1",
    });

    expect(providers).toMatchObject({
      data: [
        {
          providerId: "verified-provider",
          displayName: "검증된 제공자",
          connectionSurface: "edge-only",
          modelDiscovery: "protocol",
          protocol: "acp",
          protocols: ["acp"],
          availability: "supported",
          officialDocumentation: "https://example.com/provider",
          credentialPolicies: ["adaptive", "quota-headroom"],
          verified: true,
          runtimeCapabilities: {
            accountIsolation: "single-os-keyring-account",
            approvalModes: ["automatic", "deny"],
            approvalModesBySurface: {
              server: ["automatic", "review", "deny"],
              edge: ["automatic", "deny"],
            },
          },
        },
      ],
    });
    expect(accounts).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          alias: "업무 계정",
          canManage: true,
          connectorLocation: "edge",
          minimumRemainingRatio: 0.75,
          version: 3,
        },
        {
          accountId: "shared-account-1",
          alias: "공유 계정",
          canManage: false,
          connectorLocation: "server",
          version: 2,
        },
      ],
    });
    expect((accounts.data as Array<Record<string, unknown>>)[1]).not.toHaveProperty("minimumRemainingRatio");
    expect((accounts.data as Array<Record<string, unknown>>)[1]).toMatchObject({
      profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
    });
    expect((accounts.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty("profileHandle");
    expect(quota).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          exhausted: false,
          windows: [{ kind: "monthly", remainingRatio: 0.75 }],
        },
      ],
    });
    expect(policy).toMatchObject({
      data: [
        {
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          version: 2,
          source: "configured",
        },
      ],
    });
    expect(doctor).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          accountStatus: "active",
          connectorStatus: "ready",
          quotaStatus: "available",
          action: "none",
        },
      ],
    });
    const serialized = JSON.stringify([providers, accounts, quota, policy, doctor]);
    for (const forbidden of [
      "organization-secret",
      "owner-secret",
      "profile-fingerprint-secret",
      "shared-profile-fingerprint-secret",
      "connector-public-key-secret",
      "provider-client-secret",
      "policy-token-secret",
      "quota-snapshot-secret",
      "private-quota-endpoint",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("협업방 조회", () => {
  const roomReadModel: ApplicationReadModel = {
    ...readModel,
    rooms: async () => [
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        name: "3분기 이탈 분석",
        kind: "work",
        status: "active",
        participantIds: ["00000000-0000-4000-8000-000000000000", "representative", "dynamic-staff-8"],
        participants: [
          { subjectId: "00000000-0000-4000-8000-000000000000", kind: "user" as const },
          { subjectId: "representative", kind: "agent" as const },
          { subjectId: "dynamic-staff-8", kind: "agent" as const },
        ],
        lastMessageSequence: 3,
      },
    ],
    messages: async () => [
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-question",
        sequence: 1,
        messageType: "question",
        authorKind: "user",
        authorId: "query-user",
        authorDisplayName: "Reader",
        content: "라벨링 기준이 뭔가요?",
        createdAt: "2026-07-21T09:01:00.000Z",
      },
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-answer",
        sequence: 2,
        messageType: "answer",
        authorKind: "agent",
        authorId: "evidence-research",
        authorDisplayName: "Evidence & Research",
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        content: "5축입니다.",
        createdAt: "2026-07-21T09:02:00.000Z",
        replyToMessageId: "message-question",
        taskId: "task-delivery",
        contextVersionId: "context-strategy",
        executionId: "execution-delivery",
        artifactVersionId: "artifact-delivery",
        email: "reader-secret@example.com",
        accountId: "account-secret",
        credentialId: "credential-secret",
        lease: "lease-secret",
        prompt: "prompt-secret",
        input: "input-secret",
        output: "output-secret",
        explanation: "explanation-secret",
        receipt: "receipt-secret",
      },
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-challenge",
        sequence: 3,
        messageType: "challenge",
        authorKind: "agent",
        authorId: "assurance",
        content: "분기 간 비교가 성립하지 않습니다.",
        createdAt: "2026-07-21T09:03:00.000Z",
        replyToMessageId: "message-answer",
        causedByMessageId: "message-question",
      },
      {
        organizationId: context.organizationId,
        workId: "other-work",
        roomId: "room-9",
        messageId: "message-other",
        sequence: 1,
        messageType: "status",
        authorKind: "agent",
        authorId: "representative",
        content: "다른 Work의 메시지",
        createdAt: "2026-07-21T09:04:00.000Z",
      },
    ],
  };

  it("방 예산 소비량을 메시지 합으로 계산한다", async () => {
    // 소비량은 방 레코드에 없고 메시지의 token_count·cost_micros 합입니다.
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...roomReadModel,
        rooms: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            name: "3분기 이탈 분석",
            kind: "work",
            status: "active",
            participantIds: ["representative"],
            lastMessageSequence: 2,
            coordinatorHandle: "representative",
            roundCount: 4,
            maxRounds: 12,
            maxTokens: 200_000,
            maxCostMicros: 2_000_000,
          },
        ],
        messages: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            messageId: "m1",
            sequence: 1,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "하나",
            createdAt: "2026-07-21T09:01:00.000Z",
            tokenCount: 30_000,
            costMicros: 200_000,
          },
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            messageId: "m2",
            sequence: 2,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "둘",
            createdAt: "2026-07-21T09:02:00.000Z",
            tokenCount: 18_200,
            costMicros: 110_000,
          },
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-other",
            messageId: "m3",
            sequence: 1,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "다른 방",
            createdAt: "2026-07-21T09:03:00.000Z",
            tokenCount: 99_999,
            costMicros: 999_999,
          },
        ],
      },
    });

    await expect(
      registry.query(context, ["collaboration:read"], "work.rooms", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        {
          roundCount: 4,
          maxRounds: 12,
          // 다른 방의 메시지는 합에 들어가지 않습니다.
          usedTokens: 48_200,
          maxTokens: 200_000,
          usedCostMicros: 310_000,
          coordinatorHandle: "representative",
        },
      ],
    });
  });

  it("공유 컨텍스트는 checksum과 함께 Work 범위로 준다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...roomReadModel,
        sharedContexts: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            sharedContextReferenceId: "ref-1",
            sourceKind: "evidence-brief",
            sourceId: "brief-1",
            versionId: "v3",
            checksum: "a3f1c8",
          },
          {
            organizationId: context.organizationId,
            workId: "other-work",
            roomId: "room-9",
            sharedContextReferenceId: "ref-2",
            sourceKind: "evidence-brief",
            sourceId: "brief-2",
            versionId: "v1",
            checksum: "ffffff",
          },
        ],
      },
    });

    const result = await registry.query(context, ["collaboration:read"], "work.shared-contexts", {
      workId: "query-work",
    });
    expect(result.data).toEqual([
      {
        sharedContextReferenceId: "ref-1",
        roomId: "room-1",
        sourceKind: "evidence-brief",
        sourceId: "brief-1",
        versionId: "v3",
        checksum: "a3f1c8",
      },
    ]);
  });

  it("Work 지식은 read scope 뒤에 metadata만 ready·no-match·blocked 상태로 투영한다", async () => {
    const calls: string[] = [];
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workKnowledge: {
        get: async (_context, workId) => {
          calls.push(workId);
          if (workId === "ready-work") {
            return {
              workId,
              status: "ready" as const,
              repositoryId: "repository-1",
              repositoryRevisionId: "revision-1",
              indexVersionId: "index-1",
              evidenceBriefId: "brief-1",
              snapshotChecksum: "b".repeat(64),
              evidenceBriefChecksum: "c".repeat(64),
              freshnessStatus: "fresh" as const,
              query: "결제 검증",
              references: [
                {
                  referenceId: "chunk-1",
                  kind: "chunk" as const,
                  relativePath: "src/payment.ts",
                  startLine: 3,
                  endLine: 8,
                  contentHash: "a".repeat(64),
                  provenance: {
                    selection: "graph-neighbor" as const,
                    snapshotChecksum: "b".repeat(64),
                    paths: [
                      {
                        seed: {
                          referenceId: "symbol-payment-seed",
                          kind: "symbol" as const,
                          symbolKey: "symbol-key-payment-seed",
                        },
                        relation: {
                          relationId: "relation-payment-neighbor",
                          relationKey: "relation-key-payment-neighbor",
                          kind: "calls" as const,
                          sourceSymbolKey: "symbol-key-payment-seed",
                          targetSymbolKey: "symbol-key-payment",
                          targetText: "Payment.authorize",
                          resolved: true,
                          relativePath: "src/seed.ts",
                          startLine: 7,
                        },
                      },
                    ],
                  },
                  content: "sk-this-must-never-leave-the-server",
                },
              ],
              prompt: "비공개 prompt",
            } as never;
          }
          if (workId === "no-match-work") return { workId, status: "no-match", references: [] };
          return { workId, status: "blocked", references: [], failureReason: "knowledge-integrity-check-failed" };
        },
      },
    });

    await expect(registry.query(context, [], "work.knowledge", { workId: "ready-work" })).rejects.toMatchObject({
      category: "authorization",
    });
    expect(calls).toEqual([]);

    const ready = await registry.query(context, ["work:read"], "work.knowledge", { workId: "ready-work" });
    expect(ready.data).toEqual({
      workId: "ready-work",
      status: "ready",
      repositoryId: "repository-1",
      repositoryRevisionId: "revision-1",
      indexVersionId: "index-1",
      evidenceBriefId: "brief-1",
      snapshotChecksum: "b".repeat(64),
      evidenceBriefChecksum: "c".repeat(64),
      freshnessStatus: "fresh",
      query: "결제 검증",
      references: [
        {
          referenceId: "chunk-1",
          kind: "chunk",
          relativePath: "src/payment.ts",
          startLine: 3,
          endLine: 8,
          contentHash: "a".repeat(64),
          provenance: {
            selection: "graph-neighbor",
            snapshotChecksum: "b".repeat(64),
            paths: [
              {
                seed: {
                  referenceId: "symbol-payment-seed",
                  kind: "symbol",
                  symbolKey: "symbol-key-payment-seed",
                },
                relation: {
                  relationId: "relation-payment-neighbor",
                  relationKey: "relation-key-payment-neighbor",
                  kind: "calls",
                  sourceSymbolKey: "symbol-key-payment-seed",
                  targetSymbolKey: "symbol-key-payment",
                  targetText: "Payment.authorize",
                  resolved: true,
                  relativePath: "src/seed.ts",
                  startLine: 7,
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(ready.data)).not.toMatch(/prompt|sk-this/u);
    await expect(
      registry.query(context, ["work:read"], "work.knowledge", { workId: "no-match-work" }),
    ).resolves.toMatchObject({ data: { status: "no-match", references: [] } });
    await expect(
      registry.query(context, ["work:read"], "work.knowledge", { workId: "blocked-work" }),
    ).resolves.toMatchObject({
      data: { status: "blocked", references: [], failureReason: "knowledge-integrity-check-failed" },
    });
  });

  function knowledgeWorkspaceSource() {
    return {
      repository: {
        repositoryId: "repository-knowledge",
        organizationId: context.organizationId,
        workspaceId: "workspace-knowledge",
        name: "knowledge",
        providerKind: "filesystem" as const,
        rootRef: "/private/workspace/knowledge",
        rootRealPathHash: "1".repeat(64),
        status: "active" as const,
        currentIndexVersionId: "index-knowledge",
        createdByUserId: context.userId,
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T01:00:00.000Z",
      },
      index: {
        indexVersionId: "index-knowledge",
        organizationId: context.organizationId,
        repositoryId: "repository-knowledge",
        repositoryRevisionId: "revision-knowledge",
        configurationId: "configuration-knowledge",
        version: 1,
        mode: "full" as const,
        status: "complete" as const,
        current: true,
        parserBundleVersion: "parser-v1",
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable" as const,
        configurationChecksum: "2".repeat(64),
        snapshotChecksum: "3".repeat(64),
        fileCount: 2,
        symbolCount: 2,
        relationCount: 3,
        chunkCount: 2,
        createdByUserId: context.userId,
        createdAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T01:00:00.000Z",
        updatedAt: "2026-07-29T01:00:00.000Z",
      },
      configuration: {
        configurationId: "configuration-knowledge",
        organizationId: context.organizationId,
        repositoryId: "repository-knowledge",
        version: 1,
        checksum: "2".repeat(64),
        parserBundleVersion: "parser-v1",
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable" as const,
        settings: { include: ["**/*"], exclude: ["node_modules", "dist"], maxFileBytes: 1_048_576 },
        createdByUserId: context.userId,
        createdAt: "2026-07-29T00:00:00.000Z",
      },
      snapshot: {
        indexVersionId: "index-knowledge",
        files: [
          {
            sourceFileId: "file-zeta",
            sourceFileKey: "file-key-zeta",
            relativePath: "src/zeta.ts",
            language: "typescript",
            size: 30,
            contentHash: "4".repeat(64),
            status: "complete" as const,
            parserKind: "tree-sitter" as const,
            grammarVersion: "grammar-v1",
            parseErrorCount: 0,
            redactions: [],
          },
          {
            sourceFileId: "file-payment",
            sourceFileKey: "file-key-payment",
            relativePath: "src/payment.ts",
            language: "typescript",
            size: 50,
            contentHash: "5".repeat(64),
            status: "complete" as const,
            parserKind: "tree-sitter" as const,
            grammarVersion: "grammar-v1",
            parseErrorCount: 0,
            redactions: [],
          },
        ],
        symbols: [
          {
            symbolId: "symbol-authorize",
            symbolKey: "symbol-key-authorize",
            sourceFileId: "file-payment",
            relativePath: "src/payment.ts",
            name: "authorize",
            qualifiedName: "Payment.authorize",
            kind: "method" as const,
            startByte: 0,
            endByte: 20,
            startLine: 1,
            endLine: 2,
            contentHash: "5".repeat(64),
          },
          {
            symbolId: "symbol-zeta",
            symbolKey: "symbol-key-zeta",
            sourceFileId: "file-zeta",
            relativePath: "src/zeta.ts",
            name: "zeta",
            qualifiedName: "Zeta.run",
            kind: "method" as const,
            startByte: 0,
            endByte: 10,
            startLine: 1,
            endLine: 1,
            contentHash: "4".repeat(64),
          },
        ],
        chunks: [
          {
            chunkId: "chunk-payment",
            chunkKey: "chunk-key-payment",
            sourceFileId: "file-payment",
            symbolKey: "symbol-key-authorize",
            relativePath: "src/payment.ts",
            language: "typescript",
            startByte: 0,
            endByte: 20,
            startLine: 1,
            endLine: 2,
            content: "credential=must-not-leave",
            contentHash: "5".repeat(64),
          },
          {
            chunkId: "chunk-zeta",
            chunkKey: "chunk-key-zeta",
            sourceFileId: "file-zeta",
            relativePath: "src/zeta.ts",
            language: "typescript",
            startByte: 0,
            endByte: 10,
            startLine: 1,
            endLine: 1,
            content: "prompt=must-not-leave",
            contentHash: "4".repeat(64),
          },
        ],
        relations: [
          {
            relationId: "relation-symbol-call",
            relationKey: "relation-key-symbol-call",
            sourceFileId: "file-payment",
            relativePath: "src/payment.ts",
            kind: "calls" as const,
            sourceSymbolKey: "symbol-key-authorize",
            targetSymbolKey: "symbol-key-zeta",
            targetText: "Zeta.run",
            resolved: true,
            startLine: 1,
          },
          {
            relationId: "relation-file-import",
            relationKey: "relation-key-file-import",
            sourceFileId: "file-payment",
            relativePath: "src/payment.ts",
            kind: "imports" as const,
            targetSymbolKey: "symbol-key-zeta",
            targetText: "./zeta",
            resolved: true,
            startLine: 1,
          },
          {
            relationId: "relation-external",
            relationKey: "relation-key-external",
            sourceFileId: "file-payment",
            relativePath: "src/payment.ts",
            kind: "calls" as const,
            sourceSymbolKey: "symbol-key-authorize",
            targetText: "credential=must-not-leave",
            resolved: false,
            startLine: 1,
          },
        ],
        checksum: "3".repeat(64),
      },
    };
  }

  function knowledgeQueryDependencies(
    options: { readonly trust?: "trusted" | "pending"; readonly empty?: boolean } = {},
  ): ApplicationQueryDependencies & {
    readonly workKnowledge: NonNullable<ApplicationQueryDependencies["workKnowledge"]>;
  } {
    const works = [
      {
        organizationId: context.organizationId,
        workId: "work-zeta",
        title: "Zeta 점검\nprompt=must-not-leave",
        status: "running",
        revision: 1,
        artifactIds: ["artifact-version-zeta"],
        workspaceId: "workspace-knowledge",
      },
      {
        organizationId: context.organizationId,
        workId: "work-alpha",
        title: "Alpha 점검",
        status: "completed",
        revision: 2,
        artifactIds: [],
        workspaceId: "workspace-knowledge",
      },
      {
        organizationId: "other-organization",
        workId: "work-secret",
        title: "다른 조직 작업",
        status: "running",
        revision: 1,
        artifactIds: [],
        workspaceId: "workspace-knowledge",
      },
      {
        organizationId: context.organizationId,
        workId: "work-other-workspace",
        title: "다른 워크스페이스 작업",
        status: "running",
        revision: 1,
        artifactIds: [],
        workspaceId: "workspace-other",
      },
    ];
    return {
      readModel: {
        ...readModel,
        works: async () => works,
        artifacts: async () => [
          {
            organizationId: context.organizationId,
            artifactId: "artifact-zeta",
            artifactVersionId: "artifact-version-zeta",
            workId: "work-zeta",
            name: "점검 보고서",
            kind: "report",
            version: 1,
            mediaType: "text/markdown",
            checksum: "6".repeat(64),
            createdBy: "analysis",
            createdAt: "2026-07-29T02:00:00.000Z",
            contentJson: '{"prompt":"must-not-leave"}',
            absolutePath: "/private/workspace/knowledge/report.md",
          },
          {
            organizationId: "other-organization",
            artifactId: "artifact-secret",
            artifactVersionId: "artifact-version-secret",
            workId: "work-secret",
            name: "다른 조직 산출물",
            kind: "report",
            version: 1,
            mediaType: "text/plain",
            checksum: "7".repeat(64),
            createdBy: "analysis",
            createdAt: "2026-07-29T02:00:00.000Z",
          },
        ],
      },
      workspaces: {
        list: async () => [],
        get: async () => ({
          organizationId: context.organizationId,
          workspaceId: "workspace-knowledge",
          name: "knowledge",
          path: "/private/workspace/knowledge",
          kind: "local-directory" as const,
          trust: options.trust ?? ("trusted" as const),
          status: "active" as const,
          revision: 1,
          createdAt: "2026-07-29T00:00:00.000Z",
          lastUsedAt: "2026-07-29T01:00:00.000Z",
        }),
      },
      workKnowledge: {
        getWorkspaceSnapshot: async () => (options.empty ? undefined : knowledgeWorkspaceSource()),
        get: async (_context: TenantContext, workId: string) => {
          if (workId !== "work-zeta" && workId !== "work-alpha") throw new Error("scope 밖 Work 조회");
          return {
            workId,
            status: "ready" as const,
            repositoryId: "repository-knowledge",
            repositoryRevisionId: "revision-knowledge",
            indexVersionId: "index-knowledge",
            evidenceBriefId: `brief-${workId}`,
            freshnessStatus: "fresh" as const,
            query: "credential을 노출하지 않는다",
            references: [
              {
                referenceId: "chunk-payment",
                kind: "chunk" as const,
                relativePath: "src/payment.ts",
                qualifiedName: "Payment.authorize",
                startLine: 1,
                endLine: 2,
                contentHash: "5".repeat(64),
                content: "credential=must-not-leave",
              },
            ],
            prompt: "must-not-leave",
          } as never;
        },
      },
    };
  }

  it("지식 index·graph·links는 실제 정본 계보를 결정적으로 투영하고 민감 재료를 제거한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, knowledgeQueryDependencies() as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.index", {
        workspaceId: "workspace-knowledge",
      }),
    ).resolves.toMatchObject({
      data: {
        workspaceId: "workspace-knowledge",
        status: "ready",
        indexVersionId: "index-knowledge",
        fileCount: 2,
        symbolCount: 2,
        relationCount: 3,
        indexedAt: "2026-07-29T01:00:00.000Z",
        excluded: ["dist", "node_modules"],
      },
    });

    const graph = await registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
      workspaceId: "workspace-knowledge",
      lens: "work",
      limit: 2,
    });
    expect(graph.data).toEqual({
      lens: "work",
      nodes: [
        { nodeId: "work:work-alpha", kind: "work", label: "Alpha 점검", detail: "completed" },
        { nodeId: "work:work-zeta", kind: "work", label: "Zeta 점검", detail: "running" },
      ],
      edges: [
        {
          kind: "documents",
          sourceId: "work:work-alpha",
          targetId: "work:work-zeta",
          derivedVia: "src/payment.ts",
        },
      ],
    });
    expect(
      await registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "work",
        limit: 1,
      }),
    ).toMatchObject({ data: { nodes: [{ nodeId: "work:work-alpha" }], edges: [] } });

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).resolves.toMatchObject({
      data: {
        nodes: [{ nodeId: "file:file-payment" }, { nodeId: "file:file-zeta" }],
        edges: [
          {
            kind: "calls",
            sourceId: "file:file-payment",
            targetId: "file:file-zeta",
          },
          {
            kind: "imports",
            sourceId: "file:file-payment",
            targetId: "file:file-zeta",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "symbol",
      }),
    ).resolves.toMatchObject({
      data: {
        nodes: [{ nodeId: "symbol:symbol-authorize" }, { nodeId: "symbol:symbol-zeta" }],
        edges: [
          {
            kind: "calls",
            sourceId: "symbol:symbol-authorize",
            targetId: "symbol:symbol-zeta",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "artifact",
      }),
    ).resolves.toMatchObject({ data: { nodes: [{ nodeId: "artifact:artifact-version-zeta" }], edges: [] } });
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "agent",
      }),
    ).resolves.toMatchObject({ data: { nodes: [], edges: [] } });

    const workLinks = await registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
      workspaceId: "workspace-knowledge",
      nodeId: "work:work-zeta",
      limit: 10,
    });
    expect(workLinks.data).toEqual([
      {
        node: { nodeId: "artifact:artifact-version-zeta", kind: "artifact", label: "점검 보고서", detail: "report" },
        kind: "contains",
        direction: "outgoing",
      },
      {
        node: {
          nodeId: "file:file-payment",
          kind: "file",
          label: "payment.ts",
          detail: "src/payment.ts",
          group: "src",
        },
        kind: "documents",
        direction: "outgoing",
      },
      {
        node: { nodeId: "work:work-alpha", kind: "work", label: "Alpha 점검", detail: "completed" },
        kind: "documents",
        direction: "incoming",
      },
    ]);
    const serialized = JSON.stringify([graph.data, workLinks.data]);
    expect(serialized).not.toMatch(/credential|prompt|contentJson|absolutePath|\/private\//u);
    expect(serialized).not.toContain("다른 조직");
    expect(serialized).not.toContain("다른 워크스페이스");
  });

  it("재색인 뒤에도 frozen snapshot의 101번째 exact 관계를 Work 계보로 조회한다", async () => {
    const current = knowledgeWorkspaceSource();
    const original = current.snapshot.relations[0];
    if (!original) throw new Error("Knowledge relation fixture가 없습니다");
    const frozenChecksum = "8".repeat(64);
    const frozenRelations = Array.from({ length: 101 }, (_, index) => ({
      ...original,
      relationId: `relation-frozen-${String(index).padStart(3, "0")}`,
      relationKey: `relation-key-frozen-${String(index).padStart(3, "0")}`,
    }));
    const frozen = {
      ...current,
      repository: { ...current.repository, currentIndexVersionId: current.index.indexVersionId },
      index: {
        ...current.index,
        indexVersionId: "index-knowledge-frozen",
        status: "superseded" as const,
        current: false,
        snapshotChecksum: frozenChecksum,
        relationCount: frozenRelations.length,
      },
      snapshot: {
        ...current.snapshot,
        indexVersionId: "index-knowledge-frozen",
        relations: frozenRelations,
        checksum: frozenChecksum,
      },
    };
    const selectors: unknown[] = [];
    const dependencies = knowledgeQueryDependencies();
    dependencies.workKnowledge.getWorkspaceSnapshot = async (_context, _workspaceId, selector) => {
      selectors.push(selector);
      return selector === undefined ? current : frozen;
    };
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, dependencies as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
        workspaceId: "workspace-knowledge",
        nodeId: "symbol:symbol-authorize",
        indexVersionId: frozen.index.indexVersionId,
        snapshotChecksum: frozenChecksum,
        relationIds: ["relation-frozen-100"],
      }),
    ).resolves.toMatchObject({
      data: [
        {
          relationId: "relation-frozen-100",
          snapshotChecksum: frozenChecksum,
          node: { nodeId: "symbol:symbol-zeta" },
        },
      ],
    });
    expect(selectors).toEqual([{ indexVersionId: frozen.index.indexVersionId, snapshotChecksum: frozenChecksum }]);
  });

  it("지식 조회는 정본이 없으면 empty state를 반환하고 입력·scope·role을 엄격히 검증한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, knowledgeQueryDependencies({ empty: true }) as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.index", {
        workspaceId: "workspace-knowledge",
      }),
    ).resolves.toMatchObject({ data: { status: "none", fileCount: 0, symbolCount: 0, relationCount: 0 } });
    for (const lens of ["work", "document", "file", "symbol", "artifact", "agent"] as const) {
      await expect(
        registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
          workspaceId: "workspace-knowledge",
          lens,
        }),
      ).resolves.toEqual(expect.objectContaining({ data: { lens, nodes: [], edges: [] } }));
    }
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.index", {
        workspaceId: "workspace-knowledge",
        unknown: true,
      }),
    ).rejects.toThrow("알 수 없는 필드");
    for (const payload of [
      { workspaceId: "", lens: "file" },
      { workspaceId: "x".repeat(129), lens: "file" },
      { workspaceId: "workspace-knowledge", lens: "unknown" },
      { workspaceId: "workspace-knowledge", lens: "file", limit: 0 },
      { workspaceId: "workspace-knowledge", lens: "file", limit: 201 },
      { workspaceId: "workspace-knowledge", lens: "file", limit: Number.NaN },
    ]) {
      await expect(
        registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", payload),
      ).rejects.toThrow();
    }
    await expect(
      registry.query(context, ["work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toMatchObject({ category: "authorization" });
    const outsider = { ...context, role: "viewer" } as never;
    await expect(
      registry.query(outsider, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toMatchObject({ category: "authorization" });
  });

  it("지식 Work 투영은 limit 전에 N+1을 실행하지 않고 200개 상한에서 O(n) 공유 관계를 만든다", async () => {
    const works = Array.from({ length: 200 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return {
        organizationId: context.organizationId,
        workId: `work-${suffix}`,
        title: `Work ${suffix}`,
        status: "running",
        revision: 1,
        artifactIds: [],
        workspaceId: "workspace-knowledge",
      };
    });
    const dependencies = knowledgeQueryDependencies();
    const artifacts = vi.fn(async () => []);
    dependencies.readModel.works = async () => works;
    dependencies.readModel.artifacts = artifacts;
    const get = vi.fn(async (_context: TenantContext, workId: string) => ({
      workId,
      status: "ready" as const,
      repositoryId: "repository-knowledge",
      repositoryRevisionId: "revision-knowledge",
      indexVersionId: "index-knowledge",
      evidenceBriefId: `brief-${workId}`,
      freshnessStatus: "fresh" as const,
      references: [
        {
          referenceId: "chunk-payment",
          kind: "chunk" as const,
          relativePath: "src/payment.ts",
          qualifiedName: "Payment.authorize",
          startLine: 1,
          endLine: 2,
          contentHash: "5".repeat(64),
        },
      ],
    }));
    dependencies.workKnowledge.get = get;
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, dependencies as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "work",
        limit: 1,
      }),
    ).resolves.toMatchObject({ data: { nodes: [{ nodeId: "work:work-000" }], edges: [] } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(artifacts).not.toHaveBeenCalled();

    get.mockClear();
    const full = await registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
      workspaceId: "workspace-knowledge",
      lens: "work",
      limit: 200,
    });
    expect((full.data as { nodes: unknown[]; edges: unknown[] }).nodes).toHaveLength(200);
    expect((full.data as { nodes: unknown[]; edges: unknown[] }).edges).toHaveLength(199);
    expect(get).toHaveBeenCalledTimes(200);
    expect(artifacts).not.toHaveBeenCalled();

    get.mockClear();
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "work",
        limit: 201,
      }),
    ).rejects.toThrow("limit");
    expect(get).not.toHaveBeenCalled();

    const oversizedDependencies = knowledgeQueryDependencies();
    const firstWork = works[0];
    if (!firstWork) throw new Error("Work fixture가 없습니다");
    oversizedDependencies.readModel.works = async () => [
      ...works,
      { ...firstWork, workId: "work-200", title: "Work 200" },
    ];
    const oversizedGet = vi.fn(get);
    oversizedDependencies.workKnowledge.get = oversizedGet;
    const oversizedRegistry = new ApplicationQueryRegistry();
    registerApplicationQueries(oversizedRegistry, oversizedDependencies as never);
    await expect(
      oversizedRegistry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "work",
        limit: 200,
      }),
    ).rejects.toThrow("200");
    expect(oversizedGet).not.toHaveBeenCalled();
  });

  it("신뢰하지 않은 workspace와 다른 workspace·조직 노드를 지식 표면에 노출하지 않는다", async () => {
    const calls: string[] = [];
    const dependencies = knowledgeQueryDependencies({ trust: "pending" });
    dependencies.workKnowledge.getWorkspaceSnapshot = async () => {
      calls.push("snapshot");
      return knowledgeWorkspaceSource();
    };
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, dependencies as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "work",
      }),
    ).rejects.toMatchObject({ category: "authorization" });
    expect(calls).toEqual([]);
  });

  it("지식 계보가 끊기거나 모호하면 dangling 관계를 숨기지 않고 fail-closed한다", async () => {
    const source = knowledgeWorkspaceSource();
    const sourceSymbol = source.snapshot.symbols[0];
    const sourceChunk = source.snapshot.chunks[0];
    const symbolRelation = source.snapshot.relations[0];
    if (!sourceSymbol || !sourceChunk || !symbolRelation) throw new Error("Knowledge fixture가 없습니다");
    source.snapshot.symbols[0] = { ...sourceSymbol, sourceFileId: "missing-file" };
    const dependencies = knowledgeQueryDependencies();
    dependencies.workKnowledge.getWorkspaceSnapshot = async () => source;
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, dependencies as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toThrow("계보");

    source.snapshot.symbols[0] = { ...sourceSymbol, sourceFileId: "file-payment" };
    source.snapshot.chunks[0] = { ...sourceChunk, relativePath: "../private/secret.ts" };
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
        workspaceId: "workspace-knowledge",
        nodeId: "work:work-zeta",
      }),
    ).rejects.toThrow();

    source.snapshot.chunks[0] = { ...sourceChunk, relativePath: "src/payment.ts" };
    source.snapshot.relations.push({ ...symbolRelation });
    source.index.relationCount += 1;
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toThrow("모호");

    source.snapshot.relations.pop();
    source.index.relationCount -= 1;
    const fileRelation = source.snapshot.relations[1];
    if (!fileRelation) throw new Error("file relation fixture가 없습니다");
    source.snapshot.relations[1] = { ...fileRelation, targetSymbolKey: "missing-target" };
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toThrow("target 계보");
    source.snapshot.relations[1] = fileRelation;

    const targetSymbol = source.snapshot.symbols[1];
    if (!targetSymbol) throw new Error("target symbol fixture가 없습니다");
    source.snapshot.symbols.push({ ...targetSymbol, symbolId: "symbol-zeta-duplicate" });
    source.index.symbolCount += 1;
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toThrow("모호");
    source.snapshot.symbols.pop();
    source.index.symbolCount -= 1;

    source.snapshot.relations.push({
      relationId: "relation-unresolved",
      relationKey: "relation-key-unresolved",
      sourceFileId: symbolRelation.sourceFileId,
      relativePath: symbolRelation.relativePath,
      kind: "calls" as const,
      sourceSymbolKey: "missing-symbol",
      targetText: symbolRelation.targetText,
      resolved: false,
      startLine: symbolRelation.startLine,
    });
    source.index.relationCount += 1;
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.graph", {
        workspaceId: "workspace-knowledge",
        lens: "file",
      }),
    ).rejects.toThrow("계보");
  });

  it("지식 links는 선택 노드의 incoming·outgoing을 같은 정본으로 반환하고 scope 밖 노드를 거부한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, knowledgeQueryDependencies() as never);

    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
        workspaceId: "workspace-knowledge",
        nodeId: "file:file-payment",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      data: [
        { node: { nodeId: "file:file-zeta" }, kind: "calls", direction: "outgoing" },
        { node: { nodeId: "file:file-zeta" }, kind: "imports", direction: "outgoing" },
        { node: { nodeId: "symbol:symbol-authorize" }, kind: "contains", direction: "outgoing" },
        { node: { nodeId: "symbol:symbol-zeta" }, kind: "imports", direction: "outgoing" },
        { node: { nodeId: "work:work-alpha" }, kind: "documents", direction: "incoming" },
        { node: { nodeId: "work:work-zeta" }, kind: "documents", direction: "incoming" },
      ],
    });
    await expect(
      registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
        workspaceId: "workspace-knowledge",
        nodeId: "symbol:symbol-authorize",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      data: [
        { node: { nodeId: "file:file-payment" }, kind: "contains", direction: "incoming" },
        {
          node: { nodeId: "symbol:symbol-zeta" },
          kind: "calls",
          direction: "outgoing",
          relationId: "relation-symbol-call",
          relationKey: "relation-key-symbol-call",
          sourceSymbolKey: "symbol-key-authorize",
          targetSymbolKey: "symbol-key-zeta",
          snapshotChecksum: "3".repeat(64),
          sourcePath: "src/payment.ts",
          sourceLine: 1,
        },
        {
          node: { nodeId: "symbol:unresolved.relation-external", label: "색인 밖 대상" },
          kind: "calls",
          direction: "outgoing",
          unresolved: true,
          relationId: "relation-external",
          relationKey: "relation-key-external",
          sourceSymbolKey: "symbol-key-authorize",
          snapshotChecksum: "3".repeat(64),
          sourcePath: "src/payment.ts",
          sourceLine: 1,
        },
      ],
    });
    for (const nodeId of ["work:work-secret", "work:work-other-workspace", "work:missing", "", "x".repeat(257)]) {
      await expect(
        registry.query(context, ["workspace:read", "work:read"], "knowledge.links", {
          workspaceId: "workspace-knowledge",
          nodeId,
        }),
      ).rejects.toThrow();
    }
  });

  it("방 목록이 참가자와 마지막 sequence를 함께 준다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    await expect(
      registry.query(context, ["collaboration:read"], "work.rooms", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        {
          roomId: "room-1",
          participantIds: ["00000000-0000-4000-8000-000000000000", "representative", "dynamic-staff-8"],
          participants: [
            { subjectId: "00000000-0000-4000-8000-000000000000", kind: "user" },
            { subjectId: "representative", kind: "agent" },
            { subjectId: "dynamic-staff-8", kind: "agent" },
          ],
          lastMessageSequence: 3,
        },
      ],
    });
  });

  it("메시지는 타입과 인과 계보를 잃지 않는다", async () => {
    // 반론이 무엇을 반박하는지 없이 오면 화면이 인용을 그릴 수 없습니다.
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    const result = await registry.query(context, ["collaboration:read"], "work.messages", {
      workId: "query-work",
      roomId: "room-1",
    });

    expect(result.data).toMatchObject([
      {
        messageId: "message-question",
        messageType: "question",
        authorKind: "user",
        authorId: "query-user",
        authorDisplayName: "Reader",
      },
      {
        messageId: "message-answer",
        messageType: "answer",
        authorKind: "agent",
        authorDisplayName: "Evidence & Research",
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        replyToMessageId: "message-question",
        taskId: "task-delivery",
        contextVersionId: "context-strategy",
        executionId: "execution-delivery",
        artifactVersionId: "artifact-delivery",
      },
      {
        messageId: "message-challenge",
        messageType: "challenge",
        replyToMessageId: "message-answer",
        causedByMessageId: "message-question",
      },
    ]);
    const serialized = JSON.stringify(result.data);
    for (const forbidden of [
      "reader-secret@example.com",
      "account-secret",
      "credential-secret",
      "lease-secret",
      "prompt-secret",
      "input-secret",
      "output-secret",
      "explanation-secret",
      "receipt-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("Agent handoff의 실제 수신자를 공개 계약까지 보존한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...roomReadModel,
        messages: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            messageId: "message-handoff",
            sequence: 1,
            messageType: "handoff",
            authorKind: "agent",
            authorId: "representative",
            recipientAgentId: "context-strategy",
            content: "내부 실행 요약",
            createdAt: "2026-07-21T09:01:00.000Z",
          },
        ],
      },
    });

    await expect(
      registry.query(context, ["collaboration:read"], "work.messages", {
        workId: "query-work",
        roomId: "room-1",
      }),
    ).resolves.toMatchObject({
      data: [{ authorId: "representative", recipientAgentId: "context-strategy", messageType: "handoff" }],
    });
  });

  it("적용된 Staffing 제안은 안전한 공개 필드만 반환한다", async () => {
    const unsafeProposalMessage = {
      organizationId: context.organizationId,
      workId: "query-work",
      roomId: "room-1",
      messageId: "message-staffing-proposal",
      sequence: 4,
      messageType: "proposal",
      authorKind: "agent",
      authorId: "representative",
      content: "두 개의 Work 전용 Agent를 적용했습니다.",
      createdAt: "2026-07-21T09:04:00.000Z",
      staffingProposal: {
        proposalId: "proposal-public",
        status: "applied" as const,
        approvalId: "approval-public",
        nodes: [
          {
            handle: "staff-analysis",
            name: "분석 담당",
            scope: "work" as const,
            workId: "query-work",
            parentHandle: "delivery-coordination",
            role: "operator" as const,
            capabilities: ["analysis"],
          },
          {
            handle: "staff-review",
            name: "검토 담당",
            scope: "work" as const,
            workId: "query-work",
            parentHandle: "assurance",
            role: "coordinator" as const,
            capabilities: ["review"],
          },
        ],
        impactNodeHandles: ["delivery-coordination", "assurance"],
        impactReferenceCount: 2,
        fromOrganizationVersion: 12,
        toOrganizationVersion: 13,
        graphCommandJson: "graph-command-secret",
        assignmentsJson: "assignments-secret",
        references: ["reference-secret"],
        intentHash: "intent-hash-secret",
        commandId: "command-secret",
        userId: "user-secret",
      },
    };
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: { ...roomReadModel, messages: async () => [unsafeProposalMessage] },
    });

    const result = await registry.query(context, ["collaboration:read"], "work.messages", {
      workId: "query-work",
      roomId: "room-1",
    });

    expect(result.data).toEqual([
      expect.objectContaining({
        staffingProposal: {
          proposalId: "proposal-public",
          status: "applied",
          approvalId: "approval-public",
          nodes: unsafeProposalMessage.staffingProposal.nodes,
          impactNodeHandles: ["delivery-coordination", "assurance"],
          impactReferenceCount: 2,
          fromOrganizationVersion: 12,
          toOrganizationVersion: 13,
        },
      }),
    ]);
    const serialized = JSON.stringify(result.data);
    for (const secret of [
      "graph-command-secret",
      "assignments-secret",
      "reference-secret",
      "intent-hash-secret",
      "command-secret",
      "user-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("다른 Work·다른 방의 메시지는 섞이지 않는다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    const result = await registry.query(context, ["collaboration:read"], "work.messages", {
      workId: "query-work",
      roomId: "room-1",
    });

    expect(result.data).toHaveLength(3);
    expect(JSON.stringify(result.data)).not.toContain("다른 Work의 메시지");
  });

  it("설치된 확장의 Capability를 계약으로 내보내고 조직 식별자는 남기지 않는다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      extension: {
        list: async () => [
          {
            installationId: "installation-1",
            organizationId: "organization-secret",
            packageName: "@massion-ext/echo",
            state: "active",
            activeVersionId: "version-1",
            activationGeneration: 2,
            contributions: {
              runtimeTools: [{ id: "echo", handler: "echo" }],
              skills: [],
            },
            permissions: {
              network: [{ origin: "https://api.example", methods: ["GET"] }],
              storage: { quotaBytes: 1024, maxValueBytes: 256 },
              tools: [],
            },
          },
        ],
      } as never,
    });

    const result = await registry.query(context, ["extension:read"], "extension.list", {});

    expect(result.data).toEqual([
      {
        installationId: "installation-1",
        packageName: "@massion-ext/echo",
        state: "active",
        activeVersionId: "version-1",
        activationGeneration: 2,
        // 헌법 6절이 요구하는 「조직에 추가된 Capability」. 빈 그룹은 내보내지 않습니다.
        contributions: [{ kind: "runtimeTools", items: ["echo"] }],
        permissions: [
          { kind: "network", items: ["https://api.example"] },
          { kind: "storage", items: [] },
        ],
      },
    ]);
    // 예전에는 도메인 view를 그대로 통과시켜 organizationId가 클라이언트로 샜습니다.
    expect(JSON.stringify(result.data)).not.toContain("organization-secret");
  });
});
