import { hashContextContent, type PlanStrategyInput } from "@massion/context-strategy";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it, vi } from "vitest";

import { createCoreWorkPipelineExecutors } from "./core-pipeline.js";

describe("actual Core Work pipeline adapters", () => {
  it("intake가 실제 Work·Representative Runtime을 만들고 model unavailable을 명시 차단한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "pipeline@example.com", displayName: "Pipeline" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const calls: string[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context, input) => {
          calls.push(input.agentHandle);
          return { executionId: "execution-representative", status: "blocked_model_unavailable" };
        },
        cancel: async () => undefined,
      },
      strategy: {
        plan: async () => {
          throw new Error("blocked intake 뒤 strategy를 실행하면 안 됩니다");
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const result = await stages.intake.execute(context, {
      runId: "pipeline-run-0001",
      commandId: "pipeline-run-0001:intake",
      correlationId: "pipeline-correlation-0001",
      request: { text: "제품화" },
    });
    expect(result).toMatchObject({ outcome: "blocked", reason: "model-unavailable", workId: expect.any(String) });
    expect(calls).toEqual(["representative"]);
    expect(await works.getWork(context, (result as { workId: string }).workId)).toMatchObject({ status: "draft" });
  });

  it("Representative가 빈 성공 출력을 반환하면 handoff 없이 명시적으로 차단한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "empty-representative@example.com",
      displayName: "Empty Representative",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "empty-representative-execution", status: "succeeded", output: " \n" }),
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    const result = await stages.intake.execute(context, {
      runId: "empty-representative-run",
      commandId: "empty-representative-run:intake",
      correlationId: "empty-representative-correlation",
      request: { text: "빈 출력을 성공으로 처리하지 마세요" },
    });

    expect(result).toMatchObject({ outcome: "blocked", reason: "representative-invalid-output" });
    const rooms = await works.listRooms(context, (result as { workId: string }).workId);
    expect(rooms).toHaveLength(1);
    const [room] = rooms;
    if (!room) throw new Error("Representative 차단 Work의 협업방이 없습니다");
    expect(await works.listMessages(context, (result as { workId: string }).workId, room.room_id)).toHaveLength(1);
  });

  it("intake는 request의 workspaceId를 생성된 Work에 바인딩한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "workspace-intake@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "execution-representative", status: "blocked_model_unavailable" }),
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({ planVersionId: "unused" }) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const result = await stages.intake.execute(context, {
      runId: "pipeline-workspace-run-0001",
      commandId: "pipeline-workspace-run-0001:intake",
      correlationId: "pipeline-workspace-correlation-0001",
      request: { text: "워크스페이스 바인딩 검증", surface: "desktop", workspaceId: "workspace-shop-api" },
    });
    const workId = (result as { workId: string }).workId;
    const work = await works.getWork(context, workId);
    expect(work.workspace_id).toBe("workspace-shop-api");
  });

  it("trusted Workspace 근거를 Intake retry에서 한 번 연결하고 Representative와 Strategy에 같은 lineage로 전달한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "workspace-knowledge-pipeline@example.com",
      displayName: "Workspace Knowledge",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const checksum = "a".repeat(64);
    const brief = {
      evidenceBriefId: "pipeline-evidence-brief-0001",
      indexVersionId: "pipeline-index-version-0001",
      status: "ready",
      checksum,
    } as const;
    const materialized = {
      evidenceBriefId: brief.evidenceBriefId,
      indexVersionId: brief.indexVersionId,
      briefChecksum: checksum,
      snippets: [
        {
          referenceId: "pipeline-chunk-0001",
          citation: "src/pipeline.ts:1-2",
          relativePath: "src/pipeline.ts",
          startLine: 1,
          endLine: 2,
          content: "export const pipeline = true;",
          estimatedTokens: 8,
        },
      ],
      estimatedTokens: 8,
      truncated: false,
    } as const;
    const prepareInputs: unknown[] = [];
    const materializeInputs: unknown[] = [];
    const representativeInputs: { readonly estimatedTokens: number; readonly input: unknown }[] = [];
    const binderInputs: unknown[] = [];
    const planInputs: PlanStrategyInput[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      workspaces: {
        get: async () =>
          ({
            workspaceId: "pipeline-workspace-0001",
            name: "Pipeline workspace",
            path: "/workspace/pipeline",
            status: "active",
            trust: "trusted",
          }) as never,
      },
      workspaceKnowledge: {
        prepare: async (_context, input) => {
          prepareInputs.push(input);
          return { brief: { ...brief, workId: input.workId } } as never;
        },
      },
      evidencePromptMaterializer: {
        materialize: async (_context, input) => {
          materializeInputs.push(input);
          return materialized;
        },
      },
      evidenceContextBinder: {
        bind: async (_context, input) => {
          binderInputs.push(input);
          return {
            kind: "evidence",
            sourceId: brief.evidenceBriefId,
            revision: brief.indexVersionId,
            contentHash: checksum,
            observedAt: "2026-07-25T00:00:00.000Z",
            classification: "internal",
            priority: 80,
            estimatedTokens: 0,
            mandatory: true,
            content: { shouldNotPersist: true },
          };
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context, input) => {
          representativeInputs.push(input);
          return { executionId: crypto.randomUUID(), status: "succeeded", output: "근거를 확인했습니다." };
        },
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context, input) => {
          planInputs.push(input);
          return {
            contextVersion: { contextVersionId: "pipeline-context-version-0001" },
            generation: { status: "applied", strategyGenerationId: "pipeline-strategy-generation-0001" },
            projection: {},
          } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const request = {
      text: "Workspace 근거로 계획해주세요",
      surface: "test",
      workspaceId: "pipeline-workspace-0001",
      workspacePaths: ["src/pipeline.ts"],
      outputLocale: "ko" as const,
    };
    const first = await stages.intake.execute(context, {
      runId: "pipeline-knowledge-run-0001",
      commandId: "pipeline-knowledge-run-0001:intake",
      correlationId: "pipeline-knowledge-correlation-0001",
      request,
    });
    if (first.outcome !== "advanced" || !first.workId) throw new Error("Workspace Intake가 진행되지 않았습니다");
    await expect(
      stages.intake.execute(context, {
        runId: "pipeline-knowledge-run-0001",
        workId: first.workId,
        commandId: "pipeline-knowledge-run-0001:intake:retry:retry-0001",
        correlationId: "pipeline-knowledge-correlation-0001",
        request,
      }),
    ).resolves.toMatchObject({ outcome: "advanced", workId: first.workId });

    expect(prepareInputs).toEqual([
      {
        commandId: "pipeline-knowledge-run-0001:knowledge",
        workId: first.workId,
        workspaceId: "pipeline-workspace-0001",
        workspaceName: "Pipeline workspace",
        root: "/workspace/pipeline",
        query: request.text,
        relativePaths: request.workspacePaths,
      },
      {
        commandId: "pipeline-knowledge-run-0001:knowledge",
        workId: first.workId,
        workspaceId: "pipeline-workspace-0001",
        workspaceName: "Pipeline workspace",
        root: "/workspace/pipeline",
        query: request.text,
        relativePaths: request.workspacePaths,
      },
    ]);
    expect(representativeInputs).toHaveLength(2);
    for (const representativeInput of representativeInputs) {
      expect(representativeInput).toMatchObject({
        estimatedTokens: expect.any(Number),
        input: {
          operation: "coordinate_work",
          responseLanguage: "Korean (ko)",
          knowledgeSources: [materialized],
          coordinationContract: expect.stringContaining("Task·Artifact 도구를 직접 호출하지 않습니다"),
        },
      });
      const coordinationContract = (representativeInput.input as { readonly coordinationContract: string })
        .coordinationContract;
      expect(coordinationContract).toContain("업무 완료 불가 사유로 보고하지 말고");
      expect(coordinationContract).toContain("실행 지향 handoff");
      expect(coordinationContract).toContain("후속 AgentOS 단계가 자동 처리");
      expect(representativeInput.estimatedTokens).toBeLessThanOrEqual(32_000);
    }
    expect(materializeInputs).toEqual([
      { workId: first.workId, evidenceBriefId: brief.evidenceBriefId, maxEstimatedTokens: 24_000 },
      { workId: first.workId, evidenceBriefId: brief.evidenceBriefId, maxEstimatedTokens: 24_000 },
    ]);
    await expect(
      stages.intake.execute(context, {
        runId: "pipeline-low-budget-run-0001",
        commandId: "pipeline-low-budget-run-0001:intake",
        correlationId: "pipeline-low-budget-correlation-0001",
        request: { ...request, tokenBudget: 1_000 },
      }),
    ).resolves.toMatchObject({ outcome: "blocked", reason: "evidence-invalid" });
    expect(materializeInputs).toHaveLength(2);
    const room = (await works.listRooms(context, first.workId))[0];
    if (!room) throw new Error("Core Office 협업방이 없습니다");
    await expect(works.listSharedContexts(context, first.workId, room.room_id)).resolves.toMatchObject([
      {
        source_kind: "evidence-brief",
        source_id: brief.evidenceBriefId,
        version_id: brief.indexVersionId,
        checksum,
      },
    ]);
    const latestRevision = (await works.getWork(context, first.workId)).revision;
    await expect(
      stages["context-strategy"].execute(context, {
        runId: "pipeline-knowledge-run-0001",
        workId: first.workId,
        commandId: "pipeline-knowledge-run-0001:context-strategy",
        correlationId: "pipeline-knowledge-correlation-0001",
        request,
      }),
    ).resolves.toMatchObject({ outcome: "advanced" });
    expect(binderInputs).toEqual([{ evidenceBriefId: brief.evidenceBriefId, policy: "warn" }]);
    expect(planInputs[0]?.expectedWorkRevision).toBe(latestRevision);
    const evidenceSource = planInputs[0]?.context.sources.find((source) => source.kind === "evidence");
    expect(evidenceSource).toMatchObject({
      sourceId: brief.evidenceBriefId,
      revision: brief.indexVersionId,
      contentHash: checksum,
    });
    expect(evidenceSource).not.toHaveProperty("content");

    const current = await works.getWork(context, first.workId);
    await works.addSharedContext(context, {
      commandId: "pipeline-knowledge-duplicate-context-0001",
      workId: first.workId,
      expectedRevision: current.revision,
      roomId: room.room_id,
      sourceKind: "evidence-brief",
      sourceId: "pipeline-evidence-brief-duplicate",
      versionId: "pipeline-index-version-duplicate",
      checksum: "b".repeat(64),
    });
    await expect(
      stages["context-strategy"].execute(context, {
        runId: "pipeline-knowledge-run-0001",
        workId: first.workId,
        commandId: "pipeline-knowledge-run-0001:context-strategy:duplicate",
        correlationId: "pipeline-knowledge-correlation-0001",
        request,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
  });

  it("untrusted Workspace는 지식 준비와 Representative 실행 전에 Intake를 차단한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "workspace-untrusted-pipeline@example.com",
      displayName: "Untrusted Workspace",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    let prepareCalls = 0;
    let representativeCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      workspaces: {
        get: async () => ({ status: "active", trust: "pending" }) as never,
      },
      workspaceKnowledge: {
        prepare: async () => {
          prepareCalls += 1;
          return {} as never;
        },
      },
      evidencePromptMaterializer: { materialize: async () => ({}) as never },
      evidenceContextBinder: { bind: async () => ({}) as never },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => {
          representativeCalls += 1;
          return { executionId: "untrusted-representative", status: "succeeded" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const result = await stages.intake.execute(context, {
      runId: "pipeline-untrusted-run-0001",
      commandId: "pipeline-untrusted-run-0001:intake",
      correlationId: "pipeline-untrusted-correlation-0001",
      request: { text: "신뢰 전 Workspace", workspaceId: "pipeline-untrusted-workspace-0001" },
    });

    expect(result).toMatchObject({ outcome: "blocked", reason: "workspace-untrusted", workId: expect.any(String) });
    expect(prepareCalls).toBe(0);
    expect(representativeCalls).toBe(0);
    expect(await works.listRooms(context, (result as { workId: string }).workId)).toHaveLength(1);
  });

  it("Workspace 지식 준비가 30초를 넘어도 false block 없이 실제 완료를 기다린다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "workspace-timeout-pipeline@example.com",
      displayName: "Workspace Timeout",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    let preparedWorkId = "";
    let preparationStarted: (() => void) | undefined;
    let finishPreparation: ((value: unknown) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const preparation = new Promise<unknown>((resolve) => {
      finishPreparation = resolve;
    });
    let representativeCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      workspaces: {
        get: async () =>
          ({
            workspaceId: "pipeline-timeout-workspace-0001",
            name: "Timeout workspace",
            path: "/workspace/timeout",
            status: "active",
            trust: "trusted",
          }) as never,
      },
      workspaceKnowledge: {
        prepare: async (_context, input) => {
          preparedWorkId = input.workId;
          preparationStarted?.();
          return (await preparation) as never;
        },
      },
      evidencePromptMaterializer: { materialize: async () => ({}) as never },
      evidenceContextBinder: { bind: async () => ({}) as never },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => {
          representativeCalls += 1;
          return { executionId: "timeout-representative", status: "succeeded", output: "전략 단계로 전달합니다." };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    vi.useFakeTimers();
    try {
      const execution = stages.intake.execute(context, {
        runId: "pipeline-timeout-run-0001",
        commandId: "pipeline-timeout-run-0001:intake",
        correlationId: "pipeline-timeout-correlation-0001",
        request: {
          text: "지식 준비가 멈춰도 질문을 보존해주세요",
          workspaceId: "pipeline-timeout-workspace-0001",
        },
      });
      let settled = false;
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started;
      const room = (await works.listRooms(context, preparedWorkId))[0];
      if (!room) throw new Error("Core Office 협업방이 없습니다");
      await expect(works.listMessages(context, preparedWorkId, room.room_id)).resolves.toMatchObject([
        {
          sequence: 1,
          message_type: "question",
          author_kind: "user",
          content: "지식 준비가 멈춰도 질문을 보존해주세요",
        },
      ]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      finishPreparation?.({
        brief: {
          evidenceBriefId: "pipeline-slow-brief-0001",
          indexVersionId: "pipeline-slow-index-0001",
          checksum: "a".repeat(64),
          status: "no_match",
        },
      });
      await expect(execution).resolves.toMatchObject({ outcome: "advanced", workId: preparedWorkId });
      expect(representativeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Workspace 지식 준비 중 parent abort는 DB 작업을 버리지 않고 settle 직후 기존 취소 경계로 수렴한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "workspace-abort-pipeline@example.com",
      displayName: "Workspace Abort",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const controller = new AbortController();
    let preparationStarted: (() => void) | undefined;
    let finishPreparation: ((value: unknown) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const preparation = new Promise<unknown>((resolve) => {
      finishPreparation = resolve;
    });
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      workspaces: {
        get: async () =>
          ({
            workspaceId: "pipeline-abort-workspace-0001",
            name: "Abort workspace",
            path: "/workspace/abort",
            status: "active",
            trust: "trusted",
          }) as never,
      },
      workspaceKnowledge: {
        prepare: async () => {
          preparationStarted?.();
          return (await preparation) as never;
        },
      },
      evidencePromptMaterializer: { materialize: async () => ({}) as never },
      evidenceContextBinder: { bind: async () => ({}) as never },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "abort-representative", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    const execution = stages.intake.execute(context, {
      runId: "pipeline-abort-run-0001",
      commandId: "pipeline-abort-run-0001:intake",
      correlationId: "pipeline-abort-correlation-0001",
      request: { text: "지식 준비 취소", workspaceId: "pipeline-abort-workspace-0001" },
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("Application run cancelled"));
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    finishPreparation?.({
      brief: {
        evidenceBriefId: "pipeline-abort-brief-0001",
        indexVersionId: "pipeline-abort-index-0001",
        checksum: "b".repeat(64),
        status: "no_match",
      },
    });

    await expect(execution).rejects.toThrow("Application run cancelled");
  });

  it("재시도 intake는 기존 Work를 만들지 않고 같은 Work로 Representative를 다시 실행한다", async () => {
    const createWorkCalls: string[] = [];
    const representativeCalls: Array<{ workId: string; commandId: string }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async (_context: unknown, input: { commandId: string }) => {
          createWorkCalls.push(input.commandId);
          return { work: { work_id: "new-work-should-not-exist" } };
        },
        getWork: async () => ({ revision: 1, status: "draft" }),
        transition: async () => ({}) as never,
        listRooms: async () => [
          { room_id: "existing-core-office-room", title: "Core Office", coordinator_handle: "representative" },
        ],
        postMessage: async () => ({ message: { message_id: "existing-core-office-message" } }) as never,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context: unknown, input: { workId: string; commandId: string }) => {
          representativeCalls.push({ workId: input.workId, commandId: input.commandId });
          return {
            executionId: "retry-representative-execution",
            status: "succeeded",
            output: "전략 단계로 전달합니다.",
          };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    await expect(
      stages.intake.execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-retry-run-0001",
          workId: "pipeline-existing-work-0001",
          commandId: "pipeline-retry-run-0001:intake:retry:run-resume-retry-command-0001",
          correlationId: "pipeline-retry-correlation-0001",
          request: { text: "기존 Work 재시도" },
        },
      ),
    ).resolves.toMatchObject({ outcome: "advanced", workId: "pipeline-existing-work-0001" });
    expect(createWorkCalls).toEqual([]);
    expect(representativeCalls).toEqual([
      {
        workId: "pipeline-existing-work-0001",
        commandId: "pipeline-retry-run-0001:intake:retry:run-resume-retry-command-0001:representative",
      },
    ]);
  });

  it("Work 생성 직후 취소되면 Work를 cancelled로 정리하고 Representative를 시작하지 않는다", async () => {
    const controller = new AbortController();
    const transitions: unknown[] = [];
    let representativeCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          controller.abort();
          return { work: { work_id: "pipeline-cancelled-work", revision: 1, status: "draft" } };
        },
        getWork: async () => ({ work_id: "pipeline-cancelled-work", revision: 1, status: "draft" }),
        transition: async (_context: unknown, value: unknown) => {
          transitions.push(value);
          return {} as never;
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => {
          representativeCalls += 1;
          return { executionId: "representative-should-not-start", status: "succeeded" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    await expect(
      stages.intake.execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-cancel-after-work-0001",
          commandId: "pipeline-cancel-after-work-0001:intake",
          correlationId: "pipeline-cancel-after-work-correlation-0001",
          request: { text: "Work 생성 뒤 취소" },
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("Application run cancelled");
    expect(transitions).toEqual([
      {
        commandId: "pipeline-cancel-after-work-0001:work-cancel",
        workId: "pipeline-cancelled-work",
        expectedRevision: 1,
        target: "cancelled",
      },
    ]);
    expect(representativeCalls).toBe(0);
  });

  it("intake가 실행 레코드 생성 중 취소된 Representative에 signal을 전달해 Provider 시작을 막는다", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () =>
          ({ work: { work_id: "pipeline-intake-signal-work", revision: 1, status: "draft" } }) as never,
        getWork: async () => ({ work_id: "pipeline-intake-signal-work", revision: 1, status: "draft" }) as never,
        transition: async () => ({}) as never,
        listRooms: async () =>
          [{ room_id: "signal-core-office-room", title: "Core Office", coordinator_handle: "representative" }] as never,
        openRoom: async () => {
          throw new Error("기존 Core Office 방을 열면 안 됩니다");
        },
        postMessage: async () => ({ message: { message_id: "signal-core-office-message" } }) as never,
        listMessages: async () => [],
        listSharedContexts: async () => [],
        addSharedContext: async () => {
          throw new Error("Workspace 없는 Intake에서 Shared Context를 추가하면 안 됩니다");
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context, runtimeInput) => {
          receivedSignal = runtimeInput.signal;
          // 실행 레코드를 만든 직후 coordinator가 취소한 상황을 재현합니다.
          controller.abort("application-run-cancelled");
          if (!runtimeInput.signal?.aborted) providerCalls += 1;
          return { executionId: "representative-cancelled-before-provider", status: "cancelled" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    await stages.intake.execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-intake-signal-0001",
        commandId: "pipeline-intake-signal-0001:intake",
        correlationId: "pipeline-intake-signal-correlation-0001",
        request: { text: "Representative 취소 신호 전달" },
        signal: controller.signal,
      },
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(providerCalls).toBe(0);
  });

  it("context-strategy는 Work 조회 중 취소되면 Provider 계획을 시작하지 않는다", async () => {
    const controller = new AbortController();
    let releaseWork!: (value: { readonly revision: number }) => void;
    let enteredWork!: () => void;
    const workRead = new Promise<void>((resolve) => {
      enteredWork = resolve;
    });
    const work = new Promise<{ readonly revision: number }>((resolve) => {
      releaseWork = resolve;
    });
    let planCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => {
          enteredWork();
          return await work;
        },
        transition: async () => ({}) as never,
        listRooms: async () => [],
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async () => {
          planCalls += 1;
          return { contextVersion: {}, generation: { status: "applied" }, projection: {} } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    const executing = stages["context-strategy"].execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-strategy-cancel-0001",
        workId: "pipeline-strategy-work-0001",
        commandId: "pipeline-strategy-cancel-0001:context-strategy",
        correlationId: "pipeline-strategy-cancel-correlation-0001",
        request: { text: "계획 취소" },
        signal: controller.signal,
      },
    );
    await workRead;
    controller.abort();
    releaseWork({ revision: 3 });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(planCalls).toBe(0);
  });

  it("context-strategy가 실행 레코드 생성 중 취소 신호를 Strategy plan에 전달한다", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3, status: "draft" }) as never,
        transition: async () => ({}) as never,
        listRooms: async () => [],
        openRoom: async () => {
          throw new Error("context-strategy에서 방을 열면 안 됩니다");
        },
        postMessage: async () => {
          throw new Error("context-strategy에서 메시지를 쓰면 안 됩니다");
        },
        listMessages: async () => [],
        listSharedContexts: async () => [],
        addSharedContext: async () => {
          throw new Error("context-strategy에서 Shared Context를 추가하면 안 됩니다");
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context, planInput) => {
          receivedSignal = planInput.signal;
          // StrategyGenerator가 실행 레코드를 만든 직후 취소된 경우를 재현합니다.
          controller.abort("application-run-cancelled");
          if (!planInput.signal?.aborted) providerCalls += 1;
          return { contextVersion: {}, generation: { status: "failed" } } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    await stages["context-strategy"].execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-strategy-signal-0001",
        workId: "pipeline-strategy-signal-work-0001",
        commandId: "pipeline-strategy-signal-0001:context-strategy",
        correlationId: "pipeline-strategy-signal-correlation-0001",
        request: { text: "Strategy 취소 신호 전달" },
        signal: controller.signal,
      },
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(providerCalls).toBe(0);
  });

  it("context-strategy 취소는 진행 중인 strategy runtime을 정리한다", async () => {
    const lookups: string[] = [];
    const cancelled: Array<{ readonly executionId: string; readonly reason: string }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3, status: "draft" }),
        transition: async () => ({}) as never,
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async (_context: unknown, commandId: string) => {
          lookups.push(commandId);
          return "strategy-runtime-execution-0001";
        },
      },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          cancelled.push({ executionId, reason });
        },
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);
    const context = { userId: "user", organizationId: "org", membershipId: "member", role: "owner" as const };

    await stages["context-strategy"].cancel?.(context, {
      runId: "pipeline-strategy-cancel-0002",
      workId: "pipeline-strategy-work-0002",
      commandId: "pipeline-strategy-cancel-0002:context-strategy:cancel",
      correlationId: "pipeline-strategy-cancel-correlation-0002",
      request: {},
    });

    expect(lookups).toEqual(["pipeline-strategy-cancel-0002:context-strategy:generate:runtime"]);
    expect(cancelled).toEqual([
      { executionId: "strategy-runtime-execution-0001", reason: "Application run cancelled" },
    ]);
  });

  it("context-strategy가 실제 StrategyService contract에 정본 request source를 전달한다", async () => {
    const captured: Array<{
      workId: string;
      expectedWorkRevision: number;
      context: {
        objective: string;
        constraints: readonly string[];
        sources: ReadonlyArray<{ kind: string; content: unknown; contentHash: string }>;
      };
    }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3 }),
        listRooms: async () => [],
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "execution", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context: unknown, input: unknown) => {
          captured.push(input as (typeof captured)[number]);
          return { contextVersion: {}, generation: { status: "applied" }, projection: {} } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);
    await expect(
      stages["context-strategy"].execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-run-0002",
          workId: "pipeline-work-0002",
          commandId: "pipeline-run-0002:context-strategy",
          correlationId: "pipeline-correlation-0002",
          request: { text: "계획", constraints: ["근거"] },
          directives: [
            {
              directiveId: "pipeline-strategy-directive-0001",
              content: "비용 상한을 계획에 반영해주세요",
              mode: "now",
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      outcome: "advanced",
      appliedDirectiveIds: ["pipeline-strategy-directive-0001"],
    });
    expect(captured[0]).toMatchObject({
      workId: "pipeline-work-0002",
      expectedWorkRevision: 3,
      context: {
        objective: "계획",
        constraints: ["근거"],
        sources: expect.arrayContaining([expect.objectContaining({ kind: "request", content: { text: "계획" } })]),
      },
    });
    const capturedInput = captured[0];
    const source = capturedInput?.context.sources[0];
    if (!source) throw new Error("Strategy source가 capture되지 않았습니다");
    expect(source.contentHash).toBe(hashContextContent({ text: "계획" }));
    expect(capturedInput.context.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "manual",
          content: {
            directiveId: "pipeline-strategy-directive-0001",
            content: "비용 상한을 계획에 반영해주세요",
            mode: "now",
          },
        }),
      ]),
    );
  });

  it("새 Work의 Core Office 방에 요청과 Representative handoff를 기록하고 전략 입력으로 다시 사용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "collaboration-pipeline@example.com",
      displayName: "Collaboration",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const captured: unknown[] = [];
    const unsafeHandoff =
      "요청을 분석했고 전략 수립으로 전달합니다. Bearer bearer-secret-123 sk-handoff-secret-1234567890 eyJabcdefghijk.abcdefghijk.abcdefghijk api_key=api-secret-123 key=bare-secret-123 private_key=private-secret-123 secret=secret-value-123\u0001\u007f\u0085" +
      "x".repeat(20_000);
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({
          executionId: "collaboration-representative-execution",
          status: "succeeded",
          output: unsafeHandoff,
        }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context, input) => {
          captured.push(input);
          return {
            contextVersion: { contextVersionId: "collaboration-context" },
            generation: {
              status: "applied",
              strategyGenerationId: "collaboration-strategy",
              runtimeExecutionId: "collaboration-strategy-execution",
              plan: { tasks: [] },
            },
            projection: {},
          } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const request = { text: "협업 기록을 남기는 업무를 시작해주세요", surface: "test" };
    const intake = await stages.intake.execute(context, {
      runId: "collaboration-pipeline-run",
      commandId: "collaboration-pipeline-run:intake",
      correlationId: "collaboration-pipeline-correlation",
      request,
    });
    if (intake.outcome !== "advanced" || !intake.workId) throw new Error("intake가 Work ID를 반환하지 않았습니다");
    const workId = intake.workId;

    const rooms = await works.listRooms(context, workId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ title: "Core Office", coordinator_handle: "representative", status: "active" });
    const room = rooms[0];
    if (!room) throw new Error("Core Office 협업방이 생성되지 않았습니다");
    const messages = await works.listMessages(context, workId, room.room_id);
    expect(messages).toMatchObject([
      {
        sequence: 1,
        message_type: "question",
        author_kind: "user",
        author_id: context.userId,
        content: request.text,
      },
      {
        sequence: 2,
        message_type: "handoff",
        author_kind: "agent",
        author_id: "representative",
        recipient_agent_id: "context-strategy",
        content: expect.stringContaining("요청을 분석했고 전략 수립으로 전달합니다."),
      },
    ]);
    const storedHandoff = messages[1]?.content ?? "";
    for (const secret of [
      "bearer-secret-123",
      "sk-handoff-secret-1234567890",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
      "api-secret-123",
      "bare-secret-123",
      "private-secret-123",
      "secret-value-123",
    ]) {
      expect(storedHandoff).not.toContain(secret);
    }
    expect(storedHandoff).toContain("[REDACTED]");
    expect(storedHandoff.length).toBeLessThanOrEqual(16_000);
    expect(
      Array.from(storedHandoff).some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
      }),
    ).toBe(false);

    await expect(
      stages["context-strategy"].execute(context, {
        runId: "collaboration-pipeline-run",
        workId,
        commandId: "collaboration-pipeline-run:context-strategy",
        correlationId: "collaboration-pipeline-correlation",
        request,
      }),
    ).resolves.toMatchObject({ outcome: "advanced" });
    const planned = captured[0] as {
      readonly context: {
        readonly sources: readonly {
          readonly kind: string;
          readonly contentHash: string;
          readonly content?: { readonly roomId?: string; readonly messages?: readonly Record<string, unknown>[] };
        }[];
      };
    };
    const collaboration = planned.context.sources.find((source) => source.kind === "collaboration");
    if (!collaboration?.content) throw new Error("Core Office 협업 source가 생성되지 않았습니다");
    expect(collaboration?.content?.roomId).toBe(room.room_id);
    expect(collaboration?.content?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorId: context.userId, content: request.text }),
        expect.objectContaining({ authorId: "representative", messageType: "handoff" }),
      ]),
    );
    expect(collaboration.contentHash).toBe(hashContextContent(collaboration.content));

    await stages.intake.execute(context, {
      runId: "collaboration-pipeline-run",
      workId,
      commandId: "collaboration-pipeline-run:intake:retry:retry-0001",
      correlationId: "collaboration-pipeline-correlation",
      request,
    });
    expect(await works.listRooms(context, workId)).toHaveLength(1);
    expect(
      (await works.listMessages(context, workId, room.room_id)).filter(
        (message) => message.message_type === "question" && message.author_id === context.userId,
      ),
    ).toHaveLength(1);
  });

  it("Delivery 지시는 downstream 실행 입력과 반영 확인을 그대로 보존한다", async () => {
    const deliveryInputs: unknown[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: {},
      works: {},
      runtimeExecutions: {},
      representative: {},
      strategy: {},
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: {
        execute: async (_context: unknown, input: { readonly directives?: readonly { directiveId: string }[] }) => {
          deliveryInputs.push(input);
          return {
            outcome: "advanced",
            appliedDirectiveIds: input.directives?.map((directive) => directive.directiveId),
          };
        },
      },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    await expect(
      stages.delivery.execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-delivery-directive-run-0001",
          workId: "pipeline-delivery-directive-work-0001",
          commandId: "pipeline-delivery-directive-run-0001:delivery",
          correlationId: "pipeline-delivery-directive-correlation-0001",
          request: { text: "기존 실행" },
          directives: [
            {
              directiveId: "pipeline-delivery-directive-0001",
              content: "기존 구현을 다른 언어로 다시 작성해주세요",
              mode: "now",
            },
          ],
        },
      ),
    ).resolves.toEqual({ outcome: "advanced", appliedDirectiveIds: ["pipeline-delivery-directive-0001"] });
    expect(deliveryInputs).toEqual([
      expect.objectContaining({
        directives: [
          {
            directiveId: "pipeline-delivery-directive-0001",
            content: "기존 구현을 다른 언어로 다시 작성해주세요",
            mode: "now",
          },
        ],
      }),
    ]);
  });

  it.each(["evidence", "assurance", "records"] as const)(
    "미지원 %s 지시는 downstream 실행 전에 명시적으로 차단한다",
    async (stage) => {
      const downstreamCalls: string[] = [];
      const unsupportedPort = {
        execute: async () => {
          downstreamCalls.push(stage);
          return { outcome: "advanced" as const };
        },
      };
      const stages = createCoreWorkPipelineExecutors({
        graph: {},
        works: {},
        runtimeExecutions: {},
        representative: {},
        strategy: {},
        evidence: stage === "evidence" ? unsupportedPort : { execute: async () => ({ outcome: "advanced" }) },
        delivery: { execute: async () => ({ outcome: "advanced" }) },
        assurance: stage === "assurance" ? unsupportedPort : { execute: async () => ({ outcome: "advanced" }) },
        records: stage === "records" ? unsupportedPort : { execute: async () => ({ outcome: "advanced" }) },
      } as never);

      await expect(
        stages[stage].execute(
          { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
          {
            runId: `pipeline-${stage}-directive-run-0001`,
            workId: `pipeline-${stage}-directive-work-0001`,
            commandId: `pipeline-${stage}-directive-run-0001:${stage}`,
            correlationId: `pipeline-${stage}-directive-correlation-0001`,
            request: { text: "기존 실행" },
            directives: [
              {
                directiveId: `pipeline-${stage}-directive-0001`,
                content: "미지원 단계에서 소비하지 마세요",
                mode: "now",
              },
            ],
          },
        ),
      ).resolves.toEqual({ outcome: "blocked", reason: `${stage}-directive-unsupported` });
      expect(downstreamCalls).toEqual([]);
    },
  );

  it("취소는 현재 실행을 drain하고 원자 convergence에서 실제 Work를 cancelled로 전이한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "pipeline-cancel@example.com",
      displayName: "Cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "pipeline-cancel-create-0001",
      text: "취소할 작업",
      surface: "test",
      organizationVersionId: core.version.version_id,
    });
    const drains: string[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: {
        execute: async () => ({ outcome: "advanced" }),
        cancel: async (_context, input) => {
          drains.push(input.commandId);
        },
      },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const cancellationInput = {
      runId: "pipeline-cancel-run-0001",
      workId: created.work.work_id,
      commandId: "pipeline-cancel-run-0001:delivery:cancel",
      correlationId: "pipeline-cancel-correlation-0001",
      request: {},
    } as const;
    await stages.delivery.cancel?.(context, cancellationInput);
    expect(drains).toEqual(["pipeline-cancel-run-0001:delivery:cancel"]);
    await expect(works.getWork(context, created.work.work_id)).resolves.toMatchObject({ status: "draft" });

    await database.transaction(async (transaction) => {
      await stages.delivery.convergeCancellation?.(context, cancellationInput, transaction);
    });
    await expect(works.getWork(context, created.work.work_id)).resolves.toMatchObject({ status: "cancelled" });
  });
});
