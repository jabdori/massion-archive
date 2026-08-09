import { createHash, randomUUID } from "node:crypto";

import {
  GovernanceApprovalRequiredError,
  type GovernanceAuthorization,
  type GovernanceGate,
} from "@massion/governance";
import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  WORK_ASSURANCE_FAIL_CLOSED_GUARD,
  WORK_AUTONOMY_LINEAGE_MIGRATION,
  WORK_COLLABORATION_MIGRATION,
  WORK_CONSTRAINTS_MIGRATION,
  WORK_CORE_MIGRATION,
  WORK_DELIVERY_MIGRATION,
  WORK_HANDOFF_RECIPIENT_MIGRATION,
  WORK_OUTPUT_LOCALE_MIGRATION,
  WORK_RECORDS_MIGRATION,
  WORK_PROMPT_VERSION_MIGRATION,
  WORK_STRATEGY_PROJECTION_MIGRATION,
  WORK_WORKSPACE_MIGRATION,
} from "./schema.js";
import type { PromptVersionResolver, ResolveWorkPromptInput } from "./prompt-version.js";

export type WorkStatus =
  | "draft"
  | "planned"
  | "ready"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "completed"
  | "failed"
  | "retrying"
  | "replanning"
  | "cancelled";

export interface WorkRequest {
  readonly request_id: string;
  readonly organization_id: string;
  readonly requester_user_id: string;
  readonly text: string;
  readonly surface: string;
  readonly output_locale?: "en" | "ko";
  readonly created_at: unknown;
}

export interface Work {
  readonly work_id: string;
  readonly organization_id: string;
  readonly request_id: string;
  readonly parent_work_id?: string;
  readonly project_id?: string;
  readonly workspace_id?: string;
  readonly status: WorkStatus;
  readonly revision: number;
  readonly organization_version_id: string;
  readonly context_version_id?: string;
  readonly active_plan_version_id?: string;
  readonly policy_version_id?: string;
  readonly prompt_version_id?: string;
  readonly prompt_schema_version?: string;
  readonly artifact_version_ids: readonly string[];
  readonly records_schema_version?: string;
  readonly autonomy_mode?: "automatic" | "review" | "full-access";
  readonly autonomy_revision?: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface WorkEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly caused_by_event_id?: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

export interface PlanVersion {
  readonly plan_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly version: number;
  readonly content_json: string;
  readonly valid: boolean;
  readonly context_version_id?: string;
  readonly strategy_generation_id?: string;
  readonly strategy_checksum?: string;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface CreateWorkInput {
  readonly commandId: string;
  readonly text: string;
  readonly surface: string;
  readonly outputLocale?: "en" | "ko";
  readonly organizationVersionId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly contextVersionId?: string;
  readonly policyVersionId?: string;
  readonly promptVersionId?: string;
}

export interface CreateWorkResult {
  readonly request: WorkRequest;
  readonly work: Work;
  readonly event: WorkEvent;
}

export interface CreateFollowUpWorkInput {
  readonly commandId: string;
  readonly parentWorkId: string;
  readonly text: string;
  readonly surface: string;
}

export interface CreateFollowUpWorkResult {
  readonly request: WorkRequest;
  readonly work: Work;
  readonly event: WorkEvent;
}

export interface WorkCommandInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedRevision: number;
  readonly causedByEventId?: string;
}

export interface AttachContextVersionInput extends WorkCommandInput {
  readonly contextVersionId: string;
}

export interface TransitionInput extends WorkCommandInput {
  readonly target: WorkStatus;
}

export interface AuthorizeRunningActionInput extends WorkCommandInput {
  readonly governedRevision?: number;
  readonly action: string;
  readonly environment: string;
  readonly riskClass: string;
  readonly external: boolean;
  readonly approvalId?: string;
}

export interface ReconcileRunningActionApprovalInput extends WorkCommandInput {
  readonly approvalId: string;
}

export type AuthorizeRunningActionResult =
  | {
      readonly outcome: "waiting_approval";
      readonly work: Work;
      readonly event: WorkEvent;
      readonly decisionId: string;
      readonly approvalId: string;
    }
  | {
      readonly outcome: "allowed";
      readonly work: Work;
      readonly event?: WorkEvent;
      readonly authorization: GovernanceAuthorization;
    };

export interface AddPlanInput extends WorkCommandInput {
  readonly content: Record<string, unknown>;
}

export interface WorkCommandResult {
  readonly work: Work;
  readonly event: WorkEvent;
}

export interface AddPlanResult extends WorkCommandResult {
  readonly plan: PlanVersion;
}

export interface StrategyProjectionCriterion {
  readonly key: string;
  readonly statement: string;
  readonly method: "test" | "inspection" | "evidence" | "metric" | "human";
  readonly evidenceKinds: readonly string[];
  readonly planLevel: boolean;
}

export interface StrategyProjectionRisk {
  readonly key: string;
  readonly description: string;
  readonly likelihood: "low" | "medium" | "high" | "critical";
  readonly impact: "low" | "medium" | "high" | "critical";
  readonly mitigation: string;
  readonly requiresApproval: boolean;
}

export interface StrategyProjectionTask {
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly criterionKeys: readonly string[];
  readonly dependencyKeys: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly recommendedAgentHandles: readonly string[];
  readonly parallelizable: boolean;
}

export interface StrategyProjectionEvidenceRequest {
  readonly key: string;
  readonly question: string;
  readonly required: boolean;
}

export interface StrategyProjection {
  readonly objective: string;
  readonly summary: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly acceptanceCriteria: readonly StrategyProjectionCriterion[];
  readonly risks: readonly StrategyProjectionRisk[];
  readonly tasks: readonly StrategyProjectionTask[];
  readonly evidenceRequests: readonly StrategyProjectionEvidenceRequest[];
}

export interface ApplyStrategyProjectionInput extends WorkCommandInput {
  readonly contextVersionId: string;
  readonly strategyGenerationId: string;
  readonly strategyExecutionId?: string;
  readonly strategyChecksum: string;
  readonly plan: StrategyProjection;
}

export interface ApplyStrategyProjectionResult extends WorkCommandResult {
  readonly plan: PlanVersion;
  readonly tasks: readonly WorkTask[];
  readonly previousPlan?: PlanVersion;
}

export type TaskStatus = "blocked" | "ready" | "running" | "completed" | "failed" | "cancelled";

export interface WorkTask {
  readonly task_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly plan_version_id?: string;
  readonly task_key?: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptance_criteria_json: string;
  readonly dependency_ids: readonly string[];
  readonly required_capabilities?: readonly string[];
  readonly recommended_agent_handles?: readonly string[];
  readonly parallelizable?: boolean;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface TaskAssignment {
  readonly assignment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: "assigned" | "released" | "completed";
  readonly revision: number;
  readonly supersedes_assignment_id?: string;
  readonly created_by: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface WorkSession {
  readonly session_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
  readonly status: "active" | "idle" | "closed" | "archived";
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface SessionCheckpoint {
  readonly checkpoint_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly session_id: string;
  readonly version: number;
  readonly data_json: string;
  readonly checksum: string;
  readonly created_at: unknown;
}

export interface AddTaskInput extends WorkCommandInput {
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly string[];
}

export interface SetTaskDependenciesInput extends WorkCommandInput {
  readonly taskId: string;
  readonly dependencyIds: readonly string[];
}

export interface TransitionTaskInput extends WorkCommandInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly target: Exclude<TaskStatus, "blocked">;
}

export interface AssignTaskInput extends WorkCommandInput {
  readonly taskId: string;
  readonly agentHandle: string;
}

export interface OpenSessionInput extends WorkCommandInput {
  readonly agentHandle: string;
}

export interface SaveCheckpointInput extends WorkCommandInput {
  readonly sessionId: string;
  readonly expectedSessionRevision: number;
  readonly data: unknown;
}

export type CollaborationMessageType =
  | "question"
  | "answer"
  | "proposal"
  | "challenge"
  | "review_request"
  | "change_request"
  | "evidence"
  | "decision"
  | "handoff"
  | "status";

export interface CollaborationRoom {
  readonly room_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly title: string;
  readonly coordinator_handle: string;
  readonly status: "active" | "paused" | "closed" | "cancelled";
  readonly revision: number;
  readonly next_sequence: number;
  readonly max_parallel: number;
  readonly max_tokens: number;
  readonly max_cost_micros: number;
  readonly max_rounds: number;
  readonly round_count: number;
  readonly deadline?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface CollaborationParticipant {
  readonly participant_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly kind: "user" | "agent";
  readonly subject_id: string;
  readonly role: "coordinator" | "participant" | "observer";
  readonly status: "active" | "left";
  readonly joined_at: unknown;
}

export interface CollaborationMessage {
  readonly message_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly sequence: number;
  readonly message_type: CollaborationMessageType;
  readonly author_kind: "user" | "agent";
  readonly author_id: string;
  readonly recipient_agent_id?: string;
  readonly content: string;
  readonly reply_to_message_id?: string;
  readonly caused_by_message_id?: string;
  readonly task_id?: string;
  readonly context_version_id?: string;
  readonly execution_id?: string;
  readonly artifact_version_id?: string;
  readonly token_count: number;
  readonly cost_micros: number;
  readonly created_at: unknown;
}

export interface SharedContextReference {
  readonly shared_context_reference_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly version_id: string;
  readonly checksum: string;
  readonly created_at: unknown;
}

export interface ResourceLease {
  readonly lease_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly resource_key: string;
  readonly holder_id: string;
  readonly status: "active" | "released";
  readonly version: number;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface OpenRoomInput extends WorkCommandInput {
  readonly title: string;
  readonly coordinatorHandle: string;
  readonly participants: readonly {
    readonly kind: "user" | "agent";
    readonly subjectId: string;
    readonly role: "coordinator" | "participant" | "observer";
  }[];
  readonly limits: {
    readonly maxParallel: number;
    readonly maxTokens: number;
    readonly maxCostMicros: number;
    readonly maxRounds: number;
    readonly deadline?: string;
  };
}

export interface JoinRoomInput extends WorkCommandInput {
  readonly roomId: string;
  readonly expectedRoomRevision: number;
  readonly kind: "user" | "agent";
  readonly subjectId: string;
  readonly role: "coordinator" | "participant" | "observer";
}

export interface LeaveRoomInput extends WorkCommandInput {
  readonly roomId: string;
  readonly expectedRoomRevision: number;
  readonly kind: "user" | "agent";
  readonly subjectId: string;
}

export interface PostMessageInput {
  readonly commandId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly messageType: CollaborationMessageType;
  readonly authorKind: "user" | "agent";
  readonly authorId: string;
  readonly recipientAgentId?: string;
  readonly content: string;
  readonly replyToMessageId?: string;
  readonly causedByMessageId?: string;
  readonly taskId?: string;
  readonly contextVersionId?: string;
  readonly executionId?: string;
  readonly artifactVersionId?: string;
  readonly tokenCount: number;
  readonly costMicros: number;
}

export interface AddSharedContextInput extends WorkCommandInput {
  readonly roomId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly versionId: string;
  readonly checksum: string;
}

export interface AcquireLeaseInput extends WorkCommandInput {
  readonly resourceKey: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export interface ChangeLeaseInput extends WorkCommandInput {
  readonly resourceKey: string;
  readonly holderId: string;
  readonly expectedLeaseVersion: number;
  readonly ttlMs?: number;
}

export interface WorkArtifact {
  readonly artifact_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly kind: string;
  readonly name: string;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface ArtifactVersion {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly version: number;
  readonly checksum: string;
  readonly media_type: string;
  readonly content_json: string;
  readonly source_artifact_version_id?: string;
  readonly created_by: string;
  readonly creator_agent_handle?: string;
  readonly creator_execution_id?: string;
  readonly created_at: unknown;
}

export interface WorkVerification {
  readonly verification_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly verifier_id: string;
  readonly passed: boolean;
  readonly criteria_json: string;
  readonly evidence_artifact_version_ids: readonly string[];
  readonly assurance_run_id: string;
  readonly target_work_revision: number;
  readonly projected_work_revision: number;
  readonly snapshot_hash: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly binding_version_id: string;
  readonly evidence_artifact_version_id: string;
  readonly created_at: unknown;
}

export interface WorkRecord {
  readonly work_record_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly version: number;
  readonly recorded_work_revision: number;
  readonly summary: string;
  readonly event_start_sequence: number;
  readonly event_end_sequence: number;
  readonly decision_message_ids: readonly string[];
  readonly artifact_version_ids: readonly string[];
  readonly verification_ids: readonly string[];
  readonly finalized: boolean;
  readonly finalized_by: string;
  readonly finalized_at: unknown;
  readonly records_run_id?: string;
  readonly records_snapshot_hash?: string;
  readonly document_ids?: readonly string[];
  readonly schema_version?: string;
}

export interface WorkMergePlan {
  readonly merge_plan_id: string;
  readonly organization_id: string;
  readonly parent_work_id: string;
  readonly child_work_id: string;
  readonly parent_revision: number;
  readonly status: "ready" | "conflicted" | "applied";
  readonly conflict_json: string;
  readonly artifact_version_ids: readonly string[];
  readonly decision_message_ids: readonly string[];
  readonly verification_ids: readonly string[];
  readonly created_by: string;
  readonly created_at: unknown;
  readonly applied_at?: unknown;
}

export interface ForkWorkInput extends WorkCommandInput {
  readonly objective: string;
}

export interface CreateArtifactVersionInput extends WorkCommandInput {
  readonly artifactId?: string;
  readonly kind: string;
  readonly name: string;
  readonly mediaType: string;
  readonly content: unknown;
  readonly creatorAgentHandle?: string;
  readonly creatorExecutionId?: string;
  /** Task 결과 Artifact인 경우 Runtime·Task·Collaboration 계보를 한 transaction에 묶습니다. */
  readonly creatorTaskId?: string;
  /** 동일 실행의 보조 Artifact는 기존 Task 결과 message를 재사용해 round를 소비하지 않습니다. */
  readonly suppressEvidenceMessage?: boolean;
}

export interface FinalizeRecordInput extends WorkCommandInput {
  readonly summary: string;
}

export interface PlanMergeInput extends WorkCommandInput {
  readonly childWorkId: string;
}

export interface ApplyMergeInput extends WorkCommandInput {
  readonly mergePlanId: string;
}

export interface WorkComplianceFinding {
  readonly code:
    "revision" | "event-sequence" | "plan" | "task-dag" | "assignment" | "task-completion" | "verification" | "record";
  readonly message: string;
}

export interface WorkRecoveryBundle {
  readonly request: WorkRequest;
  readonly work: Work;
  readonly childWorks: Work[];
  readonly events: WorkEvent[];
  readonly plans: PlanVersion[];
  readonly tasks: WorkTask[];
  readonly assignments: TaskAssignment[];
  readonly sessions: WorkSession[];
  readonly checkpoints: SessionCheckpoint[];
  readonly rooms: CollaborationRoom[];
  readonly messages: CollaborationMessage[];
  readonly sharedContextReferences: SharedContextReference[];
  readonly leases: ResourceLease[];
  readonly artifacts: WorkArtifact[];
  readonly artifactVersions: ArtifactVersion[];
  readonly verifications: WorkVerification[];
  readonly records: WorkRecord[];
}

interface WorkOrganizationGraph {
  verifyActiveNode(context: TenantContext, handle: string, executor?: QueryExecutor, workId?: string): Promise<void>;
  releaseTerminalWorkScopedNodes(context: TenantContext, workId: string): Promise<unknown>;
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  draft: ["planned", "cancelled"],
  planned: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["waiting_approval", "verifying", "failed", "cancelled"],
  waiting_approval: ["running", "cancelled"],
  verifying: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["retrying", "replanning", "cancelled"],
  retrying: ["running", "cancelled"],
  replanning: ["planned", "cancelled"],
  cancelled: [],
};

export function canTransitionWork(current: WorkStatus, target: WorkStatus): boolean {
  return ALLOWED_TRANSITIONS[current].includes(target);
}

const COLLABORATION_MESSAGE_TYPES = new Set<CollaborationMessageType>([
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
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function datetimeMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  if (!serialized) return Number.NaN;
  const parsed = JSON.parse(serialized) as unknown;
  return typeof parsed === "string" || typeof parsed === "number" ? new Date(parsed).getTime() : Number.NaN;
}

async function findWork(executor: QueryExecutor, organizationId: string, workId: string): Promise<Work | undefined> {
  const [works] = await executor.query<[Work[]]>(
    "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: organizationId, work_id: workId },
  );
  return works[0];
}

async function listEventsWith(executor: QueryExecutor, organizationId: string, workId: string): Promise<WorkEvent[]> {
  const [events] = await executor.query<[WorkEvent[]]>(
    "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return events;
}

async function findCommand(
  executor: QueryExecutor,
  organizationId: string,
  commandId: string,
): Promise<WorkEvent | undefined> {
  const [events] = await executor.query<[WorkEvent[]]>(
    "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
    { organization_id: organizationId, command_id: commandId },
  );
  return events[0];
}

async function listTasksWith(executor: QueryExecutor, organizationId: string, workId: string): Promise<WorkTask[]> {
  const [tasks] = await executor.query<[WorkTask[]]>(
    "SELECT * OMIT id FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return tasks;
}

async function listActiveTasksWith(
  executor: QueryExecutor,
  organizationId: string,
  work: Pick<Work, "work_id" | "active_plan_version_id">,
): Promise<WorkTask[]> {
  const tasks = await listTasksWith(executor, organizationId, work.work_id);
  if (!work.active_plan_version_id) return tasks;
  return tasks.filter((task) => task.plan_version_id === work.active_plan_version_id);
}

async function listAssignmentsWith(
  executor: QueryExecutor,
  organizationId: string,
  workId: string,
): Promise<TaskAssignment[]> {
  const [assignments] = await executor.query<[TaskAssignment[]]>(
    "SELECT * OMIT id FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return assignments;
}

async function retirePlanExecution(
  executor: QueryExecutor,
  organizationId: string,
  workId: string,
  planVersionId: string,
): Promise<void> {
  const tasks = (await listTasksWith(executor, organizationId, workId)).filter(
    (task) => task.plan_version_id === planVersionId,
  );
  await executor.query(
    "UPDATE work_task SET status = 'cancelled', revision += 1, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND plan_version_id = $plan_version_id AND status IN ['blocked', 'ready', 'running', 'failed'];",
    { organization_id: organizationId, work_id: workId, plan_version_id: planVersionId },
  );
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const assignments = await listAssignmentsWith(executor, organizationId, workId);
  for (const assignment of assignments) {
    if (assignment.status !== "assigned" || !taskIds.has(assignment.task_id)) continue;
    await executor.query(
      "UPDATE task_assignment SET status = 'released', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND assignment_id = $assignment_id;",
      {
        revision: assignment.revision + 1,
        organization_id: organizationId,
        assignment_id: assignment.assignment_id,
      },
    );
  }
}

function assertAcyclic(tasks: readonly WorkTask[]): void {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const visit = (taskId: string, path: Set<string>, complete: Set<string>): void => {
    if (path.has(taskId)) throw new Error("Task DAG에 cycle이 생깁니다");
    if (complete.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${taskId}`);
    const nextPath = new Set(path).add(taskId);
    for (const dependencyId of task.dependency_ids) visit(dependencyId, nextPath, complete);
    complete.add(taskId);
  };
  const complete = new Set<string>();
  for (const task of tasks) visit(task.task_id, new Set(), complete);
}

function assertUniqueProjectionKeys(kind: string, values: readonly { readonly key: string }[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.key.trim()) throw new Error(`${kind} key는 비어 있을 수 없습니다`);
    if (seen.has(value.key)) throw new Error(`${kind} key가 중복됐습니다: ${value.key}`);
    seen.add(value.key);
  }
}

function assertStrategyProjection(plan: StrategyProjection): void {
  if (!plan.objective.trim() || !plan.summary.trim()) throw new Error("StrategyPlan objective와 summary가 필요합니다");
  if (plan.acceptanceCriteria.length === 0) throw new Error("StrategyPlan acceptance criterion이 필요합니다");
  if (plan.tasks.length === 0) throw new Error("StrategyPlan Task가 필요합니다");
  assertUniqueProjectionKeys("Acceptance criterion", plan.acceptanceCriteria);
  assertUniqueProjectionKeys("Risk", plan.risks);
  assertUniqueProjectionKeys("Task", plan.tasks);
  assertUniqueProjectionKeys("Evidence request", plan.evidenceRequests);

  const criteriaByKey = new Map(plan.acceptanceCriteria.map((criterion) => [criterion.key, criterion]));
  const taskByKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const assignedCriteria = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.title.trim() || !task.objective.trim()) throw new Error(`Strategy Task 내용이 비었습니다: ${task.key}`);
    for (const criterionKey of task.criterionKeys) {
      if (!criteriaByKey.has(criterionKey)) throw new Error(`존재하지 않는 criterion입니다: ${criterionKey}`);
      assignedCriteria.add(criterionKey);
    }
    for (const dependencyKey of task.dependencyKeys) {
      if (!taskByKey.has(dependencyKey)) throw new Error(`존재하지 않는 dependency입니다: ${dependencyKey}`);
    }
  }
  for (const criterion of plan.acceptanceCriteria) {
    if (!criterion.statement.trim()) throw new Error(`Acceptance criterion 내용이 비었습니다: ${criterion.key}`);
    if (!criterion.planLevel && !assignedCriteria.has(criterion.key)) {
      throw new Error(`Task에 귀속되지 않은 criterion입니다: ${criterion.key}`);
    }
  }
  for (const risk of plan.risks) {
    if (
      (risk.impact === "critical" || risk.likelihood === "critical") &&
      (!risk.mitigation.trim() || !risk.requiresApproval)
    ) {
      throw new Error(`critical risk에는 mitigation과 사람 승인이 필요합니다: ${risk.key}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskKey: string): void => {
    if (visiting.has(taskKey)) throw new Error(`Strategy Task dependency cycle이 있습니다: ${taskKey}`);
    if (visited.has(taskKey)) return;
    visiting.add(taskKey);
    for (const dependencyKey of taskByKey.get(taskKey)?.dependencyKeys ?? []) visit(dependencyKey);
    visiting.delete(taskKey);
    visited.add(taskKey);
  };
  for (const task of plan.tasks) visit(task.key);
}

export class WorkService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly graph?: WorkOrganizationGraph,
    private readonly governance?: Pick<GovernanceGate, "authorize" | "getApprovalStatus">,
    private readonly promptVersions?: PromptVersionResolver,
    private readonly autonomy?: (
      context: TenantContext,
      executor: QueryExecutor,
    ) => Promise<{
      readonly mode: "automatic" | "review" | "full-access";
      readonly revision: number;
    }>,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    graph?: WorkOrganizationGraph,
    governance?: Pick<GovernanceGate, "authorize" | "getApprovalStatus">,
    promptVersions?: PromptVersionResolver,
    autonomy?: (
      context: TenantContext,
      executor: QueryExecutor,
    ) => Promise<{
      readonly mode: "automatic" | "review" | "full-access";
      readonly revision: number;
    }>,
  ): Promise<WorkService> {
    await applyMigrations(database, [
      WORK_CORE_MIGRATION,
      WORK_DELIVERY_MIGRATION,
      WORK_COLLABORATION_MIGRATION,
      WORK_RECORDS_MIGRATION,
      WORK_CONSTRAINTS_MIGRATION,
      WORK_STRATEGY_PROJECTION_MIGRATION,
      WORK_PROMPT_VERSION_MIGRATION,
      WORK_WORKSPACE_MIGRATION,
      WORK_AUTONOMY_LINEAGE_MIGRATION,
      WORK_HANDOFF_RECIPIENT_MIGRATION,
      WORK_OUTPUT_LOCALE_MIGRATION,
    ]);
    await database.query(WORK_ASSURANCE_FAIL_CLOSED_GUARD);
    return new WorkService(database, organizations, graph, governance, promptVersions, autonomy);
  }

  private async verify(context: TenantContext, executor: QueryExecutor = this.database): Promise<void> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
  }

  public async createWork(context: TenantContext, input: CreateWorkInput): Promise<CreateWorkResult> {
    await this.verify(context);
    const text = input.text.trim();
    if (!text) throw new Error("Request 원문은 비어 있을 수 없습니다");
    if (!input.organizationVersionId.trim()) throw new Error("OrganizationVersion 참조가 필요합니다");
    if (this.promptVersions && input.promptVersionId !== undefined) {
      throw new Error("caller는 Growth-aware Work의 PromptVersion ID를 주입할 수 없습니다");
    }
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) return this.replay(repeated, requestJson) as CreateWorkResult;
      const autonomy = this.autonomy ? await this.autonomy(context, transaction) : undefined;
      const requestId = randomUUID();
      const workId = randomUUID();
      const promptInput: ResolveWorkPromptInput = {
        workId,
        requesterUserId: context.userId,
        organizationVersionId: input.organizationVersionId,
        ...(input.contextVersionId ? { contextVersionId: input.contextVersionId } : {}),
        ...(input.policyVersionId ? { policyVersionId: input.policyVersionId } : {}),
      };
      // Growth-aware Work는 검증된 PromptVersion 없이 생성하지 않습니다.
      // suspended·손상된 version을 무시하면 새 Work가 잘못된 계보를 갖게 됩니다.
      const resolvedPrompt = this.promptVersions
        ? await this.promptVersions.resolve(context, promptInput, transaction)
        : undefined;
      if (resolvedPrompt) {
        await this.promptVersions?.verify(context, resolvedPrompt.promptVersionId, transaction);
      }
      const [requests] = await transaction.query<[WorkRequest[]]>(
        "CREATE work_request CONTENT { request_id: $request_id, organization_id: $organization_id, requester_user_id: $requester_user_id, text: $text, surface: $surface, output_locale: $output_locale, created_at: time::now() } RETURN AFTER;",
        {
          request_id: requestId,
          organization_id: context.organizationId,
          requester_user_id: context.userId,
          text,
          surface: input.surface,
          output_locale: input.outputLocale,
        },
      );
      const [works] = await transaction.query<[Work[]]>(
        "CREATE work CONTENT { work_id: $work_id, organization_id: $organization_id, request_id: $request_id, project_id: $project_id, workspace_id: $workspace_id, status: 'draft', revision: 1, organization_version_id: $organization_version_id, context_version_id: $context_version_id, policy_version_id: $policy_version_id, prompt_version_id: $prompt_version_id, prompt_schema_version: $prompt_schema_version, autonomy_mode: $autonomy_mode, autonomy_revision: $autonomy_revision, artifact_version_ids: [], created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          work_id: workId,
          organization_id: context.organizationId,
          request_id: requestId,
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          organization_version_id: input.organizationVersionId,
          context_version_id: input.contextVersionId,
          policy_version_id: input.policyVersionId,
          prompt_version_id: resolvedPrompt?.promptVersionId ?? input.promptVersionId,
          prompt_schema_version: resolvedPrompt?.schemaVersion,
          autonomy_mode: autonomy?.mode,
          autonomy_revision: autonomy?.revision,
        },
      );
      const request = requests[0];
      const work = works[0];
      if (!request || !work) throw new Error("Request와 Work 생성 결과가 불완전합니다");
      const provisional = { request, work };
      const event = await this.appendEvent(
        transaction,
        context,
        work,
        input.commandId,
        "work_created",
        requestJson,
        { requestId },
        provisional,
      );
      const result = { request, work, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    });
  }

  public async getWork(context: TenantContext, workId: string, executor: QueryExecutor = this.database): Promise<Work> {
    await this.verify(context, executor);
    const work = await findWork(executor, context.organizationId, workId);
    if (!work) throw new Error(`Work를 찾을 수 없습니다: ${workId}`);
    return work;
  }

  public async findArtifactVersion(
    context: TenantContext,
    input: { readonly workId: string; readonly kind: string; readonly name: string },
  ): Promise<{ readonly artifact: WorkArtifact; readonly artifactVersion: ArtifactVersion } | undefined> {
    await this.getWork(context, input.workId);
    const [artifacts] = await this.database.query<[WorkArtifact[]]>(
      "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id AND kind = $kind AND name = $name;",
      {
        organization_id: context.organizationId,
        work_id: input.workId,
        kind: input.kind,
        name: input.name,
      },
    );
    if (artifacts.length > 1) throw new Error("같은 Work delivery 이름의 Artifact가 중복됐습니다");
    const artifact = artifacts[0];
    if (!artifact) return undefined;
    const [versions] = await this.database.query<[ArtifactVersion[]]>(
      "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_id = $artifact_id ORDER BY version ASC;",
      {
        organization_id: context.organizationId,
        work_id: input.workId,
        artifact_id: artifact.artifact_id,
      },
    );
    if (versions.length !== 1 || !versions[0]) {
      throw new Error("Software delivery Artifact에는 정확히 하나의 버전이 필요합니다");
    }
    return { artifact, artifactVersion: versions[0] };
  }

  public async getWorkRequest(context: TenantContext, workId: string): Promise<WorkRequest> {
    const work = await this.getWork(context, workId);
    const [requests] = await this.database.query<[WorkRequest[]]>(
      "SELECT * OMIT id FROM work_request WHERE organization_id = $organization_id AND request_id = $request_id LIMIT 1;",
      { organization_id: context.organizationId, request_id: work.request_id },
    );
    if (!requests[0]) throw new Error(`Work Request를 찾을 수 없습니다: ${work.request_id}`);
    return requests[0];
  }

  public async attachContextVersion(
    context: TenantContext,
    input: AttachContextVersionInput,
  ): Promise<WorkCommandResult> {
    if (!input.contextVersionId.trim()) throw new Error("ContextVersion 참조가 필요합니다");
    return await this.mutate(context, input, "context_version_attached", async (transaction, work) => {
      if (!["draft", "planned", "replanning"].includes(work.status)) {
        throw new Error(`ContextVersion을 연결할 수 없는 Work 상태입니다: ${work.status}`);
      }
      await transaction.query(
        "UPDATE work SET context_version_id = $context_version_id WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          context_version_id: input.contextVersionId,
          organization_id: context.organizationId,
          work_id: work.work_id,
        },
      );
      return {};
    });
  }

  public async createFollowUpWork(
    context: TenantContext,
    input: CreateFollowUpWorkInput,
  ): Promise<CreateFollowUpWorkResult> {
    await this.verify(context);
    const text = input.text.trim();
    if (!text) throw new Error("후속 Request 원문은 비어 있을 수 없습니다");
    if (!input.surface.trim()) throw new Error("후속 Request surface가 필요합니다");
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) return this.replay(repeated, requestJson) as CreateFollowUpWorkResult;
      const parent = await findWork(transaction, context.organizationId, input.parentWorkId);
      if (!parent) throw new Error(`부모 Work를 찾을 수 없습니다: ${input.parentWorkId}`);
      const autonomy = this.autonomy ? await this.autonomy(context, transaction) : undefined;

      const requestId = randomUUID();
      const workId = randomUUID();
      const [requests] = await transaction.query<[WorkRequest[]]>(
        "CREATE work_request CONTENT { request_id: $request_id, organization_id: $organization_id, requester_user_id: $requester_user_id, text: $text, surface: $surface, created_at: time::now() } RETURN AFTER;",
        {
          request_id: requestId,
          organization_id: context.organizationId,
          requester_user_id: context.userId,
          text,
          surface: input.surface.trim(),
        },
      );
      const [works] = await transaction.query<[Work[]]>(
        "CREATE work CONTENT { work_id: $work_id, organization_id: $organization_id, request_id: $request_id, parent_work_id: $parent_work_id, project_id: $project_id, workspace_id: $workspace_id, status: 'draft', revision: 1, organization_version_id: $organization_version_id, context_version_id: $context_version_id, policy_version_id: $policy_version_id, prompt_version_id: $prompt_version_id, prompt_schema_version: $prompt_schema_version, autonomy_mode: $autonomy_mode, autonomy_revision: $autonomy_revision, artifact_version_ids: $artifact_version_ids, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          work_id: workId,
          organization_id: context.organizationId,
          request_id: requestId,
          parent_work_id: parent.work_id,
          project_id: parent.project_id,
          workspace_id: parent.workspace_id,
          organization_version_id: parent.organization_version_id,
          context_version_id: parent.context_version_id,
          policy_version_id: parent.policy_version_id,
          prompt_version_id: parent.prompt_version_id,
          prompt_schema_version: parent.prompt_schema_version,
          autonomy_mode: autonomy?.mode,
          autonomy_revision: autonomy?.revision,
          artifact_version_ids: parent.artifact_version_ids,
        },
      );
      const request = requests[0];
      const work = works[0];
      if (!request || !work) throw new Error("후속 Request와 Work 생성 결과가 불완전합니다");
      const provisional = { request, work };
      const event = await this.appendEvent(
        transaction,
        context,
        work,
        input.commandId,
        "follow_up_work_created",
        requestJson,
        { parentWorkId: parent.work_id },
        provisional,
      );
      const result = { request, work, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    });
  }

  public async listEvents(context: TenantContext, workId: string): Promise<WorkEvent[]> {
    await this.getWork(context, workId);
    return await listEventsWith(this.database, context.organizationId, workId);
  }

  public async getActivePlan(
    context: TenantContext,
    workId: string,
    executor: QueryExecutor = this.database,
  ): Promise<PlanVersion | undefined> {
    const work = await this.getWork(context, workId, executor);
    if (!work.active_plan_version_id) return undefined;
    const [plans] = await executor.query<[PlanVersion[]]>(
      "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id AND plan_version_id = $plan_version_id LIMIT 1;",
      {
        organization_id: context.organizationId,
        work_id: workId,
        plan_version_id: work.active_plan_version_id,
      },
    );
    if (!plans[0]) throw new Error(`활성 PlanVersion을 찾을 수 없습니다: ${work.active_plan_version_id}`);
    return plans[0];
  }

  public async applyStrategyProjection(
    context: TenantContext,
    input: ApplyStrategyProjectionInput,
  ): Promise<ApplyStrategyProjectionResult> {
    if (!input.contextVersionId.trim()) throw new Error("ContextVersion 참조가 필요합니다");
    if (!input.strategyGenerationId.trim()) throw new Error("StrategyGeneration 참조가 필요합니다");
    if (!/^[a-f0-9]{64}$/u.test(input.strategyChecksum)) {
      throw new Error("Strategy checksum은 SHA-256 형식이어야 합니다");
    }
    assertStrategyProjection(input.plan);

    return await this.mutate(context, input, "strategy_projection_applied", async (transaction, work) => {
      if (!["draft", "planned", "replanning"].includes(work.status)) {
        throw new Error(`StrategyPlan을 투영할 수 없는 Work 상태입니다: ${work.status}`);
      }
      const [plans] = await transaction.query<[PlanVersion[]]>(
        "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY version ASC;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const previousPlan = work.active_plan_version_id
        ? plans.find((candidate) => candidate.plan_version_id === work.active_plan_version_id)
        : undefined;
      if (work.active_plan_version_id && !previousPlan) {
        throw new Error(`활성 PlanVersion을 찾을 수 없습니다: ${work.active_plan_version_id}`);
      }
      if (previousPlan) {
        await transaction.query(
          "UPDATE plan_version SET valid = false WHERE organization_id = $organization_id AND work_id = $work_id AND plan_version_id = $plan_version_id;",
          {
            organization_id: context.organizationId,
            work_id: work.work_id,
            plan_version_id: previousPlan.plan_version_id,
          },
        );
        await retirePlanExecution(transaction, context.organizationId, work.work_id, previousPlan.plan_version_id);
      }

      const planVersionId = randomUUID();
      const version = plans.reduce((maximum, candidate) => Math.max(maximum, candidate.version), 0) + 1;
      const [createdPlans] = await transaction.query<[PlanVersion[]]>(
        "CREATE plan_version CONTENT { plan_version_id: $plan_version_id, organization_id: $organization_id, work_id: $work_id, version: $version, content_json: $content_json, valid: true, context_version_id: $context_version_id, strategy_generation_id: $strategy_generation_id, strategy_checksum: $strategy_checksum, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
        {
          plan_version_id: planVersionId,
          organization_id: context.organizationId,
          work_id: work.work_id,
          version,
          content_json: canonicalJson(input.plan),
          context_version_id: input.contextVersionId,
          strategy_generation_id: input.strategyGenerationId,
          strategy_checksum: input.strategyChecksum,
          created_by: context.userId,
        },
      );
      const plan = createdPlans[0];
      if (!plan) throw new Error("Strategy PlanVersion 생성 결과가 없습니다");

      const taskIdByKey = new Map(input.plan.tasks.map((task) => [task.key, randomUUID()]));
      const criterionByKey = new Map(input.plan.acceptanceCriteria.map((criterion) => [criterion.key, criterion]));
      const tasks: WorkTask[] = [];
      for (const projected of input.plan.tasks) {
        const dependencyIds = projected.dependencyKeys.map((key) => {
          const taskId = taskIdByKey.get(key);
          if (!taskId) throw new Error(`존재하지 않는 dependency입니다: ${key}`);
          return taskId;
        });
        const criteria = projected.criterionKeys.map((key) => {
          const criterion = criterionByKey.get(key);
          if (!criterion) throw new Error(`존재하지 않는 criterion입니다: ${key}`);
          return criterion;
        });
        const [createdTasks] = await transaction.query<[WorkTask[]]>(
          "CREATE work_task CONTENT { task_id: $task_id, organization_id: $organization_id, work_id: $work_id, plan_version_id: $plan_version_id, task_key: $task_key, title: $title, objective: $objective, acceptance_criteria_json: $acceptance_criteria_json, dependency_ids: $dependency_ids, required_capabilities: $required_capabilities, recommended_agent_handles: $recommended_agent_handles, parallelizable: $parallelizable, status: $status, revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            task_id: taskIdByKey.get(projected.key),
            organization_id: context.organizationId,
            work_id: work.work_id,
            plan_version_id: plan.plan_version_id,
            task_key: projected.key,
            title: projected.title.trim(),
            objective: projected.objective.trim(),
            acceptance_criteria_json: canonicalJson(criteria),
            dependency_ids: dependencyIds,
            required_capabilities: projected.requiredCapabilities,
            recommended_agent_handles: projected.recommendedAgentHandles,
            parallelizable: projected.parallelizable,
            status: dependencyIds.length === 0 ? "ready" : "blocked",
          },
        );
        const task = createdTasks[0];
        if (!task) throw new Error(`Strategy Task 생성 결과가 없습니다: ${projected.key}`);
        tasks.push(task);
      }
      assertAcyclic(tasks);
      if (input.strategyExecutionId) {
        const [executions] = await transaction.query<[{ readonly execution_id: string }[]]>(
          "SELECT execution_id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND execution_id = $execution_id AND agent_handle = 'context-strategy' AND status = 'succeeded' LIMIT 1;",
          {
            organization_id: context.organizationId,
            work_id: work.work_id,
            execution_id: input.strategyExecutionId,
          },
        );
        if (!executions[0]) throw new Error("Strategy 결과의 Runtime Execution을 찾을 수 없습니다");
        const [rooms] = await transaction.query<[CollaborationRoom[]]>(
          "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND title = 'Core Office' AND coordinator_handle = 'representative' LIMIT 1;",
          { organization_id: context.organizationId, work_id: work.work_id },
        );
        const room = rooms[0];
        if (room) {
          if (room.status !== "active") throw new Error("Strategy 결과를 기록할 Core Office 방이 비활성 상태입니다");
          const [participants] = await transaction.query<[CollaborationParticipant[]]>(
            "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = 'agent' AND subject_id = 'context-strategy' AND status = 'active' LIMIT 1;",
            { organization_id: context.organizationId, room_id: room.room_id },
          );
          if (!participants[0]) throw new Error("Strategy 결과 작성자의 활성 participant를 찾을 수 없습니다");
          const [messages] = await transaction.query<[CollaborationMessage[]]>(
            "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id ORDER BY sequence ASC;",
            { organization_id: context.organizationId, work_id: work.work_id, room_id: room.room_id },
          );
          const previous = messages.at(-1);
          if (!previous) throw new Error("Strategy 결과의 원인 Collaboration message를 찾을 수 없습니다");
          if (room.round_count + 1 > room.max_rounds) {
            throw new Error("Strategy 결과가 Collaboration Room round 한도를 초과했습니다");
          }
          const usedTokens = messages.reduce((sum, message) => sum + message.token_count, 0);
          const usedCost = messages.reduce((sum, message) => sum + message.cost_micros, 0);
          if (usedTokens > room.max_tokens)
            throw new Error("Strategy 결과가 Collaboration Room token 한도를 초과했습니다");
          if (usedCost > room.max_cost_micros)
            throw new Error("Strategy 결과가 Collaboration Room cost 한도를 초과했습니다");
          if (room.deadline && Date.now() > datetimeMillis(room.deadline)) {
            throw new Error("Strategy 결과 전에 Collaboration Room deadline이 지났습니다");
          }
          await transaction.query(
            "CREATE collaboration_message CONTENT { message_id: $message_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, sequence: $sequence, message_type: 'answer', author_kind: 'agent', author_id: 'context-strategy', content: $content, reply_to_message_id: $previous_message_id, caused_by_message_id: $previous_message_id, context_version_id: $context_version_id, execution_id: $execution_id, token_count: 0, cost_micros: 0, created_at: time::now() }; UPDATE collaboration_room SET revision = $revision, next_sequence = $next_sequence, round_count = $round_count, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id;",
            {
              message_id: randomUUID(),
              organization_id: context.organizationId,
              work_id: work.work_id,
              room_id: room.room_id,
              sequence: room.next_sequence,
              content: `전략 계획을 확정했습니다. ${String(tasks.length)}개 작업을 실행합니다.`,
              previous_message_id: previous.message_id,
              context_version_id: input.contextVersionId,
              execution_id: input.strategyExecutionId,
              revision: room.revision + 1,
              next_sequence: room.next_sequence + 1,
              round_count: room.round_count + 1,
            },
          );
        }
      }
      await transaction.query(
        "UPDATE work SET status = $status, context_version_id = $context_version_id, active_plan_version_id = $active_plan_version_id, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          status: work.status === "draft" || work.status === "replanning" ? "planned" : work.status,
          context_version_id: input.contextVersionId,
          active_plan_version_id: plan.plan_version_id,
          organization_id: context.organizationId,
          work_id: work.work_id,
        },
      );
      return { plan, tasks, ...(previousPlan ? { previousPlan } : {}) };
    });
  }

  public async addPlan(context: TenantContext, input: AddPlanInput): Promise<AddPlanResult> {
    if (Object.keys(input.content).length === 0) throw new Error("Plan content는 비어 있을 수 없습니다");
    return await this.mutate(context, input, "plan_version_created", async (transaction, work) => {
      const [plans] = await transaction.query<[PlanVersion[]]>(
        "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const version = plans.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
      if (work.active_plan_version_id) {
        await retirePlanExecution(transaction, context.organizationId, work.work_id, work.active_plan_version_id);
      }
      await transaction.query(
        "UPDATE plan_version SET valid = false WHERE organization_id = $organization_id AND work_id = $work_id AND valid = true;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const planVersionId = randomUUID();
      const [created] = await transaction.query<[PlanVersion[]]>(
        "CREATE plan_version CONTENT { plan_version_id: $plan_version_id, organization_id: $organization_id, work_id: $work_id, version: $version, content_json: $content_json, valid: true, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
        {
          plan_version_id: planVersionId,
          organization_id: context.organizationId,
          work_id: work.work_id,
          version,
          content_json: canonicalJson(input.content),
          created_by: context.userId,
        },
      );
      const plan = created[0];
      if (!plan) throw new Error("PlanVersion 생성 결과가 없습니다");
      await transaction.query(
        "UPDATE work SET active_plan_version_id = $active_plan_version_id WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          active_plan_version_id: plan.plan_version_id,
          organization_id: context.organizationId,
          work_id: work.work_id,
        },
      );
      return { plan };
    });
  }

  public async addTask(context: TenantContext, input: AddTaskInput): Promise<WorkCommandResult & { task: WorkTask }> {
    if (!input.title.trim() || !input.objective.trim())
      throw new Error("Task title과 objective는 비어 있을 수 없습니다");
    if (input.acceptanceCriteria.length === 0) throw new Error("Task acceptance criteria가 필요합니다");
    return await this.mutate(context, input, "task_created", async (transaction, work) => {
      if (!work.active_plan_version_id) throw new Error("Task 생성에는 활성 PlanVersion이 필요합니다");
      const existing = await listActiveTasksWith(transaction, context.organizationId, work);
      for (const dependencyId of input.dependencyIds) {
        if (!existing.some((task) => task.task_id === dependencyId)) {
          throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${dependencyId}`);
        }
      }
      const [records] = await transaction.query<[WorkTask[]]>(
        "CREATE work_task CONTENT { task_id: $task_id, organization_id: $organization_id, work_id: $work_id, plan_version_id: $plan_version_id, task_key: $task_key, title: $title, objective: $objective, acceptance_criteria_json: $acceptance_criteria_json, dependency_ids: $dependency_ids, status: $status, revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          task_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          plan_version_id: work.active_plan_version_id,
          task_key: randomUUID(),
          title: input.title.trim(),
          objective: input.objective.trim(),
          acceptance_criteria_json: canonicalJson(input.acceptanceCriteria),
          dependency_ids: input.dependencyIds,
          status: input.dependencyIds.length === 0 ? "ready" : "blocked",
        },
      );
      const task = records[0];
      if (!task) throw new Error("Task 생성 결과가 없습니다");
      assertAcyclic([...existing, task]);
      return { task };
    });
  }

  public async setTaskDependencies(
    context: TenantContext,
    input: SetTaskDependenciesInput,
  ): Promise<WorkCommandResult & { task: WorkTask }> {
    return await this.mutate(context, input, "task_dependencies_changed", async (transaction, work) => {
      const tasks = await listActiveTasksWith(transaction, context.organizationId, work);
      const target = tasks.find((task) => task.task_id === input.taskId);
      if (!target) throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
      for (const dependencyId of input.dependencyIds) {
        if (!tasks.some((task) => task.task_id === dependencyId)) {
          throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${dependencyId}`);
        }
      }
      const planned = tasks.map((task) =>
        task.task_id === input.taskId
          ? {
              ...task,
              dependency_ids: input.dependencyIds,
              status: input.dependencyIds.length === 0 ? ("ready" as const) : ("blocked" as const),
            }
          : task,
      );
      assertAcyclic(planned);
      await transaction.query(
        "UPDATE work_task SET dependency_ids = $dependency_ids, status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
        {
          dependency_ids: input.dependencyIds,
          status: input.dependencyIds.length === 0 ? "ready" : "blocked",
          revision: target.revision + 1,
          organization_id: context.organizationId,
          work_id: work.work_id,
          task_id: input.taskId,
        },
      );
      const updated = (await listActiveTasksWith(transaction, context.organizationId, work)).find(
        (task) => task.task_id === input.taskId,
      );
      if (!updated) throw new Error("변경된 Task를 찾을 수 없습니다");
      return { task: updated };
    });
  }

  public async assignTask(
    context: TenantContext,
    input: AssignTaskInput,
    executor?: QueryExecutor,
  ): Promise<WorkCommandResult & { assignment: TaskAssignment }> {
    if (!this.graph) throw new Error("Organization Graph reader가 필요합니다");
    const assign = async (transaction: QueryExecutor, work: Work) => {
      await this.graph?.verifyActiveNode(context, input.agentHandle, transaction, work.work_id);
      const tasks = await listActiveTasksWith(transaction, context.organizationId, work);
      if (!tasks.some((task) => task.task_id === input.taskId))
        throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND title = 'Core Office' AND coordinator_handle = 'representative' AND status = 'active' LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const room = rooms[0];
      if (room) {
        const [participants] = await transaction.query<[CollaborationParticipant[]]>(
          "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = 'agent' AND subject_id = $subject_id LIMIT 1;",
          {
            organization_id: context.organizationId,
            room_id: room.room_id,
            subject_id: input.agentHandle,
          },
        );
        const participant = participants[0];
        if (participant?.status !== "active") {
          if (participant) {
            await transaction.query(
              "UPDATE collaboration_participant SET role = 'participant', status = 'active', joined_at = time::now() WHERE organization_id = $organization_id AND participant_id = $participant_id;",
              { organization_id: context.organizationId, participant_id: participant.participant_id },
            );
          } else {
            await transaction.query(
              "CREATE collaboration_participant CONTENT { participant_id: $participant_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, kind: 'agent', subject_id: $subject_id, role: 'participant', status: 'active', joined_at: time::now() };",
              {
                participant_id: randomUUID(),
                organization_id: context.organizationId,
                work_id: work.work_id,
                room_id: room.room_id,
                subject_id: input.agentHandle,
              },
            );
          }
          await transaction.query(
            "UPDATE collaboration_room SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id;",
            {
              revision: room.revision + 1,
              organization_id: context.organizationId,
              room_id: room.room_id,
            },
          );
        }
      }
      const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
      const active = assignments.find(
        (assignment) => assignment.task_id === input.taskId && assignment.status === "assigned",
      );
      if (active) {
        await transaction.query(
          "UPDATE task_assignment SET status = 'released', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND assignment_id = $assignment_id;",
          {
            revision: active.revision + 1,
            organization_id: context.organizationId,
            assignment_id: active.assignment_id,
          },
        );
      }
      const [records] = await transaction.query<[TaskAssignment[]]>(
        "CREATE task_assignment CONTENT { assignment_id: $assignment_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, status: 'assigned', revision: 1, supersedes_assignment_id: $supersedes_assignment_id, created_by: $created_by, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          assignment_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          task_id: input.taskId,
          agent_handle: input.agentHandle,
          supersedes_assignment_id: active?.assignment_id,
          created_by: context.userId,
        },
      );
      const assignment = records[0];
      if (!assignment) throw new Error("Assignment 생성 결과가 없습니다");
      return { assignment };
    };
    return await this.mutate(context, input, "task_assigned", assign, executor);
  }

  public async transitionTask(
    context: TenantContext,
    input: TransitionTaskInput,
    executor?: QueryExecutor,
  ): Promise<WorkCommandResult & { task: WorkTask; unblockedTasks: WorkTask[] }> {
    const allowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
      blocked: ["ready", "cancelled"],
      ready: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled"],
      completed: [],
      failed: ["ready", "cancelled"],
      cancelled: [],
    };
    const result = await this.mutate(
      context,
      input,
      "task_state_changed",
      async (transaction, work) => {
        const tasks = await listActiveTasksWith(transaction, context.organizationId, work);
        const target = tasks.find((task) => task.task_id === input.taskId);
        if (!target) throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
        if (target.revision !== input.expectedTaskRevision) {
          throw new Error(`현재 Task revision은 ${String(target.revision)}입니다`);
        }
        const failsBeforeRunning = target.status === "ready" && input.target === "failed";
        if (!allowed[target.status].includes(input.target) && !failsBeforeRunning) {
          throw new Error(`허용되지 않은 Task 상태 전이입니다: ${target.status} -> ${input.target}`);
        }
        if (
          input.target === "ready" &&
          target.dependency_ids.some(
            (dependencyId) => tasks.find((task) => task.task_id === dependencyId)?.status !== "completed",
          )
        ) {
          throw new Error("완료되지 않은 dependency Task가 있습니다");
        }
        if (input.target === "failed" && !canTransitionWork(work.status, "failed")) {
          throw new Error(`Task와 함께 실패시킬 수 없는 Work 상태입니다: ${work.status}`);
        }
        if (failsBeforeRunning) {
          await transaction.query(
            "UPDATE work_task SET status = 'running', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
            {
              revision: target.revision + 1,
              organization_id: context.organizationId,
              work_id: work.work_id,
              task_id: target.task_id,
            },
          );
          const runningTask = { ...target, status: "running" as const, revision: target.revision + 1 };
          await this.appendEvent(
            transaction,
            context,
            work,
            `${input.commandId}:started`,
            "task_state_changed",
            canonicalJson({ ...input, commandId: `${input.commandId}:started`, target: "running" }),
            { from: "ready", to: "running", taskId: target.task_id, reason: "delivery-failure-convergence" },
            { work, task: runningTask, unblockedTasks: [] },
            input.causedByEventId,
          );
        }
        const nextTaskRevision = target.revision + (failsBeforeRunning ? 2 : 1);
        await transaction.query(
          "UPDATE work_task SET status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
          {
            status: input.target,
            revision: nextTaskRevision,
            organization_id: context.organizationId,
            work_id: work.work_id,
            task_id: target.task_id,
          },
        );
        if (input.target === "failed") {
          await transaction.query(
            "UPDATE work SET status = 'failed', updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
            { organization_id: context.organizationId, work_id: work.work_id },
          );
        }
        const unblockedTasks: WorkTask[] = [];
        if (input.target === "completed") {
          const completedIds = new Set(
            tasks
              .filter((task) => task.status === "completed" || task.task_id === target.task_id)
              .map((task) => task.task_id),
          );
          for (const candidate of tasks) {
            if (
              candidate.status === "blocked" &&
              candidate.dependency_ids.every((dependencyId) => completedIds.has(dependencyId))
            ) {
              await transaction.query(
                "UPDATE work_task SET status = 'ready', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
                {
                  revision: candidate.revision + 1,
                  organization_id: context.organizationId,
                  work_id: work.work_id,
                  task_id: candidate.task_id,
                },
              );
              unblockedTasks.push({ ...candidate, status: "ready", revision: candidate.revision + 1 });
            }
          }
        }
        return { task: { ...target, status: input.target, revision: nextTaskRevision }, unblockedTasks };
      },
      executor,
    );
    if (input.target === "failed" && executor === undefined) {
      await this.graph?.releaseTerminalWorkScopedNodes(context, input.workId);
    }
    return result;
  }

  public async listTasks(
    context: TenantContext,
    workId: string,
    executor: QueryExecutor = this.database,
  ): Promise<WorkTask[]> {
    await this.getWork(context, workId, executor);
    return await listTasksWith(executor, context.organizationId, workId);
  }

  public async listAssignments(
    context: TenantContext,
    workId: string,
    executor: QueryExecutor = this.database,
  ): Promise<TaskAssignment[]> {
    await this.getWork(context, workId, executor);
    return await listAssignmentsWith(executor, context.organizationId, workId);
  }

  public async openSession(
    context: TenantContext,
    input: OpenSessionInput,
  ): Promise<WorkCommandResult & { session: WorkSession }> {
    return await this.mutate(context, input, "session_opened", async (transaction, work) => {
      const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
      if (
        !assignments.some(
          (assignment) => assignment.agent_handle === input.agentHandle && assignment.status === "assigned",
        )
      ) {
        throw new Error("Agent의 활성 Assignment가 필요합니다");
      }
      const [existing] = await transaction.query<[WorkSession[]]>(
        "SELECT * OMIT id FROM work_session WHERE organization_id = $organization_id AND work_id = $work_id AND agent_handle = $agent_handle LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, agent_handle: input.agentHandle },
      );
      if (existing[0]) return { session: existing[0] };
      const [records] = await transaction.query<[WorkSession[]]>(
        "CREATE work_session CONTENT { session_id: $session_id, organization_id: $organization_id, work_id: $work_id, agent_handle: $agent_handle, status: 'active', revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          session_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          agent_handle: input.agentHandle,
        },
      );
      const session = records[0];
      if (!session) throw new Error("Session 생성 결과가 없습니다");
      return { session };
    });
  }

  public async saveCheckpoint(
    context: TenantContext,
    input: SaveCheckpointInput,
  ): Promise<WorkCommandResult & { session: WorkSession; checkpoint: SessionCheckpoint }> {
    return await this.mutate(context, input, "checkpoint_saved", async (transaction, work) => {
      const [sessions] = await transaction.query<[WorkSession[]]>(
        "SELECT * OMIT id FROM work_session WHERE organization_id = $organization_id AND work_id = $work_id AND session_id = $session_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, session_id: input.sessionId },
      );
      const session = sessions[0];
      if (!session) throw new Error(`Session을 찾을 수 없습니다: ${input.sessionId}`);
      if (session.revision !== input.expectedSessionRevision) {
        throw new Error(`현재 Session revision은 ${String(session.revision)}입니다`);
      }
      const dataJson = canonicalJson(input.data);
      const version = session.revision;
      const [records] = await transaction.query<[SessionCheckpoint[]]>(
        "CREATE session_checkpoint CONTENT { checkpoint_id: $checkpoint_id, organization_id: $organization_id, work_id: $work_id, session_id: $session_id, version: $version, data_json: $data_json, checksum: $checksum, created_at: time::now() } RETURN AFTER;",
        {
          checkpoint_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          session_id: session.session_id,
          version,
          data_json: dataJson,
          checksum: createHash("sha256").update(dataJson).digest("hex"),
        },
      );
      await transaction.query(
        "UPDATE work_session SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND session_id = $session_id;",
        { revision: session.revision + 1, organization_id: context.organizationId, session_id: session.session_id },
      );
      const checkpoint = records[0];
      if (!checkpoint) throw new Error("Checkpoint 생성 결과가 없습니다");
      return { session: { ...session, revision: session.revision + 1 }, checkpoint };
    });
  }

  public async openRoom(
    context: TenantContext,
    input: OpenRoomInput,
  ): Promise<WorkCommandResult & { room: CollaborationRoom; participants: CollaborationParticipant[] }> {
    if (!this.graph) throw new Error("Organization Graph reader가 필요합니다");
    if (!input.title.trim()) throw new Error("Collaboration Room 제목은 비어 있을 수 없습니다");
    if (
      input.limits.maxParallel < 1 ||
      input.limits.maxTokens < 1 ||
      input.limits.maxCostMicros < 0 ||
      input.limits.maxRounds < 1
    ) {
      throw new Error("Collaboration Room 한계 값이 유효하지 않습니다");
    }
    if (
      !input.participants.some(
        (participant) =>
          participant.kind === "agent" &&
          participant.subjectId === input.coordinatorHandle &&
          participant.role === "coordinator",
      )
    ) {
      throw new Error("coordinator Agent가 참여자에 포함되어야 합니다");
    }
    return await this.mutate(context, input, "collaboration_room_opened", async (transaction, work) => {
      await this.graph?.verifyActiveNode(context, input.coordinatorHandle, transaction, work.work_id);
      for (const participant of input.participants) {
        if (participant.kind === "agent")
          await this.graph?.verifyActiveNode(context, participant.subjectId, transaction, work.work_id);
        else
          await this.organizations.verifyOrganizationMember(participant.subjectId, context.organizationId, transaction);
      }
      const roomId = randomUUID();
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "CREATE collaboration_room CONTENT { room_id: $room_id, organization_id: $organization_id, work_id: $work_id, title: $title, coordinator_handle: $coordinator_handle, status: 'active', revision: 1, next_sequence: 1, max_parallel: $max_parallel, max_tokens: $max_tokens, max_cost_micros: $max_cost_micros, max_rounds: $max_rounds, round_count: 0, deadline: $deadline, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          room_id: roomId,
          organization_id: context.organizationId,
          work_id: work.work_id,
          title: input.title.trim(),
          coordinator_handle: input.coordinatorHandle,
          max_parallel: input.limits.maxParallel,
          max_tokens: input.limits.maxTokens,
          max_cost_micros: input.limits.maxCostMicros,
          max_rounds: input.limits.maxRounds,
          deadline: input.limits.deadline ? new Date(input.limits.deadline) : undefined,
        },
      );
      const participants: CollaborationParticipant[] = [];
      for (const participant of input.participants) {
        const [records] = await transaction.query<[CollaborationParticipant[]]>(
          "CREATE collaboration_participant CONTENT { participant_id: $participant_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, kind: $kind, subject_id: $subject_id, role: $role, status: 'active', joined_at: time::now() } RETURN AFTER;",
          {
            participant_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: work.work_id,
            room_id: roomId,
            kind: participant.kind,
            subject_id: participant.subjectId,
            role: participant.role,
          },
        );
        if (records[0]) participants.push(records[0]);
      }
      const room = rooms[0];
      if (!room || participants.length !== input.participants.length)
        throw new Error("Collaboration Room 생성 결과가 불완전합니다");
      return { room, participants };
    });
  }

  public async postMessage(
    context: TenantContext,
    input: PostMessageInput,
    executor?: QueryExecutor,
  ): Promise<WorkCommandResult & { room: CollaborationRoom; message: CollaborationMessage }> {
    await this.verify(context, executor);
    const content = input.content.trim();
    if (!content) throw new Error("Collaboration message 내용은 비어 있을 수 없습니다");
    if (!COLLABORATION_MESSAGE_TYPES.has(input.messageType)) {
      throw new Error("지원하지 않는 Collaboration message type입니다");
    }
    if (input.authorKind === "user" && input.authorId !== context.userId) {
      throw new Error("다른 사용자를 작성자로 지정할 수 없습니다");
    }
    if (input.recipientAgentId !== undefined && (input.messageType !== "handoff" || input.authorKind !== "agent")) {
      throw new Error("수신 Agent는 Agent가 작성한 handoff 메시지에만 지정할 수 있습니다");
    }
    if (input.recipientAgentId === input.authorId) {
      throw new Error("handoff 작성자와 수신 Agent는 달라야 합니다");
    }
    if (input.tokenCount < 0 || input.costMicros < 0) throw new Error("token과 cost는 음수일 수 없습니다");
    const requestJson = canonicalJson(input);
    const postMessage = async (
      transaction: QueryExecutor,
    ): Promise<WorkCommandResult & { room: CollaborationRoom; message: CollaborationMessage }> => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) {
        return this.replay(repeated, requestJson) as WorkCommandResult & {
          room: CollaborationRoom;
          message: CollaborationMessage;
        };
      }
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (["completed", "cancelled"].includes(work.status)) {
        throw new Error("terminal Work에는 Collaboration message를 추가할 수 없습니다");
      }
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, room_id: input.roomId },
      );
      const room = rooms[0];
      if (!room || room.status !== "active") throw new Error("활성 Collaboration Room을 찾을 수 없습니다");
      const [participants] = await transaction.query<[CollaborationParticipant[]]>(
        "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = $kind AND subject_id = $subject_id AND status = 'active' LIMIT 1;",
        {
          organization_id: context.organizationId,
          room_id: room.room_id,
          kind: input.authorKind,
          subject_id: input.authorId,
        },
      );
      if (!participants[0]) throw new Error("활성 Collaboration participant만 메시지를 작성할 수 있습니다");
      if (input.recipientAgentId !== undefined) {
        const [recipients] = await transaction.query<[CollaborationParticipant[]]>(
          "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = 'agent' AND subject_id = $subject_id AND status = 'active' LIMIT 1;",
          {
            organization_id: context.organizationId,
            room_id: room.room_id,
            subject_id: input.recipientAgentId,
          },
        );
        if (!recipients[0]) throw new Error("같은 Collaboration Room의 활성 수신 Agent를 찾을 수 없습니다");
      }
      const [messages] = await transaction.query<[CollaborationMessage[]]>(
        "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND room_id = $room_id ORDER BY sequence ASC;",
        { organization_id: context.organizationId, room_id: room.room_id },
      );
      for (const referenceId of [input.replyToMessageId, input.causedByMessageId].filter(Boolean)) {
        if (!messages.some((message) => message.message_id === referenceId)) {
          throw new Error(`같은 Room의 원인 message를 찾을 수 없습니다: ${referenceId ?? ""}`);
        }
      }
      const usedTokens = messages.reduce((sum, message) => sum + message.token_count, 0);
      const usedCost = messages.reduce((sum, message) => sum + message.cost_micros, 0);
      if (room.round_count + 1 > room.max_rounds) throw new Error("Collaboration Room round 한도를 초과했습니다");
      if (usedTokens + input.tokenCount > room.max_tokens)
        throw new Error("Collaboration Room token 한도를 초과했습니다");
      if (usedCost + input.costMicros > room.max_cost_micros)
        throw new Error("Collaboration Room cost 한도를 초과했습니다");
      if (room.deadline && Date.now() > datetimeMillis(room.deadline))
        throw new Error("Collaboration Room deadline이 지났습니다");
      const [created] = await transaction.query<[CollaborationMessage[]]>(
        "CREATE collaboration_message CONTENT { message_id: $message_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, sequence: $sequence, message_type: $message_type, author_kind: $author_kind, author_id: $author_id, recipient_agent_id: $recipient_agent_id, content: $content, reply_to_message_id: $reply_to_message_id, caused_by_message_id: $caused_by_message_id, task_id: $task_id, context_version_id: $context_version_id, execution_id: $execution_id, artifact_version_id: $artifact_version_id, token_count: $token_count, cost_micros: $cost_micros, created_at: time::now() } RETURN AFTER;",
        {
          message_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          room_id: room.room_id,
          sequence: room.next_sequence,
          message_type: input.messageType,
          author_kind: input.authorKind,
          author_id: input.authorId,
          recipient_agent_id: input.recipientAgentId,
          content,
          reply_to_message_id: input.replyToMessageId,
          caused_by_message_id: input.causedByMessageId,
          task_id: input.taskId,
          context_version_id: input.contextVersionId,
          execution_id: input.executionId,
          artifact_version_id: input.artifactVersionId,
          token_count: input.tokenCount,
          cost_micros: input.costMicros,
        },
      );
      await transaction.query(
        "UPDATE collaboration_room SET revision = $revision, next_sequence = $next_sequence, round_count = $round_count, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id; UPDATE work SET revision = $work_revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          revision: room.revision + 1,
          next_sequence: room.next_sequence + 1,
          round_count: room.round_count + 1,
          organization_id: context.organizationId,
          room_id: room.room_id,
          work_revision: work.revision + 1,
          work_id: work.work_id,
        },
      );
      const message = created[0];
      const updatedWork = await findWork(transaction, context.organizationId, work.work_id);
      if (!message || !updatedWork) throw new Error("Collaboration message 결과가 불완전합니다");
      const updatedRoom = {
        ...room,
        revision: room.revision + 1,
        next_sequence: room.next_sequence + 1,
        round_count: room.round_count + 1,
      };
      const provisional = { work: updatedWork, room: updatedRoom, message };
      const event = await this.appendEvent(
        transaction,
        context,
        updatedWork,
        input.commandId,
        "collaboration_message_posted",
        requestJson,
        { roomId: room.room_id, messageId: message.message_id },
        provisional,
      );
      const result = { ...provisional, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    };
    return executor ? await postMessage(executor) : await this.database.transaction(postMessage);
  }

  public async joinRoom(
    context: TenantContext,
    input: JoinRoomInput,
  ): Promise<WorkCommandResult & { room: CollaborationRoom; participant: CollaborationParticipant }> {
    if (input.kind === "user" && input.subjectId !== context.userId) {
      throw new Error("다른 사용자를 Collaboration participant로 참여시킬 수 없습니다");
    }
    return await this.mutate(context, input, "collaboration_participant_joined", async (transaction, work) => {
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, room_id: input.roomId },
      );
      const room = rooms[0];
      if (!room || room.status !== "active") throw new Error("활성 Collaboration Room을 찾을 수 없습니다");
      if (room.revision !== input.expectedRoomRevision) {
        throw new Error(`현재 Collaboration Room revision은 ${String(room.revision)}입니다`);
      }
      if (input.kind === "agent") {
        if (!this.graph) throw new Error("Agent 참여에는 Organization Graph reader가 필요합니다");
        await this.graph.verifyActiveNode(context, input.subjectId, transaction, work.work_id);
      } else {
        await this.organizations.verifyOrganizationMember(input.subjectId, context.organizationId, transaction);
      }
      const [existing] = await transaction.query<[CollaborationParticipant[]]>(
        "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = $kind AND subject_id = $subject_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          room_id: room.room_id,
          kind: input.kind,
          subject_id: input.subjectId,
        },
      );
      if (existing[0]?.status === "active") throw new Error("이미 활성 Collaboration participant입니다");
      let participant: CollaborationParticipant;
      if (existing[0]) {
        const [updated] = await transaction.query<[CollaborationParticipant[]]>(
          "UPDATE collaboration_participant SET status = 'active', role = $role, joined_at = time::now() WHERE organization_id = $organization_id AND participant_id = $participant_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            participant_id: existing[0].participant_id,
            role: input.role,
          },
        );
        if (!updated[0]) throw new Error("Collaboration participant 재참여 결과가 없습니다");
        participant = updated[0];
      } else {
        const [created] = await transaction.query<[CollaborationParticipant[]]>(
          "CREATE collaboration_participant CONTENT { participant_id: $participant_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, kind: $kind, subject_id: $subject_id, role: $role, status: 'active', joined_at: time::now() } RETURN AFTER;",
          {
            participant_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: work.work_id,
            room_id: room.room_id,
            kind: input.kind,
            subject_id: input.subjectId,
            role: input.role,
          },
        );
        if (!created[0]) throw new Error("Collaboration participant 참여 결과가 없습니다");
        participant = created[0];
      }
      await transaction.query(
        "UPDATE collaboration_room SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id AND revision = $expected_revision;",
        {
          organization_id: context.organizationId,
          room_id: room.room_id,
          expected_revision: room.revision,
          revision: room.revision + 1,
        },
      );
      return { room: { ...room, revision: room.revision + 1 }, participant };
    });
  }

  public async leaveRoom(
    context: TenantContext,
    input: LeaveRoomInput,
  ): Promise<WorkCommandResult & { room: CollaborationRoom; participant: CollaborationParticipant }> {
    if (input.kind === "user" && input.subjectId !== context.userId) {
      throw new Error("다른 Collaboration participant를 나가게 할 수 없습니다");
    }
    return await this.mutate(context, input, "collaboration_participant_left", async (transaction, work) => {
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, room_id: input.roomId },
      );
      const room = rooms[0];
      if (!room || room.status !== "active") throw new Error("활성 Collaboration Room을 찾을 수 없습니다");
      if (room.revision !== input.expectedRoomRevision) {
        throw new Error(`현재 Collaboration Room revision은 ${String(room.revision)}입니다`);
      }
      const [participants] = await transaction.query<[CollaborationParticipant[]]>(
        "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = $kind AND subject_id = $subject_id AND status = 'active' LIMIT 1;",
        {
          organization_id: context.organizationId,
          room_id: room.room_id,
          kind: input.kind,
          subject_id: input.subjectId,
        },
      );
      const current = participants[0];
      if (!current) throw new Error("활성 Collaboration participant를 찾을 수 없습니다");
      if (current.role === "coordinator") throw new Error("Collaboration Room coordinator는 바로 나갈 수 없습니다");
      const [updated] = await transaction.query<[CollaborationParticipant[]]>(
        "UPDATE collaboration_participant SET status = 'left' WHERE organization_id = $organization_id AND participant_id = $participant_id RETURN AFTER;",
        { organization_id: context.organizationId, participant_id: current.participant_id },
      );
      if (!updated[0]) throw new Error("Collaboration participant 퇴장 결과가 없습니다");
      await transaction.query(
        "UPDATE collaboration_room SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id AND revision = $expected_revision;",
        {
          organization_id: context.organizationId,
          room_id: room.room_id,
          expected_revision: room.revision,
          revision: room.revision + 1,
        },
      );
      return { room: { ...room, revision: room.revision + 1 }, participant: updated[0] };
    });
  }

  public async listMessages(context: TenantContext, workId: string, roomId: string): Promise<CollaborationMessage[]> {
    await this.getWork(context, workId);
    const [messages] = await this.database.query<[CollaborationMessage[]]>(
      "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, work_id: workId, room_id: roomId },
    );
    return messages;
  }

  public async listRooms(context: TenantContext, workId: string): Promise<CollaborationRoom[]> {
    await this.getWork(context, workId);
    const [rooms] = await this.database.query<[CollaborationRoom[]]>(
      "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId, work_id: workId },
    );
    return rooms;
  }

  public async listSharedContexts(
    context: TenantContext,
    workId: string,
    roomId: string,
  ): Promise<SharedContextReference[]> {
    await this.getWork(context, workId);
    const [references] = await this.database.query<[SharedContextReference[]]>(
      "SELECT * OMIT id FROM shared_context_reference WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId, work_id: workId, room_id: roomId },
    );
    return references;
  }

  public async addSharedContext(
    context: TenantContext,
    input: AddSharedContextInput,
  ): Promise<WorkCommandResult & { reference: SharedContextReference }> {
    if (!/^[a-f0-9]{64}$/.test(input.checksum)) throw new Error("Shared Context checksum은 SHA-256이어야 합니다");
    return await this.mutate(context, input, "shared_context_attached", async (transaction, work) => {
      const [rooms] = await transaction.query<[CollaborationRoom[]]>(
        "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, room_id: input.roomId },
      );
      if (!rooms[0]) throw new Error(`Collaboration Room을 찾을 수 없습니다: ${input.roomId}`);
      const [references] = await transaction.query<[SharedContextReference[]]>(
        "CREATE shared_context_reference CONTENT { shared_context_reference_id: $reference_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, source_kind: $source_kind, source_id: $source_id, version_id: $version_id, checksum: $checksum, created_at: time::now() } RETURN AFTER;",
        {
          reference_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          room_id: input.roomId,
          source_kind: input.sourceKind,
          source_id: input.sourceId,
          version_id: input.versionId,
          checksum: input.checksum,
        },
      );
      const reference = references[0];
      if (!reference) throw new Error("Shared Context Reference 생성 결과가 없습니다");
      return { reference };
    });
  }

  public async acquireLease(
    context: TenantContext,
    input: AcquireLeaseInput,
  ): Promise<WorkCommandResult & { lease: ResourceLease }> {
    if (input.ttlMs < 1) throw new Error("lease TTL은 1ms 이상이어야 합니다");
    return await this.mutate(context, input, "resource_lease_acquired", async (transaction, work) => {
      const [leases] = await transaction.query<[ResourceLease[]]>(
        "SELECT * OMIT id FROM resource_lease WHERE organization_id = $organization_id AND work_id = $work_id AND resource_key = $resource_key LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, resource_key: input.resourceKey },
      );
      const existing = leases[0];
      if (existing && existing.status === "active" && datetimeMillis(existing.expires_at) > Date.now()) {
        throw new Error(`resource lease가 이미 활성 상태입니다: ${input.resourceKey}`);
      }
      const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      if (existing) {
        await transaction.query(
          "UPDATE resource_lease SET holder_id = $holder_id, status = 'active', version = $version, expires_at = type::datetime($expires_at), updated_at = time::now() WHERE organization_id = $organization_id AND lease_id = $lease_id;",
          {
            holder_id: input.holderId,
            version: existing.version + 1,
            expires_at: expiresAt,
            organization_id: context.organizationId,
            lease_id: existing.lease_id,
          },
        );
        return {
          lease: {
            ...existing,
            holder_id: input.holderId,
            status: "active",
            version: existing.version + 1,
            expires_at: expiresAt,
          },
        };
      }
      const [created] = await transaction.query<[ResourceLease[]]>(
        "CREATE resource_lease CONTENT { lease_id: $lease_id, organization_id: $organization_id, work_id: $work_id, resource_key: $resource_key, holder_id: $holder_id, status: 'active', version: 1, expires_at: type::datetime($expires_at), created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          lease_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          resource_key: input.resourceKey,
          holder_id: input.holderId,
          expires_at: expiresAt,
        },
      );
      const lease = created[0];
      if (!lease) throw new Error("Resource lease 생성 결과가 없습니다");
      return { lease };
    });
  }

  public async releaseLease(
    context: TenantContext,
    input: ChangeLeaseInput,
  ): Promise<WorkCommandResult & { lease: ResourceLease }> {
    return await this.mutate(context, input, "resource_lease_released", async (transaction, work) => {
      const [leases] = await transaction.query<[ResourceLease[]]>(
        "SELECT * OMIT id FROM resource_lease WHERE organization_id = $organization_id AND work_id = $work_id AND resource_key = $resource_key LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, resource_key: input.resourceKey },
      );
      const lease = leases[0];
      if (!lease || lease.status !== "active" || lease.holder_id !== input.holderId)
        throw new Error("holder의 활성 resource lease가 없습니다");
      if (lease.version !== input.expectedLeaseVersion)
        throw new Error(`현재 lease version은 ${String(lease.version)}입니다`);
      await transaction.query(
        "UPDATE resource_lease SET status = 'released', version = $version, updated_at = time::now() WHERE organization_id = $organization_id AND lease_id = $lease_id;",
        { version: lease.version + 1, organization_id: context.organizationId, lease_id: lease.lease_id },
      );
      return { lease: { ...lease, status: "released", version: lease.version + 1 } };
    });
  }

  public async renewLease(
    context: TenantContext,
    input: ChangeLeaseInput & { readonly ttlMs: number },
  ): Promise<WorkCommandResult & { lease: ResourceLease }> {
    if (input.ttlMs < 1) throw new Error("lease TTL은 1ms 이상이어야 합니다");
    return await this.mutate(context, input, "resource_lease_renewed", async (transaction, work) => {
      const [leases] = await transaction.query<[ResourceLease[]]>(
        "SELECT * OMIT id FROM resource_lease WHERE organization_id = $organization_id AND work_id = $work_id AND resource_key = $resource_key LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, resource_key: input.resourceKey },
      );
      const lease = leases[0];
      if (!lease || lease.status !== "active" || lease.holder_id !== input.holderId) {
        throw new Error("holder의 활성 resource lease가 없습니다");
      }
      if (lease.version !== input.expectedLeaseVersion) {
        throw new Error(`현재 lease version은 ${String(lease.version)}입니다`);
      }
      const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      await transaction.query(
        "UPDATE resource_lease SET version = $version, expires_at = type::datetime($expires_at), updated_at = time::now() WHERE organization_id = $organization_id AND lease_id = $lease_id;",
        {
          version: lease.version + 1,
          expires_at: expiresAt,
          organization_id: context.organizationId,
          lease_id: lease.lease_id,
        },
      );
      return { lease: { ...lease, version: lease.version + 1, expires_at: expiresAt } };
    });
  }

  public async forkWork(
    context: TenantContext,
    input: ForkWorkInput,
  ): Promise<WorkCommandResult & { childRequest: WorkRequest; childWork: Work; childEvent: WorkEvent }> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("자식 Work objective는 비어 있을 수 없습니다");
    return await this.mutate(context, input, "work_forked", async (transaction, parent) => {
      const autonomy = this.autonomy ? await this.autonomy(context, transaction) : undefined;
      const requestId = randomUUID();
      const childWorkId = randomUUID();
      const [requests] = await transaction.query<[WorkRequest[]]>(
        "CREATE work_request CONTENT { request_id: $request_id, organization_id: $organization_id, requester_user_id: $requester_user_id, text: $text, surface: 'fork', created_at: time::now() } RETURN AFTER;",
        {
          request_id: requestId,
          organization_id: context.organizationId,
          requester_user_id: context.userId,
          text: objective,
        },
      );
      const [works] = await transaction.query<[Work[]]>(
        "CREATE work CONTENT { work_id: $work_id, organization_id: $organization_id, request_id: $request_id, parent_work_id: $parent_work_id, project_id: $project_id, workspace_id: $workspace_id, status: 'draft', revision: 1, organization_version_id: $organization_version_id, context_version_id: $context_version_id, policy_version_id: $policy_version_id, prompt_version_id: $prompt_version_id, prompt_schema_version: $prompt_schema_version, autonomy_mode: $autonomy_mode, autonomy_revision: $autonomy_revision, artifact_version_ids: $artifact_version_ids, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          work_id: childWorkId,
          organization_id: context.organizationId,
          request_id: requestId,
          parent_work_id: parent.work_id,
          project_id: parent.project_id,
          workspace_id: parent.workspace_id,
          organization_version_id: parent.organization_version_id,
          context_version_id: parent.context_version_id,
          policy_version_id: parent.policy_version_id,
          prompt_version_id: parent.prompt_version_id,
          prompt_schema_version: parent.prompt_schema_version,
          autonomy_mode: autonomy?.mode,
          autonomy_revision: autonomy?.revision,
          artifact_version_ids: parent.artifact_version_ids,
        },
      );
      const childRequest = requests[0];
      const childWork = works[0];
      if (!childRequest || !childWork) throw new Error("자식 Work 생성 결과가 불완전합니다");
      const childCommandId = randomUUID();
      const childProvisional = { request: childRequest, work: childWork };
      const childEvent = await this.appendEvent(
        transaction,
        context,
        childWork,
        childCommandId,
        "work_created_from_fork",
        canonicalJson({ parentWorkId: parent.work_id, objective }),
        { parentWorkId: parent.work_id },
        childProvisional,
      );
      const childResult = { ...childProvisional, event: childEvent };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(childResult),
        event_id: childEvent.event_id,
      });
      return { childRequest, childWork, childEvent };
    });
  }

  public async createArtifactVersion(
    context: TenantContext,
    input: CreateArtifactVersionInput,
  ): Promise<WorkCommandResult & { artifact: WorkArtifact; artifactVersion: ArtifactVersion }> {
    if (Boolean(input.creatorAgentHandle) !== Boolean(input.creatorExecutionId)) {
      throw new Error("ArtifactVersion creator Agent handle과 Runtime Execution ID는 함께 필요합니다");
    }
    if (input.creatorTaskId && (!input.creatorAgentHandle || !input.creatorExecutionId)) {
      throw new Error("ArtifactVersion creator Task ID에는 Agent handle과 Runtime Execution ID가 함께 필요합니다");
    }
    if (!input.kind.trim() || !input.name.trim() || !input.mediaType.trim())
      throw new Error("Artifact kind, name과 media type이 필요합니다");
    return await this.mutate(context, input, "artifact_version_created", async (transaction, work) => {
      if (input.creatorAgentHandle && input.creatorExecutionId) {
        const [executions] = await transaction.query<[{ execution_id: string }[]]>(
          input.creatorTaskId
            ? "SELECT execution_id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id AND execution_id = $execution_id AND agent_handle = $agent_handle AND status = 'succeeded' LIMIT 1;"
            : "SELECT execution_id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND execution_id = $execution_id AND agent_handle = $agent_handle AND status = 'succeeded' LIMIT 1;",
          {
            organization_id: context.organizationId,
            work_id: work.work_id,
            task_id: input.creatorTaskId,
            execution_id: input.creatorExecutionId,
            agent_handle: input.creatorAgentHandle,
          },
        );
        if (!executions[0]) throw new Error("ArtifactVersion creator Runtime Execution을 찾을 수 없습니다");
        if (input.creatorTaskId) {
          const [assignments] = await transaction.query<[{ readonly assignment_id: string }[]]>(
            "SELECT assignment_id FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id AND agent_handle = $agent_handle AND status = 'assigned' LIMIT 1;",
            {
              organization_id: context.organizationId,
              work_id: work.work_id,
              task_id: input.creatorTaskId,
              agent_handle: input.creatorAgentHandle,
            },
          );
          if (!assignments[0]) {
            throw new Error("ArtifactVersion creator Agent가 현재 Task assignment와 일치하지 않습니다");
          }
        }
      }
      let artifact: WorkArtifact | undefined;
      if (input.artifactId) {
        const [artifacts] = await transaction.query<[WorkArtifact[]]>(
          "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_id = $artifact_id LIMIT 1;",
          { organization_id: context.organizationId, work_id: work.work_id, artifact_id: input.artifactId },
        );
        artifact = artifacts[0];
        if (!artifact) throw new Error(`같은 Work의 Artifact를 찾을 수 없습니다: ${input.artifactId}`);
      } else {
        const [artifacts] = await transaction.query<[WorkArtifact[]]>(
          "CREATE work_artifact CONTENT { artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, kind: $kind, name: $name, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
          {
            artifact_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: work.work_id,
            kind: input.kind.trim(),
            name: input.name.trim(),
            created_by: context.userId,
          },
        );
        artifact = artifacts[0];
      }
      if (!artifact) throw new Error("Artifact 생성 결과가 없습니다");
      const [versions] = await transaction.query<[ArtifactVersion[]]>(
        "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND artifact_id = $artifact_id;",
        { organization_id: context.organizationId, artifact_id: artifact.artifact_id },
      );
      const version = versions.reduce((maximum, candidate) => Math.max(maximum, candidate.version), 0) + 1;
      const contentJson = canonicalJson(input.content);
      const [created] = await transaction.query<[ArtifactVersion[]]>(
        input.creatorAgentHandle && input.creatorExecutionId
          ? "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: $version, checksum: $checksum, media_type: $media_type, content_json: $content_json, created_by: $created_by, creator_agent_handle: $creator_agent_handle, creator_execution_id: $creator_execution_id, created_at: time::now() } RETURN AFTER;"
          : "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: $version, checksum: $checksum, media_type: $media_type, content_json: $content_json, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
        {
          artifact_version_id: randomUUID(),
          artifact_id: artifact.artifact_id,
          organization_id: context.organizationId,
          work_id: work.work_id,
          version,
          checksum: createHash("sha256").update(contentJson).digest("hex"),
          media_type: input.mediaType.trim(),
          content_json: contentJson,
          created_by: context.userId,
          ...(input.creatorAgentHandle && input.creatorExecutionId
            ? {
                creator_agent_handle: input.creatorAgentHandle,
                creator_execution_id: input.creatorExecutionId,
              }
            : {}),
        },
      );
      const artifactVersion = created[0];
      if (!artifactVersion) throw new Error("ArtifactVersion 생성 결과가 없습니다");
      if (
        input.creatorTaskId &&
        input.creatorAgentHandle &&
        input.creatorExecutionId &&
        !input.suppressEvidenceMessage
      ) {
        const [tasks] = await transaction.query<[WorkTask[]]>(
          "SELECT * OMIT id FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id AND status = 'running' LIMIT 1;",
          {
            organization_id: context.organizationId,
            work_id: work.work_id,
            task_id: input.creatorTaskId,
          },
        );
        if (!tasks[0]) throw new Error("ArtifactVersion creator Task가 실행 상태가 아닙니다");
        const [rooms] = await transaction.query<[CollaborationRoom[]]>(
          "SELECT * OMIT id FROM collaboration_room WHERE organization_id = $organization_id AND work_id = $work_id AND title = 'Core Office' AND coordinator_handle = 'representative' LIMIT 1;",
          { organization_id: context.organizationId, work_id: work.work_id },
        );
        const room = rooms[0];
        if (!room || room.status !== "active") throw new Error("Delivery 결과를 기록할 활성 Core Office 방이 없습니다");
        const [participants] = await transaction.query<[CollaborationParticipant[]]>(
          "SELECT * OMIT id FROM collaboration_participant WHERE organization_id = $organization_id AND room_id = $room_id AND kind = 'agent' AND subject_id = $agent_handle AND status = 'active' LIMIT 1;",
          {
            organization_id: context.organizationId,
            room_id: room.room_id,
            agent_handle: input.creatorAgentHandle,
          },
        );
        if (!participants[0]) throw new Error("Delivery 결과 작성자의 활성 participant를 찾을 수 없습니다");
        const [messages] = await transaction.query<[CollaborationMessage[]]>(
          "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND room_id = $room_id ORDER BY sequence ASC;",
          { organization_id: context.organizationId, work_id: work.work_id, room_id: room.room_id },
        );
        const previous = messages.at(-1);
        if (!previous) throw new Error("Delivery 결과의 원인 Collaboration message를 찾을 수 없습니다");
        if (room.round_count + 1 > room.max_rounds) {
          throw new Error("Delivery 결과가 Collaboration Room round 한도를 초과했습니다");
        }
        const usedTokens = messages.reduce((sum, message) => sum + message.token_count, 0);
        const usedCost = messages.reduce((sum, message) => sum + message.cost_micros, 0);
        if (usedTokens > room.max_tokens)
          throw new Error("Delivery 결과가 Collaboration Room token 한도를 초과했습니다");
        if (usedCost > room.max_cost_micros)
          throw new Error("Delivery 결과가 Collaboration Room cost 한도를 초과했습니다");
        if (room.deadline && Date.now() > datetimeMillis(room.deadline)) {
          throw new Error("Delivery 결과 전에 Collaboration Room deadline이 지났습니다");
        }
        await transaction.query(
          "CREATE collaboration_message CONTENT { message_id: $message_id, organization_id: $organization_id, work_id: $work_id, room_id: $room_id, sequence: $sequence, message_type: 'evidence', author_kind: 'agent', author_id: $author_id, content: '작업 결과를 산출물로 기록했습니다.', reply_to_message_id: $previous_message_id, caused_by_message_id: $previous_message_id, task_id: $task_id, execution_id: $execution_id, artifact_version_id: $artifact_version_id, token_count: 0, cost_micros: 0, created_at: time::now() }; UPDATE collaboration_room SET revision = $revision, next_sequence = $next_sequence, round_count = $round_count, updated_at = time::now() WHERE organization_id = $organization_id AND room_id = $room_id;",
          {
            message_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: work.work_id,
            room_id: room.room_id,
            sequence: room.next_sequence,
            author_id: input.creatorAgentHandle,
            previous_message_id: previous.message_id,
            task_id: input.creatorTaskId,
            execution_id: input.creatorExecutionId,
            artifact_version_id: artifactVersion.artifact_version_id,
            revision: room.revision + 1,
            next_sequence: room.next_sequence + 1,
            round_count: room.round_count + 1,
          },
        );
      }
      const references = [...new Set([...work.artifact_version_ids, artifactVersion.artifact_version_id])];
      await transaction.query(
        "UPDATE work SET artifact_version_ids = $artifact_version_ids WHERE organization_id = $organization_id AND work_id = $work_id;",
        { artifact_version_ids: references, organization_id: context.organizationId, work_id: work.work_id },
      );
      return { artifact, artifactVersion };
    });
  }

  public async finalizeRecord(
    context: TenantContext,
    input: FinalizeRecordInput,
  ): Promise<WorkCommandResult & { record: WorkRecord }> {
    const summary = input.summary.trim();
    if (!summary) throw new Error("WorkRecord summary는 비어 있을 수 없습니다");
    return await this.mutate(context, input, "work_record_finalized", async (transaction, work) => {
      const [databaseInfo] = await transaction.query<[{ tables: Readonly<Record<string, unknown>> }]>("INFO FOR DB;");
      const recordsRuns =
        "records_run" in databaseInfo.tables
          ? (
              await transaction.query<[{ records_run_id: string }[]]>(
                "SELECT records_run_id FROM records_run WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
                { organization_id: context.organizationId, work_id: work.work_id },
              )
            )[0]
          : [];
      if (work.records_schema_version === "massion.work.records.v1" || recordsRuns.length !== 0) {
        throw new Error("Phase 13 WorkRecord는 Records projection으로만 생성할 수 있습니다");
      }
      const [existing] = await transaction.query<[WorkRecord[]]>(
        "SELECT * OMIT id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY version ASC;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const version = existing.reduce((maximum, record) => Math.max(maximum, record.version), 0) + 1;
      const events = await listEventsWith(transaction, context.organizationId, work.work_id);
      const [decisions] = await transaction.query<[CollaborationMessage[]]>(
        "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'decision' ORDER BY sequence ASC;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const [verifications] = await transaction.query<[WorkVerification[]]>(
        "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const [records] = await transaction.query<[WorkRecord[]]>(
        "CREATE work_record CONTENT { work_record_id: $record_id, organization_id: $organization_id, work_id: $work_id, version: $version, recorded_work_revision: $recorded_work_revision, summary: $summary, event_start_sequence: $start_sequence, event_end_sequence: $end_sequence, decision_message_ids: $decision_ids, artifact_version_ids: $artifact_ids, verification_ids: $verification_ids, finalized: true, finalized_by: $finalized_by, finalized_at: time::now() } RETURN AFTER;",
        {
          record_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          version,
          recorded_work_revision: work.revision + 1,
          summary,
          start_sequence: events[0]?.sequence ?? 1,
          end_sequence: (events.at(-1)?.sequence ?? 0) + 1,
          decision_ids: decisions.map((message) => message.message_id),
          artifact_ids: work.artifact_version_ids,
          verification_ids: verifications.map((verification) => verification.verification_id),
          finalized_by: context.userId,
        },
      );
      const record = records[0];
      if (!record) throw new Error("WorkRecord 생성 결과가 없습니다");
      return { record };
    });
  }

  public async planMerge(
    context: TenantContext,
    input: PlanMergeInput,
  ): Promise<WorkCommandResult & { mergePlan: WorkMergePlan }> {
    return await this.mutate(context, input, "work_merge_planned", async (transaction, parent) => {
      const child = await findWork(transaction, context.organizationId, input.childWorkId);
      if (!child || child.parent_work_id !== parent.work_id) throw new Error("직접 자식 Work만 merge할 수 있습니다");
      const versionIds = [...new Set([...parent.artifact_version_ids, ...child.artifact_version_ids])];
      const [versions] = await transaction.query<[ArtifactVersion[]]>(
        "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND artifact_version_id IN $version_ids;",
        { organization_id: context.organizationId, version_ids: versionIds },
      );
      const [artifacts] = await transaction.query<[WorkArtifact[]]>(
        "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      );
      const artifactById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
      const parentByName = new Map<string, ArtifactVersion>();
      for (const version of versions.filter((candidate) =>
        parent.artifact_version_ids.includes(candidate.artifact_version_id),
      )) {
        const name = artifactById.get(version.artifact_id)?.name;
        const current = name ? parentByName.get(name) : undefined;
        if (name && (!current || version.version > current.version)) parentByName.set(name, version);
      }
      const conflicts: { name: string; parentChecksum: string; childChecksum: string }[] = [];
      for (const version of versions.filter((candidate) =>
        child.artifact_version_ids.includes(candidate.artifact_version_id),
      )) {
        const name = artifactById.get(version.artifact_id)?.name;
        const parentVersion = name ? parentByName.get(name) : undefined;
        if (name && parentVersion && parentVersion.checksum !== version.checksum) {
          conflicts.push({ name, parentChecksum: parentVersion.checksum, childChecksum: version.checksum });
        }
      }
      const [decisions] = await transaction.query<[CollaborationMessage[]]>(
        "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'decision';",
        { organization_id: context.organizationId, work_id: child.work_id },
      );
      const [verifications] = await transaction.query<[WorkVerification[]]>(
        "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: child.work_id },
      );
      const childOnlyArtifacts = child.artifact_version_ids.filter((id) => !parent.artifact_version_ids.includes(id));
      const [plans] = await transaction.query<[WorkMergePlan[]]>(
        "CREATE work_merge_plan CONTENT { merge_plan_id: $merge_plan_id, organization_id: $organization_id, parent_work_id: $parent_work_id, child_work_id: $child_work_id, parent_revision: $parent_revision, status: $status, conflict_json: $conflict_json, artifact_version_ids: $artifact_ids, decision_message_ids: $decision_ids, verification_ids: $verification_ids, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
        {
          merge_plan_id: randomUUID(),
          organization_id: context.organizationId,
          parent_work_id: parent.work_id,
          child_work_id: child.work_id,
          parent_revision: parent.revision + 1,
          status: conflicts.length === 0 ? "ready" : "conflicted",
          conflict_json: canonicalJson(conflicts),
          artifact_ids: childOnlyArtifacts,
          decision_ids: decisions.map((message) => message.message_id),
          verification_ids: verifications.map((verification) => verification.verification_id),
          created_by: context.userId,
        },
      );
      const mergePlan = plans[0];
      if (!mergePlan) throw new Error("Work MergePlan 생성 결과가 없습니다");
      return { mergePlan };
    });
  }

  public async applyMerge(
    context: TenantContext,
    input: ApplyMergeInput,
  ): Promise<WorkCommandResult & { mergePlan: WorkMergePlan; mergedArtifactVersions: ArtifactVersion[] }> {
    return await this.mutate(context, input, "work_merge_applied", async (transaction, parent) => {
      const [plans] = await transaction.query<[WorkMergePlan[]]>(
        "SELECT * OMIT id FROM work_merge_plan WHERE organization_id = $organization_id AND parent_work_id = $work_id AND merge_plan_id = $merge_plan_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: parent.work_id, merge_plan_id: input.mergePlanId },
      );
      const plan = plans[0];
      if (!plan) throw new Error(`Work MergePlan을 찾을 수 없습니다: ${input.mergePlanId}`);
      if (plan.status !== "ready") throw new Error("충돌이 없고 ready 상태인 MergePlan만 적용할 수 있습니다");
      if (plan.parent_revision !== parent.revision)
        throw new Error("MergePlan 생성 후 부모 Work가 변경되어 다시 계획해야 합니다");
      const [sourceVersions] = await transaction.query<[ArtifactVersion[]]>(
        "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND artifact_version_id IN $version_ids;",
        { organization_id: context.organizationId, version_ids: plan.artifact_version_ids },
      );
      const mergedArtifactVersions: ArtifactVersion[] = [];
      for (const sourceVersion of sourceVersions) {
        const [sourceArtifacts] = await transaction.query<[WorkArtifact[]]>(
          "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id AND artifact_id = $artifact_id LIMIT 1;",
          { organization_id: context.organizationId, artifact_id: sourceVersion.artifact_id },
        );
        const sourceArtifact = sourceArtifacts[0];
        if (!sourceArtifact) throw new Error(`병합 원본 Artifact를 찾을 수 없습니다: ${sourceVersion.artifact_id}`);
        const [parentArtifacts] = await transaction.query<[WorkArtifact[]]>(
          "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id AND name = $name LIMIT 1;",
          { organization_id: context.organizationId, work_id: parent.work_id, name: sourceArtifact.name },
        );
        let parentArtifact = parentArtifacts[0];
        if (!parentArtifact) {
          const [createdArtifacts] = await transaction.query<[WorkArtifact[]]>(
            "CREATE work_artifact CONTENT { artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, kind: $kind, name: $name, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
            {
              artifact_id: randomUUID(),
              organization_id: context.organizationId,
              work_id: parent.work_id,
              kind: sourceArtifact.kind,
              name: sourceArtifact.name,
              created_by: context.userId,
            },
          );
          parentArtifact = createdArtifacts[0];
        }
        if (!parentArtifact) throw new Error("부모 Artifact 생성 결과가 없습니다");
        const [existingVersions] = await transaction.query<[ArtifactVersion[]]>(
          "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND artifact_id = $artifact_id;",
          { organization_id: context.organizationId, artifact_id: parentArtifact.artifact_id },
        );
        const version = existingVersions.reduce((maximum, candidate) => Math.max(maximum, candidate.version), 0) + 1;
        const [createdVersions] = await transaction.query<[ArtifactVersion[]]>(
          "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: $version, checksum: $checksum, media_type: $media_type, content_json: $content_json, source_artifact_version_id: $source_id, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
          {
            artifact_version_id: randomUUID(),
            artifact_id: parentArtifact.artifact_id,
            organization_id: context.organizationId,
            work_id: parent.work_id,
            version,
            checksum: sourceVersion.checksum,
            media_type: sourceVersion.media_type,
            content_json: sourceVersion.content_json,
            source_id: sourceVersion.artifact_version_id,
            created_by: context.userId,
          },
        );
        if (!createdVersions[0]) throw new Error("병합 ArtifactVersion 생성 결과가 없습니다");
        mergedArtifactVersions.push(createdVersions[0]);
      }
      const references = [
        ...new Set([
          ...parent.artifact_version_ids,
          ...mergedArtifactVersions.map((version) => version.artifact_version_id),
        ]),
      ];
      await transaction.query(
        "UPDATE work SET artifact_version_ids = $artifact_ids WHERE organization_id = $organization_id AND work_id = $work_id; UPDATE work_merge_plan SET status = 'applied', applied_at = time::now() WHERE organization_id = $organization_id AND merge_plan_id = $merge_plan_id;",
        {
          artifact_ids: references,
          organization_id: context.organizationId,
          work_id: parent.work_id,
          merge_plan_id: plan.merge_plan_id,
        },
      );
      return { mergePlan: { ...plan, status: "applied" }, mergedArtifactVersions };
    });
  }

  public async auditWork(context: TenantContext, workId: string): Promise<WorkComplianceFinding[]> {
    const work = await this.getWork(context, workId);
    const events = await listEventsWith(this.database, context.organizationId, workId);
    const tasks = await listActiveTasksWith(this.database, context.organizationId, work);
    const assignments = await listAssignmentsWith(this.database, context.organizationId, workId);
    const findings: WorkComplianceFinding[] = [];
    if (work.revision !== events.length) {
      findings.push({
        code: "revision",
        message: `Work revision ${String(work.revision)}과 Event 수 ${String(events.length)}가 다릅니다`,
      });
    }
    if (events.some((event, index) => event.sequence !== index + 1)) {
      findings.push({ code: "event-sequence", message: "WorkEvent sequence가 연속적이지 않습니다" });
    }
    const planRequired = !["draft", "cancelled"].includes(work.status);
    if (planRequired) {
      const [plans] = await this.database.query<[PlanVersion[]]>(
        "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY version ASC;",
        { organization_id: context.organizationId, work_id: workId },
      );
      const validPlans = plans.filter((plan) => plan.valid);
      if (validPlans.length !== 1) {
        findings.push({ code: "plan", message: "현재 Work 상태의 유효한 PlanVersion 수가 1이 아닙니다" });
      } else if (work.active_plan_version_id && validPlans[0]?.plan_version_id !== work.active_plan_version_id) {
        findings.push({ code: "plan", message: "활성 PlanVersion 참조와 유효한 PlanVersion이 다릅니다" });
      }
    }
    try {
      assertAcyclic(tasks);
    } catch (error) {
      findings.push({
        code: "task-dag",
        message: error instanceof Error ? error.message : "Task DAG가 유효하지 않습니다",
      });
    }
    if (["ready", "running", "waiting_approval", "verifying", "completed"].includes(work.status)) {
      if (tasks.length === 0) findings.push({ code: "task-dag", message: "실행 상태 Work에 Task가 없습니다" });
      for (const task of tasks.filter((candidate) => candidate.status !== "cancelled")) {
        const active = assignments.filter(
          (assignment) => assignment.task_id === task.task_id && assignment.status === "assigned",
        );
        if (active.length !== 1) {
          findings.push({ code: "assignment", message: `Task의 활성 Assignment 수가 1이 아닙니다: ${task.task_id}` });
        }
      }
    }
    if (
      ["verifying", "completed"].includes(work.status) &&
      tasks.some((task) => !["completed", "cancelled"].includes(task.status))
    ) {
      findings.push({ code: "task-completion", message: "검증 상태 Work에 완료되지 않은 Task가 있습니다" });
    }
    if (work.status === "completed") {
      const [verifications] = await this.database.query<[WorkVerification[]]>(
        "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
        { organization_id: context.organizationId, work_id: workId },
      );
      const [records] = await this.database.query<[WorkRecord[]]>(
        "SELECT * OMIT id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND finalized = true ORDER BY version ASC;",
        { organization_id: context.organizationId, work_id: workId },
      );
      if (!verifications.at(-1)?.passed)
        findings.push({ code: "verification", message: "완료 Work의 최신 Verification이 통과 상태가 아닙니다" });
      if (records.at(-1)?.recorded_work_revision !== work.revision - 1) {
        findings.push({ code: "record", message: "완료 Work의 최신 revision에 대응하는 확정 WorkRecord가 없습니다" });
      }
    }
    return findings.sort((left, right) =>
      `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`),
    );
  }

  public async recoverWork(context: TenantContext, workId: string): Promise<WorkRecoveryBundle> {
    const work = await this.getWork(context, workId);
    const findings = await this.auditWork(context, workId);
    if (findings.length > 0) throw new Error(`Work 복구 전 준수 위반을 해결해야 합니다: ${canonicalJson(findings)}`);
    const [requests] = await this.database.query<[WorkRequest[]]>(
      "SELECT * OMIT id FROM work_request WHERE organization_id = $organization_id AND request_id = $request_id LIMIT 1;",
      { organization_id: context.organizationId, request_id: work.request_id },
    );
    const request = requests[0];
    if (!request) throw new Error(`Work Request를 찾을 수 없습니다: ${work.request_id}`);
    const query = async <RecordType>(table: string): Promise<RecordType[]> => {
      const [records] = await this.database.query<[RecordType[]]>(
        `SELECT * OMIT id FROM ${table} WHERE organization_id = $organization_id AND work_id = $work_id;`,
        { organization_id: context.organizationId, work_id: workId },
      );
      return records;
    };
    const [children] = await this.database.query<[Work[]]>(
      "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND parent_work_id = $work_id;",
      { organization_id: context.organizationId, work_id: workId },
    );
    return {
      request,
      work,
      childWorks: children,
      events: await listEventsWith(this.database, context.organizationId, workId),
      plans: await query<PlanVersion>("plan_version"),
      tasks: await listTasksWith(this.database, context.organizationId, workId),
      assignments: await listAssignmentsWith(this.database, context.organizationId, workId),
      sessions: await query<WorkSession>("work_session"),
      checkpoints: await query<SessionCheckpoint>("session_checkpoint"),
      rooms: await query<CollaborationRoom>("collaboration_room"),
      messages: await query<CollaborationMessage>("collaboration_message"),
      sharedContextReferences: await query<SharedContextReference>("shared_context_reference"),
      leases: await query<ResourceLease>("resource_lease"),
      artifacts: await query<WorkArtifact>("work_artifact"),
      artifactVersions: await query<ArtifactVersion>("artifact_version"),
      verifications: await query<WorkVerification>("work_verification"),
      records: await query<WorkRecord>("work_record"),
    };
  }

  public async transition(
    context: TenantContext,
    input: TransitionInput,
    executor?: QueryExecutor,
  ): Promise<WorkCommandResult> {
    const result = await this.mutate(
      context,
      input,
      "work_state_changed",
      async (transaction, work) => {
        if (!canTransitionWork(work.status, input.target)) {
          throw new Error(`허용되지 않은 Work 상태 전이입니다: ${work.status} -> ${input.target}`);
        }
        if (input.target === "planned") {
          const [plans] = await transaction.query<[PlanVersion[]]>(
            "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY version ASC;",
            { organization_id: context.organizationId, work_id: work.work_id },
          );
          const activePlan = plans.find(
            (plan) =>
              plan.valid && (!work.active_plan_version_id || plan.plan_version_id === work.active_plan_version_id),
          );
          if (!activePlan) throw new Error("planned 전이에는 유효한 PlanVersion이 필요합니다");
        }
        if (input.target === "ready") {
          const tasks = await listActiveTasksWith(transaction, context.organizationId, work);
          assertAcyclic(tasks);
          if (tasks.length === 0) throw new Error("ready 전이에는 Task DAG가 필요합니다");
          const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
          if (
            tasks
              .filter((task) => task.status !== "cancelled")
              .some(
                (task) =>
                  !assignments.some(
                    (assignment) => assignment.task_id === task.task_id && assignment.status === "assigned",
                  ),
              )
          ) {
            throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
          }
          if (!this.graph) throw new Error("ready 전이에는 Organization Graph reader가 필요합니다");
          for (const assignment of assignments.filter((candidate) => candidate.status === "assigned")) {
            await this.graph.verifyActiveNode(context, assignment.agent_handle, transaction, work.work_id);
          }
        }
        if (input.target === "verifying") {
          const tasks = await listActiveTasksWith(transaction, context.organizationId, work);
          if (tasks.length === 0 || tasks.some((task) => !["completed", "cancelled"].includes(task.status))) {
            throw new Error("verifying 전이에는 모든 실행 Task의 완료가 필요합니다");
          }
        }
        if (input.target === "completed") {
          const [verifications] = await transaction.query<[WorkVerification[]]>(
            "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
            { organization_id: context.organizationId, work_id: work.work_id },
          );
          const [records] = await transaction.query<[WorkRecord[]]>(
            "SELECT * OMIT id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND finalized = true ORDER BY version ASC;",
            { organization_id: context.organizationId, work_id: work.work_id },
          );
          const latestVerification = verifications.at(-1);
          if (
            !latestVerification?.passed ||
            latestVerification.projected_work_revision + 1 !== work.revision ||
            records.at(-1)?.recorded_work_revision !== work.revision
          ) {
            throw new Error("completed 전이에는 통과 Verification과 확정 WorkRecord가 필요합니다");
          }
        }
        await transaction.query(
          "UPDATE work SET status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
          {
            status: input.target,
            revision: work.revision + 1,
            organization_id: context.organizationId,
            work_id: work.work_id,
          },
        );
        return {};
      },
      executor,
    );
    if (["completed", "failed", "cancelled"].includes(input.target) && executor === undefined) {
      await this.graph?.releaseTerminalWorkScopedNodes(context, input.workId);
    }
    return result;
  }

  public async authorizeRunningAction(
    context: TenantContext,
    input: AuthorizeRunningActionInput,
  ): Promise<AuthorizeRunningActionResult> {
    if (!this.governance) throw new Error("Work Governance Gate가 구성되지 않았습니다");
    const work = await this.getWork(context, input.workId);
    if (work.revision !== input.expectedRevision)
      throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
    const governedRevision = input.governedRevision ?? work.revision;
    const governedAction = {
      commandId: input.commandId,
      action: input.action,
      resource: { type: "Work", id: work.work_id, revision: governedRevision },
      environment: input.environment,
      riskClass: input.riskClass,
      external: input.external,
      executionId: `work-action:${work.work_id}:${input.commandId}`,
    } as const;
    if (input.approvalId) {
      const approvalId = input.approvalId;
      return await this.mutate(context, input, "work_state_changed", async (transaction, current) => {
        if (current.status !== "waiting_approval")
          throw new Error("waiting_approval Work만 승인 후 재개할 수 있습니다");
        const authorization = await this.governance?.authorize(context, { ...governedAction, approvalId }, transaction);
        if (!authorization) throw new Error("Work Governance Gate가 구성되지 않았습니다");
        await transaction.query(
          "UPDATE work SET status = 'running', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
          {
            revision: current.revision + 1,
            organization_id: context.organizationId,
            work_id: current.work_id,
          },
        );
        return { outcome: "allowed" as const, authorization };
      });
    }
    let authorization: GovernanceAuthorization;
    try {
      authorization = await this.governance.authorize(context, governedAction);
    } catch (error) {
      if (!(error instanceof GovernanceApprovalRequiredError)) throw error;
      if (work.status !== "running") throw new Error("running Work만 승인 대기로 전이할 수 있습니다", { cause: error });
      const waiting = await this.transition(context, {
        commandId: `${input.commandId}:waiting-approval`,
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "waiting_approval",
      });
      return {
        outcome: "waiting_approval",
        work: waiting.work,
        event: waiting.event,
        decisionId: error.decisionId,
        approvalId: error.approvalId,
      };
    }
    if (work.status !== "running") throw new Error("승인 없는 실행 허가는 running Work에서만 사용할 수 있습니다");
    return { outcome: "allowed", work, authorization };
  }

  public async reconcileRunningActionApproval(
    context: TenantContext,
    input: ReconcileRunningActionApprovalInput,
  ): Promise<WorkCommandResult> {
    if (!this.governance) throw new Error("Work Governance Gate가 구성되지 않았습니다");
    const status = await this.governance.getApprovalStatus(context, input.approvalId);
    if (!["rejected", "expired", "cancelled"].includes(status)) {
      throw new Error(`종료된 거절 승인만 Work 취소로 조정할 수 있습니다: ${status}`);
    }
    return await this.transition(context, { ...input, target: "cancelled" });
  }

  private async mutate<Extra extends object>(
    context: TenantContext,
    input: WorkCommandInput,
    eventType: string,
    operation: (transaction: QueryExecutor, work: Work) => Promise<Extra>,
    executor?: QueryExecutor,
  ): Promise<WorkCommandResult & Extra> {
    await this.verify(context, executor);
    const requestJson = canonicalJson(input);
    const mutate = async (transaction: QueryExecutor): Promise<WorkCommandResult & Extra> => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) return this.replay(repeated, requestJson) as WorkCommandResult & Extra;
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (
        ["completed", "cancelled"].includes(work.status) &&
        !(work.status === "cancelled" && eventType === "work_record_finalized")
      ) {
        throw new Error("terminal Work는 변경할 수 없습니다");
      }
      if (work.revision !== input.expectedRevision)
        throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
      const extra = await operation(transaction, work);
      // 아래 revision 계산과 appendEvent가 같은 목록을 씁니다. event 행은 payload·result JSON을
      // 통째로 실어 무거우므로, 한 transaction에서 두 번 읽으면 Work가 자랄수록 O(N²)가 됩니다.
      let appended: readonly WorkEvent[] | undefined;
      if (eventType !== "work_state_changed") {
        // revision은 호출자의 산술이 아니라 원장에서 파생합니다. operation이 추가 event를 남기는
        // 경로(ready→failed 수렴)가 있고, work.revision + 1로 고정하면 auditWork가 강제하는
        // revision == events.length가 깨집니다. auditWork는 recoverWork 안에서 fail-closed라
        // 그 순간 Records·Assurance 단계가 통째로 멈춥니다. 아래 +1은 곧 append할 이 event의 몫입니다.
        appended = await listEventsWith(transaction, context.organizationId, work.work_id);
        await transaction.query(
          "UPDATE work SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
          { revision: appended.length + 1, organization_id: context.organizationId, work_id: work.work_id },
        );
      }
      const updated = await findWork(transaction, context.organizationId, work.work_id);
      if (!updated) throw new Error("변경된 Work를 찾을 수 없습니다");
      const provisional = { work: updated, ...extra };
      const event = await this.appendEvent(
        transaction,
        context,
        updated,
        input.commandId,
        eventType,
        requestJson,
        extra,
        provisional,
        input.causedByEventId,
        appended,
      );
      const result = { ...provisional, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    };
    return executor ? await mutate(executor) : await this.database.transaction(mutate);
  }

  private replay(event: WorkEvent, requestJson: string): unknown {
    if (event.request_json !== requestJson) throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
    return JSON.parse(event.result_json) as unknown;
  }

  private async appendEvent(
    executor: QueryExecutor,
    context: TenantContext,
    work: Work,
    commandId: string,
    eventType: string,
    requestJson: string,
    payload: unknown,
    result: unknown,
    causedByEventId?: string,
    /** 호출자가 이미 읽었으면 그것을 씁니다. event 행은 payload·result JSON을 통째로 실어 무겁습니다. */
    knownEvents?: readonly WorkEvent[],
  ): Promise<WorkEvent> {
    const existing = knownEvents ?? (await listEventsWith(executor, context.organizationId, work.work_id));
    const sequence = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    if (causedByEventId && !existing.some((event) => event.event_id === causedByEventId)) {
      throw new Error(`원인 WorkEvent를 찾을 수 없습니다: ${causedByEventId}`);
    }
    const [events] = await executor.query<[WorkEvent[]]>(
      "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, caused_by_event_id: $caused_by_event_id, request_json: $request_json, payload_json: $payload_json, result_json: $result_json, created_at: time::now() } RETURN AFTER;",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        work_id: work.work_id,
        sequence,
        command_id: commandId,
        event_type: eventType,
        actor_user_id: context.userId,
        caused_by_event_id: causedByEventId,
        request_json: requestJson,
        payload_json: JSON.stringify(payload),
        result_json: JSON.stringify(result),
      },
    );
    const event = events[0];
    if (!event) throw new Error("WorkEvent 생성 결과가 없습니다");
    return event;
  }
}
