import {
  decodeApprovalDisplayPreview,
  normalizeApprovalDisplayPreview,
  type ApprovalDisplayPreview,
} from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import type {
  ApplicationAppliedStaffingProposalSource,
  ApplicationApprovalSource,
  ApplicationArtifactSource,
  ApplicationAssignmentSource,
  ApplicationDirectiveSource,
  ApplicationExecutionSource,
  ApplicationExtensionSource,
  ApplicationMessageSource,
  ApplicationOrganizationSource,
  ApplicationReadModel,
  ApplicationRoomSource,
  ApplicationSharedContextSource,
  ApplicationStaffingProposalNodeSource,
  ApplicationRecordSource,
  ApplicationSourceWatermarks,
  ApplicationTaskSource,
  ApplicationVerificationSource,
  ApplicationWorkSource,
} from "../read-model.js";

interface OrganizationVersionRecord {
  readonly version: number;
}

interface OrganizationNodeRecord {
  readonly node_id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: readonly string[];
  readonly parent_handle?: string;
  readonly builtin?: boolean;
  readonly status: string;
  readonly role: string;
  readonly scope: string;
  readonly work_id?: string;
}

interface WorkRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly request_id: string;
  readonly status: string;
  readonly revision: number;
  readonly artifact_version_ids: readonly string[];
  readonly workspace_id?: string;
  readonly autonomy_mode?: "automatic" | "review" | "full-access";
  readonly autonomy_revision?: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface WorkRequestRecord {
  readonly request_id: string;
  readonly text: string;
}

interface TaskRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptance_criteria_json: string;
  readonly dependency_ids: readonly string[];
  readonly required_capabilities?: readonly string[];
  readonly recommended_agent_handles?: readonly string[];
  readonly parallelizable?: boolean;
  readonly status: string;
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface AssignmentRecord {
  readonly assignment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ExecutionRecord {
  readonly organization_id: string;
  readonly execution_id: string;
  readonly work_id: string;
  readonly task_id?: string;
  readonly agent_handle: string;
  readonly model_route: string;
  readonly status: string;
  readonly autonomy_mode?: "automatic" | "review" | "full-access";
  readonly autonomy_revision?: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface UsageRecord {
  readonly execution_id?: string;
  readonly token_count: number;
  readonly cost_micros: number;
}

interface RoomRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly title: string;
  readonly status: string;
  readonly next_sequence: number;
  readonly created_at: unknown;
  readonly coordinator_handle?: string;
  readonly round_count?: number;
  readonly max_rounds?: number;
  readonly max_tokens?: number;
  readonly max_cost_micros?: number;
}

interface SharedContextRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly shared_context_reference_id: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly version_id: string;
  readonly checksum: string;
}

interface ParticipantRecord {
  readonly participant_id: string;
  readonly room_id: string;
  readonly subject_id: string;
  readonly kind: string;
  readonly status: string;
  readonly joined_at: unknown;
}

interface MessageRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly message_id: string;
  readonly sequence: number;
  readonly message_type: string;
  readonly author_kind: string;
  readonly author_id: string;
  readonly recipient_agent_id?: string;
  readonly content: string;
  readonly created_at: unknown;
  readonly token_count?: number;
  readonly cost_micros?: number;
  readonly reply_to_message_id?: string;
  readonly caused_by_message_id?: string;
  readonly task_id?: string;
  readonly context_version_id?: string;
  readonly execution_id?: string;
  readonly artifact_version_id?: string;
}

interface StaffingProposalRecord {
  readonly proposal_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly core_office_room_id: string;
  readonly status: string;
  readonly approval_id?: string;
  readonly nodes_json: string;
  readonly impact_json?: string;
  readonly expected_organization_version: number;
  readonly applied_organization_version?: number;
  readonly message_id: string;
}

interface ApprovalLineageRecord {
  readonly organization_id: string;
  readonly approval_id: string;
  readonly work_id?: string;
  readonly status: string;
}

interface MembershipDisplayRecord {
  readonly user_id: string;
}

interface UserDisplayRecord {
  readonly user_id: string;
  readonly display_name: string;
}

interface NodeDisplayRecord {
  readonly handle: string;
  readonly name: string;
  readonly scope: string;
  readonly work_id?: string;
}

interface ExecutionLineageRecord {
  readonly execution_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
}

interface RouteAttemptLineageRecord {
  readonly execution_id: string;
  readonly model_profile_id: string;
}

interface ModelProfileLineageRecord {
  readonly model_profile_id: string;
  readonly provider_id: string;
  readonly model_id: string;
}

interface WorkRecordProjection {
  readonly organization_id: string;
  readonly work_id: string;
  readonly work_record_id: string;
  readonly version: number;
  readonly summary: string;
  readonly artifact_version_ids: readonly string[];
  readonly verification_ids: readonly string[];
  readonly finalized_at: unknown;
}

interface ApprovalRecord {
  readonly organization_id: string;
  readonly approval_id: string;
  readonly decision_id: string;
  readonly request_hash: string;
  readonly policy_version_id: string;
  readonly status: string;
  readonly requester_user_id: string;
  readonly work_id?: string;
  readonly execution_id?: string;
  readonly resource_revision?: number;
  readonly resume_target?: string;
  readonly display_preview_json?: string;
  readonly revision: number;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ApprovalDecisionRecord {
  readonly decision_id: string;
  readonly policy_version_id?: string;
  readonly request_hash: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly resource_revision?: number;
}

interface DynamicStaffingApprovalRecord {
  readonly organization_id: string;
  readonly approval_id?: string;
  readonly work_id: string;
  readonly status: string;
  readonly ux_metadata_json: string;
}

interface WorkArtifactRecord {
  readonly artifact_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly kind: string;
  readonly name: string;
}

interface ArtifactVersionRecord {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly version: number;
  readonly checksum: string;
  readonly media_type: string;
  readonly source_artifact_version_id?: string;
  readonly created_by: string;
  readonly creator_agent_handle?: string;
  readonly creator_execution_id?: string;
  readonly created_at: unknown;
}

interface VerificationRecord {
  readonly verification_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly verifier_id: string;
  readonly passed: boolean;
  readonly criteria_json: string;
  readonly evidence_artifact_version_ids: readonly string[];
  readonly assurance_run_id?: string;
  readonly target_work_revision?: number;
  readonly projected_work_revision?: number;
  readonly profile_id?: string;
  readonly profile_version?: string;
  readonly binding_version_id?: string;
  readonly created_at: unknown;
}

interface DirectiveRecord {
  readonly directive_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly content: string;
  readonly mode: "now" | "next-stage";
  readonly submitted_stage: string;
  readonly status: string;
  readonly revision: number;
  readonly failure_reason?: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ExtensionInstallationRecord {
  readonly organization_id: string;
  readonly installation_id: string;
  readonly package_name: string;
  readonly state: string;
  readonly active_version_id?: string;
}

interface ExtensionVersionRecord {
  readonly version_id: string;
  readonly package_version: string;
  readonly manifest_json: string;
}

function scalar(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return 0;
}

function iso(value: unknown): string {
  const serialized =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string" || typeof value === "number"
        ? value
        : value && typeof value === "object" && "toISOString" in value
          ? String((value as { toISOString(): unknown }).toISOString())
          : undefined;
  if (serialized === undefined) throw new Error("datetime 값이 유효하지 않습니다");
  const date = new Date(serialized);
  if (Number.isNaN(date.getTime())) throw new Error("datetime 값이 유효하지 않습니다");
  return date.toISOString();
}

function contributionIds(manifestJson: string): readonly string[] {
  try {
    const manifest = JSON.parse(manifestJson) as {
      contributions?: Readonly<Record<string, unknown>>;
    };
    const result: string[] = [];
    for (const [kind, candidates] of Object.entries(manifest.contributions ?? {})) {
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string") {
          result.push(`${kind}:${(candidate as { id: string }).id}`);
        }
      }
    }
    return result.sort();
  } catch {
    throw new Error("Extension manifest contribution을 해석할 수 없습니다");
  }
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} JSON을 해석할 수 없습니다`);
  }
}

function staffingApprovalPreview(
  approval: ApprovalRecord,
  decision: ApprovalDecisionRecord,
  candidates: readonly DynamicStaffingApprovalRecord[],
): ApprovalDisplayPreview | undefined {
  if (
    candidates.length !== 1 ||
    decision.action !== "organization.change" ||
    decision.resource_type !== "Organization" ||
    decision.resource_id !== approval.organization_id ||
    decision.resource_revision !== approval.resource_revision ||
    approval.work_id === undefined
  )
    return undefined;
  const proposal = candidates[0];
  if (
    !proposal ||
    proposal.organization_id !== approval.organization_id ||
    proposal.work_id !== approval.work_id ||
    (proposal.status !== "awaiting-approval" && proposal.status !== "applied")
  )
    return undefined;
  try {
    const metadata = json(proposal.ux_metadata_json, "Dynamic Staffing UX metadata");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const value = metadata as Record<string, unknown>;
    if (
      Object.keys(value).sort().join("\0") !==
        ["assignments", "kind", "proposedAgentCount", "strategyGenerationId", "taskCount", "title", "workId"].join(
          "\0",
        ) ||
      value.kind !== "dynamic-staffing-proposal" ||
      value.title !== "동적 Staffing 제안" ||
      value.workId !== proposal.work_id ||
      typeof value.strategyGenerationId !== "string" ||
      value.strategyGenerationId.length === 0 ||
      !Number.isSafeInteger(value.taskCount) ||
      Number(value.taskCount) < 1 ||
      !Number.isSafeInteger(value.proposedAgentCount) ||
      Number(value.proposedAgentCount) < 1 ||
      Number(value.proposedAgentCount) > Number(value.taskCount) ||
      !Array.isArray(value.assignments) ||
      value.assignments.length !== value.taskCount
    )
      return undefined;
    const assignments = value.assignments as readonly unknown[];
    if (
      assignments.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          Object.keys(item).sort().join("\0") !== "agentHandle\0source\0taskKey" ||
          typeof (item as Record<string, unknown>).taskKey !== "string" ||
          String((item as Record<string, unknown>).taskKey).trim().length === 0 ||
          typeof (item as Record<string, unknown>).agentHandle !== "string" ||
          String((item as Record<string, unknown>).agentHandle).trim().length === 0 ||
          !["recommendation", "proposal"].includes(String((item as Record<string, unknown>).source)),
      )
    )
      return undefined;
    const taskKeys = assignments.map((item) => (item as { readonly taskKey: string }).taskKey.trim());
    const proposedAgentHandles = assignments.flatMap((item) => {
      const assignment = item as { readonly agentHandle: string; readonly source: string };
      return assignment.source === "proposal" ? [assignment.agentHandle.trim()] : [];
    });
    if (
      new Set(taskKeys).size !== assignments.length ||
      proposedAgentHandles.length !== value.proposedAgentCount ||
      new Set(proposedAgentHandles).size !== value.proposedAgentCount
    )
      return undefined;
    return normalizeApprovalDisplayPreview({
      kind: "provider",
      title: value.title,
      reason: `전문 Agent ${String(value.proposedAgentCount)}명을 추가하고 ${String(value.taskCount)}개 Task의 담당을 정하는 조직 변경입니다.`,
    });
  } catch {
    return undefined;
  }
}

function taskAcceptanceCriteria(value: string, label: string): readonly string[] {
  const parsed = json(value, label);
  if (!Array.isArray(parsed)) throw new Error(`${label}가 배열이 아닙니다`);
  return parsed.map((item) => {
    if (typeof item === "string") return item;
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { statement?: unknown }).statement === "string"
    ) {
      return (item as { statement: string }).statement;
    }
    throw new Error(`${label} 항목이 string 또는 criterion이 아닙니다`);
  });
}

function displayTitle(requestText: string): string {
  const line = requestText
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) throw new Error("Work request 제목을 만들 수 없습니다");
  return Array.from(line.replace(/\s+/gu, " ")).slice(0, 160).join("");
}

function organizationNodeScope(scope: string): "persistent" | "work" {
  if (scope !== "persistent" && scope !== "work") throw new Error("Organization node scope가 유효하지 않습니다");
  return scope;
}

function appliedStaffingProposal(
  message: MessageRecord,
  proposals: readonly StaffingProposalRecord[],
  approvals: readonly ApprovalLineageRecord[],
): ApplicationAppliedStaffingProposalSource | undefined {
  if (
    message.message_type !== "proposal" ||
    message.author_kind !== "agent" ||
    message.author_id !== "context-strategy" ||
    proposals.length !== 1
  )
    return undefined;
  const [proposal] = proposals;
  const toVersion = proposal?.applied_organization_version;
  if (
    !proposal ||
    proposal.organization_id !== message.organization_id ||
    proposal.work_id !== message.work_id ||
    proposal.core_office_room_id !== message.room_id ||
    proposal.message_id !== message.message_id ||
    proposal.status !== "applied" ||
    typeof proposal.proposal_id !== "string" ||
    proposal.proposal_id.length === 0 ||
    !Number.isSafeInteger(proposal.expected_organization_version) ||
    proposal.expected_organization_version < 1 ||
    !Number.isSafeInteger(toVersion) ||
    toVersion === undefined ||
    toVersion <= proposal.expected_organization_version
  )
    return undefined;
  if (
    proposal.approval_id !== undefined &&
    approvals.filter(
      (approval) =>
        approval.organization_id === message.organization_id &&
        approval.approval_id === proposal.approval_id &&
        approval.work_id === message.work_id &&
        approval.status === "consumed",
    ).length !== 1
  )
    return undefined;

  try {
    const rawNodes = JSON.parse(proposal.nodes_json) as unknown;
    const rawImpact = JSON.parse(proposal.impact_json ?? "") as unknown;
    if (
      !Array.isArray(rawNodes) ||
      rawNodes.length === 0 ||
      !rawImpact ||
      typeof rawImpact !== "object" ||
      Array.isArray(rawImpact)
    ) {
      return undefined;
    }
    const impact = rawImpact as Record<string, unknown>;
    if (
      !Array.isArray(impact.nodeHandles) ||
      !impact.nodeHandles.every((handle) => typeof handle === "string" && handle.length > 0) ||
      !Array.isArray(impact.references)
    )
      return undefined;
    const nodes = rawNodes.map((item): ApplicationStaffingProposalNodeSource => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid proposal item");
      const proposalNode = item as Record<string, unknown>;
      const candidate = proposalNode.node;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("invalid proposal node");
      }
      const node = candidate as Record<string, unknown>;
      const { capabilities, handle, name, parentHandle, role, scope, workId } = node;
      if (
        typeof proposalNode.taskKey !== "string" ||
        proposalNode.taskKey.length === 0 ||
        typeof proposalNode.taskId !== "string" ||
        proposalNode.taskId.length === 0 ||
        proposalNode.agentHandle !== handle ||
        typeof handle !== "string" ||
        handle.length === 0 ||
        typeof name !== "string" ||
        name.length === 0 ||
        scope !== "work" ||
        workId !== message.work_id ||
        typeof parentHandle !== "string" ||
        parentHandle.length === 0 ||
        (role !== "orchestrator" && role !== "coordinator" && role !== "operator") ||
        !Array.isArray(capabilities) ||
        !capabilities.every((capability) => typeof capability === "string" && capability.length > 0)
      )
        throw new Error("invalid proposal node");
      return {
        handle,
        name,
        scope: "work" as const,
        workId,
        parentHandle,
        role,
        capabilities,
      };
    });
    if (new Set(nodes.map((node) => node.handle)).size !== nodes.length) return undefined;
    return {
      proposalId: proposal.proposal_id,
      status: "applied",
      ...(proposal.approval_id === undefined ? {} : { approvalId: proposal.approval_id }),
      nodes,
      impactNodeHandles: impact.nodeHandles as string[],
      impactReferenceCount: impact.references.length,
      fromOrganizationVersion: proposal.expected_organization_version,
      toOrganizationVersion: toVersion,
    };
  } catch {
    return undefined;
  }
}

export class SurrealApplicationReadModel implements ApplicationReadModel {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async watermarks(context: TenantContext): Promise<ApplicationSourceWatermarks> {
    await this.organizations.verifyTenantContext(context);
    const queries = [
      "SELECT version AS watermark FROM organization_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM work WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM runtime_execution WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT created_at AS watermark FROM collaboration_message WHERE organization_id = $organization_id ORDER BY created_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM governance_approval WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM extension_installation WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
    ];
    const values = await Promise.all(
      queries.map(async (query) => {
        const [records] = await this.database.query<[Array<{ watermark?: unknown }>]>(query, {
          organization_id: context.organizationId,
        });
        return scalar(records[0]?.watermark);
      }),
    );
    return {
      organization: values[0] ?? 0,
      work: values[1] ?? 0,
      runtime: values[2] ?? 0,
      collaboration: values[3] ?? 0,
      governance: values[4] ?? 0,
      extension: values[5] ?? 0,
    };
  }

  public async organization(context: TenantContext): Promise<ApplicationOrganizationSource> {
    await this.organizations.verifyTenantContext(context);
    const [versions] = await this.database.query<[OrganizationVersionRecord[]]>(
      "SELECT version FROM organization_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
      { organization_id: context.organizationId },
    );
    if (!versions[0]) throw new Error("Application snapshot OrganizationVersion을 찾을 수 없습니다");
    const [nodes] = await this.database.query<[OrganizationNodeRecord[]]>(
      "SELECT node_id, handle, name, responsibility, capabilities, parent_handle, status, role, scope, work_id, builtin FROM organization_node WHERE organization_id = $organization_id AND (scope != 'work' OR status = 'active') ORDER BY handle ASC;",
      { organization_id: context.organizationId },
    );
    return {
      organizationId: context.organizationId,
      version: versions[0].version,
      nodes: nodes.map((node) => ({
        nodeId: node.node_id,
        handle: node.handle,
        name: node.name,
        responsibility: node.responsibility,
        capabilities: node.capabilities,
        ...(node.parent_handle === undefined ? {} : { parentHandle: node.parent_handle }),
        builtin: node.builtin === true,
        status: node.status,
        role: node.role,
        scope: organizationNodeScope(node.scope),
        ...(node.work_id === undefined ? {} : { workId: node.work_id }),
      })),
    };
  }

  public async works(context: TenantContext): Promise<readonly ApplicationWorkSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[WorkRecord[]]>(
      "SELECT organization_id, work_id, request_id, status, revision, artifact_version_ids, workspace_id, autonomy_mode, autonomy_revision, created_at, updated_at FROM work WHERE organization_id = $organization_id ORDER BY updated_at DESC, work_id ASC;",
      { organization_id: context.organizationId },
    );
    const [requests] = await this.database.query<[WorkRequestRecord[]]>(
      "SELECT request_id, text FROM work_request WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const requestsById = new Map(requests.map((request) => [request.request_id, request]));
    return records.map((record) => {
      const request = requestsById.get(record.request_id);
      if (!request) throw new Error(`Work Request를 찾을 수 없습니다: ${record.request_id}`);
      return {
        organizationId: record.organization_id,
        workId: record.work_id,
        title: displayTitle(request.text),
        status: record.status,
        revision: record.revision,
        artifactIds: record.artifact_version_ids,
        ...(record.workspace_id === undefined ? {} : { workspaceId: record.workspace_id }),
        ...(record.autonomy_mode === undefined ? {} : { autonomyMode: record.autonomy_mode }),
        ...(record.autonomy_revision === undefined ? {} : { autonomyRevision: record.autonomy_revision }),
        createdAt: iso(record.created_at),
        updatedAt: iso(record.updated_at),
      };
    });
  }

  public async tasks(context: TenantContext): Promise<readonly ApplicationTaskSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[TaskRecord[]]>(
      "SELECT organization_id, work_id, task_id, title, objective, acceptance_criteria_json, dependency_ids, required_capabilities, recommended_agent_handles, parallelizable, status, revision, created_at, updated_at FROM work_task WHERE organization_id = $organization_id ORDER BY created_at ASC, task_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      taskId: record.task_id,
      title: record.title,
      objective: record.objective,
      acceptanceCriteria: taskAcceptanceCriteria(record.acceptance_criteria_json, "Task acceptance criteria"),
      dependencyIds: record.dependency_ids,
      ...(record.required_capabilities === undefined ? {} : { requiredCapabilities: record.required_capabilities }),
      ...(record.recommended_agent_handles === undefined
        ? {}
        : { recommendedAgentHandles: record.recommended_agent_handles }),
      ...(record.parallelizable === undefined ? {} : { parallelizable: record.parallelizable }),
      status: record.status,
      revision: record.revision,
      createdAt: iso(record.created_at),
      updatedAt: iso(record.updated_at),
    }));
  }

  public async assignments(context: TenantContext): Promise<readonly ApplicationAssignmentSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[AssignmentRecord[]]>(
      "SELECT organization_id, work_id, task_id, agent_handle, status, revision, created_at, updated_at, assignment_id FROM task_assignment WHERE organization_id = $organization_id ORDER BY created_at ASC, assignment_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      assignmentId: record.assignment_id,
      workId: record.work_id,
      taskId: record.task_id,
      agentHandle: record.agent_handle,
      status: record.status,
      revision: record.revision,
      createdAt: iso(record.created_at),
      updatedAt: iso(record.updated_at),
    }));
  }

  public async executions(context: TenantContext): Promise<readonly ApplicationExecutionSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records, usages, attempts, profiles] = await this.database.query<
      [ExecutionRecord[], UsageRecord[], RouteAttemptLineageRecord[], ModelProfileLineageRecord[]]
    >(
      `SELECT organization_id, execution_id, work_id, task_id, agent_handle, model_route, status, autonomy_mode, autonomy_revision, created_at, updated_at FROM runtime_execution WHERE organization_id = $organization_id ORDER BY created_at ASC, execution_id ASC;
       SELECT execution_id, token_count, cost_micros FROM collaboration_message WHERE organization_id = $organization_id AND execution_id != NONE;
       SELECT execution_id, model_profile_id FROM route_attempt WHERE organization_id = $organization_id AND execution_id != NONE;
       SELECT model_profile_id, provider_id, model_id FROM model_profile WHERE organization_id = $organization_id;`,
      { organization_id: context.organizationId },
    );
    const usageByExecution = new Map<string, { inputTokens: number; costMicros: number }>();
    for (const usage of usages) {
      if (usage.execution_id === undefined) continue;
      const total = usageByExecution.get(usage.execution_id) ?? { inputTokens: 0, costMicros: 0 };
      total.inputTokens += usage.token_count;
      total.costMicros += usage.cost_micros;
      usageByExecution.set(usage.execution_id, total);
    }
    const attemptsByExecution = new Map<string, RouteAttemptLineageRecord[]>();
    for (const attempt of attempts) {
      const linked = attemptsByExecution.get(attempt.execution_id) ?? [];
      linked.push(attempt);
      attemptsByExecution.set(attempt.execution_id, linked);
    }
    const profilesById = new Map(profiles.map((profile) => [profile.model_profile_id, profile]));
    return records.map((record) => {
      const usage = usageByExecution.get(record.execution_id);
      const linkedAttempts = attemptsByExecution.get(record.execution_id) ?? [];
      const linkedProfiles = linkedAttempts.map((attempt) => profilesById.get(attempt.model_profile_id));
      const actualModels = new Map(
        linkedProfiles
          .filter((profile): profile is ModelProfileLineageRecord => profile !== undefined)
          .map((profile) => [`${profile.provider_id}\0${profile.model_id}`, profile]),
      );
      const actualModel =
        linkedAttempts.length > 0 && linkedProfiles.every((profile) => profile !== undefined) && actualModels.size === 1
          ? actualModels.values().next().value
          : undefined;
      return {
        organizationId: record.organization_id,
        executionId: record.execution_id,
        workId: record.work_id,
        ...(record.task_id === undefined ? {} : { taskId: record.task_id }),
        agentHandle: record.agent_handle,
        modelRoute: record.model_route,
        ...(actualModel === undefined ? {} : { providerId: actualModel.provider_id, modelId: actualModel.model_id }),
        status: record.status,
        ...(record.autonomy_mode === undefined ? {} : { autonomyMode: record.autonomy_mode }),
        ...(record.autonomy_revision === undefined ? {} : { autonomyRevision: record.autonomy_revision }),
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: 0,
        costMicros: usage?.costMicros ?? 0,
        createdAt: iso(record.created_at),
        updatedAt: iso(record.updated_at),
      };
    });
  }

  public async rooms(context: TenantContext): Promise<readonly ApplicationRoomSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [rooms] = await this.database.query<[RoomRecord[]]>(
      "SELECT organization_id, work_id, room_id, title, status, next_sequence, created_at, coordinator_handle, round_count, max_rounds, max_tokens, max_cost_micros FROM collaboration_room WHERE organization_id = $organization_id ORDER BY created_at ASC, room_id ASC;",
      { organization_id: context.organizationId },
    );
    const [participants] = await this.database.query<[ParticipantRecord[]]>(
      "SELECT participant_id, room_id, subject_id, kind, status, joined_at FROM collaboration_participant WHERE organization_id = $organization_id ORDER BY joined_at ASC, participant_id ASC;",
      { organization_id: context.organizationId },
    );
    return rooms.map((room) => {
      const roomParticipants = participants
        .filter((participant) => participant.room_id === room.room_id && participant.status === "active")
        .map((participant) => ({
          subjectId: participant.subject_id,
          kind: participant.kind === "user" ? ("user" as const) : ("agent" as const),
        }));
      return {
        organizationId: room.organization_id,
        workId: room.work_id,
        roomId: room.room_id,
        name: room.title,
        kind: "work",
        status: room.status,
        ...(room.coordinator_handle === undefined ? {} : { coordinatorHandle: room.coordinator_handle }),
        ...(room.round_count === undefined ? {} : { roundCount: room.round_count }),
        ...(room.max_rounds === undefined ? {} : { maxRounds: room.max_rounds }),
        ...(room.max_tokens === undefined ? {} : { maxTokens: room.max_tokens }),
        ...(room.max_cost_micros === undefined ? {} : { maxCostMicros: room.max_cost_micros }),
        participantIds: roomParticipants.map((participant) => participant.subjectId),
        participants: roomParticipants,
        lastMessageSequence: Math.max(0, room.next_sequence - 1),
      };
    });
  }

  public async messages(context: TenantContext): Promise<readonly ApplicationMessageSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records, memberships, users, nodes, executions, attempts, profiles, proposals, approvalLineages] =
      await this.database.query<
        [
          MessageRecord[],
          MembershipDisplayRecord[],
          UserDisplayRecord[],
          NodeDisplayRecord[],
          ExecutionLineageRecord[],
          RouteAttemptLineageRecord[],
          ModelProfileLineageRecord[],
          StaffingProposalRecord[],
          ApprovalLineageRecord[],
        ]
      >(
        `SELECT organization_id, work_id, room_id, message_id, sequence, message_type, author_kind, author_id, recipient_agent_id, content, created_at, token_count, cost_micros, reply_to_message_id, caused_by_message_id, task_id, context_version_id, execution_id, artifact_version_id FROM collaboration_message WHERE organization_id = $organization_id ORDER BY room_id ASC, sequence ASC;
       SELECT user_id FROM membership WHERE organization_id = $organization_id;
       SELECT user_id, display_name FROM identity_user WHERE user_id IN (SELECT VALUE user_id FROM membership WHERE organization_id = $organization_id);
       SELECT handle, name, scope, work_id FROM organization_node WHERE organization_id = $organization_id;
       SELECT execution_id, work_id, agent_handle FROM runtime_execution WHERE organization_id = $organization_id;
       SELECT execution_id, model_profile_id FROM route_attempt WHERE organization_id = $organization_id AND execution_id != NONE AND status = 'succeeded';
       SELECT model_profile_id, provider_id, model_id FROM model_profile WHERE organization_id = $organization_id;
       SELECT proposal_id, organization_id, work_id, core_office_room_id, status, approval_id, nodes_json, impact_json, expected_organization_version, applied_organization_version, message_id FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND message_id != NONE;
       SELECT organization_id, approval_id, work_id, status FROM governance_approval WHERE organization_id = $organization_id;`,
        { organization_id: context.organizationId },
      );
    const memberIds = new Set(memberships.map((membership) => membership.user_id));
    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const nodesByHandle = new Map<string, NodeDisplayRecord[]>();
    for (const node of nodes) {
      const matching = nodesByHandle.get(node.handle) ?? [];
      matching.push(node);
      nodesByHandle.set(node.handle, matching);
    }
    const executionsById = new Map<string, ExecutionLineageRecord[]>();
    for (const execution of executions) {
      const matching = executionsById.get(execution.execution_id) ?? [];
      matching.push(execution);
      executionsById.set(execution.execution_id, matching);
    }
    const attemptsByExecution = new Map<string, RouteAttemptLineageRecord[]>();
    for (const attempt of attempts) {
      const matching = attemptsByExecution.get(attempt.execution_id) ?? [];
      matching.push(attempt);
      attemptsByExecution.set(attempt.execution_id, matching);
    }
    const profilesById = new Map(profiles.map((profile) => [profile.model_profile_id, profile]));
    const proposalsByMessage = new Map<string, StaffingProposalRecord[]>();
    for (const proposal of proposals) {
      const matching = proposalsByMessage.get(proposal.message_id) ?? [];
      matching.push(proposal);
      proposalsByMessage.set(proposal.message_id, matching);
    }
    return records.map((record) => {
      const authorDisplayName =
        record.author_kind === "user" && memberIds.has(record.author_id)
          ? usersById.get(record.author_id)?.display_name
          : record.author_kind === "agent"
            ? nodesByHandle
                .get(record.author_id)
                ?.find(
                  (node) => node.scope === "persistent" || (node.scope === "work" && node.work_id === record.work_id),
                )?.name
            : undefined;
      const execution = (
        record.execution_id === undefined ? [] : (executionsById.get(record.execution_id) ?? [])
      ).filter((candidate) => candidate.work_id === record.work_id);
      const successfulAttempts =
        record.author_kind === "agent" && execution.length === 1 && execution[0]?.agent_handle === record.author_id
          ? (attemptsByExecution.get(execution[0].execution_id) ?? [])
          : [];
      const actualModel =
        successfulAttempts.length === 1 ? profilesById.get(successfulAttempts[0]?.model_profile_id ?? "") : undefined;
      const staffingProposal = appliedStaffingProposal(
        record,
        proposalsByMessage.get(record.message_id) ?? [],
        approvalLineages,
      );
      return {
        organizationId: record.organization_id,
        workId: record.work_id,
        roomId: record.room_id,
        messageId: record.message_id,
        sequence: record.sequence,
        messageType: record.message_type,
        authorKind: record.author_kind,
        authorId: record.author_id,
        ...(record.recipient_agent_id === undefined ? {} : { recipientAgentId: record.recipient_agent_id }),
        ...(authorDisplayName === undefined ? {} : { authorDisplayName }),
        ...(actualModel === undefined ? {} : { providerId: actualModel.provider_id, modelId: actualModel.model_id }),
        content: record.content,
        createdAt: iso(record.created_at),
        ...(record.token_count === undefined ? {} : { tokenCount: record.token_count }),
        ...(record.cost_micros === undefined ? {} : { costMicros: record.cost_micros }),
        ...(record.reply_to_message_id === undefined ? {} : { replyToMessageId: record.reply_to_message_id }),
        ...(record.caused_by_message_id === undefined ? {} : { causedByMessageId: record.caused_by_message_id }),
        ...(record.task_id === undefined ? {} : { taskId: record.task_id }),
        ...(record.context_version_id === undefined ? {} : { contextVersionId: record.context_version_id }),
        ...(record.execution_id === undefined ? {} : { executionId: record.execution_id }),
        ...(record.artifact_version_id === undefined ? {} : { artifactVersionId: record.artifact_version_id }),
        ...(staffingProposal === undefined ? {} : { staffingProposal }),
      };
    });
  }

  public async sharedContexts(context: TenantContext): Promise<readonly ApplicationSharedContextSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[SharedContextRecord[]]>(
      "SELECT organization_id, work_id, room_id, shared_context_reference_id, source_kind, source_id, version_id, checksum FROM shared_context_reference WHERE organization_id = $organization_id ORDER BY room_id ASC, shared_context_reference_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      roomId: record.room_id,
      sharedContextReferenceId: record.shared_context_reference_id,
      sourceKind: record.source_kind,
      sourceId: record.source_id,
      versionId: record.version_id,
      checksum: record.checksum,
    }));
  }

  public async records(context: TenantContext): Promise<readonly ApplicationRecordSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[WorkRecordProjection[]]>(
      "SELECT organization_id, work_id, work_record_id, version, summary, artifact_version_ids, verification_ids, finalized_at FROM work_record WHERE organization_id = $organization_id AND finalized = true ORDER BY work_id ASC, version ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      recordId: record.work_record_id,
      version: record.version,
      summary: record.summary,
      artifactIds: record.artifact_version_ids,
      verificationIds: record.verification_ids,
      finalizedAt: iso(record.finalized_at),
    }));
  }

  public async artifacts(context: TenantContext): Promise<readonly ApplicationArtifactSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [[artifacts], [versions]] = await Promise.all([
      this.database.query<[WorkArtifactRecord[]]>(
        "SELECT artifact_id, organization_id, work_id, kind, name FROM work_artifact WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[ArtifactVersionRecord[]]>(
        "SELECT artifact_version_id, artifact_id, organization_id, work_id, version, checksum, media_type, source_artifact_version_id, created_by, creator_agent_handle, creator_execution_id, created_at FROM artifact_version WHERE organization_id = $organization_id ORDER BY created_at DESC, artifact_version_id ASC;",
        { organization_id: context.organizationId },
      ),
    ]);
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
    return versions.map((version) => {
      const artifact = artifactsById.get(version.artifact_id);
      if (!artifact || artifact.work_id !== version.work_id) {
        throw new Error(`ArtifactVersion의 Artifact를 찾을 수 없습니다: ${version.artifact_version_id}`);
      }
      return {
        organizationId: version.organization_id,
        artifactId: version.artifact_id,
        artifactVersionId: version.artifact_version_id,
        workId: version.work_id,
        name: artifact.name,
        kind: artifact.kind,
        version: version.version,
        mediaType: version.media_type,
        checksum: version.checksum,
        createdBy: version.created_by,
        createdAt: iso(version.created_at),
        ...(version.source_artifact_version_id === undefined
          ? {}
          : { sourceArtifactVersionId: version.source_artifact_version_id }),
        ...(version.creator_agent_handle === undefined ? {} : { creatorAgentHandle: version.creator_agent_handle }),
        ...(version.creator_execution_id === undefined ? {} : { creatorExecutionId: version.creator_execution_id }),
      };
    });
  }

  public async verifications(context: TenantContext): Promise<readonly ApplicationVerificationSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[VerificationRecord[]]>(
      "SELECT verification_id, organization_id, work_id, verifier_id, passed, criteria_json, evidence_artifact_version_ids, assurance_run_id, target_work_revision, projected_work_revision, profile_id, profile_version, binding_version_id, created_at FROM work_verification WHERE organization_id = $organization_id ORDER BY created_at DESC, verification_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      verificationId: record.verification_id,
      workId: record.work_id,
      verifierId: record.verifier_id,
      passed: record.passed,
      criteria: json(record.criteria_json, "Work verification criteria"),
      evidenceArtifactVersionIds: record.evidence_artifact_version_ids,
      ...(record.assurance_run_id === undefined ? {} : { assuranceRunId: record.assurance_run_id }),
      ...(record.target_work_revision === undefined ? {} : { targetWorkRevision: record.target_work_revision }),
      ...(record.projected_work_revision === undefined
        ? {}
        : { projectedWorkRevision: record.projected_work_revision }),
      ...(record.profile_id === undefined ? {} : { profileId: record.profile_id }),
      ...(record.profile_version === undefined ? {} : { profileVersion: record.profile_version }),
      ...(record.binding_version_id === undefined ? {} : { bindingVersionId: record.binding_version_id }),
      createdAt: iso(record.created_at),
    }));
  }

  public async directives(context: TenantContext): Promise<readonly ApplicationDirectiveSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[DirectiveRecord[]]>(
      "SELECT directive_id, organization_id, work_id, run_id, sequence, content, mode, submitted_stage, status, revision, failure_reason, created_at, updated_at FROM application_work_directive WHERE organization_id = $organization_id ORDER BY run_id ASC, sequence ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      directiveId: record.directive_id,
      workId: record.work_id,
      runId: record.run_id,
      sequence: record.sequence,
      content: record.content,
      mode: record.mode,
      submittedStage: record.submitted_stage,
      status: record.status,
      revision: record.revision,
      ...(record.failure_reason === undefined ? {} : { failureReason: record.failure_reason }),
      createdAt: iso(record.created_at),
      updatedAt: iso(record.updated_at),
    }));
  }

  public async approvals(context: TenantContext): Promise<readonly ApplicationApprovalSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [[records], [decisions], [staffingProposals]] = await Promise.all([
      this.database.query<[ApprovalRecord[]]>(
        "SELECT organization_id, approval_id, decision_id, request_hash, policy_version_id, status, requester_user_id, work_id, execution_id, resource_revision, resume_target, display_preview_json, revision, expires_at, created_at, updated_at FROM governance_approval WHERE organization_id = $organization_id ORDER BY created_at ASC, approval_id ASC;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[ApprovalDecisionRecord[]]>(
        "SELECT decision_id, policy_version_id, request_hash, action, resource_type, resource_id, resource_revision FROM governance_policy_decision WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[DynamicStaffingApprovalRecord[]]>(
        "SELECT organization_id, approval_id, work_id, status, ux_metadata_json FROM dynamic_staffing_proposal WHERE organization_id = $organization_id AND approval_id != NONE;",
        { organization_id: context.organizationId },
      ),
    ]);
    const decisionsById = new Map(decisions.map((decision) => [decision.decision_id, decision]));
    return records.map((record) => {
      const decision = decisionsById.get(record.decision_id);
      const decisionMatches =
        decision !== undefined &&
        decision.request_hash === record.request_hash &&
        decision.policy_version_id === record.policy_version_id;
      const displayPreview = decisionMatches
        ? (decodeApprovalDisplayPreview(record.display_preview_json) ??
          staffingApprovalPreview(
            record,
            decision,
            staffingProposals.filter((proposal) => proposal.approval_id === record.approval_id),
          ))
        : undefined;
      return {
        organizationId: record.organization_id,
        approvalId: record.approval_id,
        action: decisionMatches ? decision.action : "unknown",
        status: record.status,
        requestedBy: record.requester_user_id,
        expiresAt: iso(record.expires_at),
        ...(record.work_id === undefined ? {} : { workId: record.work_id }),
        ...(record.execution_id === undefined ? {} : { executionId: record.execution_id }),
        ...(record.resource_revision === undefined ? {} : { resourceRevision: record.resource_revision }),
        ...(record.resume_target === undefined ? {} : { resumeTarget: record.resume_target }),
        revision: record.revision,
        createdAt: iso(record.created_at),
        updatedAt: iso(record.updated_at),
        ...(displayPreview === undefined ? {} : { displayPreview }),
      };
    });
  }

  public async extensions(context: TenantContext): Promise<readonly ApplicationExtensionSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [installations] = await this.database.query<[ExtensionInstallationRecord[]]>(
      "SELECT organization_id, installation_id, package_name, state, active_version_id FROM extension_installation WHERE organization_id = $organization_id ORDER BY package_name ASC;",
      { organization_id: context.organizationId },
    );
    const [versions] = await this.database.query<[ExtensionVersionRecord[]]>(
      "SELECT version_id, package_version, manifest_json FROM extension_version WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    return installations.map((installation) => {
      const version = versions.find((candidate) => candidate.version_id === installation.active_version_id);
      return {
        organizationId: installation.organization_id,
        installationId: installation.installation_id,
        packageName: installation.package_name,
        packageVersion: version?.package_version ?? "inactive",
        state: installation.state,
        contributions: version ? contributionIds(version.manifest_json) : [],
      };
    });
  }
}
