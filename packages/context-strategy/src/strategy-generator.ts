import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { CORE_OFFICE_HANDLES } from "@massion/organization";
import type { StructuredAgentRunner, StructuredOutputValidationResult } from "@massion/runtime";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { WorkService } from "@massion/work";

import type { ContextStore } from "./context-store.js";
import { hashContextContent } from "./context-store.js";
import { STRATEGY_GENERATION_MIGRATION, STRATEGY_GENERATION_RECOVERY_MIGRATION } from "./schema.js";
import {
  automaticStrategyPlanJsonSchema,
  validateAutomaticStrategyPlan,
  validateStrategyPlan,
  type StrategyPlan,
} from "./strategy-schema.js";

export type StrategyGenerationStatus =
  "pending" | "generated" | "blocked_model_unavailable" | "failed" | "applied" | "conflicted";

export interface StrategyGeneration {
  readonly strategyGenerationId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly contextVersionId: string;
  readonly commandId: string;
  readonly expectedWorkRevision: number;
  readonly status: StrategyGenerationStatus;
  readonly runtimeExecutionId?: string;
  readonly plan?: StrategyPlan;
  readonly checksum?: string;
  readonly error?: { readonly category: string; readonly causeId: string };
  readonly createdByUserId: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface StrategyStartupRecoveryCandidate {
  readonly strategyGenerationId: string;
  readonly organizationId: string;
  readonly actorUserId?: string;
}

export interface GenerateStrategyInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly contextVersionId: string;
  readonly signal?: AbortSignal;
}

interface StrategyGenerationRecord {
  readonly strategy_generation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly context_version_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly expected_work_revision: number;
  readonly status: StrategyGenerationStatus;
  readonly runtime_execution_id?: string;
  readonly plan_json?: string;
  readonly checksum?: string;
  readonly error_json?: string;
  readonly execution_claim_id?: string;
  readonly execution_claim_expires_at?: unknown;
  readonly execution_started_at?: unknown;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface PreparedStrategyExecution {
  readonly contextVersion: Awaited<ReturnType<ContextStore["get"]>>;
  readonly baselineTokens: number;
  readonly evidenceTokens: number;
  readonly evidenceMaterials: readonly StrategyEvidenceMaterial[];
  readonly route: string;
  readonly availableAgents: readonly StrategyPlanningAgent[];
  readonly availableAgentCapabilities: ReadonlyMap<string, ReadonlySet<string>>;
}

interface StoredGenerationError {
  readonly category: string;
  readonly causeId: string;
  readonly terminalStatus?: "blocked_model_unavailable" | "failed";
}

const EXECUTION_CLAIM_LEASE_MS = 60_000;
const PENDING_POLL_MS = 10;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(input: GenerateStrategyInput): string {
  const { signal, ...request } = input;
  void signal;
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function datetimeMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  if (!serialized) return Number.NaN;
  const parsed = JSON.parse(serialized) as unknown;
  return typeof parsed === "string" || typeof parsed === "number" ? new Date(parsed).getTime() : Number.NaN;
}

async function waitForPending(signal?: AbortSignal): Promise<void> {
  if (signal) await delay(PENDING_POLL_MS, undefined, { signal });
  else await delay(PENDING_POLL_MS);
}

export interface StrategyPlanningAgent {
  readonly handle: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly scope: "persistent" | "work";
  readonly work_id?: string;
}

export interface StrategyAgentDirectory {
  listNodes(context: TenantContext, executor?: QueryExecutor): Promise<readonly StrategyPlanningAgent[]>;
}

export interface StrategyEvidenceMaterial {
  readonly evidenceBriefId: string;
  readonly indexVersionId: string;
  readonly briefChecksum: string;
  readonly snippets: readonly { readonly citation: string; readonly content: string }[];
  readonly estimatedTokens: number;
}

export interface StrategyEvidenceMaterialResolver {
  materialize(
    context: TenantContext,
    input: { readonly workId: string; readonly evidenceBriefId: string; readonly maxEstimatedTokens?: number },
  ): Promise<StrategyEvidenceMaterial>;
}

function validatedPlan(
  value: unknown,
  availableAgentCapabilities: ReadonlyMap<string, ReadonlySet<string>>,
): StrategyPlan {
  const plan = validateAutomaticStrategyPlan(value);
  for (const task of plan.tasks) {
    for (const handle of task.recommendedAgentHandles) {
      const capabilities = availableAgentCapabilities.get(handle);
      if (!capabilities) throw new Error("StrategyPlan이 활성 Organization Agent가 아닌 담당자를 추천했습니다");
      if (task.requiredCapabilities.some((capability) => !capabilities.has(capability))) {
        throw new Error("StrategyPlan이 필수 역량을 모두 보유하지 않은 담당자를 추천했습니다");
      }
    }
  }
  return plan;
}

function validateOutput(
  value: unknown,
  availableAgentCapabilities: ReadonlyMap<string, ReadonlySet<string>>,
): StructuredOutputValidationResult {
  try {
    return { success: true, value: validatedPlan(value, availableAgentCapabilities) };
  } catch {
    return { success: false, error: new Error("StrategyPlan structured output 검증에 실패했습니다") };
  }
}

export class StrategyGenerator {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runner: StructuredAgentRunner,
    private readonly contexts: Pick<ContextStore, "get">,
    private readonly works: Pick<WorkService, "getWork">,
    private readonly agents?: StrategyAgentDirectory,
    private readonly evidence?: StrategyEvidenceMaterialResolver,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    runner: StructuredAgentRunner,
    contexts: Pick<ContextStore, "get">,
    works: Pick<WorkService, "getWork">,
    agents?: StrategyAgentDirectory,
    evidence?: StrategyEvidenceMaterialResolver,
  ): Promise<StrategyGenerator> {
    await applyMigrations(database, [STRATEGY_GENERATION_MIGRATION, STRATEGY_GENERATION_RECOVERY_MIGRATION]);
    return new StrategyGenerator(database, organizations, runner, contexts, works, agents, evidence);
  }

  public async generate(context: TenantContext, input: GenerateStrategyInput): Promise<StrategyGeneration> {
    await this.organizations.verifyTenantContext(context);
    const hash = requestHash(input);
    const existing = await this.byCommand(context.organizationId, input.commandId);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("같은 commandId에 다른 Strategy 요청을 사용할 수 없습니다");
      if (existing.status !== "pending") return this.view(existing);
      const continued = await this.continuePending(context, input, hash, true);
      if (!continued) throw new Error("Strategy generation pending 대기가 중단됐습니다");
      return continued;
    }

    const prepared = await this.prepareExecution(context, input);
    const claimed = await this.claimGeneration(context, input, hash, true);
    if (claimed.record.status !== "pending") return this.view(claimed.record);
    if (!claimed.claimId) {
      const continued = await this.continuePending(context, input, hash, true);
      if (!continued) throw new Error("Strategy generation pending 대기가 중단됐습니다");
      return continued;
    }
    return await this.executeClaimed(context, input, claimed.record, claimed.claimId, prepared);
  }

  public async get(context: TenantContext, strategyGenerationId: string): Promise<StrategyGeneration> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, strategyGenerationId));
  }

  public async listGenerated(context: TenantContext): Promise<StrategyGeneration[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND status = 'generated' ORDER BY created_at ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => this.view(record));
  }

  public async listRecoverable(context: TenantContext): Promise<StrategyGeneration[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND status IN ['pending', 'generated'] ORDER BY created_at ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => this.view(record));
  }

  public async listStartupRecoverable(limit = 100): Promise<StrategyStartupRecoveryCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Strategy 시작 복구 조회 개수가 유효하지 않습니다");
    }
    const [records] = await this.database.query<
      [
        Pick<
          StrategyGenerationRecord,
          "strategy_generation_id" | "organization_id" | "created_by_user_id" | "created_at"
        >[],
      ]
    >(
      "SELECT strategy_generation_id, organization_id, created_by_user_id, created_at FROM strategy_generation WHERE status IN ['pending', 'generated'] ORDER BY created_at ASC, strategy_generation_id ASC LIMIT $limit;",
      { limit },
    );
    return records.map((record) => ({
      strategyGenerationId: record.strategy_generation_id,
      organizationId: record.organization_id,
      ...(record.created_by_user_id ? { actorUserId: record.created_by_user_id } : {}),
    }));
  }

  public async recoverPending(
    context: TenantContext,
    strategyGenerationId: string,
    waitForLease = false,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration | undefined> {
    signal?.throwIfAborted();
    await this.organizations.verifyTenantContext(context);
    signal?.throwIfAborted();
    const record = await this.find(this.database, context.organizationId, strategyGenerationId);
    signal?.throwIfAborted();
    if (record.status !== "pending") return this.view(record);
    return await this.continuePending(
      context,
      {
        commandId: record.command_id,
        workId: record.work_id,
        expectedWorkRevision: record.expected_work_revision,
        contextVersionId: record.context_version_id,
        ...(signal ? { signal } : {}),
      },
      record.request_hash,
      waitForLease,
      signal,
    );
  }

  public async markApplied(
    context: TenantContext,
    strategyGenerationId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    return await this.reconcile(context, strategyGenerationId, commandId, "applied", signal);
  }

  public async markConflicted(
    context: TenantContext,
    strategyGenerationId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    return await this.reconcile(context, strategyGenerationId, commandId, "conflicted", signal);
  }

  private async prepareExecution(
    context: TenantContext,
    input: GenerateStrategyInput,
    recoverySignal?: AbortSignal,
  ): Promise<PreparedStrategyExecution> {
    recoverySignal?.throwIfAborted();
    const work = await this.works.getWork(context, input.workId);
    recoverySignal?.throwIfAborted();
    if (work.revision !== input.expectedWorkRevision)
      throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
    const contextVersion = await this.contexts.get(context, input.contextVersionId);
    recoverySignal?.throwIfAborted();
    if (contextVersion.workId !== input.workId) throw new Error("ContextVersion과 Work가 일치하지 않습니다");
    const evidenceSources = contextVersion.selectedSources.filter((source) => source.kind === "evidence");
    if (evidenceSources.length > 0 && !this.evidence) throw new Error("Strategy evidence resolver가 없습니다");
    const baselineTokens = Math.min(contextVersion.tokenBudget, contextVersion.tokenTotal + 4_000);
    const maxEvidenceTokens = Math.min(24_000, contextVersion.tokenBudget - baselineTokens);
    if (evidenceSources.length > 0 && maxEvidenceTokens < 1)
      throw new Error("Strategy evidence를 위한 Context 실행 예산이 부족합니다");
    const evidenceMaterials: StrategyEvidenceMaterial[] = [];
    let evidenceTokens = 0;
    for (const source of evidenceSources) {
      const reference = source.evidenceRef;
      if (
        source.content !== undefined ||
        !reference ||
        source.sourceId !== reference.evidenceBriefId ||
        source.revision !== reference.indexVersionId ||
        source.contentHash !== reference.briefChecksum
      ) {
        throw new Error("Strategy evidence source 계약이 일치하지 않습니다");
      }
      const evidence = this.evidence;
      if (!evidence) throw new Error("Strategy evidence resolver가 없습니다");
      const materialized = await evidence.materialize(context, {
        workId: input.workId,
        evidenceBriefId: reference.evidenceBriefId,
        maxEstimatedTokens: maxEvidenceTokens - evidenceTokens,
      });
      recoverySignal?.throwIfAborted();
      if (
        materialized.evidenceBriefId !== reference.evidenceBriefId ||
        materialized.indexVersionId !== reference.indexVersionId ||
        materialized.briefChecksum !== reference.briefChecksum
      ) {
        throw new Error("Strategy materialized evidence가 source와 일치하지 않습니다");
      }
      if (
        !Number.isSafeInteger(materialized.estimatedTokens) ||
        materialized.estimatedTokens < 1 ||
        evidenceTokens + materialized.estimatedTokens > maxEvidenceTokens
      ) {
        throw new Error("Strategy evidence material token 합계가 Context 실행 예산을 초과했습니다");
      }
      evidenceTokens += materialized.estimatedTokens;
      evidenceMaterials.push(materialized);
    }
    const route = contextVersion.selectedSources.some((source) => source.classification === "local-private")
      ? "local-private"
      : "planning-quality";
    const availableAgents = await this.availableAgents(context, input.workId);
    recoverySignal?.throwIfAborted();
    return {
      contextVersion,
      baselineTokens,
      evidenceTokens,
      evidenceMaterials,
      route,
      availableAgents,
      availableAgentCapabilities: new Map(
        availableAgents.map((agent) => [agent.handle, new Set(agent.capabilities)] as const),
      ),
    };
  }

  private async claimGeneration(
    context: TenantContext,
    input: GenerateStrategyInput,
    hash: string,
    create: boolean,
    recoverySignal?: AbortSignal,
  ): Promise<{ readonly record: StrategyGenerationRecord; readonly claimId?: string }> {
    recoverySignal?.throwIfAborted();
    const claimId = randomUUID();
    const claimExpiresAt = new Date(Date.now() + EXECUTION_CLAIM_LEASE_MS).toISOString();
    const generationId = randomUUID();
    return await this.database.transaction(async (tx) => {
      recoverySignal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      recoverySignal?.throwIfAborted();
      const repeated = await this.byCommand(context.organizationId, input.commandId, tx);
      recoverySignal?.throwIfAborted();
      if (repeated) {
        if (repeated.request_hash !== hash) throw new Error("같은 commandId에 다른 Strategy 요청을 사용할 수 없습니다");
        if (
          repeated.status !== "pending" ||
          this.pendingCheckpoint(repeated) ||
          this.claimIsActive(repeated) ||
          repeated.execution_started_at !== undefined
        ) {
          return { record: repeated };
        }
        recoverySignal?.throwIfAborted();
        const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
          "UPDATE strategy_generation SET execution_claim_id = $execution_claim_id, execution_claim_expires_at = type::datetime($execution_claim_expires_at), updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' RETURN AFTER;",
          {
            execution_claim_id: claimId,
            execution_claim_expires_at: claimExpiresAt,
            organization_id: context.organizationId,
            strategy_generation_id: repeated.strategy_generation_id,
          },
        );
        recoverySignal?.throwIfAborted();
        if (!updated[0] || updated[0].execution_claim_id !== claimId) {
          return { record: await this.find(tx, context.organizationId, repeated.strategy_generation_id) };
        }
        return { record: updated[0], claimId };
      }
      if (!create) throw new Error(`Strategy generation을 찾을 수 없습니다: ${input.commandId}`);
      recoverySignal?.throwIfAborted();
      await tx.query(
        "CREATE strategy_generation CONTENT { strategy_generation_id: $strategy_generation_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: $command_id, request_hash: $request_hash, expected_work_revision: $expected_work_revision, status: 'pending', execution_claim_id: $execution_claim_id, execution_claim_expires_at: type::datetime($execution_claim_expires_at), created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() };",
        {
          strategy_generation_id: generationId,
          organization_id: context.organizationId,
          work_id: input.workId,
          context_version_id: input.contextVersionId,
          command_id: input.commandId,
          request_hash: hash,
          expected_work_revision: input.expectedWorkRevision,
          execution_claim_id: claimId,
          execution_claim_expires_at: claimExpiresAt,
          created_by_user_id: context.userId,
        },
      );
      recoverySignal?.throwIfAborted();
      await this.insertEvent(
        tx,
        context.organizationId,
        input.workId,
        generationId,
        `${input.commandId}:started`,
        "strategy_generation_started",
        { contextVersionId: input.contextVersionId },
      );
      recoverySignal?.throwIfAborted();
      return { record: await this.find(tx, context.organizationId, generationId), claimId };
    });
  }

  private async continuePending(
    context: TenantContext,
    input: GenerateStrategyInput,
    hash: string,
    wait: boolean,
    recoverySignal?: AbortSignal,
  ): Promise<StrategyGeneration | undefined> {
    for (;;) {
      recoverySignal?.throwIfAborted();
      const claimed = await this.claimGeneration(context, input, hash, false, recoverySignal);
      recoverySignal?.throwIfAborted();
      if (claimed.record.status !== "pending") return this.view(claimed.record);
      if (this.pendingCheckpoint(claimed.record)) {
        return await this.finishCheckpoint(context, claimed.record, recoverySignal);
      }
      if (claimed.record.execution_started_at !== undefined && !this.claimIsActive(claimed.record)) {
        return await this.closeUncertainExecution(context, claimed.record, recoverySignal);
      }
      if (claimed.claimId) {
        const work = await this.works.getWork(context, input.workId);
        recoverySignal?.throwIfAborted();
        if (work.revision !== input.expectedWorkRevision) {
          return await this.closeClaimed(
            context,
            claimed.record,
            claimed.claimId,
            "conflicted",
            "work_revision_conflict",
            recoverySignal,
          );
        }
        let prepared: PreparedStrategyExecution;
        try {
          prepared = await this.prepareExecution(context, input, recoverySignal);
        } catch {
          recoverySignal?.throwIfAborted();
          return await this.closeClaimed(
            context,
            claimed.record,
            claimed.claimId,
            "failed",
            "recovery_preparation",
            recoverySignal,
          );
        }
        recoverySignal?.throwIfAborted();
        return await this.executeClaimed(context, input, claimed.record, claimed.claimId, prepared, recoverySignal);
      }
      if (!wait) return undefined;
      await waitForPending(recoverySignal);
    }
  }

  private async executeClaimed(
    context: TenantContext,
    input: GenerateStrategyInput,
    record: StrategyGenerationRecord,
    claimId: string,
    prepared: PreparedStrategyExecution,
    recoverySignal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    recoverySignal?.throwIfAborted();
    if (!(await this.markExecutionStarted(context, record.strategy_generation_id, claimId, recoverySignal))) {
      recoverySignal?.throwIfAborted();
      const continued = await this.continuePending(context, input, requestHash(input), true, recoverySignal);
      if (!continued) throw new Error("Strategy generation 실행 claim을 잃었습니다");
      return continued;
    }
    recoverySignal?.throwIfAborted();
    let result: Awaited<ReturnType<StructuredAgentRunner["executeStructured"]>>;
    try {
      result = await this.runner.executeStructured(
        context,
        {
          commandId: `${input.commandId}:runtime`,
          workId: input.workId,
          agentHandle: "context-strategy",
          modelRoute: prepared.route,
          correlationId: input.commandId,
          estimatedTokens: prepared.baselineTokens + prepared.evidenceTokens,
          estimatedCostMicros: 0,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          input: {
            operation: "create_strategy_plan",
            planningContract:
              "사용자의 자연어 목표와 제공된 맥락만으로 실제 deliverable을 만드는 최소 실행 Task와 검증 가능한 acceptance criteria를 계획하세요. 사용자가 제공한 요청 자체에만 답하는 인사·접수 확인 같은 단순 대화 응답 Task에는 requiredCapabilities와 recommendedAgentHandles를 모두 빈 배열로 두세요. 코드·설정·문서·제공된 근거를 조사해 사실을 확인하는 Task는 Evidence & Research의 정본 책임입니다. availableAgents에 evidence-research가 있고 그 역량을 보유하면 requiredCapabilities와 recommendedAgentHandles에 각각 evidence-research만 사용하세요. availableAgents는 그 밖의 Task에 추천 후보를 고르기 위한 비완전 목록이며 requiredCapabilities의 허용 목록이 아닙니다. Evidence & Research 책임만으로 해결할 수 없는 불가결한 도메인·방법론 전문성은 구체적인 requiredCapabilities로 정의하고 현재 Agent에 없어도 그대로 유지하세요. 모든 필수 역량을 실제로 보유한 availableAgents만 recommendedAgentHandles에 넣고, 없으면 빈 배열로 두어 AgentOS의 동적 배치가 보완하게 하세요. intake, planning, assurance, records 같은 AgentOS 내장 단계를 Work Task로 복제하지 마세요. 별도 근거 조사가 필요하면 evidenceRequests를 만들지 말고 실행 가능한 research Task로 계획하세요. likelihood 또는 impact가 critical인 risk는 mitigation을 비우지 말고 requiresApproval을 true로 설정하세요. 사용자에게 내부 key나 schema 필드를 지정하도록 요구하지 마세요.",
            contextVersionId: prepared.contextVersion.contextVersionId,
            objective: prepared.contextVersion.objective,
            scopeIn: prepared.contextVersion.scopeIn,
            scopeOut: prepared.contextVersion.scopeOut,
            constraints: prepared.contextVersion.constraints,
            assumptions: prepared.contextVersion.assumptions,
            unknowns: prepared.contextVersion.unknowns,
            decisions: prepared.contextVersion.decisions,
            sources: prepared.contextVersion.selectedSources,
            ...(prepared.evidenceMaterials.length === 0 ? {} : { evidenceMaterials: prepared.evidenceMaterials }),
            availableAgents: prepared.availableAgents.map((agent) => ({
              handle: agent.handle,
              capabilities: agent.capabilities,
            })),
          },
        },
        {
          name: "massion-strategy-plan",
          description: "검증 가능한 Work StrategyPlan",
          jsonSchema: automaticStrategyPlanJsonSchema,
          validate: (value) => validateOutput(value, prepared.availableAgentCapabilities),
        },
      );
    } catch {
      recoverySignal?.throwIfAborted();
      return await this.closeClaimed(context, record, claimId, "failed", "runtime_exception", recoverySignal);
    }
    recoverySignal?.throwIfAborted();

    let status: "generated" | "blocked_model_unavailable" | "failed";
    let plan: StrategyPlan | undefined;
    let checksum: string | undefined;
    let error: { readonly category: string; readonly causeId: string } | undefined;
    if (result.status === "succeeded") {
      try {
        plan = validatedPlan(result.output, prepared.availableAgentCapabilities);
        checksum = hashContextContent(plan);
        status = "generated";
      } catch {
        status = "failed";
        error = { category: "structured_output", causeId: randomUUID() };
      }
    } else {
      status = result.status === "blocked_model_unavailable" ? "blocked_model_unavailable" : "failed";
      error = { category: result.error?.category ?? "runtime", causeId: result.error?.causeId ?? randomUUID() };
    }
    const checkpointed = await this.saveCheckpoint(
      context,
      record.strategy_generation_id,
      claimId,
      {
        status,
        runtimeExecutionId: result.executionId,
        ...(plan ? { plan } : {}),
        ...(checksum ? { checksum } : {}),
        ...(error ? { error } : {}),
      },
      recoverySignal,
    );
    recoverySignal?.throwIfAborted();
    if (checkpointed.status !== "pending") return this.view(checkpointed);
    if (!this.pendingCheckpoint(checkpointed)) {
      const continued = await this.continuePending(context, input, requestHash(input), true, recoverySignal);
      if (!continued) throw new Error("Strategy generation 결과 checkpoint를 잃었습니다");
      return continued;
    }
    return await this.finishCheckpoint(context, checkpointed, recoverySignal);
  }

  private async markExecutionStarted(
    context: TenantContext,
    generationId: string,
    claimId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET execution_started_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' AND execution_claim_id = $execution_claim_id AND execution_claim_expires_at > time::now() RETURN AFTER;",
        {
          organization_id: context.organizationId,
          strategy_generation_id: generationId,
          execution_claim_id: claimId,
        },
      );
      signal?.throwIfAborted();
      return updated[0]?.execution_claim_id === claimId;
    });
  }

  private async saveCheckpoint(
    context: TenantContext,
    generationId: string,
    claimId: string,
    output: {
      readonly status: "generated" | "blocked_model_unavailable" | "failed";
      readonly runtimeExecutionId: string;
      readonly plan?: StrategyPlan;
      readonly checksum?: string;
      readonly error?: { readonly category: string; readonly causeId: string };
    },
    signal?: AbortSignal,
  ): Promise<StrategyGenerationRecord> {
    signal?.throwIfAborted();
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, generationId);
      signal?.throwIfAborted();
      let checkpoint = output;
      if (output.status === "generated" && output.plan) {
        const availableAgents = await this.availableAgents(context, current.work_id, tx);
        signal?.throwIfAborted();
        try {
          validatedPlan(
            output.plan,
            new Map(availableAgents.map((agent) => [agent.handle, new Set(agent.capabilities)] as const)),
          );
        } catch {
          checkpoint = {
            status: "failed",
            runtimeExecutionId: output.runtimeExecutionId,
            error: { category: "structured_output", causeId: randomUUID() },
          };
        }
      }
      const storedError = checkpoint.error ? { ...checkpoint.error, terminalStatus: checkpoint.status } : undefined;
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET runtime_execution_id = $runtime_execution_id, plan_json = $plan_json, checksum = $checksum, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' AND execution_claim_id = $execution_claim_id AND execution_claim_expires_at > time::now() RETURN AFTER;",
        {
          organization_id: context.organizationId,
          strategy_generation_id: generationId,
          execution_claim_id: claimId,
          runtime_execution_id: checkpoint.runtimeExecutionId,
          plan_json: checkpoint.plan ? canonicalJson(checkpoint.plan) : undefined,
          checksum: checkpoint.checksum,
          error_json: storedError ? canonicalJson(storedError) : undefined,
        },
      );
      signal?.throwIfAborted();
      return updated[0] ?? (await this.find(tx, context.organizationId, generationId));
    });
  }

  private async finishCheckpoint(
    context: TenantContext,
    record: StrategyGenerationRecord,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, record.strategy_generation_id);
      signal?.throwIfAborted();
      if (current.status !== "pending") return this.view(current);
      const checkpoint = this.pendingCheckpoint(current);
      if (!checkpoint) throw new Error("Strategy generation terminal checkpoint가 없습니다");
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET status = $status, execution_claim_id = NONE, execution_claim_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' RETURN AFTER;",
        {
          status: checkpoint.status,
          organization_id: context.organizationId,
          strategy_generation_id: current.strategy_generation_id,
        },
      );
      signal?.throwIfAborted();
      if (!updated[0]) return this.view(await this.find(tx, context.organizationId, current.strategy_generation_id));
      await this.insertEvent(
        tx,
        context.organizationId,
        current.work_id,
        current.strategy_generation_id,
        `${current.command_id}:terminal`,
        checkpoint.status === "generated" ? "strategy_generated" : `strategy_generation_${checkpoint.status}`,
        {
          status: checkpoint.status,
          runtimeExecutionId: current.runtime_execution_id,
          ...(current.checksum ? { checksum: current.checksum } : {}),
          ...(checkpoint.error ? { error: checkpoint.error } : {}),
        },
      );
      return this.view(updated[0]);
    });
  }

  private async closeClaimed(
    context: TenantContext,
    record: StrategyGenerationRecord,
    claimId: string,
    status: "failed" | "conflicted",
    category: string,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    const error = { category, causeId: randomUUID() };
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, record.strategy_generation_id);
      signal?.throwIfAborted();
      if (current.status !== "pending") return this.view(current);
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET status = $status, error_json = $error_json, execution_claim_id = NONE, execution_claim_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' AND execution_claim_id = $execution_claim_id RETURN AFTER;",
        {
          status,
          error_json: canonicalJson(error),
          organization_id: context.organizationId,
          strategy_generation_id: current.strategy_generation_id,
          execution_claim_id: claimId,
        },
      );
      signal?.throwIfAborted();
      if (!updated[0]) throw new Error("Strategy generation 실행 claim이 일치하지 않습니다");
      await this.insertEvent(
        tx,
        context.organizationId,
        current.work_id,
        current.strategy_generation_id,
        `${current.command_id}:terminal`,
        `strategy_generation_${status}`,
        { status, error },
      );
      return this.view(updated[0]);
    });
  }

  private async closeUncertainExecution(
    context: TenantContext,
    record: StrategyGenerationRecord,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    const runtimeResult = await this.runner.findResultByCommand?.(context, `${record.command_id}:runtime`);
    signal?.throwIfAborted();
    if (runtimeResult) return await this.restoreRuntimeCheckpoint(context, record, runtimeResult, signal);
    const error = { category: "recovery_execution_outcome_unknown", causeId: randomUUID() };
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, record.strategy_generation_id);
      signal?.throwIfAborted();
      if (current.status !== "pending") return this.view(current);
      if (this.pendingCheckpoint(current)) return this.view(current);
      if (this.claimIsActive(current) || current.execution_started_at === undefined) {
        return this.view(current);
      }
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET status = 'failed', error_json = $error_json, execution_claim_id = NONE, execution_claim_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' RETURN AFTER;",
        {
          error_json: canonicalJson(error),
          organization_id: context.organizationId,
          strategy_generation_id: current.strategy_generation_id,
        },
      );
      signal?.throwIfAborted();
      if (!updated[0]) return this.view(await this.find(tx, context.organizationId, current.strategy_generation_id));
      await this.insertEvent(
        tx,
        context.organizationId,
        current.work_id,
        current.strategy_generation_id,
        `${current.command_id}:terminal`,
        "strategy_generation_failed",
        { status: "failed", error },
      );
      return this.view(updated[0]);
    });
  }

  private async restoreRuntimeCheckpoint(
    context: TenantContext,
    record: StrategyGenerationRecord,
    result: Awaited<ReturnType<NonNullable<StructuredAgentRunner["findResultByCommand"]>>>,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    if (!result) throw new Error("Runtime terminal 결과가 없습니다");
    let status: "generated" | "blocked_model_unavailable" | "failed";
    let plan: StrategyPlan | undefined;
    let checksum: string | undefined;
    let error: { readonly category: string; readonly causeId: string } | undefined;
    if (result.status === "succeeded") {
      status = "generated";
    } else {
      status = result.status === "blocked_model_unavailable" ? "blocked_model_unavailable" : "failed";
      error = { category: result.error?.category ?? "runtime", causeId: result.error?.causeId ?? randomUUID() };
    }
    signal?.throwIfAborted();
    const checkpointed = await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, record.strategy_generation_id);
      signal?.throwIfAborted();
      if (current.status !== "pending") return current;
      if (result.status === "succeeded") {
        try {
          const availableAgents = await this.availableAgents(context, current.work_id, tx);
          signal?.throwIfAborted();
          plan = validatedPlan(
            result.output,
            new Map(availableAgents.map((agent) => [agent.handle, new Set(agent.capabilities)] as const)),
          );
          checksum = hashContextContent(plan);
        } catch {
          status = "failed";
          error = { category: "structured_output", causeId: randomUUID() };
        }
      }
      const storedError = error ? { ...error, terminalStatus: status } : undefined;
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET runtime_execution_id = $runtime_execution_id, plan_json = $plan_json, checksum = $checksum, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' RETURN AFTER;",
        {
          runtime_execution_id: result.executionId,
          plan_json: plan ? canonicalJson(plan) : undefined,
          checksum,
          error_json: storedError ? canonicalJson(storedError) : undefined,
          organization_id: context.organizationId,
          strategy_generation_id: current.strategy_generation_id,
        },
      );
      signal?.throwIfAborted();
      return updated[0] ?? (await this.find(tx, context.organizationId, current.strategy_generation_id));
    });
    signal?.throwIfAborted();
    return checkpointed.status === "pending"
      ? await this.finishCheckpoint(context, checkpointed, signal)
      : this.view(checkpointed);
  }

  private claimIsActive(record: StrategyGenerationRecord): boolean {
    return Boolean(
      record.execution_claim_id &&
      record.execution_claim_expires_at !== undefined &&
      datetimeMillis(record.execution_claim_expires_at) > Date.now(),
    );
  }

  private pendingCheckpoint(record: StrategyGenerationRecord):
    | {
        readonly status: "generated" | "blocked_model_unavailable" | "failed";
        readonly error?: { readonly category: string; readonly causeId: string };
      }
    | undefined {
    if (!record.runtime_execution_id) return undefined;
    if (record.plan_json && record.checksum) return { status: "generated" };
    if (!record.error_json) return undefined;
    const stored = JSON.parse(record.error_json) as StoredGenerationError;
    return {
      status: stored.terminalStatus === "blocked_model_unavailable" ? "blocked_model_unavailable" : "failed",
      error: { category: stored.category, causeId: stored.causeId },
    };
  }

  private async availableAgents(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<readonly StrategyPlanningAgent[]> {
    const candidates: readonly StrategyPlanningAgent[] = this.agents
      ? await this.agents.listNodes(context, executor)
      : CORE_OFFICE_HANDLES.map((handle) => ({
          handle,
          status: "active",
          capabilities: [handle === "representative" ? "request-coordination" : handle],
          scope: "persistent" as const,
        }));
    const unique = new Map<string, StrategyPlanningAgent>();
    for (const candidate of candidates) {
      if (candidate.status !== "active" || !candidate.handle.trim()) continue;
      if (candidate.scope === "work" && candidate.work_id !== workId) continue;
      unique.set(candidate.handle, {
        handle: candidate.handle,
        status: candidate.status,
        capabilities: [...candidate.capabilities],
        scope: candidate.scope,
        ...(candidate.work_id === undefined ? {} : { work_id: candidate.work_id }),
      });
    }
    return [...unique.values()].sort((left, right) => left.handle.localeCompare(right.handle));
  }

  private async reconcile(
    context: TenantContext,
    strategyGenerationId: string,
    commandId: string,
    status: "applied" | "conflicted",
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    await this.organizations.verifyTenantContext(context);
    signal?.throwIfAborted();
    return await this.database.transaction(async (tx) => {
      signal?.throwIfAborted();
      await this.organizations.verifyTenantContext(context, undefined, tx);
      signal?.throwIfAborted();
      const current = await this.find(tx, context.organizationId, strategyGenerationId);
      signal?.throwIfAborted();
      if (current.status === status) return this.view(current);
      if (current.status !== "generated") {
        throw new Error(`generated Strategy만 ${status} 상태로 조정할 수 있습니다: ${current.status}`);
      }
      const error = status === "conflicted" ? { category: "work_revision_conflict", causeId: randomUUID() } : undefined;
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET status = $status, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'generated' RETURN AFTER;",
        {
          status,
          error_json: error ? canonicalJson(error) : undefined,
          organization_id: context.organizationId,
          strategy_generation_id: strategyGenerationId,
        },
      );
      signal?.throwIfAborted();
      if (!updated[0]) {
        const concurrent = await this.find(tx, context.organizationId, strategyGenerationId);
        if (concurrent.status === status) return this.view(concurrent);
        throw new Error(`Strategy generation ${status} 전이에 실패했습니다`);
      }
      await this.insertEvent(
        tx,
        context.organizationId,
        current.work_id,
        strategyGenerationId,
        commandId,
        status === "applied" ? "strategy_projection_applied" : "strategy_projection_conflicted",
        { status, ...(error ? { error } : {}) },
      );
      return this.view(updated[0]);
    });
  }

  private async byCommand(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<StrategyGenerationRecord | undefined> {
    const [records] = await executor.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async find(
    executor: QueryExecutor,
    organizationId: string,
    generationId: string,
  ): Promise<StrategyGenerationRecord> {
    const [records] = await executor.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id LIMIT 1;",
      { organization_id: organizationId, strategy_generation_id: generationId },
    );
    if (!records[0]) throw new Error(`Strategy generation을 찾을 수 없습니다: ${generationId}`);
    return records[0];
  }

  private async insertEvent(
    executor: QueryExecutor,
    organizationId: string,
    workId: string,
    generationId: string,
    commandId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    await executor.query(
      "CREATE strategy_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, command_id: $command_id, event_type: $event_type, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        work_id: workId,
        strategy_generation_id: generationId,
        command_id: commandId,
        event_type: eventType,
        payload_json: canonicalJson(payload),
      },
    );
  }

  private view(record: StrategyGenerationRecord): StrategyGeneration {
    const plan = record.plan_json ? validateStrategyPlan(JSON.parse(record.plan_json) as unknown) : undefined;
    const storedError = record.error_json ? (JSON.parse(record.error_json) as StoredGenerationError) : undefined;
    if (plan && record.checksum !== hashContextContent(plan)) {
      throw new Error(`Strategy generation checksum이 일치하지 않습니다: ${record.strategy_generation_id}`);
    }
    return {
      strategyGenerationId: record.strategy_generation_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      contextVersionId: record.context_version_id,
      commandId: record.command_id,
      expectedWorkRevision: record.expected_work_revision,
      status: record.status,
      ...(record.runtime_execution_id ? { runtimeExecutionId: record.runtime_execution_id } : {}),
      ...(plan ? { plan } : {}),
      ...(record.checksum ? { checksum: record.checksum } : {}),
      ...(storedError ? { error: { category: storedError.category, causeId: storedError.causeId } } : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
