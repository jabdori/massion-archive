import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  ORGANIZATION_CAPABILITY_MIGRATION,
  ORGANIZATION_CORE_OFFICE_CAPABILITY_BACKFILL_MIGRATION,
  ORGANIZATION_GRAPH_MIGRATION,
} from "./schema.js";

export const CORE_OFFICE_HANDLES = [
  "representative",
  "context-strategy",
  "evidence-research",
  "governance",
  "delivery-coordination",
  "assurance",
  "records-documentation",
  "growth",
] as const;

const CORE_OFFICE = [
  {
    handle: "representative",
    name: "Representative",
    responsibility: "사용자 요청 접수, 조정, 최종 응답",
    outputs: ["Request", "Work", "FinalResult"],
    capabilities: ["request-coordination"],
    parentHandle: undefined,
  },
  {
    handle: "context-strategy",
    name: "Context & Strategy",
    responsibility: "프로젝트·업무 맥락 구성, 계획, 위험 분석",
    outputs: ["ContextPackage", "Plan", "AcceptanceCriteria"],
    capabilities: ["context-strategy"],
    parentHandle: "representative",
  },
  {
    handle: "evidence-research",
    name: "Evidence & Research",
    responsibility: "코드·문서·외부 근거 조사, 출처 검증",
    outputs: ["EvidenceBrief"],
    capabilities: ["evidence-research"],
    parentHandle: "representative",
  },
  {
    handle: "governance",
    name: "Governance",
    responsibility: "실행·조직·Extension·자기수정 정책과 승인",
    outputs: ["PolicyDecision", "Approval"],
    capabilities: ["governance"],
    parentHandle: "representative",
  },
  {
    handle: "delivery-coordination",
    name: "Delivery Coordination",
    responsibility: "Task 배정, 전문 팀 실행 조정, 결과 통합",
    outputs: ["Assignment", "Execution"],
    capabilities: ["delivery-coordination"],
    parentHandle: "representative",
  },
  {
    handle: "assurance",
    name: "Assurance",
    responsibility: "독립 리뷰, 테스트·보안·운영 검증",
    outputs: ["Verification"],
    capabilities: ["assurance"],
    parentHandle: "representative",
  },
  {
    handle: "records-documentation",
    name: "Records & Documentation",
    responsibility: "handoff·결정·계보 기록, 문서 영향 반영",
    outputs: ["WorkRecord", "ADR", "Changelog", "Runbook"],
    capabilities: ["records-documentation"],
    parentHandle: "representative",
  },
  {
    handle: "growth",
    name: "Growth",
    responsibility: "Reflection, 개선안 평가·채택·효과 비교·되돌리기",
    outputs: ["Suggestion", "Adoption", "Revert"],
    capabilities: ["growth"],
    parentHandle: "representative",
  },
] as const;

export type NodeScope = "persistent" | "work";
export type NodeStatus = "active" | "inactive" | "retired";
export type NodeRole = "orchestrator" | "coordinator" | "operator";
export type ReferenceKind =
  "work" | "agent" | "task" | "conversation" | "memory" | "approval" | "permission" | "prompt" | "skill" | "extension";

export interface OrganizationNode {
  readonly node_id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly outputs: readonly string[];
  readonly capabilities: readonly string[];
  readonly parent_handle?: string;
  readonly scope: NodeScope;
  readonly work_id?: string;
  readonly builtin: boolean;
  readonly status: NodeStatus;
  readonly role: NodeRole;
  readonly created_at: unknown;
}

export interface OrganizationVersion {
  readonly version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly previous_version?: number;
  readonly command_id: string;
  readonly command_kind: string;
  readonly request_json: string;
  readonly impact_json: string;
  readonly actor_user_id: string;
  readonly before_json: string;
  readonly after_json: string;
  readonly created_at: unknown;
}

interface CommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly governanceApprovalId?: string;
  readonly governanceEnvironment?: string;
}

interface LifecycleWork {
  readonly work_id: string;
  readonly request_id: string;
  readonly status: string;
}

interface LifecycleMembership {
  readonly user_id: string;
  readonly created_at: unknown;
}

interface DatabaseInfo {
  readonly tables: Readonly<Record<string, string>>;
}

export interface CreateNodeCommand extends CommandBase {
  readonly kind: "create";
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly parentHandle: string;
  readonly scope: NodeScope;
  readonly workId?: string;
  readonly role?: NodeRole;
  readonly outputs?: readonly string[];
}

export interface TargetCommand extends CommandBase {
  readonly kind: "activate" | "deactivate" | "retire" | "restore";
  readonly handle: string;
}

export interface MoveCommand extends CommandBase {
  readonly kind: "move";
  readonly handle: string;
  readonly parentHandle: string;
}

export interface RoleCommand extends CommandBase {
  readonly kind: "change-role" | "promote";
  readonly handle: string;
  readonly role: NodeRole;
}

export interface ScopePromotionCommand extends CommandBase {
  readonly kind: "promote-scope";
  readonly handle: string;
  readonly workId: string;
}

export interface SplitCommand extends CommandBase {
  readonly kind: "split";
  readonly sourceHandle: string;
  readonly newHandle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly childHandles: readonly string[];
  readonly referencePlan: readonly ReferenceDisposition[];
}

export interface MergeCommand extends CommandBase {
  readonly kind: "merge";
  readonly survivorHandle: string;
  readonly sourceHandle: string;
  readonly referencePlan: readonly ReferenceDisposition[];
}

export interface ReferenceDisposition {
  readonly referenceId: string;
  readonly action: "retain" | "move";
  readonly targetHandle?: string;
}

export interface RevertCommand extends CommandBase {
  readonly kind: "revert";
  readonly targetVersion: number;
}

export interface OrganizationProfileNode {
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly outputs: readonly string[];
  readonly capabilities: readonly string[];
  readonly parentHandle: string;
  readonly scope: NodeScope;
  readonly workId?: string;
  readonly role: NodeRole;
}

export interface InstallProfileCommand extends CommandBase {
  readonly kind: "install-profile";
  readonly profileId: string;
  readonly profileVersion: string;
  readonly nodes: readonly OrganizationProfileNode[];
}

export type OrganizationCommand =
  | CreateNodeCommand
  | TargetCommand
  | MoveCommand
  | RoleCommand
  | ScopePromotionCommand
  | SplitCommand
  | MergeCommand
  | RevertCommand
  | InstallProfileCommand;

export interface OrganizationReference {
  readonly reference_id: string;
  readonly organization_id: string;
  readonly node_handle: string;
  readonly kind: ReferenceKind;
  readonly target_id: string;
}

export interface ImpactReport {
  readonly nodeHandles: string[];
  readonly references: OrganizationReference[];
}

export interface ComplianceFinding {
  readonly code: "core-office" | "orphan" | "cycle" | "scope" | "inactive-parent";
  readonly handle: string;
  readonly message: string;
  readonly suggestedCommand?: string;
}

export interface GraphChangeResult {
  readonly nodes: OrganizationNode[];
  readonly version: OrganizationVersion;
  readonly impact: ImpactReport;
}

export interface OrganizationChangeAuthorization {
  readonly kind: "organization-change-authorization";
}

export interface OrganizationGovernanceGate {
  authorize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly action: string;
      readonly resource: {
        readonly type: string;
        readonly id: string;
        readonly revision?: number;
        readonly attributes?: Readonly<Record<string, unknown>>;
      };
      readonly environment: string;
      readonly riskClass: string;
      readonly external: boolean;
      readonly executionId: string;
      readonly workId?: string;
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<unknown>;
}

type MutableNode = { -readonly [Key in keyof OrganizationNode]: OrganizationNode[Key] };
type StoredOrganizationNode = Omit<OrganizationNode, "capabilities"> & {
  readonly capabilities?: readonly string[];
};

async function listNodes(executor: QueryExecutor, organizationId: string): Promise<OrganizationNode[]> {
  const [nodes] = await executor.query<[StoredOrganizationNode[]]>(
    "SELECT node_id, organization_id, handle, name, responsibility, outputs, capabilities, parent_handle, scope, work_id, builtin, status, role, created_at FROM organization_node WHERE organization_id = $organization_id ORDER BY handle ASC;",
    { organization_id: organizationId },
  );
  return nodes.map((node) => ({ ...node, capabilities: node.capabilities ?? [] }));
}

async function listVersions(executor: QueryExecutor, organizationId: string): Promise<OrganizationVersion[]> {
  const [versions] = await executor.query<[OrganizationVersion[]]>(
    "SELECT * OMIT id FROM organization_version WHERE organization_id = $organization_id;",
    { organization_id: organizationId },
  );
  return versions;
}

function latestVersion(versions: OrganizationVersion[]): OrganizationVersion | undefined {
  return versions.reduce<OrganizationVersion | undefined>(
    (latest, candidate) => (!latest || candidate.version > latest.version ? candidate : latest),
    undefined,
  );
}

async function databaseTables(executor: QueryExecutor): Promise<ReadonlySet<string>> {
  const [info] = await executor.query<[DatabaseInfo]>("INFO FOR DB;");
  return new Set(Object.keys(info.tables));
}

function normalizeSnapshot(nodes: readonly StoredOrganizationNode[]): OrganizationNode[] {
  return [...nodes]
    .map((node) => ({ ...node, capabilities: node.capabilities ?? [], created_at: String(node.created_at) }))
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

function restoreSnapshot(nodes: readonly StoredOrganizationNode[]): OrganizationNode[] {
  const capabilitiesByHandle = new Map<string, readonly string[]>(
    CORE_OFFICE.map((node) => [node.handle, node.capabilities]),
  );
  return normalizeSnapshot(nodes).map((node) => {
    const capabilities = node.builtin ? capabilitiesByHandle.get(node.handle) : undefined;
    return capabilities ? { ...node, capabilities } : node;
  });
}

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

function logicalCommandJson(command: OrganizationCommand): string {
  const logicalCommand: Record<string, unknown> = { ...command };
  delete logicalCommand.governanceApprovalId;
  return canonicalJson(logicalCommand);
}

function logicalCommandHash(command: OrganizationCommand): string {
  return createHash("sha256").update(logicalCommandJson(command)).digest("hex");
}

function recordedLogicalCommandJson(requestJson: string): string | undefined {
  try {
    return logicalCommandJson(JSON.parse(requestJson) as OrganizationCommand);
  } catch {
    return undefined;
  }
}

function descendants(nodes: readonly OrganizationNode[], roots: readonly string[]): string[] {
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parent_handle && affected.has(node.parent_handle) && !affected.has(node.handle)) {
        affected.add(node.handle);
        changed = true;
      }
    }
  }
  return [...affected].sort();
}

function validateGraph(nodes: readonly OrganizationNode[]): void {
  const handles = new Map(nodes.map((node) => [node.handle, node]));
  if (handles.size !== nodes.length) throw new Error("조직 노드 handle은 중복될 수 없습니다");
  for (const node of nodes) {
    if (node.scope === "work" && !node.work_id) throw new Error("work scope 노드는 workId가 필요합니다");
    if (node.scope === "persistent" && node.work_id) throw new Error("persistent 노드는 workId를 가질 수 없습니다");
    const parent = node.parent_handle ? handles.get(node.parent_handle) : undefined;
    if (node.parent_handle && !parent) throw new Error(`고아 부모 참조입니다: ${node.handle}`);
    if (parent?.scope === "work" && node.scope === "persistent") {
      throw new Error(`persistent 노드는 Work 범위 부모를 가질 수 없습니다: ${node.handle}`);
    }
    if (parent?.scope === "work" && node.scope === "work" && parent.work_id !== node.work_id) {
      throw new Error(`Work 범위 부모와 자식은 같은 Work에 속해야 합니다: ${node.handle}`);
    }
    const visited = new Set<string>();
    let current: OrganizationNode | undefined = node;
    while (current?.parent_handle) {
      if (visited.has(current.handle)) throw new Error("조직 그래프에 cycle이 생깁니다");
      visited.add(current.handle);
      current = handles.get(current.parent_handle);
    }
  }
}

function validateOperationalGraph(nodes: readonly OrganizationNode[]): void {
  const handles = new Map(nodes.map((node) => [node.handle, node]));
  for (const node of nodes) {
    if (node.status === "active" && node.parent_handle && handles.get(node.parent_handle)?.status !== "active") {
      throw new Error(`활성 노드의 부모는 active 상태여야 합니다: ${node.handle}`);
    }
  }
}

function targetRoots(command: OrganizationCommand): string[] {
  if (command.kind === "create") return [command.parentHandle];
  if (command.kind === "install-profile") return command.nodes.map((node) => node.handle);
  if (command.kind === "split") return [command.sourceHandle, ...command.childHandles];
  if (command.kind === "merge") return [command.survivorHandle, command.sourceHandle];
  if (command.kind === "revert") return [];
  return [command.handle];
}

function changedHandles(before: readonly OrganizationNode[], after: readonly OrganizationNode[]): string[] {
  const snapshots = new Map(before.map((node) => [node.handle, canonicalJson(node)]));
  const changed = new Set<string>();
  for (const node of after) {
    if (snapshots.get(node.handle) !== canonicalJson(node)) changed.add(node.handle);
    snapshots.delete(node.handle);
  }
  for (const removed of snapshots.keys()) changed.add(removed);
  return [...changed].sort();
}

export class OrganizationGraphService {
  private readonly workScopeReleaseQueues = new Map<string, Promise<unknown>>();
  private readonly preparedAuthorizations = new WeakMap<
    OrganizationChangeAuthorization,
    { readonly organizationId: string; readonly userId: string; readonly commandHash: string }
  >();

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly governance?: OrganizationGovernanceGate,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    governance?: OrganizationGovernanceGate,
  ) {
    await applyMigrations(database, [
      ORGANIZATION_GRAPH_MIGRATION,
      ORGANIZATION_CAPABILITY_MIGRATION,
      ORGANIZATION_CORE_OFFICE_CAPABILITY_BACKFILL_MIGRATION,
    ]);
    return new OrganizationGraphService(database, organizations, governance);
  }

  private async verify(context: TenantContext, requireOwner = false): Promise<void> {
    if (requireOwner && context.role !== "owner") throw new Error("조직 그래프 변경은 owner만 수행할 수 있습니다");
    await this.organizations.getOrganization(context, context.organizationId);
  }

  private async serializeWorkScopeRelease<Result>(
    organizationId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.workScopeReleaseQueues.get(organizationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.workScopeReleaseQueues.set(organizationId, current);
    try {
      return await current;
    } finally {
      if (this.workScopeReleaseQueues.get(organizationId) === current) {
        this.workScopeReleaseQueues.delete(organizationId);
      }
    }
  }

  private async authorizeChange(
    context: TenantContext,
    command: OrganizationCommand,
    executor?: QueryExecutor,
  ): Promise<unknown> {
    if (!this.governance) return undefined;
    const workIds =
      command.kind === "install-profile"
        ? [...new Set(command.nodes.filter((node) => node.scope === "work").map((node) => node.workId))]
        : [];
    const workId = workIds.length === 1 ? workIds[0] : undefined;
    return await this.governance.authorize(
      context,
      {
        commandId: command.commandId,
        action: "organization.change",
        resource: {
          type: "Organization",
          id: context.organizationId,
          revision: command.expectedVersion,
          attributes: { toolInputDigest: logicalCommandHash(command) },
        },
        environment: command.governanceEnvironment ?? "local",
        riskClass: "write",
        external: false,
        executionId: `organization-change:${command.commandId}`,
        ...(workId ? { workId } : {}),
        ...(command.governanceApprovalId ? { approvalId: command.governanceApprovalId } : {}),
      },
      executor,
    );
  }

  public async authorizeExecution(
    context: TenantContext,
    command: OrganizationCommand,
  ): Promise<OrganizationChangeAuthorization> {
    if (command.governanceApprovalId) {
      throw new Error("승인 ID가 있는 조직 변경은 원자 적용 transaction에서 검증해야 합니다");
    }
    await this.verify(context, true);
    await this.authorizeChange(context, command);
    const authorization = { kind: "organization-change-authorization" as const };
    this.preparedAuthorizations.set(authorization, {
      organizationId: context.organizationId,
      userId: context.userId,
      commandHash: logicalCommandHash(command),
    });
    return authorization;
  }

  public async bootstrap(context: TenantContext): Promise<GraphChangeResult> {
    await this.verify(context, true);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, ["owner"], transaction);
      const versions = await listVersions(transaction, context.organizationId);
      const existing = latestVersion(versions);
      if (existing) {
        const nodes = await listNodes(transaction, context.organizationId);
        return { nodes, version: existing, impact: { nodeHandles: [], references: [] } };
      }
      for (const { handle, name, responsibility, outputs, capabilities, parentHandle } of CORE_OFFICE) {
        await this.insertNode(transaction, {
          node_id: randomUUID(),
          organization_id: context.organizationId,
          handle,
          name,
          responsibility,
          outputs,
          capabilities,
          ...(parentHandle ? { parent_handle: parentHandle } : {}),
          scope: "persistent",
          builtin: true,
          status: "active",
          role: handle === "representative" ? "orchestrator" : "coordinator",
          created_at: new Date().toISOString(),
        });
      }
      const nodes = await listNodes(transaction, context.organizationId);
      const version = await this.createVersion(
        transaction,
        context,
        1,
        undefined,
        "core-office-bootstrap",
        "bootstrap",
        "{}",
        { nodeHandles: CORE_OFFICE_HANDLES.slice(), references: [] },
        [],
        nodes,
      );
      return { nodes, version, impact: { nodeHandles: CORE_OFFICE_HANDLES.slice(), references: [] } };
    });
  }

  public async listNodes(context: TenantContext, executor: QueryExecutor = this.database): Promise<OrganizationNode[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    return await listNodes(executor, context.organizationId);
  }

  public async getCurrentSnapshot(
    context: TenantContext,
  ): Promise<{ readonly nodes: OrganizationNode[]; readonly version: OrganizationVersion }> {
    await this.verify(context);
    const version = latestVersion(await listVersions(this.database, context.organizationId));
    if (!version) throw new Error("OrganizationVersion을 찾을 수 없습니다");
    return { nodes: normalizeSnapshot(await listNodes(this.database, context.organizationId)), version };
  }

  public async verifyActiveNode(
    context: TenantContext,
    handle: string,
    executor: QueryExecutor = this.database,
    workId?: string,
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const nodes = await listNodes(executor, context.organizationId);
    const node = nodes.find((candidate) => candidate.handle === handle && candidate.status === "active");
    if (!node) {
      throw new Error(`활성 OrganizationNode를 찾을 수 없습니다: ${handle}`);
    }
    if (node.scope === "work" && node.work_id !== workId) {
      throw new Error(`Work 범위 OrganizationNode를 다른 Work에서 사용할 수 없습니다: ${handle}`);
    }
  }

  /** terminal Work의 임시 노드를 현재 조직에서 해제하고 immutable version에 남깁니다. */
  public async releaseTerminalWorkScopedNodes(
    context: TenantContext,
    workId: string,
  ): Promise<GraphChangeResult | undefined> {
    if (!workId.trim()) throw new Error("Work 범위 OrganizationNode 해제에는 Work ID가 필요합니다");
    return await this.serializeWorkScopeRelease(
      context.organizationId,
      async () =>
        await this.database.transaction(async (transaction): Promise<GraphChangeResult | undefined> => {
          await this.organizations.verifyTenantContext(context, undefined, transaction);
          const tables = await databaseTables(transaction);
          if (!tables.has("work")) return undefined;
          const [works] = await transaction.query<[LifecycleWork[]]>(
            "SELECT work_id, request_id, status FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
            { organization_id: context.organizationId, work_id: workId },
          );
          const work = works[0];
          if (!work || !["completed", "failed", "cancelled"].includes(work.status)) return undefined;
          if (tables.has("application_run")) {
            const [activeRuns] = await transaction.query<[{ readonly run_id: string }[]]>(
              "SELECT run_id FROM application_run WHERE organization_id = $organization_id AND work_id = $work_id AND status NOT IN ['completed', 'failed', 'cancelled'] LIMIT 1;",
              { organization_id: context.organizationId, work_id: workId },
            );
            if (activeRuns[0]) return undefined;
          }

          const before = normalizeSnapshot(await listNodes(transaction, context.organizationId));
          const releasedHandles = before
            .filter(
              (node) => node.scope === "work" && node.work_id === workId && node.status === "active" && !node.builtin,
            )
            .map((node) => node.handle)
            .sort();
          if (releasedHandles.length === 0) return undefined;

          const released = new Set(releasedHandles);
          const after = before.map((node) =>
            released.has(node.handle) ? { ...node, status: "inactive" as const } : node,
          );
          validateGraph(after);
          validateOperationalGraph(after);
          const versions = await listVersions(transaction, context.organizationId);
          const current = latestVersion(versions);
          if (!current) throw new Error("OrganizationVersion을 찾을 수 없습니다");
          const impact = await this.analyzeImpactWith(transaction, context.organizationId, releasedHandles, after);
          await this.replaceNodes(transaction, context.organizationId, after);
          const storedAfter = normalizeSnapshot(await listNodes(transaction, context.organizationId));
          const version = await this.createVersion(
            transaction,
            context,
            current.version + 1,
            current.version,
            `work-scope-release:${workId}:${current.version_id}`,
            "release-work-scope",
            canonicalJson({ workId, releasedHandles }),
            impact,
            before,
            storedAfter,
          );
          return { nodes: storedAfter, version, impact };
        }),
    );
  }

  /** 시작 시 이전 process가 남긴 terminal Work의 활성 임시 노드를 tenant별로 재조정합니다. */
  public async reconcileTerminalWorkScopedNodes(): Promise<number> {
    const tables = await databaseTables(this.database);
    if (!tables.has("work") || !tables.has("application_run")) return 0;
    const [nodes] = await this.database.query<[Array<{ readonly organization_id: string; readonly work_id?: string }>]>(
      "SELECT organization_id, work_id FROM organization_node WHERE scope = 'work' AND status = 'active' AND work_id != NONE;",
    );
    const candidates = new Map<string, { readonly organizationId: string; readonly workId: string }>();
    for (const node of nodes) {
      if (!node.work_id) continue;
      candidates.set(`${node.organization_id}:${node.work_id}`, {
        organizationId: node.organization_id,
        workId: node.work_id,
      });
    }
    let reconciled = 0;
    for (const candidate of candidates.values()) {
      const [works] = await this.database.query<[LifecycleWork[]]>(
        "SELECT work_id, request_id, status FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
        { organization_id: candidate.organizationId, work_id: candidate.workId },
      );
      const work = works[0];
      if (!work || !["completed", "failed", "cancelled"].includes(work.status)) continue;
      const [requests] = await this.database.query<[{ readonly requester_user_id: string }[]]>(
        "SELECT requester_user_id FROM work_request WHERE organization_id = $organization_id AND request_id = $request_id LIMIT 1;",
        { organization_id: candidate.organizationId, request_id: work.request_id },
      );
      const [memberships] = await this.database.query<[LifecycleMembership[]]>(
        "SELECT user_id, created_at FROM membership WHERE organization_id = $organization_id AND status = 'active' ORDER BY created_at ASC;",
        { organization_id: candidate.organizationId },
      );
      const actorIds = [requests[0]?.requester_user_id, ...memberships.map((membership) => membership.user_id)].filter(
        (userId): userId is string => userId !== undefined,
      );
      let tenant: TenantContext | undefined;
      for (const userId of new Set(actorIds)) {
        try {
          tenant = await this.organizations.resolveTenantContext(userId, candidate.organizationId);
          break;
        } catch {
          // 중단된 requester 대신 같은 tenant의 활성 Membership을 사용합니다.
        }
      }
      if (!tenant) continue;
      try {
        if (await this.releaseTerminalWorkScopedNodes(tenant, candidate.workId)) reconciled += 1;
      } catch {
        // 한 Work의 손상이나 일시 실패가 다른 tenant의 시작 조정을 막지 않습니다.
      }
    }
    return reconciled;
  }

  public async registerReference(
    context: TenantContext,
    nodeHandle: string,
    kind: ReferenceKind,
    targetId: string,
  ): Promise<OrganizationReference> {
    await this.verify(context);
    const nodes = await listNodes(this.database, context.organizationId);
    if (!nodes.some((node) => node.handle === nodeHandle))
      throw new Error(`대상 노드를 찾을 수 없습니다: ${nodeHandle}`);
    const [records] = await this.database.query<[OrganizationReference[]]>(
      "CREATE organization_reference CONTENT { reference_id: $reference_id, organization_id: $organization_id, node_handle: $node_handle, kind: $kind, target_id: $target_id, created_at: time::now() } RETURN AFTER;",
      {
        reference_id: randomUUID(),
        organization_id: context.organizationId,
        node_handle: nodeHandle,
        kind,
        target_id: targetId,
      },
    );
    const reference = records[0];
    if (!reference) throw new Error("조직 참조 생성 결과가 없습니다");
    return reference;
  }

  public async analyzeImpact(context: TenantContext, rootHandles: readonly string[]): Promise<ImpactReport> {
    await this.verify(context);
    const nodes = await listNodes(this.database, context.organizationId);
    for (const handle of rootHandles) {
      if (!nodes.some((node) => node.handle === handle)) throw new Error(`대상 노드를 찾을 수 없습니다: ${handle}`);
    }
    return await this.analyzeImpactWith(this.database, context.organizationId, rootHandles, nodes);
  }

  public async execute(
    context: TenantContext,
    command: OrganizationCommand,
    executor?: QueryExecutor,
    authorization?: OrganizationChangeAuthorization,
  ): Promise<GraphChangeResult> {
    if (executor) {
      if (context.role !== "owner") throw new Error("조직 그래프 변경은 owner만 수행할 수 있습니다");
    } else {
      await this.verify(context, true);
    }
    const requestJson = logicalCommandJson(command);
    const replay = (versions: OrganizationVersion[]): GraphChangeResult | undefined => {
      const repeated = versions.find((version) => version.command_id === command.commandId);
      if (!repeated) return undefined;
      if (recordedLogicalCommandJson(repeated.request_json) !== requestJson) {
        throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
      }
      return {
        nodes: normalizeSnapshot(JSON.parse(repeated.after_json) as StoredOrganizationNode[]),
        version: repeated,
        impact: JSON.parse(repeated.impact_json) as ImpactReport,
      };
    };
    const execute = async (transaction: QueryExecutor): Promise<GraphChangeResult> => {
      await this.organizations.verifyTenantContext(context, ["owner"], transaction);
      const versions = await listVersions(transaction, context.organizationId);
      const repeated = replay(versions);
      if (repeated) return repeated;
      const current = latestVersion(versions);
      if (!current || current.version !== command.expectedVersion) {
        throw new Error(`현재 OrganizationVersion은 ${String(current?.version ?? 0)}입니다`);
      }
      if (command.governanceApprovalId) await this.authorizeChange(context, command, transaction);
      const before = normalizeSnapshot(await listNodes(transaction, context.organizationId));
      const after =
        command.kind === "revert"
          ? this.snapshotForRevert(versions, command.targetVersion)
          : this.plan(before, command);
      validateGraph(after);
      validateOperationalGraph(after);
      const roots = command.kind === "revert" ? changedHandles(before, after) : targetRoots(command);
      const impact = await this.analyzeImpactWith(transaction, context.organizationId, roots, after);
      await this.replaceNodes(transaction, context.organizationId, after);
      if (command.kind === "split" || command.kind === "merge") {
        await this.applyReferencePlan(transaction, context.organizationId, command, after);
      }
      const storedAfter = normalizeSnapshot(await listNodes(transaction, context.organizationId));
      const version = await this.createVersion(
        transaction,
        context,
        current.version + 1,
        current.version,
        command.commandId,
        command.kind,
        requestJson,
        impact,
        before,
        storedAfter,
      );
      return { nodes: storedAfter, version, impact };
    };
    if (executor) {
      await this.organizations.verifyTenantContext(context, ["owner"], executor);
      const observedVersions = await listVersions(executor, context.organizationId);
      const observedReplay = replay(observedVersions);
      if (observedReplay) return observedReplay;
      if (!command.governanceApprovalId && this.governance) {
        const prepared = authorization ? this.preparedAuthorizations.get(authorization) : undefined;
        if (
          !prepared ||
          prepared.organizationId !== context.organizationId ||
          prepared.userId !== context.userId ||
          prepared.commandHash !== logicalCommandHash(command)
        ) {
          throw new Error("조직 그래프 원자 적용에는 검증된 사전 승인이 필요합니다");
        }
      }
      const observedCurrent = latestVersion(observedVersions);
      if (!observedCurrent || observedCurrent.version !== command.expectedVersion) {
        throw new Error(`현재 OrganizationVersion은 ${String(observedCurrent?.version ?? 0)}입니다`);
      }
      const result = await execute(executor);
      if (authorization) this.preparedAuthorizations.delete(authorization);
      return result;
    }
    const observedVersions = await listVersions(this.database, context.organizationId);
    const observedReplay = replay(observedVersions);
    if (observedReplay) return observedReplay;
    const observedCurrent = latestVersion(observedVersions);
    if (!observedCurrent || observedCurrent.version !== command.expectedVersion) {
      throw new Error(`현재 OrganizationVersion은 ${String(observedCurrent?.version ?? 0)}입니다`);
    }
    if (!command.governanceApprovalId) await this.authorizeChange(context, command);
    return await this.database.transaction(execute);
  }

  /** Growth projection이 현재 정본을 같은 transaction에서 검사할 때만 사용합니다. */
  public async inspectGrowthProjection(
    context: TenantContext,
    executor: QueryExecutor,
  ): Promise<{ readonly nodes: OrganizationNode[]; readonly version: OrganizationVersion }> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const version = latestVersion(await listVersions(executor, context.organizationId));
    if (!version) throw new Error("OrganizationVersion을 찾을 수 없습니다");
    return { nodes: normalizeSnapshot(await listNodes(executor, context.organizationId)), version };
  }

  /** 검증된 책임 변경을 기존 그래프 불변조건·영향 분석·버전 원장으로 투영합니다. */
  public async applyGrowthProjection(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersion: number;
      readonly patch: { readonly handle: string; readonly responsibility: string };
    },
    executor: QueryExecutor,
  ): Promise<GraphChangeResult> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const versions = await listVersions(executor, context.organizationId);
    const repeated = versions.find((version) => version.command_id === input.commandId);
    if (repeated) {
      if (repeated.request_json !== canonicalJson(input))
        throw new Error("같은 commandId에 다른 조직 Growth patch를 사용할 수 없습니다");
      return {
        nodes: normalizeSnapshot(JSON.parse(repeated.after_json) as StoredOrganizationNode[]),
        version: repeated,
        impact: JSON.parse(repeated.impact_json) as ImpactReport,
      };
    }
    const current = latestVersion(versions);
    if (!current || current.version !== input.expectedVersion)
      throw new Error("OrganizationVersion precondition이 일치하지 않습니다");
    const before = normalizeSnapshot(await listNodes(executor, context.organizationId));
    const target = before.find((node) => node.handle === input.patch.handle);
    if (!target) throw new Error(`대상 노드를 찾을 수 없습니다: ${input.patch.handle}`);
    if (target.builtin) throw new Error("Core Office 노드는 변경할 수 없습니다");
    const after = before.map((node) =>
      node.handle === input.patch.handle ? { ...node, responsibility: input.patch.responsibility } : node,
    );
    validateGraph(after);
    validateOperationalGraph(after);
    const impact = await this.analyzeImpactWith(executor, context.organizationId, [input.patch.handle], after);
    await this.replaceNodes(executor, context.organizationId, after);
    const storedAfter = normalizeSnapshot(await listNodes(executor, context.organizationId));
    const version = await this.createVersion(
      executor,
      context,
      current.version + 1,
      current.version,
      input.commandId,
      "growth-change-node",
      canonicalJson(input),
      impact,
      before,
      storedAfter,
    );
    return { nodes: storedAfter, version, impact };
  }

  public async revertGrowthProjection(
    context: TenantContext,
    input: { readonly commandId: string; readonly expectedVersionId: string; readonly targetVersionId: string },
    executor: QueryExecutor,
  ): Promise<GraphChangeResult> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const versions = await listVersions(executor, context.organizationId);
    const repeated = versions.find((version) => version.command_id === input.commandId);
    if (repeated) {
      if (repeated.request_json !== canonicalJson(input))
        throw new Error("같은 commandId에 다른 조직 Growth revert를 사용할 수 없습니다");
      return {
        nodes: normalizeSnapshot(JSON.parse(repeated.after_json) as StoredOrganizationNode[]),
        version: repeated,
        impact: JSON.parse(repeated.impact_json) as ImpactReport,
      };
    }
    const current = latestVersion(versions);
    if (!current || current.version_id !== input.expectedVersionId)
      throw new Error("OrganizationVersion revert precondition이 일치하지 않습니다");
    const target = versions.find((version) => version.version_id === input.targetVersionId);
    if (!target) throw new Error("되돌릴 OrganizationVersion을 찾을 수 없습니다");
    const before = normalizeSnapshot(await listNodes(executor, context.organizationId));
    const after = restoreSnapshot(JSON.parse(target.after_json) as StoredOrganizationNode[]);
    validateGraph(after);
    validateOperationalGraph(after);
    const impact = await this.analyzeImpactWith(executor, context.organizationId, changedHandles(before, after), after);
    await this.replaceNodes(executor, context.organizationId, after);
    const storedAfter = normalizeSnapshot(await listNodes(executor, context.organizationId));
    const version = await this.createVersion(
      executor,
      context,
      current.version + 1,
      current.version,
      input.commandId,
      "growth-revert",
      canonicalJson(input),
      impact,
      before,
      storedAfter,
    );
    return { nodes: storedAfter, version, impact };
  }

  public async auditCompliance(context: TenantContext): Promise<ComplianceFinding[]> {
    await this.verify(context);
    const nodes = await listNodes(this.database, context.organizationId);
    const byHandle = new Map(nodes.map((node) => [node.handle, node]));
    const findings: ComplianceFinding[] = [];
    for (const { handle, name, responsibility, outputs, capabilities, parentHandle } of CORE_OFFICE) {
      const node = byHandle.get(handle);
      if (
        !node ||
        !node.builtin ||
        node.name !== name ||
        node.responsibility !== responsibility ||
        canonicalJson(node.outputs) !== canonicalJson(outputs) ||
        canonicalJson(node.capabilities) !== canonicalJson(capabilities) ||
        node.parent_handle !== parentHandle ||
        node.status !== "active"
      ) {
        findings.push({
          code: "core-office",
          handle,
          message: `Core Office 정의가 누락되거나 변형되었습니다: ${handle}`,
        });
      }
    }
    for (const node of nodes) {
      if (node.parent_handle && !byHandle.has(node.parent_handle))
        findings.push({ code: "orphan", handle: node.handle, message: "부모 노드가 없습니다" });
      if ((node.scope === "work") !== Boolean(node.work_id))
        findings.push({ code: "scope", handle: node.handle, message: "scope와 workId가 일치하지 않습니다" });
      if (node.status === "active" && node.parent_handle && byHandle.get(node.parent_handle)?.status !== "active") {
        findings.push({
          code: "inactive-parent",
          handle: node.handle,
          message: "활성 노드의 부모가 활성 상태가 아닙니다",
          suggestedCommand: `activate:${node.parent_handle}`,
        });
      }
      const path = new Set<string>();
      let current: OrganizationNode | undefined = node;
      while (current?.parent_handle && byHandle.has(current.parent_handle)) {
        if (path.has(current.handle)) {
          findings.push({ code: "cycle", handle: node.handle, message: "조직 그래프에 cycle이 있습니다" });
          break;
        }
        path.add(current.handle);
        current = byHandle.get(current.parent_handle);
      }
    }
    const [references] = await this.database.query<[OrganizationReference[]]>(
      "SELECT reference_id, organization_id, node_handle, kind, target_id FROM organization_reference WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    for (const reference of references) {
      if (!byHandle.has(reference.node_handle))
        findings.push({
          code: "orphan",
          handle: reference.node_handle,
          message: `조직 참조의 노드가 없습니다: ${reference.kind}:${reference.target_id}`,
        });
    }
    return findings.sort((left, right) => `${left.code}:${left.handle}`.localeCompare(`${right.code}:${right.handle}`));
  }

  private plan(before: OrganizationNode[], command: Exclude<OrganizationCommand, RevertCommand>): OrganizationNode[] {
    const nodes: MutableNode[] = before.map((node) => ({ ...node }));
    const find = (handle: string) => {
      const node = nodes.find((candidate) => candidate.handle === handle);
      if (!node) throw new Error(`대상 노드를 찾을 수 없습니다: ${handle}`);
      return node;
    };
    const mutable = (handle: string) => {
      const node = find(handle);
      if (node.builtin) throw new Error("Core Office 노드는 변경할 수 없습니다");
      return node;
    };
    if (command.kind === "create") {
      if (nodes.some((node) => node.handle === command.handle))
        throw new Error(`이미 존재하는 handle입니다: ${command.handle}`);
      find(command.parentHandle);
      nodes.push({
        node_id: randomUUID(),
        organization_id: before[0]?.organization_id ?? "",
        handle: command.handle,
        name: command.name.trim(),
        responsibility: command.responsibility.trim(),
        outputs: command.outputs ?? [],
        capabilities: [],
        parent_handle: command.parentHandle,
        scope: command.scope,
        ...(command.workId ? { work_id: command.workId } : {}),
        builtin: false,
        status: "active",
        role: command.role ?? "operator",
        created_at: new Date().toISOString(),
      });
    } else if (command.kind === "install-profile") {
      if (!command.profileId.trim() || !command.profileVersion.trim()) {
        throw new Error("Profile ID와 version이 필요합니다");
      }
      if (command.nodes.length === 0) throw new Error("Profile에는 하나 이상의 조직 노드가 필요합니다");
      const profileHandles = new Set<string>();
      for (const profileNode of command.nodes) {
        if (profileHandles.has(profileNode.handle)) {
          throw new Error(`Profile 안에 중복 handle이 있습니다: ${profileNode.handle}`);
        }
        profileHandles.add(profileNode.handle);
        if (nodes.some((node) => node.handle === profileNode.handle)) {
          throw new Error(`이미 존재하는 handle입니다: ${profileNode.handle}`);
        }
        if (
          !profileNode.handle.trim() ||
          !profileNode.name.trim() ||
          !profileNode.responsibility.trim() ||
          !profileNode.parentHandle.trim()
        ) {
          throw new Error("Profile node의 handle, name, responsibility와 parent가 필요합니다");
        }
        if (profileNode.outputs.length === 0 || profileNode.capabilities.length === 0) {
          throw new Error(`Profile node에는 output과 capability가 필요합니다: ${profileNode.handle}`);
        }
        nodes.push({
          node_id: randomUUID(),
          organization_id: before[0]?.organization_id ?? "",
          handle: profileNode.handle,
          name: profileNode.name.trim(),
          responsibility: profileNode.responsibility.trim(),
          outputs: [...profileNode.outputs],
          capabilities: [...profileNode.capabilities],
          parent_handle: profileNode.parentHandle,
          scope: profileNode.scope,
          ...(profileNode.workId ? { work_id: profileNode.workId } : {}),
          builtin: false,
          status: "active",
          role: profileNode.role,
          created_at: new Date().toISOString(),
        });
      }
    } else if (command.kind === "move") {
      mutable(command.handle).parent_handle = find(command.parentHandle).handle;
    } else if (command.kind === "promote-scope") {
      const target = mutable(command.handle);
      if (target.status !== "active") throw new Error("영구 승격 대상은 active 상태여야 합니다");
      if (target.scope !== "work" || !target.work_id) throw new Error("영구 승격 대상은 Work 범위여야 합니다");
      if (target.work_id !== command.workId)
        throw new Error("Work 범위 OrganizationNode를 다른 Work에서 승격할 수 없습니다");
      target.scope = "persistent";
      delete target.work_id;
    } else if (command.kind === "change-role" || command.kind === "promote") {
      const target = mutable(command.handle);
      if (command.kind === "promote") {
        const rank: Record<NodeRole, number> = { operator: 0, coordinator: 1, orchestrator: 2 };
        if (rank[command.role] <= rank[target.role]) throw new Error("promote는 현재보다 높은 역할만 허용합니다");
      }
      target.role = command.role;
    } else if (command.kind === "split") {
      const source = mutable(command.sourceHandle);
      if (nodes.some((node) => node.handle === command.newHandle))
        throw new Error(`이미 존재하는 handle입니다: ${command.newHandle}`);
      for (const childHandle of command.childHandles) {
        const child = mutable(childHandle);
        if (child.parent_handle !== source.handle) throw new Error(`split 대상 자식이 아닙니다: ${childHandle}`);
      }
      nodes.push({
        ...source,
        node_id: randomUUID(),
        handle: command.newHandle,
        name: command.name,
        responsibility: command.responsibility,
        builtin: false,
        created_at: new Date().toISOString(),
      });
      for (const childHandle of command.childHandles) mutable(childHandle).parent_handle = command.newHandle;
    } else if (command.kind === "merge") {
      const survivor = mutable(command.survivorHandle);
      const source = mutable(command.sourceHandle);
      if (survivor.handle === source.handle) throw new Error("같은 노드를 merge할 수 없습니다");
      for (const node of nodes) if (node.parent_handle === source.handle) node.parent_handle = survivor.handle;
      source.status = "retired";
    } else {
      const target = mutable(command.handle);
      target.status =
        command.kind === "activate" || command.kind === "restore"
          ? "active"
          : command.kind === "deactivate"
            ? "inactive"
            : "retired";
    }
    return normalizeSnapshot(nodes);
  }

  private snapshotForRevert(versions: OrganizationVersion[], targetVersion: number): OrganizationNode[] {
    const target = versions.find((version) => version.version === targetVersion);
    if (!target) throw new Error(`되돌릴 OrganizationVersion을 찾을 수 없습니다: ${String(targetVersion)}`);
    return restoreSnapshot(JSON.parse(target.after_json) as StoredOrganizationNode[]);
  }

  private async analyzeImpactWith(
    executor: QueryExecutor,
    organizationId: string,
    roots: readonly string[],
    nodes = [] as OrganizationNode[],
  ): Promise<ImpactReport> {
    const graphNodes = nodes.length > 0 ? nodes : await listNodes(executor, organizationId);
    const existingRoots = roots.filter((handle) => graphNodes.some((node) => node.handle === handle));
    const removedRoots = roots.filter((handle) => !graphNodes.some((node) => node.handle === handle));
    const nodeHandles = [...new Set([...descendants(graphNodes, existingRoots), ...removedRoots])].sort();
    if (nodeHandles.length === 0) return { nodeHandles, references: [] };
    const [references] = await executor.query<[OrganizationReference[]]>(
      "SELECT reference_id, organization_id, node_handle, kind, target_id FROM organization_reference WHERE organization_id = $organization_id AND node_handle IN $node_handles ORDER BY kind, target_id;",
      { organization_id: organizationId, node_handles: nodeHandles },
    );
    return { nodeHandles, references };
  }

  private async replaceNodes(
    executor: QueryExecutor,
    organizationId: string,
    nodes: readonly OrganizationNode[],
  ): Promise<void> {
    await executor.query("DELETE organization_node WHERE organization_id = $organization_id;", {
      organization_id: organizationId,
    });
    for (const node of nodes) await this.insertNode(executor, node);
  }

  private async applyReferencePlan(
    executor: QueryExecutor,
    organizationId: string,
    command: SplitCommand | MergeCommand,
    nodes: readonly OrganizationNode[],
  ): Promise<void> {
    const [references] = await executor.query<[OrganizationReference[]]>(
      "SELECT reference_id, organization_id, node_handle, kind, target_id FROM organization_reference WHERE organization_id = $organization_id AND node_handle = $node_handle;",
      { organization_id: organizationId, node_handle: command.sourceHandle },
    );
    const dispositions = new Map(command.referencePlan.map((item) => [item.referenceId, item]));
    for (const reference of references) {
      const disposition = dispositions.get(reference.reference_id);
      if (!disposition) throw new Error(`분리·병합 참조 처리 계획이 없습니다: ${reference.reference_id}`);
      if (disposition.action === "move") {
        if (!disposition.targetHandle || !nodes.some((node) => node.handle === disposition.targetHandle)) {
          throw new Error(`참조 이동 대상 노드를 찾을 수 없습니다: ${disposition.targetHandle ?? ""}`);
        }
        await executor.query(
          "UPDATE organization_reference SET node_handle = $target_handle WHERE organization_id = $organization_id AND reference_id = $reference_id;",
          {
            target_handle: disposition.targetHandle,
            organization_id: organizationId,
            reference_id: reference.reference_id,
          },
        );
      }
    }
    for (const referenceId of dispositions.keys()) {
      if (!references.some((reference) => reference.reference_id === referenceId)) {
        throw new Error(`참조 처리 계획의 대상을 찾을 수 없습니다: ${referenceId}`);
      }
    }
  }

  private async insertNode(executor: QueryExecutor, node: OrganizationNode): Promise<void> {
    await executor.query(
      "CREATE organization_node CONTENT { node_id: $node_id, organization_id: $organization_id, handle: $handle, name: $name, responsibility: $responsibility, outputs: $outputs, capabilities: $capabilities, parent_handle: $parent_handle, scope: $scope, work_id: $work_id, builtin: $builtin, status: $status, role: $role, created_at: type::datetime($created_at) };",
      {
        node_id: node.node_id,
        organization_id: node.organization_id,
        handle: node.handle,
        name: node.name,
        responsibility: node.responsibility,
        outputs: node.outputs,
        capabilities: node.capabilities,
        parent_handle: node.parent_handle,
        scope: node.scope,
        work_id: node.work_id,
        builtin: node.builtin,
        status: node.status,
        role: node.role,
        created_at: String(node.created_at),
      },
    );
  }

  private async createVersion(
    executor: QueryExecutor,
    context: TenantContext,
    version: number,
    previousVersion: number | undefined,
    commandId: string,
    commandKind: string,
    requestJson: string,
    impact: ImpactReport,
    before: OrganizationNode[],
    after: OrganizationNode[],
  ): Promise<OrganizationVersion> {
    const [versions] = await executor.query<[OrganizationVersion[]]>(
      "CREATE organization_version CONTENT { version_id: $version_id, organization_id: $organization_id, version: $version, previous_version: $previous_version, command_id: $command_id, command_kind: $command_kind, request_json: $request_json, impact_json: $impact_json, actor_user_id: $actor_user_id, before_json: $before_json, after_json: $after_json, created_at: time::now() } RETURN AFTER;",
      {
        version_id: randomUUID(),
        organization_id: context.organizationId,
        version,
        previous_version: previousVersion,
        command_id: commandId,
        command_kind: commandKind,
        request_json: requestJson,
        impact_json: JSON.stringify(impact),
        actor_user_id: context.userId,
        before_json: JSON.stringify(before),
        after_json: JSON.stringify(after),
      },
    );
    const created = versions[0];
    if (!created) throw new Error("OrganizationVersion 생성 결과가 없습니다");
    return created;
  }
}
