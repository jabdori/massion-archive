import {
  hashContextContent,
  type ContextSource,
  type PlanStrategyInput,
  type PlanStrategyResult,
  type StrategyService,
} from "@massion/context-strategy";
import type {
  EvidenceContextBinder,
  EvidencePromptMaterializer,
  MaterializedEvidencePrompt,
  WorkspaceKnowledgeService,
} from "@massion/evidence";
import type { TenantContext } from "@massion/identity";
import { CORE_OFFICE_HANDLES, type OrganizationGraphService } from "@massion/organization";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import type { QueryExecutor } from "@massion/storage";
import { canTransitionWork, type WorkService } from "@massion/work";
import type { WorkspaceService } from "@massion/workspace";

import type {
  CoreWorkStage,
  CoreWorkStageExecutor,
  CoreWorkStageInput,
  CoreWorkStageResult,
} from "./core-work-coordinator.js";

type StagePort = {
  execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult>;
  convergeCancellation?(
    context: TenantContext,
    input: Omit<CoreWorkStageInput, "resumeInput">,
    executor: QueryExecutor,
  ): Promise<void>;
  cancel?(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void>;
};

export interface CoreWorkPipelineDependencies {
  readonly graph: Pick<OrganizationGraphService, "getCurrentSnapshot">;
  readonly works: Pick<
    WorkService,
    | "createWork"
    | "getWork"
    | "transition"
    | "openRoom"
    | "postMessage"
    | "listRooms"
    | "listMessages"
    | "listSharedContexts"
    | "addSharedContext"
  >;
  readonly workspaces?: Pick<WorkspaceService, "get">;
  readonly workspaceKnowledge?: Pick<WorkspaceKnowledgeService, "prepare">;
  readonly evidencePromptMaterializer?: Pick<EvidencePromptMaterializer, "materialize">;
  readonly evidenceContextBinder?: Pick<EvidenceContextBinder, "bind">;
  readonly representative: Pick<AgentRunner, "execute" | "cancel">;
  readonly runtimeExecutions: Pick<RuntimeExecutionStore, "findExecutionIdByCommand">;
  readonly strategy: Pick<StrategyService, "plan">;
  readonly evidence: StagePort;
  readonly delivery: StagePort;
  readonly assurance: StagePort;
  readonly records: StagePort;
}

const CORE_OFFICE_ROOM_TITLE = "Core Office";
const MAX_KNOWLEDGE_TOKENS = 24_000;
const STAGE_OUTPUT_RESERVE_TOKENS = 4_000;

function promptTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

type CurrentOrganizationSnapshot = Awaited<ReturnType<CoreWorkPipelineDependencies["graph"]["getCurrentSnapshot"]>>;

function organizationDeclarationContent(snapshot: CurrentOrganizationSnapshot) {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return {
    product: {
      name: "Massion",
      identity: "현재 Work를 처리하는 조직형 AgentOS",
      interpretationRule:
        "사용자가 별도 외부 조직이나 서비스를 명시하지 않는 한, 'Massion'은 현재 설치의 AgentOS와 그 조직을 뜻합니다.",
    },
    organization: {
      version: snapshot.version.version,
      versionId: snapshot.version.version_id,
      nodes: nodes.map((node) => ({
        handle: node.handle,
        name: node.name,
        responsibility: node.responsibility,
        parentHandle: node.parent_handle,
        role: node.role,
        status: node.status,
        capabilities: node.capabilities,
        outputs: node.outputs,
      })),
    },
  };
}

function organizationDeclarationSource(snapshot: CurrentOrganizationSnapshot, observedAt: string): ContextSource {
  const content = organizationDeclarationContent(snapshot);
  const serialized = JSON.stringify(content);
  return {
    kind: "declaration",
    sourceId: `organization:${snapshot.version.version_id}`,
    revision: String(snapshot.version.version),
    contentHash: hashContextContent(content),
    observedAt,
    classification: "internal",
    priority: 120,
    estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
    mandatory: true,
    content,
  };
}

function directiveIds(input: CoreWorkStageInput): readonly string[] {
  return input.directives?.map((directive) => directive.directiveId) ?? [];
}

function strategyDirectiveSources(input: CoreWorkStageInput, observedAt: string): readonly ContextSource[] {
  return (input.directives ?? []).map((directive) => {
    const content = {
      directiveId: directive.directiveId,
      content: directive.content,
      mode: directive.mode,
    };
    return {
      kind: "manual",
      sourceId: directive.directiveId,
      revision: "1",
      contentHash: hashContextContent(content),
      observedAt,
      classification: "internal",
      priority: 110,
      estimatedTokens: Math.max(1, Math.ceil(JSON.stringify(content).length / 4)),
      mandatory: true,
      content,
    };
  });
}

function blockUnsupportedDirectives(
  stage: Exclude<CoreWorkStage, "context-strategy">,
  executor: CoreWorkStageExecutor,
): CoreWorkStageExecutor {
  return {
    claimDirectives: true,
    async execute(context, input) {
      if (input.directives && input.directives.length > 0) {
        return { outcome: "blocked", reason: `${stage}-directive-unsupported` };
      }
      return await executor.execute(context, input);
    },
    async cancel(context, input) {
      await executor.cancel?.(context, input);
    },
    async convergeCancellation(context, input, transaction) {
      await executor.convergeCancellation?.(context, input, transaction);
    },
  };
}

function handoffContent(output: unknown): string {
  let content: string | undefined;
  if (typeof output === "string" && output.trim()) content = output.trim();
  try {
    const encoded = content === undefined ? JSON.stringify(output) : undefined;
    if (encoded && encoded !== "{}" && encoded !== "null") content = encoded;
  } catch {
    // 구조화할 수 없는 실행 출력은 handoff 본문으로 저장하지 않습니다.
  }
  if (!content) return "사용자 요청을 Context & Strategy에 전달합니다.";
  const printable = Array.from(content)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && (code < 128 || code > 159));
    })
    .join("");
  const redacted = printable
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(
      /(\b(?:api[_ -]?key|private[_ -]?key|key|access[_ -]?token|authorization|credential|secret)\s*[:=]\s*["']?)[^\s,"';}]{8,}/giu,
      "$1[REDACTED]",
    )
    .trim();
  return redacted ? redacted.slice(0, 16_000) : "사용자 요청을 Context & Strategy에 전달합니다.";
}

interface CoreRequest {
  readonly text: string;
  readonly surface: string;
  readonly outputLocale: "en" | "ko";
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly workspacePaths: readonly string[];
  readonly tokenBudget: number;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly decisions: readonly string[];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function request(value: unknown): CoreRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Core Work request는 object여야 합니다");
  const input = value as Record<string, unknown>;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 64 * 1024) throw new Error("Core Work request text가 유효하지 않습니다");
  const tokenBudget = input.tokenBudget === undefined ? 32_000 : Number(input.tokenBudget);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1_000 || tokenBudget > 1_000_000)
    throw new Error("Core Work token budget이 유효하지 않습니다");
  return {
    text,
    surface: typeof input.surface === "string" ? input.surface : "application",
    outputLocale: input.outputLocale === "ko" ? "ko" : "en",
    ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    workspacePaths: strings(input.workspacePaths),
    tokenBudget,
    scopeIn: strings(input.scopeIn),
    scopeOut: strings(input.scopeOut),
    constraints: strings(input.constraints),
    assumptions: strings(input.assumptions),
    unknowns: strings(input.unknowns),
    decisions: strings(input.decisions),
  };
}

export function createCoreWorkPipelineExecutors(
  dependencies: CoreWorkPipelineDependencies,
): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  const cancelCreatedWork = async (
    context: TenantContext,
    runId: string,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<void> => {
    const work = await dependencies.works.getWork(context, workId, executor);
    if (!canTransitionWork(work.status, "cancelled")) return;
    await dependencies.works.transition(
      context,
      {
        commandId: `${runId}:work-cancel`,
        workId,
        expectedRevision: work.revision,
        target: "cancelled",
      },
      executor,
    );
  };
  const throwIfCancelled = (input: CoreWorkStageInput): void => {
    if (input.signal?.aborted) throw new Error("Application run cancelled");
  };
  const cancelAndThrowIfCancelled = async (
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
  ): Promise<void> => {
    if (!input.signal?.aborted) return;
    await cancelCreatedWork(context, input.runId, workId);
    throw new Error("Application run cancelled");
  };
  const coreOfficeRoom = async (
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    tokenBudget: number,
  ) => {
    const existing = (await dependencies.works.listRooms(context, workId)).find(
      (room) => room.title === CORE_OFFICE_ROOM_TITLE && room.coordinator_handle === "representative",
    );
    if (existing) return existing;
    const work = await dependencies.works.getWork(context, workId);
    const opened = await dependencies.works.openRoom(context, {
      commandId: `${input.runId}:core-office-room`,
      workId,
      expectedRevision: work.revision,
      title: CORE_OFFICE_ROOM_TITLE,
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        ...CORE_OFFICE_HANDLES.map((handle) => ({
          kind: "agent" as const,
          subjectId: handle,
          role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
        })),
      ],
      limits: {
        maxParallel: CORE_OFFICE_HANDLES.length,
        maxTokens: tokenBudget,
        maxCostMicros: 1_000_000,
        maxRounds: 100,
      },
    });
    return opened.room;
  };
  const intake: CoreWorkStageExecutor = {
    async execute(context, input) {
      const value = request(input.request);
      const organizationSnapshot = await dependencies.graph.getCurrentSnapshot(context);
      throwIfCancelled(input);
      const representativeInput = {
        operation: "coordinate_work",
        request: value,
        responseLanguage: value.outputLocale === "ko" ? "Korean (ko)" : "English (en)",
        organization: organizationDeclarationContent(organizationSnapshot),
        coordinationContract:
          "Representative는 이 단계에서 Task·Artifact 도구를 직접 호출하지 않습니다. 도구 부재를 업무 완료 불가 사유로 보고하지 말고, 요청과 조직을 분석해 Context & Strategy가 후속 계획·배치·실행을 진행할 수 있는 실행 지향 handoff만 반환하세요. Task 실행, ArtifactVersion 저장, Assurance 검증, Records 완료는 후속 AgentOS 단계가 자동 처리합니다.",
      };
      const representativeBaseline = Math.min(
        value.tokenBudget,
        promptTokens(representativeInput) + STAGE_OUTPUT_RESERVE_TOKENS,
      );
      let workId = input.workId;
      if (workId === undefined) {
        const created = await dependencies.works.createWork(context, {
          commandId: `${input.commandId}:work`,
          text: value.text,
          surface: value.surface,
          outputLocale: value.outputLocale,
          organizationVersionId: organizationSnapshot.version.version_id,
          ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
          ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId }),
        });
        workId = created.work.work_id;
        if (input.signal?.aborted) await cancelAndThrowIfCancelled(context, input, workId);
      }
      if (input.signal?.aborted) await cancelAndThrowIfCancelled(context, input, workId);
      const room = await coreOfficeRoom(context, input, workId, value.tokenBudget);
      await cancelAndThrowIfCancelled(context, input, workId);
      const requestMessage = await dependencies.works.postMessage(context, {
        commandId: `${input.runId}:core-office-request`,
        workId,
        roomId: room.room_id,
        messageType: "question",
        authorKind: "user",
        authorId: context.userId,
        content: value.text,
        tokenCount: 0,
        costMicros: 0,
      });
      await cancelAndThrowIfCancelled(context, input, workId);
      const currentWork = await dependencies.works.getWork(context, workId);
      await cancelAndThrowIfCancelled(context, input, workId);
      let knowledgeSources: readonly MaterializedEvidencePrompt[] | undefined;
      if (currentWork.workspace_id !== undefined) {
        if (!dependencies.workspaces)
          return { outcome: "blocked", reason: "workspace-knowledge-not-configured", workId };
        let workspace: Awaited<ReturnType<NonNullable<typeof dependencies.workspaces>["get"]>>;
        try {
          workspace = await dependencies.workspaces.get(context, currentWork.workspace_id);
        } catch {
          await cancelAndThrowIfCancelled(context, input, workId);
          return { outcome: "blocked", reason: "workspace-inactive", workId };
        }
        await cancelAndThrowIfCancelled(context, input, workId);
        if (workspace.status !== "active") return { outcome: "blocked", reason: "workspace-inactive", workId };
        if (workspace.trust !== "trusted") return { outcome: "blocked", reason: "workspace-untrusted", workId };
        if (
          !dependencies.workspaceKnowledge ||
          !dependencies.evidencePromptMaterializer ||
          !dependencies.evidenceContextBinder
        ) {
          return { outcome: "blocked", reason: "workspace-knowledge-not-configured", workId };
        }
        let prepared: Awaited<ReturnType<typeof dependencies.workspaceKnowledge.prepare>>;
        try {
          prepared = await dependencies.workspaceKnowledge.prepare(context, {
            commandId: `${input.runId}:knowledge`,
            workId,
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.name,
            root: workspace.path,
            query: value.text,
            ...(value.workspacePaths.length === 0 ? {} : { relativePaths: value.workspacePaths }),
          });
        } catch {
          await cancelAndThrowIfCancelled(context, input, workId);
          return { outcome: "blocked", reason: "evidence-invalid", workId };
        }
        await cancelAndThrowIfCancelled(context, input, workId);
        const { brief } = prepared;
        if (brief.status === "ready") {
          let existing: { readonly checksum: string } | undefined;
          try {
            existing = (await dependencies.works.listSharedContexts(context, workId, room.room_id)).find(
              (reference) =>
                reference.source_kind === "evidence-brief" &&
                reference.source_id === brief.evidenceBriefId &&
                reference.version_id === brief.indexVersionId,
            );
          } catch {
            await cancelAndThrowIfCancelled(context, input, workId);
            return { outcome: "blocked", reason: "evidence-invalid", workId };
          }
          await cancelAndThrowIfCancelled(context, input, workId);
          if (existing && existing.checksum !== brief.checksum)
            return { outcome: "blocked", reason: "evidence-invalid", workId };
          if (!existing) {
            let latestRevision: number;
            try {
              latestRevision = (await dependencies.works.getWork(context, workId)).revision;
            } catch {
              await cancelAndThrowIfCancelled(context, input, workId);
              return { outcome: "blocked", reason: "evidence-invalid", workId };
            }
            await cancelAndThrowIfCancelled(context, input, workId);
            try {
              await dependencies.works.addSharedContext(context, {
                commandId: `${input.runId}:knowledge-shared:${brief.evidenceBriefId}`,
                workId,
                expectedRevision: latestRevision,
                roomId: room.room_id,
                sourceKind: "evidence-brief",
                sourceId: brief.evidenceBriefId,
                versionId: brief.indexVersionId,
                checksum: brief.checksum,
              });
            } catch {
              await cancelAndThrowIfCancelled(context, input, workId);
              return { outcome: "blocked", reason: "evidence-invalid", workId };
            }
            await cancelAndThrowIfCancelled(context, input, workId);
          }
          let materialized: MaterializedEvidencePrompt;
          const maxKnowledgeTokens = Math.min(MAX_KNOWLEDGE_TOKENS, value.tokenBudget - representativeBaseline);
          if (maxKnowledgeTokens < 1) return { outcome: "blocked", reason: "evidence-invalid", workId };
          try {
            materialized = await dependencies.evidencePromptMaterializer.materialize(context, {
              workId,
              evidenceBriefId: brief.evidenceBriefId,
              maxEstimatedTokens: maxKnowledgeTokens,
            });
          } catch {
            await cancelAndThrowIfCancelled(context, input, workId);
            return { outcome: "blocked", reason: "evidence-invalid", workId };
          }
          await cancelAndThrowIfCancelled(context, input, workId);
          if (
            materialized.evidenceBriefId !== brief.evidenceBriefId ||
            materialized.indexVersionId !== brief.indexVersionId ||
            materialized.briefChecksum !== brief.checksum ||
            !Number.isSafeInteger(materialized.estimatedTokens) ||
            materialized.estimatedTokens < 1 ||
            materialized.estimatedTokens > maxKnowledgeTokens
          ) {
            return { outcome: "blocked", reason: "evidence-invalid", workId };
          }
          knowledgeSources = [materialized];
        } else if (brief.status !== "no_match") {
          return { outcome: "blocked", reason: "evidence-invalid", workId };
        }
      }
      const runtime = await dependencies.representative.execute(context, {
        commandId: `${input.commandId}:representative`,
        workId,
        agentHandle: "representative",
        modelRoute: "orchestration-balanced",
        correlationId: input.correlationId,
        estimatedTokens: representativeBaseline + (knowledgeSources?.[0]?.estimatedTokens ?? 0),
        estimatedCostMicros: 0,
        input: {
          ...representativeInput,
          ...(knowledgeSources === undefined ? {} : { knowledgeSources }),
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (runtime.status === "blocked_model_unavailable")
        return { outcome: "blocked", reason: "model-unavailable", workId };
      if (runtime.status !== "succeeded")
        return { outcome: "blocked", reason: `representative-${runtime.status}`, workId };
      if (input.signal?.aborted) return { outcome: "blocked", reason: "representative-cancelled", workId };
      if (typeof runtime.output !== "string" || !runtime.output.trim())
        return { outcome: "blocked", reason: "representative-invalid-output", workId };
      await dependencies.works.postMessage(context, {
        commandId: `${input.commandId}:representative-handoff`,
        workId,
        roomId: room.room_id,
        messageType: "handoff",
        authorKind: "agent",
        authorId: "representative",
        recipientAgentId: "context-strategy",
        content: handoffContent(runtime.output),
        replyToMessageId: requestMessage.message.message_id,
        causedByMessageId: requestMessage.message.message_id,
        executionId: runtime.executionId,
        tokenCount: 0,
        costMicros: 0,
      });
      await cancelAndThrowIfCancelled(context, input, workId);
      return {
        outcome: "advanced",
        workId,
        data: { representativeExecutionId: runtime.executionId, roomId: room.room_id },
      };
    },
    async cancel(context, input) {
      const executionCommand = `${input.commandId.replace(/:cancel$/u, "")}:representative`;
      const executionId = await dependencies.runtimeExecutions.findExecutionIdByCommand(context, executionCommand);
      if (executionId) await dependencies.representative.cancel(context, executionId, "Application run cancelled");
    },
  };
  const strategy: CoreWorkStageExecutor = {
    async execute(context, input) {
      if (!input.workId) throw new Error("context-strategy stage에 Work ID가 없습니다");
      const value = request(input.request);
      const work = await dependencies.works.getWork(context, input.workId);
      throwIfCancelled(input);
      const organizationSnapshot = await dependencies.graph.getCurrentSnapshot(context);
      throwIfCancelled(input);
      const sourceContent = { text: value.text };
      const room = (await dependencies.works.listRooms(context, input.workId)).find(
        (candidate) => candidate.title === CORE_OFFICE_ROOM_TITLE && candidate.coordinator_handle === "representative",
      );
      throwIfCancelled(input);
      const messages = room ? await dependencies.works.listMessages(context, input.workId, room.room_id) : [];
      throwIfCancelled(input);
      const handoffIndex = messages.findLastIndex(
        (message) =>
          message.author_kind === "agent" &&
          message.author_id === "representative" &&
          message.message_type === "handoff",
      );
      // Strategy 입력은 권한 있는 Representative handoff까지로 고정합니다. 이후 projection message가
      // stage command replay의 context hash를 바꾸거나 실행 완료 권한처럼 취급되면 안 됩니다.
      const strategyMessages = handoffIndex < 0 ? messages : messages.slice(0, handoffIndex + 1);
      const evidenceReferences =
        room && work.workspace_id !== undefined
          ? (await dependencies.works.listSharedContexts(context, input.workId, room.room_id)).filter(
              (reference) => reference.source_kind === "evidence-brief",
            )
          : [];
      throwIfCancelled(input);
      if (evidenceReferences.length > 1) return { outcome: "blocked", reason: "evidence-invalid" };
      const observedAt = new Date().toISOString();
      const sources: ContextSource[] = [
        {
          kind: "request",
          sourceId: input.runId,
          revision: "1",
          contentHash: hashContextContent(sourceContent),
          observedAt,
          classification: "internal",
          priority: 100,
          estimatedTokens: Math.max(1, Math.ceil(value.text.length / 4)),
          mandatory: true,
          content: sourceContent,
        },
        organizationDeclarationSource(organizationSnapshot, observedAt),
        ...strategyDirectiveSources(input, observedAt),
      ];
      if (room && strategyMessages.length > 0) {
        const collaborationContent = {
          roomId: room.room_id,
          messages: strategyMessages.map((message) => ({
            sequence: message.sequence,
            messageType: message.message_type,
            authorKind: message.author_kind,
            authorId: message.author_id,
            content: message.content,
          })),
        };
        const serialized = JSON.stringify(collaborationContent);
        sources.push({
          kind: "collaboration",
          sourceId: room.room_id,
          revision: String(strategyMessages.at(-1)?.sequence ?? 0),
          contentHash: hashContextContent(collaborationContent),
          observedAt: new Date().toISOString(),
          classification: "internal",
          priority: 90,
          estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
          mandatory: false,
          content: collaborationContent,
        });
      }
      for (const reference of evidenceReferences) {
        if (!dependencies.evidenceContextBinder) return { outcome: "blocked", reason: "evidence-invalid" };
        let source: ContextSource;
        try {
          source = await dependencies.evidenceContextBinder.bind(context, {
            evidenceBriefId: reference.source_id,
            policy: "warn",
          });
        } catch {
          throwIfCancelled(input);
          return { outcome: "blocked", reason: "evidence-invalid" };
        }
        throwIfCancelled(input);
        if (
          source.sourceId !== reference.source_id ||
          source.revision !== reference.version_id ||
          source.contentHash !== reference.checksum
        ) {
          return { outcome: "blocked", reason: "evidence-invalid" };
        }
        // content는 선택 속성(content?: unknown)이므로 정적 삭제로 메타데이터만 남깁니다.
        const metadataOnly = { ...source };
        delete metadataOnly.content;
        sources.push(metadataOnly);
      }
      const planInput: PlanStrategyInput = {
        commandId: input.commandId,
        workId: input.workId,
        expectedWorkRevision: work.revision,
        tokenBudget: value.tokenBudget,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        context: {
          objective: value.text,
          scopeIn: value.scopeIn,
          scopeOut: value.scopeOut,
          constraints: value.constraints,
          assumptions: value.assumptions,
          unknowns: value.unknowns,
          decisions: value.decisions,
          sources,
        },
      };
      const planned: PlanStrategyResult = await dependencies.strategy.plan(context, planInput);
      if (planned.generation.status === "blocked_model_unavailable")
        return { outcome: "blocked", reason: "model-unavailable" };
      if (planned.generation.status !== "applied" || !planned.projection)
        return { outcome: "blocked", reason: `strategy-${planned.generation.status}` };
      return {
        outcome: "advanced",
        data: {
          contextVersionId: planned.contextVersion.contextVersionId,
          strategyGenerationId: planned.generation.strategyGenerationId,
        },
        ...(directiveIds(input).length === 0 ? {} : { appliedDirectiveIds: directiveIds(input) }),
      };
    },
    async cancel(context, input) {
      const strategyCommandId = input.commandId.replace(/:cancel$/u, "");
      const executionId = await dependencies.runtimeExecutions.findExecutionIdByCommand(
        context,
        `${strategyCommandId}:generate:runtime`,
      );
      if (executionId) await dependencies.representative.cancel(context, executionId, "Application run cancelled");
    },
  };
  const cancelWork = (stage: StagePort): CoreWorkStageExecutor => ({
    execute: async (context, input) => await stage.execute(context, input),
    async cancel(context, input) {
      await stage.cancel?.(context, input);
    },
    async convergeCancellation(context, input, transaction) {
      await stage.convergeCancellation?.(context, input, transaction);
      if (input.workId) await cancelCreatedWork(context, input.runId, input.workId, transaction);
    },
  });
  return {
    intake: blockUnsupportedDirectives("intake", cancelWork(intake)),
    "context-strategy": cancelWork(strategy),
    evidence: blockUnsupportedDirectives("evidence", cancelWork(dependencies.evidence)),
    delivery: cancelWork(dependencies.delivery),
    assurance: blockUnsupportedDirectives("assurance", cancelWork(dependencies.assurance)),
    records: blockUnsupportedDirectives("records", cancelWork(dependencies.records)),
  };
}
