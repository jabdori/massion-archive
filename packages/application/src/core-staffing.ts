import { createHash } from "node:crypto";

import {
  type StaffingAdvisor,
  type StaffingAssessment,
  type StaffingRecommendation,
  type StrategyPlan,
  validateStrategyPlan,
} from "@massion/context-strategy";
import { GovernanceApprovalRequiredError } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import type {
  GraphChangeResult,
  InstallProfileCommand,
  OrganizationGraphService,
  OrganizationNode,
  OrganizationProfileNode,
} from "@massion/organization";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { CollaborationRoom, PlanVersion, Work, WorkService, WorkTask } from "@massion/work";

import { APPLICATION_DYNAMIC_STAFFING_MIGRATION } from "./schema.js";

export interface DynamicStaffingPrepareInput {
  readonly commandId: string;
  readonly workId: string;
  readonly approvalId?: string;
  readonly signal?: AbortSignal;
}

export type DynamicStaffingPrepareResult =
  | { readonly outcome: "ready"; readonly proposalId?: string }
  | { readonly outcome: "awaiting-approval"; readonly approvalId: string; readonly proposalId: string }
  | { readonly outcome: "blocked"; readonly reason: string };

type ProposalStatus = "prepared" | "awaiting-approval" | "applied";

interface ProposalAssignment {
  readonly taskKey: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly source: "recommendation" | "proposal";
}

interface ProposalNode {
  readonly taskKey: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly node: OrganizationProfileNode;
}

interface ProposalIntentFields {
  readonly proposal_id: string;
  readonly organization_id: string;
  readonly created_by_user_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly work_id: string;
  readonly plan_version_id: string;
  readonly context_version_id?: string;
  readonly strategy_generation_id: string;
  readonly assessment_id: string;
  readonly graph_command_json: string;
  readonly expected_organization_version: number;
  readonly expected_work_revision: number;
  readonly nodes_json: string;
  readonly assignments_json: string;
  readonly core_office_room_id: string;
  readonly ux_metadata_json: string;
}

interface ProposalRecord extends ProposalIntentFields {
  readonly intent_hash: string;
  readonly status: ProposalStatus;
  readonly approval_id?: string;
  readonly applied_organization_version?: number;
  readonly applied_organization_version_id?: string;
  readonly impact_json?: string;
  readonly message_id?: string;
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface StaffingBoundary {
  readonly work: Work;
  readonly planVersion: PlanVersion;
  readonly plan: StrategyPlan;
  readonly tasks: readonly WorkTask[];
  readonly room: CollaborationRoom;
}

interface StaffingAssessmentRecord {
  readonly assessment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly strategy_generation_id: string;
  readonly command_id: string;
  readonly recommendations_json: string;
  readonly created_by_user_id: string;
}

interface AppliedOrganizationVersionRecord {
  readonly version_id: string;
  readonly version: number;
  readonly command_id: string;
  readonly request_json: string;
  readonly impact_json: string;
}

interface AppliedProposalMessageRecord {
  readonly message_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly sequence: number;
  readonly message_type: string;
  readonly author_kind: string;
  readonly author_id: string;
  readonly content: string;
  readonly reply_to_message_id?: string;
  readonly caused_by_message_id?: string;
  readonly context_version_id?: string;
  readonly task_id?: string;
  readonly execution_id?: string;
  readonly artifact_version_id?: string;
  readonly token_count: number;
  readonly cost_micros: number;
}

interface AppliedAssignmentRecord {
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: string;
}

interface ValidatedProposalPayload {
  readonly command: InstallProfileCommand;
  readonly nodes: readonly ProposalNode[];
  readonly assignments: readonly ProposalAssignment[];
}

interface DynamicStaffingAuthorization {
  readonly kind: "organization-change-authorization";
}

interface DynamicStaffingGraphPort {
  getCurrentSnapshot: OrganizationGraphService["getCurrentSnapshot"];
  authorizeExecution?(
    context: TenantContext,
    command: Parameters<OrganizationGraphService["execute"]>[1],
  ): Promise<DynamicStaffingAuthorization>;
  execute(
    context: TenantContext,
    command: Parameters<OrganizationGraphService["execute"]>[1],
    executor?: QueryExecutor,
    authorization?: DynamicStaffingAuthorization,
  ): ReturnType<OrganizationGraphService["execute"]>;
}

interface DynamicStaffingWorkPort {
  getWork(context: TenantContext, workId: string, executor?: QueryExecutor): ReturnType<WorkService["getWork"]>;
  getActivePlan(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): ReturnType<WorkService["getActivePlan"]>;
  listTasks: WorkService["listTasks"];
  listAssignments(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): ReturnType<WorkService["listAssignments"]>;
  listRooms: WorkService["listRooms"];
  postMessage(
    context: TenantContext,
    input: Parameters<WorkService["postMessage"]>[1],
    executor?: QueryExecutor,
  ): ReturnType<WorkService["postMessage"]>;
  assignTask(
    context: TenantContext,
    input: Parameters<WorkService["assignTask"]>[1],
    executor?: QueryExecutor,
  ): ReturnType<WorkService["assignTask"]>;
}

type BoundaryResult =
  | { readonly outcome: "ready"; readonly boundary: StaffingBoundary }
  | {
      readonly outcome: "blocked";
      readonly reason: string;
    };

const APPLICATION_RUN_CANCELLED = "Application run cancelled";
const INVALID_PROPOSAL_PAYLOAD = "Dynamic Staffing proposal 저장 payload가 유효하지 않습니다";

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(APPLICATION_RUN_CANCELLED);
}

function invalidProposalPayload(): never {
  throw new Error(INVALID_PROPOSAL_PAYLOAD);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalidProposalPayload();
  }
}

function exactString(value: unknown): string {
  if (typeof value !== "string") return invalidProposalPayload();
  return value;
}

function exactStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((candidate) => typeof candidate === "string")) {
    return invalidProposalPayload();
  }
  return value;
}

function requestHash(input: Pick<DynamicStaffingPrepareInput, "commandId" | "workId">): string {
  return sha256(canonicalJson({ commandId: input.commandId, workId: input.workId }));
}

function proposalIntent(proposal: ProposalIntentFields): unknown {
  return {
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
  };
}

function proposalIntentHash(proposal: ProposalIntentFields): string {
  return sha256(canonicalJson(proposalIntent(proposal)));
}

function validateProposalIntent(proposal: ProposalRecord): ProposalRecord {
  if (!/^[a-f0-9]{64}$/u.test(proposal.intent_hash) || proposal.intent_hash !== proposalIntentHash(proposal)) {
    return invalidProposalPayload();
  }
  return proposal;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f));
  });
}

function validateIdentifier(value: string, label: string): void {
  if (!value.trim() || value.trim() !== value || value.length > 512 || hasControlCharacter(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return canonicalJson(left ?? []) === canonicalJson(right);
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function proposalHandle(organizationId: string, workId: string, strategyGenerationId: string, taskKey: string): string {
  return `staff-${sha256(canonicalJson({ organizationId, workId, strategyGenerationId, taskKey }))}`;
}

function proposalNode(
  organizationId: string,
  workId: string,
  strategyGenerationId: string,
  task: WorkTask & { readonly task_key: string },
): OrganizationProfileNode {
  const handle = proposalHandle(organizationId, workId, strategyGenerationId, task.task_key);
  return {
    handle,
    name: `Work Operator ${task.task_key}`.slice(0, 100),
    responsibility: `Work task ${task.task_key} 실행`.slice(0, 500),
    outputs: [`Task ${task.task_key} result`.slice(0, 200)],
    capabilities: [...(task.required_capabilities ?? [])],
    parentHandle: "delivery-coordination",
    scope: "work",
    workId,
    role: "operator",
  };
}

function proposalMessage(assignments: readonly ProposalAssignment[], proposedNodes: number): string {
  const mappings = assignments.map((assignment) => `${assignment.taskKey} → ${assignment.agentHandle}`).join(", ");
  return `동적 Staffing 제안을 적용했습니다. Work 전용 Agent ${String(proposedNodes)}개를 구성했습니다.${
    mappings ? ` 배정: ${mappings}` : ""
  }`.slice(0, 4_000);
}

function proposalUxMetadata(
  boundary: StaffingBoundary,
  nodes: readonly ProposalNode[],
  assignments: readonly ProposalAssignment[],
): unknown {
  return {
    kind: "dynamic-staffing-proposal",
    title: "동적 Staffing 제안",
    workId: boundary.work.work_id,
    strategyGenerationId: boundary.planVersion.strategy_generation_id,
    taskCount: assignments.length,
    proposedAgentCount: nodes.length,
    assignments: assignments.map(({ taskKey, agentHandle, source }) => ({ taskKey, agentHandle, source })),
  };
}

export class DynamicStaffingCoordinator {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly dependencies: {
      readonly advisor: Pick<StaffingAdvisor, "assess">;
      readonly graph: DynamicStaffingGraphPort;
      readonly organizations: Pick<OrganizationService, "resolveTenantContext">;
      readonly works: DynamicStaffingWorkPort;
    },
  ) {}

  public static async create(
    database: MassionDatabase,
    dependencies: {
      readonly advisor: Pick<StaffingAdvisor, "assess">;
      readonly graph: DynamicStaffingGraphPort;
      readonly organizations: Pick<OrganizationService, "resolveTenantContext">;
      readonly works: DynamicStaffingWorkPort;
    },
  ): Promise<DynamicStaffingCoordinator> {
    await applyMigrations(database, [APPLICATION_DYNAMIC_STAFFING_MIGRATION]);
    return new DynamicStaffingCoordinator(database, dependencies);
  }

  public async prepare(
    context: TenantContext,
    input: DynamicStaffingPrepareInput,
  ): Promise<DynamicStaffingPrepareResult> {
    throwIfCancelled(input.signal);
    validateIdentifier(input.commandId, "Dynamic Staffing commandId");
    validateIdentifier(input.workId, "Dynamic Staffing workId");
    if (input.approvalId !== undefined) validateIdentifier(input.approvalId, "Dynamic Staffing approvalId");

    const boundaryResult = await this.boundary(context, input.workId, input.signal);
    if (boundaryResult.outcome === "blocked") return boundaryResult;
    const boundary = boundaryResult.boundary;
    if (input.approvalId !== undefined) {
      const approvalId = input.approvalId;
      const approved = await this.database.transaction(
        async (transaction) => await this.findByApproval(context.organizationId, approvalId, transaction),
      );
      throwIfCancelled(input.signal);
      if (!approved || approved.work_id !== input.workId) {
        throw new Error("Dynamic Staffing proposal의 approval ID 또는 Work가 일치하지 않습니다");
      }
      if (!this.sameLineage(approved, boundary)) return { outcome: "blocked", reason: "staffing-lineage-stale" };
      return await this.continueProposal(context, approvalId, approved, input.signal);
    }
    const hash = requestHash(input);
    const existing = await this.find(context.organizationId, input.commandId);
    throwIfCancelled(input.signal);
    if (existing) {
      this.assertReplay(existing, hash, input.workId);
      if (!this.sameLineage(existing, boundary)) return { outcome: "blocked", reason: "staffing-lineage-stale" };
      return await this.continueProposal(context, input.approvalId, existing, input.signal);
    }

    const assessment = await this.dependencies.advisor.assess(context, {
      commandId: `${input.commandId}:assessment`,
      workId: input.workId,
      strategyGenerationId: boundary.planVersion.strategy_generation_id ?? "",
      tasks: boundary.plan.tasks,
    });
    throwIfCancelled(input.signal);
    this.assertAssessmentLineage(context, input.commandId, boundary, assessment);
    const snapshot = await this.dependencies.graph.getCurrentSnapshot(context);
    throwIfCancelled(input.signal);
    const planned = this.planAssignments(context.organizationId, boundary, assessment.recommendations, snapshot.nodes);
    if (planned.nodes.length === 0) {
      return await this.database.transaction(async (transaction): Promise<DynamicStaffingPrepareResult> => {
        const latest = await this.atomicBoundary(context, input.workId, transaction, input.signal);
        if (latest.outcome === "blocked") return latest;
        if (
          latest.boundary.work.revision !== boundary.work.revision ||
          latest.boundary.planVersion.plan_version_id !== boundary.planVersion.plan_version_id ||
          latest.boundary.planVersion.context_version_id !== boundary.planVersion.context_version_id ||
          latest.boundary.planVersion.strategy_generation_id !== boundary.planVersion.strategy_generation_id
        ) {
          return { outcome: "blocked", reason: "staffing-work-revision-stale" };
        }
        await this.assign(context, input.commandId, input.workId, planned.assignments, input.signal, transaction);
        throwIfCancelled(input.signal);
        return { outcome: "ready" };
      });
    }
    if (planned.nodes.some((candidate) => candidate.node.capabilities.length === 0)) {
      return { outcome: "blocked", reason: "staffing-gap-capabilities-missing" };
    }

    const proposalId = sha256(`${context.organizationId}\0${input.commandId}`);
    const graphCommand: InstallProfileCommand = {
      commandId: `${input.commandId}:organization`,
      expectedVersion: snapshot.version.version,
      kind: "install-profile",
      profileId: `dynamic-staffing-${proposalId}`,
      profileVersion: "1",
      nodes: planned.nodes.map((candidate) => candidate.node),
    };
    const proposal = await this.createProposal(
      context,
      hash,
      boundary,
      assessment,
      graphCommand,
      planned,
      proposalId,
      input.signal,
    );
    throwIfCancelled(input.signal);
    return await this.continueProposal(context, input.approvalId, proposal, input.signal);
  }

  private async boundary(context: TenantContext, workId: string, signal?: AbortSignal): Promise<BoundaryResult> {
    throwIfCancelled(signal);
    const work = await this.dependencies.works.getWork(context, workId);
    throwIfCancelled(signal);
    if (work.status !== "planned") return { outcome: "blocked", reason: `staffing-work-${work.status}` };
    const [planVersion, allTasks, rooms] = await Promise.all([
      this.dependencies.works.getActivePlan(context, workId),
      this.dependencies.works.listTasks(context, workId),
      this.dependencies.works.listRooms(context, workId),
    ]);
    throwIfCancelled(signal);
    return this.resolveBoundary(context, workId, work, planVersion, allTasks, rooms);
  }

  private async atomicBoundary(
    context: TenantContext,
    workId: string,
    executor: QueryExecutor,
    signal?: AbortSignal,
  ): Promise<BoundaryResult> {
    throwIfCancelled(signal);
    const work = await this.dependencies.works.getWork(context, workId, executor);
    throwIfCancelled(signal);
    const planVersion = await this.dependencies.works.getActivePlan(context, workId, executor);
    throwIfCancelled(signal);
    const [taskRows, roomRows] = await Promise.all([
      executor.query<[WorkTask[]]>(
        "SELECT * OMIT id FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      ),
      executor.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      ),
    ]);
    throwIfCancelled(signal);
    return this.resolveBoundary(context, workId, work, planVersion, taskRows[0], roomRows[0]);
  }

  private resolveBoundary(
    context: TenantContext,
    workId: string,
    work: Work,
    planVersion: PlanVersion | undefined,
    allTasks: readonly WorkTask[],
    rooms: readonly CollaborationRoom[],
  ): BoundaryResult {
    if (work.status !== "planned") return { outcome: "blocked", reason: `staffing-work-${work.status}` };
    if (
      !planVersion ||
      !planVersion.valid ||
      planVersion.organization_id !== context.organizationId ||
      planVersion.work_id !== workId ||
      planVersion.plan_version_id !== work.active_plan_version_id ||
      !planVersion.strategy_generation_id
    ) {
      return { outcome: "blocked", reason: "staffing-plan-lineage-invalid" };
    }
    let plan: StrategyPlan;
    try {
      plan = validateStrategyPlan(JSON.parse(planVersion.content_json) as unknown);
    } catch {
      return { outcome: "blocked", reason: "staffing-plan-invalid" };
    }
    const tasks = allTasks.filter((task) => task.plan_version_id === planVersion.plan_version_id);
    const byKey = new Map<string, WorkTask>();
    for (const task of tasks) {
      if (!task.task_key || byKey.has(task.task_key)) {
        return { outcome: "blocked", reason: "staffing-task-lineage-invalid" };
      }
      byKey.set(task.task_key, task);
    }
    if (
      tasks.length !== plan.tasks.length ||
      plan.tasks.some((planned) => {
        const task = byKey.get(planned.key);
        return (
          !task ||
          task.organization_id !== context.organizationId ||
          task.work_id !== workId ||
          !sameStrings(task.required_capabilities, planned.requiredCapabilities) ||
          !sameStrings(task.recommended_agent_handles, planned.recommendedAgentHandles)
        );
      })
    ) {
      return { outcome: "blocked", reason: "staffing-task-lineage-invalid" };
    }
    const room = rooms
      .filter(
        (candidate) =>
          candidate.title === "Core Office" &&
          candidate.coordinator_handle === "representative" &&
          candidate.status === "active",
      )
      .sort((left, right) => left.room_id.localeCompare(right.room_id))[0];
    if (!room) return { outcome: "blocked", reason: "staffing-core-office-room-missing" };
    return { outcome: "ready", boundary: { work, planVersion, plan, tasks, room } };
  }

  private planAssignments(
    organizationId: string,
    boundary: StaffingBoundary,
    recommendations: readonly StaffingRecommendation[],
    organizationNodes: readonly OrganizationNode[],
  ): { readonly nodes: readonly ProposalNode[]; readonly assignments: readonly ProposalAssignment[] } {
    const taskByKey = new Map(
      boundary.tasks.flatMap((task) => (task.task_key ? [[task.task_key, task] as const] : [])),
    );
    const nodeByHandle = new Map(organizationNodes.map((node) => [node.handle, node]));
    const nodes: ProposalNode[] = [];
    const assignments: ProposalAssignment[] = [];
    for (const planned of boundary.plan.tasks) {
      const task = taskByKey.get(planned.key);
      if (!task) throw new Error(`Strategy Task의 WorkTask를 찾을 수 없습니다: ${planned.key}`);
      if (task.status === "cancelled") continue;
      const recommendation = recommendations
        .filter((candidate) =>
          this.isEligibleRecommendation(
            candidate,
            planned.key,
            planned.requiredCapabilities,
            boundary.work.work_id,
            nodeByHandle,
          ),
        )
        .sort((left, right) => left.agentHandle.localeCompare(right.agentHandle))[0];
      if (recommendation) {
        assignments.push({
          taskKey: planned.key,
          taskId: task.task_id,
          agentHandle: recommendation.agentHandle,
          source: "recommendation",
        });
        continue;
      }
      if (planned.requiredCapabilities.length === 0 || !task.task_key) continue;
      const node = proposalNode(
        organizationId,
        boundary.work.work_id,
        boundary.planVersion.strategy_generation_id ?? "",
        { ...task, task_key: task.task_key },
      );
      const proposed = { taskKey: planned.key, taskId: task.task_id, agentHandle: node.handle, node };
      nodes.push(proposed);
      assignments.push({
        taskKey: planned.key,
        taskId: task.task_id,
        agentHandle: proposed.agentHandle,
        source: "proposal",
      });
    }
    nodes.sort((left, right) => left.taskKey.localeCompare(right.taskKey));
    return { nodes, assignments };
  }

  private async createProposal(
    context: TenantContext,
    hash: string,
    boundary: StaffingBoundary,
    assessment: StaffingAssessment,
    graphCommand: InstallProfileCommand,
    planned: { readonly nodes: readonly ProposalNode[]; readonly assignments: readonly ProposalAssignment[] },
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<ProposalRecord> {
    throwIfCancelled(signal);
    const strategyGenerationId = boundary.planVersion.strategy_generation_id;
    if (!strategyGenerationId) throw new Error("Dynamic Staffing Strategy generation 계보가 없습니다");
    try {
      const proposal = await this.database.transaction(async (transaction) => {
        const repeated = await this.find(
          context.organizationId,
          graphCommand.commandId.replace(/:organization$/u, ""),
          transaction,
        );
        throwIfCancelled(signal);
        if (repeated) {
          this.assertReplay(repeated, hash, boundary.work.work_id);
          return repeated;
        }
        const immutable: ProposalIntentFields = {
          proposal_id: proposalId,
          organization_id: context.organizationId,
          created_by_user_id: context.userId,
          command_id: graphCommand.commandId.replace(/:organization$/u, ""),
          request_hash: hash,
          work_id: boundary.work.work_id,
          plan_version_id: boundary.planVersion.plan_version_id,
          ...(boundary.planVersion.context_version_id === undefined
            ? {}
            : { context_version_id: boundary.planVersion.context_version_id }),
          strategy_generation_id: strategyGenerationId,
          assessment_id: assessment.assessmentId,
          graph_command_json: canonicalJson(graphCommand),
          expected_organization_version: graphCommand.expectedVersion,
          expected_work_revision: boundary.work.revision,
          nodes_json: canonicalJson(planned.nodes),
          assignments_json: canonicalJson(planned.assignments),
          core_office_room_id: boundary.room.room_id,
          ux_metadata_json: canonicalJson(proposalUxMetadata(boundary, planned.nodes, planned.assignments)),
        };
        const [created] = await transaction.query<[ProposalRecord[]]>(
          "CREATE dynamic_staffing_proposal CONTENT { proposal_id: $proposal_id, organization_id: $organization_id, created_by_user_id: $created_by_user_id, command_id: $command_id, request_hash: $request_hash, intent_hash: $intent_hash, work_id: $work_id, plan_version_id: $plan_version_id, context_version_id: $context_version_id, strategy_generation_id: $strategy_generation_id, assessment_id: $assessment_id, graph_command_json: $graph_command_json, expected_organization_version: $expected_organization_version, expected_work_revision: $expected_work_revision, nodes_json: $nodes_json, assignments_json: $assignments_json, core_office_room_id: $core_office_room_id, ux_metadata_json: $ux_metadata_json, status: 'prepared', approval_id: NONE, applied_organization_version: NONE, applied_organization_version_id: NONE, impact_json: NONE, message_id: NONE, revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          { ...immutable, intent_hash: proposalIntentHash(immutable) },
        );
        throwIfCancelled(signal);
        if (!created[0]) throw new Error("Dynamic Staffing proposal 생성 결과가 없습니다");
        return created[0];
      });
      throwIfCancelled(signal);
      return proposal;
    } catch (error) {
      if (signal?.aborted) throw error;
      const repeated = await this.find(context.organizationId, graphCommand.commandId.replace(/:organization$/u, ""));
      throwIfCancelled(signal);
      if (!repeated) throw error;
      this.assertReplay(repeated, hash, boundary.work.work_id);
      return repeated;
    }
  }

  private async continueProposal(
    context: TenantContext,
    approvalId: string | undefined,
    initial: ProposalRecord,
    signal?: AbortSignal,
  ): Promise<DynamicStaffingPrepareResult> {
    throwIfCancelled(signal);
    const proposal = validateProposalIntent(initial);
    const boundaryResult = await this.boundary(context, proposal.work_id, signal);
    if (boundaryResult.outcome === "blocked") return boundaryResult;
    if (!this.sameLineage(proposal, boundaryResult.boundary)) {
      return { outcome: "blocked", reason: "staffing-lineage-stale" };
    }
    const snapshot = await this.dependencies.graph.getCurrentSnapshot(context);
    throwIfCancelled(signal);
    const recommendations = await this.loadAssessmentRecommendations(context, proposal, signal);
    const validated = this.validateProposalPayload(proposal, boundaryResult.boundary, recommendations, snapshot.nodes);
    if (proposal.status === "awaiting-approval" && approvalId === undefined) {
      if (!proposal.approval_id) throw new Error("Dynamic Staffing proposal의 approval 계보가 없습니다");
      return {
        outcome: "awaiting-approval",
        approvalId: proposal.approval_id,
        proposalId: proposal.proposal_id,
      };
    }
    if (approvalId !== undefined) {
      if (proposal.status === "prepared" || !proposal.approval_id || proposal.approval_id !== approvalId) {
        throw new Error("Dynamic Staffing proposal의 approval ID 또는 상태가 일치하지 않습니다");
      }
    }
    if (proposal.status === "applied") {
      await this.verifyAppliedProposal(proposal, validated, this.database, signal);
      return { outcome: "ready", proposalId: proposal.proposal_id };
    }
    const actorContext =
      proposal.created_by_user_id === context.userId
        ? context
        : await this.dependencies.organizations.resolveTenantContext(
            proposal.created_by_user_id,
            proposal.organization_id,
          );
    throwIfCancelled(signal);
    let authorization: DynamicStaffingAuthorization | undefined;
    if (approvalId === undefined && this.dependencies.graph.authorizeExecution) {
      try {
        authorization = await this.dependencies.graph.authorizeExecution(actorContext, validated.command);
        throwIfCancelled(signal);
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError) {
          const awaiting = await this.markAwaiting(context, proposal.proposal_id, error.approvalId);
          throwIfCancelled(signal);
          return {
            outcome: "awaiting-approval",
            approvalId: error.approvalId,
            proposalId: awaiting.proposal_id,
          };
        }
        throw error;
      }
    }
    try {
      return await this.database.transaction(async (transaction): Promise<DynamicStaffingPrepareResult> => {
        throwIfCancelled(signal);
        const current = await this.findById(proposal.organization_id, proposal.proposal_id, transaction);
        throwIfCancelled(signal);
        if (
          approvalId !== undefined &&
          (current.status === "prepared" || !current.approval_id || current.approval_id !== approvalId)
        ) {
          throw new Error("Dynamic Staffing proposal의 approval ID 또는 상태가 일치하지 않습니다");
        }
        const atomicBoundary = await this.atomicBoundary(actorContext, current.work_id, transaction, signal);
        if (atomicBoundary.outcome === "blocked") return atomicBoundary;
        if (!this.sameLineage(current, atomicBoundary.boundary)) {
          return { outcome: "blocked", reason: "staffing-lineage-stale" };
        }
        const payload = this.validateProposalPayload(current, atomicBoundary.boundary, recommendations, snapshot.nodes);
        if (current.status === "applied") {
          await this.verifyAppliedProposal(current, payload, transaction, signal);
          return { outcome: "ready", proposalId: current.proposal_id };
        }
        if (atomicBoundary.boundary.work.revision !== current.expected_work_revision) {
          return { outcome: "blocked", reason: "staffing-work-revision-stale" };
        }
        const changed = await this.dependencies.graph.execute(
          actorContext,
          {
            ...payload.command,
            ...(approvalId === undefined ? {} : { governanceApprovalId: approvalId }),
          },
          transaction,
          authorization,
        );
        throwIfCancelled(signal);
        const [previousMessages] = await transaction.query<
          [{ readonly message_id: string; readonly sequence: number }[]]
        >(
          "SELECT message_id, sequence FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id;",
          {
            organization_id: current.organization_id,
            work_id: current.work_id,
            room_id: current.core_office_room_id,
          },
        );
        throwIfCancelled(signal);
        const previousMessageId = previousMessages
          .filter((message) => Number.isSafeInteger(message.sequence))
          .sort(
            (left, right) => right.sequence - left.sequence || right.message_id.localeCompare(left.message_id),
          )[0]?.message_id;
        const content = proposalMessage(payload.assignments, payload.nodes.length);
        const posted = await this.dependencies.works.postMessage(
          actorContext,
          {
            commandId: `${current.command_id}:message`,
            workId: current.work_id,
            roomId: current.core_office_room_id,
            messageType: "proposal",
            authorKind: "agent",
            authorId: "context-strategy",
            content,
            ...(previousMessageId ? { replyToMessageId: previousMessageId, causedByMessageId: previousMessageId } : {}),
            ...(current.context_version_id ? { contextVersionId: current.context_version_id } : {}),
            tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4)),
            costMicros: 0,
          },
          transaction,
        );
        throwIfCancelled(signal);
        await this.assign(actorContext, current.command_id, current.work_id, payload.assignments, signal, transaction);
        throwIfCancelled(signal);
        const applied = await this.markAtomicallyApplied(
          actorContext,
          current.proposal_id,
          changed,
          posted.message.message_id,
          transaction,
        );
        throwIfCancelled(signal);
        return { outcome: "ready", proposalId: applied.proposal_id };
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) {
        const awaiting = await this.markAwaiting(context, proposal.proposal_id, error.approvalId);
        throwIfCancelled(signal);
        return {
          outcome: "awaiting-approval",
          approvalId: error.approvalId,
          proposalId: awaiting.proposal_id,
        };
      }
      throwIfCancelled(signal);
      const repeated = await this.find(proposal.organization_id, proposal.command_id);
      throwIfCancelled(signal);
      if (repeated?.status === "applied") {
        const repeatedBoundary = await this.boundary(context, repeated.work_id, signal);
        if (repeatedBoundary.outcome === "blocked") return repeatedBoundary;
        const repeatedSnapshot = await this.dependencies.graph.getCurrentSnapshot(context);
        throwIfCancelled(signal);
        const repeatedRecommendations = await this.loadAssessmentRecommendations(context, repeated, signal);
        const repeatedPayload = this.validateProposalPayload(
          repeated,
          repeatedBoundary.boundary,
          repeatedRecommendations,
          repeatedSnapshot.nodes,
        );
        await this.verifyAppliedProposal(repeated, repeatedPayload, this.database, signal);
        return { outcome: "ready", proposalId: repeated.proposal_id };
      }
      throw error;
    }
  }

  private async verifyAppliedProposal(
    proposal: ProposalRecord,
    payload: ValidatedProposalPayload,
    executor: QueryExecutor,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    if (
      proposal.status !== "applied" ||
      proposal.applied_organization_version === undefined ||
      !proposal.applied_organization_version_id ||
      !proposal.impact_json ||
      !proposal.message_id
    ) {
      return invalidProposalPayload();
    }
    const version = await first<AppliedOrganizationVersionRecord>(
      executor,
      "SELECT version_id, version, command_id, request_json, impact_json FROM organization_version WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
      { organization_id: proposal.organization_id, version_id: proposal.applied_organization_version_id },
    );
    throwIfCancelled(signal);
    if (
      !version ||
      version.version !== proposal.applied_organization_version ||
      version.version_id !== proposal.applied_organization_version_id ||
      version.command_id !== payload.command.commandId ||
      canonicalJson(parseStoredJson(version.request_json)) !== canonicalJson(payload.command) ||
      canonicalJson(parseStoredJson(version.impact_json)) !== canonicalJson(parseStoredJson(proposal.impact_json))
    ) {
      return invalidProposalPayload();
    }

    const message = await first<AppliedProposalMessageRecord>(
      executor,
      "SELECT message_id, organization_id, work_id, room_id, sequence, message_type, author_kind, author_id, content, reply_to_message_id, caused_by_message_id, context_version_id, task_id, execution_id, artifact_version_id, token_count, cost_micros FROM collaboration_message WHERE organization_id = $organization_id AND message_id = $message_id LIMIT 1;",
      { organization_id: proposal.organization_id, message_id: proposal.message_id },
    );
    throwIfCancelled(signal);
    const expectedContent = proposalMessage(payload.assignments, payload.nodes.length);
    if (
      !message ||
      message.message_id !== proposal.message_id ||
      message.organization_id !== proposal.organization_id ||
      message.work_id !== proposal.work_id ||
      message.room_id !== proposal.core_office_room_id ||
      message.message_type !== "proposal" ||
      message.author_kind !== "agent" ||
      message.author_id !== "context-strategy" ||
      message.content !== expectedContent ||
      message.context_version_id !== proposal.context_version_id ||
      message.task_id !== undefined ||
      message.execution_id !== undefined ||
      message.artifact_version_id !== undefined ||
      message.token_count !== Math.max(1, Math.ceil(Buffer.byteLength(expectedContent, "utf8") / 4)) ||
      message.cost_micros !== 0
    ) {
      return invalidProposalPayload();
    }
    const [roomMessages] = await executor.query<[{ readonly message_id: string; readonly sequence: number }[]]>(
      "SELECT message_id, sequence FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id;",
      {
        organization_id: proposal.organization_id,
        work_id: proposal.work_id,
        room_id: proposal.core_office_room_id,
      },
    );
    const previous = roomMessages
      .filter((candidate) => candidate.sequence < message.sequence)
      .sort((left, right) => right.sequence - left.sequence || right.message_id.localeCompare(left.message_id))[0];
    if (message.reply_to_message_id !== previous?.message_id || message.caused_by_message_id !== previous?.message_id) {
      return invalidProposalPayload();
    }

    const [assignmentRows] = await executor.query<[AppliedAssignmentRecord[]]>(
      "SELECT task_id, agent_handle, status FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id AND status = 'assigned';",
      { organization_id: proposal.organization_id, work_id: proposal.work_id },
    );
    throwIfCancelled(signal);
    const expectedAssignments = payload.assignments
      .map((assignment) => ({ task_id: assignment.taskId, agent_handle: assignment.agentHandle, status: "assigned" }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
    const taskIds = new Set(expectedAssignments.map((assignment) => assignment.task_id));
    const actualAssignments = assignmentRows
      .filter((assignment) => taskIds.has(assignment.task_id))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
    if (canonicalJson(actualAssignments) !== canonicalJson(expectedAssignments)) return invalidProposalPayload();

    for (const agentHandle of new Set(payload.assignments.map((assignment) => assignment.agentHandle))) {
      const participant = await first<{ readonly subject_id: string; readonly status: string }>(
        executor,
        "SELECT subject_id, status FROM collaboration_participant WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id AND kind = 'agent' AND subject_id = $subject_id AND status = 'active' LIMIT 1;",
        {
          organization_id: proposal.organization_id,
          work_id: proposal.work_id,
          room_id: proposal.core_office_room_id,
          subject_id: agentHandle,
        },
      );
      throwIfCancelled(signal);
      if (!participant || participant.subject_id !== agentHandle || participant.status !== "active") {
        return invalidProposalPayload();
      }
    }
  }

  private async assign(
    context: TenantContext,
    commandId: string,
    workId: string,
    assignments: readonly ProposalAssignment[],
    signal?: AbortSignal,
    executor?: QueryExecutor,
  ): Promise<void> {
    for (const planned of assignments) {
      throwIfCancelled(signal);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        throwIfCancelled(signal);
        const currentAssignments = await this.dependencies.works.listAssignments(context, workId, executor);
        throwIfCancelled(signal);
        const active = currentAssignments.find(
          (candidate) => candidate.task_id === planned.taskId && candidate.status === "assigned",
        );
        if (active) {
          if (active.agent_handle !== planned.agentHandle) {
            throw new Error("Dynamic Staffing 활성 Assignment Agent가 계획과 다릅니다");
          }
          break;
        }
        const work = await this.dependencies.works.getWork(context, workId, executor);
        throwIfCancelled(signal);
        if (work.status !== "planned") throw new Error(`Dynamic Staffing assignment Work 상태가 ${work.status}입니다`);
        try {
          await this.dependencies.works.assignTask(
            context,
            {
              commandId: `${commandId}:task:${planned.taskId}:assign`,
              workId,
              expectedRevision: work.revision,
              taskId: planned.taskId,
              agentHandle: planned.agentHandle,
            },
            executor,
          );
          throwIfCancelled(signal);
          break;
        } catch (error) {
          throwIfCancelled(signal);
          const racedAssignments = await this.dependencies.works.listAssignments(context, workId, executor);
          throwIfCancelled(signal);
          const raced = racedAssignments.find(
            (candidate) => candidate.task_id === planned.taskId && candidate.status === "assigned",
          );
          if (raced) {
            if (raced.agent_handle !== planned.agentHandle) {
              throw new Error("Dynamic Staffing 활성 Assignment Agent가 계획과 다릅니다", { cause: error });
            }
            break;
          }
          if (attempt === 2 || !/현재 Work revision/iu.test(error instanceof Error ? error.message : String(error))) {
            throw error;
          }
        }
      }
    }
  }

  private assertAssessmentLineage(
    context: TenantContext,
    commandId: string,
    boundary: StaffingBoundary,
    assessment: StaffingAssessment,
  ): void {
    const taskByKey = new Map(boundary.plan.tasks.map((task) => [task.key, task]));
    if (
      assessment.organizationId !== context.organizationId ||
      assessment.workId !== boundary.work.work_id ||
      assessment.strategyGenerationId !== boundary.planVersion.strategy_generation_id ||
      assessment.commandId !== `${commandId}:assessment` ||
      assessment.createdByUserId !== context.userId ||
      assessment.recommendations.some((recommendation) => {
        const task = taskByKey.get(recommendation.taskKey);
        return !task || !sameStrings(recommendation.requiredCapabilities, task.requiredCapabilities);
      })
    ) {
      throw new Error("Staffing assessment 계보가 유효하지 않습니다");
    }
  }

  private isEligibleRecommendation(
    recommendation: StaffingRecommendation,
    taskKey: string,
    requiredCapabilities: readonly string[],
    workId: string,
    nodeByHandle: ReadonlyMap<string, OrganizationNode>,
  ): boolean {
    const node = nodeByHandle.get(recommendation.agentHandle);
    return (
      recommendation.taskKey === taskKey &&
      sameStrings(recommendation.requiredCapabilities, requiredCapabilities) &&
      node !== undefined &&
      node.status === "active" &&
      (node.scope === "persistent" || node.work_id === workId) &&
      requiredCapabilities.every((capability) => node.capabilities.includes(capability))
    );
  }

  private async loadAssessmentRecommendations(
    context: TenantContext,
    proposal: ProposalRecord,
    signal?: AbortSignal,
  ): Promise<readonly StaffingRecommendation[]> {
    const record = await first<StaffingAssessmentRecord>(
      this.database,
      "SELECT assessment_id, organization_id, work_id, strategy_generation_id, command_id, recommendations_json, created_by_user_id FROM staffing_assessment WHERE organization_id = $organization_id AND assessment_id = $assessment_id LIMIT 1;",
      { organization_id: context.organizationId, assessment_id: proposal.assessment_id },
    );
    throwIfCancelled(signal);
    if (
      !record ||
      record.assessment_id !== proposal.assessment_id ||
      record.organization_id !== proposal.organization_id ||
      record.work_id !== proposal.work_id ||
      record.strategy_generation_id !== proposal.strategy_generation_id ||
      record.command_id !== `${proposal.command_id}:assessment` ||
      record.created_by_user_id !== proposal.created_by_user_id
    ) {
      return invalidProposalPayload();
    }
    const raw = parseStoredJson(record.recommendations_json);
    if (!Array.isArray(raw)) return invalidProposalPayload();
    const recommendations = raw.map((candidate): StaffingRecommendation => {
      if (!isRecord(candidate)) return invalidProposalPayload();
      const recommendation = {
        taskKey: exactString(candidate.taskKey),
        agentHandle: exactString(candidate.agentHandle),
        requiredCapabilities: exactStringArray(candidate.requiredCapabilities),
      };
      if (canonicalJson(candidate) !== canonicalJson(recommendation)) return invalidProposalPayload();
      return recommendation;
    });
    const unique = new Set(recommendations.map(({ taskKey, agentHandle }) => `${taskKey}\0${agentHandle}`));
    if (unique.size !== recommendations.length) return invalidProposalPayload();
    return recommendations;
  }

  private validateProposalPayload(
    proposal: ProposalRecord,
    boundary: StaffingBoundary,
    recommendations: readonly StaffingRecommendation[],
    organizationNodes: readonly OrganizationNode[],
  ): ValidatedProposalPayload {
    if (
      proposal.proposal_id !== sha256(`${proposal.organization_id}\0${proposal.command_id}`) ||
      proposal.organization_id !== boundary.work.organization_id ||
      proposal.work_id !== boundary.work.work_id ||
      proposal.plan_version_id !== boundary.planVersion.plan_version_id ||
      proposal.context_version_id !== boundary.planVersion.context_version_id ||
      proposal.strategy_generation_id !== boundary.planVersion.strategy_generation_id ||
      proposal.core_office_room_id !== boundary.room.room_id ||
      !Number.isSafeInteger(proposal.expected_organization_version) ||
      proposal.expected_organization_version < 1 ||
      !Number.isSafeInteger(proposal.expected_work_revision) ||
      proposal.expected_work_revision < 1
    ) {
      return invalidProposalPayload();
    }

    const taskByKey = new Map(
      boundary.tasks.flatMap((task) => (task.task_key ? [[task.task_key, task] as const] : [])),
    );
    const strategyTaskByKey = new Map(boundary.plan.tasks.map((task) => [task.key, task]));
    const rawNodes = parseStoredJson(proposal.nodes_json);
    if (!Array.isArray(rawNodes)) return invalidProposalPayload();
    const nodes = rawNodes.map((candidate): ProposalNode => {
      if (!isRecord(candidate) || !isRecord(candidate.node)) return invalidProposalPayload();
      const taskKey = exactString(candidate.taskKey);
      const taskId = exactString(candidate.taskId);
      const agentHandle = exactString(candidate.agentHandle);
      const task = taskByKey.get(taskKey);
      if (!task?.task_key || task.task_id !== taskId) return invalidProposalPayload();
      const node = proposalNode(proposal.organization_id, proposal.work_id, proposal.strategy_generation_id, {
        ...task,
        task_key: task.task_key,
      });
      const parsed = { taskKey, taskId, agentHandle, node };
      if (agentHandle !== node.handle || canonicalJson(candidate) !== canonicalJson(parsed)) {
        return invalidProposalPayload();
      }
      return parsed;
    });
    const nodeTaskKeys = nodes.map((candidate) => candidate.taskKey);
    if (
      new Set(nodeTaskKeys).size !== nodeTaskKeys.length ||
      canonicalJson(nodeTaskKeys) !== canonicalJson([...nodeTaskKeys].sort())
    ) {
      return invalidProposalPayload();
    }

    const rawAssignments = parseStoredJson(proposal.assignments_json);
    if (!Array.isArray(rawAssignments)) return invalidProposalPayload();
    const assignments = rawAssignments.map((candidate): ProposalAssignment => {
      if (!isRecord(candidate)) return invalidProposalPayload();
      const rawSource = candidate.source;
      if (rawSource !== "recommendation" && rawSource !== "proposal") return invalidProposalPayload();
      const source: ProposalAssignment["source"] = rawSource;
      const assignment = {
        taskKey: exactString(candidate.taskKey),
        taskId: exactString(candidate.taskId),
        agentHandle: exactString(candidate.agentHandle),
        source,
      };
      if (canonicalJson(candidate) !== canonicalJson(assignment)) return invalidProposalPayload();
      const task = taskByKey.get(assignment.taskKey);
      if (!task || task.task_id !== assignment.taskId) return invalidProposalPayload();
      return assignment;
    });
    const assignmentTaskKeys = assignments.map((assignment) => assignment.taskKey);
    if (new Set(assignmentTaskKeys).size !== assignmentTaskKeys.length) return invalidProposalPayload();
    const taskOrder = new Map(boundary.plan.tasks.map((task, index) => [task.key, index]));
    if (
      assignments.some(
        (assignment, index) =>
          index > 0 &&
          (taskOrder.get(assignments[index - 1]?.taskKey ?? "") ?? -1) >= (taskOrder.get(assignment.taskKey) ?? -1),
      )
    ) {
      return invalidProposalPayload();
    }

    const nodeByTask = new Map(nodes.map((candidate) => [candidate.taskKey, candidate]));
    const organizationNodeByHandle = new Map(organizationNodes.map((node) => [node.handle, node]));
    for (const assignment of assignments) {
      const strategyTask = strategyTaskByKey.get(assignment.taskKey);
      if (!strategyTask) return invalidProposalPayload();
      const eligible = recommendations
        .filter((recommendation) =>
          this.isEligibleRecommendation(
            recommendation,
            assignment.taskKey,
            strategyTask.requiredCapabilities,
            proposal.work_id,
            organizationNodeByHandle,
          ),
        )
        .sort((left, right) => left.agentHandle.localeCompare(right.agentHandle));
      if (assignment.source === "recommendation") {
        if (nodeByTask.has(assignment.taskKey) || eligible[0]?.agentHandle !== assignment.agentHandle) {
          return invalidProposalPayload();
        }
      } else {
        const node = nodeByTask.get(assignment.taskKey);
        if (!node || node.agentHandle !== assignment.agentHandle || eligible.length > 0) {
          return invalidProposalPayload();
        }
      }
    }
    if (
      nodes.some(
        (node) =>
          !assignments.some(
            (assignment) =>
              assignment.source === "proposal" &&
              assignment.taskKey === node.taskKey &&
              assignment.taskId === node.taskId &&
              assignment.agentHandle === node.agentHandle,
          ),
      )
    ) {
      return invalidProposalPayload();
    }

    const expected = this.planAssignments(proposal.organization_id, boundary, recommendations, organizationNodes);
    if (
      canonicalJson(nodes) !== canonicalJson(expected.nodes) ||
      canonicalJson(assignments) !== canonicalJson(expected.assignments)
    ) {
      return invalidProposalPayload();
    }

    const command: InstallProfileCommand = {
      commandId: `${proposal.command_id}:organization`,
      expectedVersion: proposal.expected_organization_version,
      kind: "install-profile",
      profileId: `dynamic-staffing-${proposal.proposal_id}`,
      profileVersion: "1",
      nodes: nodes.map((candidate) => candidate.node),
    };
    if (canonicalJson(parseStoredJson(proposal.graph_command_json)) !== canonicalJson(command)) {
      return invalidProposalPayload();
    }
    if (
      canonicalJson(parseStoredJson(proposal.ux_metadata_json)) !==
      canonicalJson(proposalUxMetadata(boundary, nodes, assignments))
    ) {
      return invalidProposalPayload();
    }
    return { command, nodes, assignments };
  }

  private async markAwaiting(context: TenantContext, proposalId: string, approvalId: string): Promise<ProposalRecord> {
    return await this.update(context, proposalId, (record) => {
      if (record.status !== "prepared" && record.status !== "awaiting-approval") return record;
      if (record.status === "awaiting-approval" && record.approval_id !== approvalId) {
        throw new Error("Dynamic Staffing proposal approval 계보가 일치하지 않습니다");
      }
      return { status: "awaiting-approval", approvalId };
    });
  }

  private async markAtomicallyApplied(
    context: TenantContext,
    proposalId: string,
    changed: GraphChangeResult,
    messageId: string,
    executor: QueryExecutor,
  ): Promise<ProposalRecord> {
    const current = await this.findById(context.organizationId, proposalId, executor);
    if (current.status === "applied") {
      if (
        current.applied_organization_version !== changed.version.version ||
        current.applied_organization_version_id !== changed.version.version_id ||
        current.impact_json !== canonicalJson(changed.impact) ||
        current.message_id !== messageId
      ) {
        throw new Error("Dynamic Staffing 원자 적용 checkpoint가 일치하지 않습니다");
      }
      return current;
    }
    const [updated] = await executor.query<[ProposalRecord[]]>(
      "UPDATE dynamic_staffing_proposal SET status = 'applied', applied_organization_version = $applied_organization_version, applied_organization_version_id = $applied_organization_version_id, impact_json = $impact_json, message_id = $message_id, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND proposal_id = $proposal_id AND revision = $expected_revision RETURN AFTER;",
      {
        applied_organization_version: changed.version.version,
        applied_organization_version_id: changed.version.version_id,
        impact_json: canonicalJson(changed.impact),
        message_id: messageId,
        revision: current.revision + 1,
        organization_id: context.organizationId,
        proposal_id: proposalId,
        expected_revision: current.revision,
      },
    );
    if (!updated[0]) throw new Error("Dynamic Staffing proposal revision conflict입니다");
    return updated[0];
  }

  private async update(
    context: TenantContext,
    proposalId: string,
    change: (
      record: ProposalRecord,
    ) => ProposalRecord | { readonly status: "awaiting-approval"; readonly approvalId: string },
  ): Promise<ProposalRecord> {
    return await this.database.transaction(async (transaction) => {
      const current = await this.findById(context.organizationId, proposalId, transaction);
      const next = change(current);
      if ("proposal_id" in next) return next;
      const [updated] = await transaction.query<[ProposalRecord[]]>(
        "UPDATE dynamic_staffing_proposal SET status = $status, approval_id = $approval_id, applied_organization_version = $applied_organization_version, applied_organization_version_id = $applied_organization_version_id, impact_json = $impact_json, message_id = $message_id, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND proposal_id = $proposal_id AND revision = $expected_revision RETURN AFTER;",
        {
          status: next.status,
          approval_id: next.approvalId,
          applied_organization_version: current.applied_organization_version,
          applied_organization_version_id: current.applied_organization_version_id,
          impact_json: current.impact_json,
          message_id: current.message_id,
          revision: current.revision + 1,
          organization_id: context.organizationId,
          proposal_id: proposalId,
          expected_revision: current.revision,
        },
      );
      if (!updated[0]) throw new Error("Dynamic Staffing proposal revision conflict입니다");
      return updated[0];
    });
  }

  private sameLineage(proposal: ProposalRecord, boundary: StaffingBoundary): boolean {
    return (
      proposal.organization_id === boundary.work.organization_id &&
      proposal.work_id === boundary.work.work_id &&
      proposal.plan_version_id === boundary.planVersion.plan_version_id &&
      proposal.strategy_generation_id === boundary.planVersion.strategy_generation_id &&
      proposal.context_version_id === boundary.planVersion.context_version_id &&
      proposal.core_office_room_id === boundary.room.room_id
    );
  }

  private assertReplay(proposal: ProposalRecord, hash: string, workId: string): void {
    if (proposal.request_hash !== hash || proposal.work_id !== workId) {
      throw new Error("같은 commandId에 다른 Dynamic Staffing payload를 사용할 수 없습니다");
    }
  }

  private async find(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<ProposalRecord | undefined> {
    const proposal = await first<ProposalRecord>(
      executor,
      "SELECT * OMIT id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return proposal ? validateProposalIntent(proposal) : undefined;
  }

  private async findByApproval(
    organizationId: string,
    approvalId: string,
    executor: QueryExecutor = this.database,
  ): Promise<ProposalRecord | undefined> {
    const proposal = await first<ProposalRecord>(
      executor,
      "SELECT * OMIT id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND approval_id = $approval_id LIMIT 1;",
      { organization_id: organizationId, approval_id: approvalId },
    );
    return proposal ? validateProposalIntent(proposal) : undefined;
  }

  private async findById(
    organizationId: string,
    proposalId: string,
    executor: QueryExecutor = this.database,
  ): Promise<ProposalRecord> {
    const proposal = await first<ProposalRecord>(
      executor,
      "SELECT * OMIT id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND proposal_id = $proposal_id LIMIT 1;",
      { organization_id: organizationId, proposal_id: proposalId },
    );
    if (!proposal) throw new Error("Dynamic Staffing proposal을 찾을 수 없습니다");
    return validateProposalIntent(proposal);
  }
}
