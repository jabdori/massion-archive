import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import { ApplicationError } from "./errors.js";
import type {
  ApplicationApprovalSource,
  ApplicationAssignmentSource,
  ApplicationExecutionSource,
  ApplicationExtensionSource,
  ApplicationOrganizationSource,
  ApplicationReadModel,
  ApplicationRoomSource,
  ApplicationSourceWatermarks,
  ApplicationTaskSource,
  ApplicationWorkSource,
} from "./read-model.js";

export interface CollaborationGraphNode {
  readonly nodeId: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: readonly string[];
  readonly parentHandle?: string;
  readonly status: string;
  readonly role: string;
  readonly scope: "persistent" | "work";
  readonly workId?: string;
  /** Core Office 여덟 노드. 화면이 편성 조작을 미리 막는 데 씁니다. */
  readonly builtin: boolean;
  readonly currentTaskId?: string;
  readonly currentWorkId?: string;
  readonly executionId?: string;
  readonly executionStatus?: string;
  readonly modelRoute?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros?: number;
}

export interface CollaborationGraphWork {
  readonly workId: string;
  readonly status: string;
  readonly revision: number;
  readonly artifactIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly roomIds: readonly string[];
  readonly workspaceId?: string;
  readonly autonomyMode?: "automatic" | "review" | "full-access";
  readonly autonomyRevision?: number;
}

export interface CollaborationGraphSnapshot {
  readonly schemaVersion: "massion.collaboration.snapshot.v1";
  readonly revision: string;
  readonly sourceWatermarks: ApplicationSourceWatermarks;
  readonly organization: { readonly organizationId: string; readonly version: number };
  readonly nodes: readonly CollaborationGraphNode[];
  readonly works: readonly CollaborationGraphWork[];
  readonly tasks: readonly Omit<ApplicationTaskSource, "organizationId">[];
  readonly assignments: readonly Omit<ApplicationAssignmentSource, "organizationId">[];
  readonly executions: readonly Omit<ApplicationExecutionSource, "organizationId">[];
  readonly rooms: readonly Omit<ApplicationRoomSource, "organizationId">[];
  readonly pendingApprovals: readonly Omit<ApplicationApprovalSource, "organizationId">[];
  readonly extensions: readonly Omit<ApplicationExtensionSource, "organizationId">[];
}

interface SnapshotSources {
  readonly organization: ApplicationOrganizationSource;
  readonly works: readonly ApplicationWorkSource[];
  readonly tasks: readonly ApplicationTaskSource[];
  readonly assignments: readonly ApplicationAssignmentSource[];
  readonly executions: readonly ApplicationExecutionSource[];
  readonly rooms: readonly ApplicationRoomSource[];
  readonly approvals: readonly ApplicationApprovalSource[];
  readonly extensions: readonly ApplicationExtensionSource[];
}

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

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertTenant(context: TenantContext, sources: SnapshotSources): void {
  if (sources.organization.organizationId !== context.organizationId) {
    throw new Error("Application snapshot organization tenant가 일치하지 않습니다");
  }
  const records = [
    ...sources.works,
    ...sources.tasks,
    ...sources.assignments,
    ...sources.executions,
    ...sources.rooms,
    ...sources.approvals,
    ...sources.extensions,
  ];
  if (records.some((record) => record.organizationId !== context.organizationId)) {
    throw new Error("Application snapshot source tenant가 일치하지 않습니다");
  }
}

export class CollaborationGraphSnapshotProjector {
  private readonly maxAttempts: number;

  public constructor(
    private readonly source: ApplicationReadModel,
    input: { readonly maxAttempts?: number } = {},
  ) {
    this.maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new Error("Application snapshot maxAttempts가 유효하지 않습니다");
    }
  }

  public async project(context: TenantContext): Promise<CollaborationGraphSnapshot> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const before = await this.source.watermarks(context);
      const [organization, works, tasks, assignments, executions, rooms, approvals, extensions] = await Promise.all([
        this.source.organization(context),
        this.source.works(context),
        this.source.tasks(context),
        this.source.assignments(context),
        this.source.executions(context),
        this.source.rooms(context),
        this.source.approvals(context),
        this.source.extensions(context),
      ]);
      const after = await this.source.watermarks(context);
      if (canonicalJson(before) !== canonicalJson(after)) continue;
      const sources = { organization, works, tasks, assignments, executions, rooms, approvals, extensions };
      assertTenant(context, sources);
      return this.map(after, sources);
    }
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: true,
      userMessage: "협업 그래프가 계속 변경되어 일관된 snapshot을 만들 수 없습니다",
      operatorCode: "APP_SNAPSHOT_UNSTABLE",
    });
  }

  private map(watermarks: ApplicationSourceWatermarks, sources: SnapshotSources): CollaborationGraphSnapshot {
    const assigned = new Map(
      sources.assignments
        .filter((assignment) => assignment.status === "assigned")
        .map((assignment) => [assignment.agentHandle, assignment]),
    );
    const executing = new Map(
      sources.executions
        .filter((execution) => ["queued", "running", "suspended"].includes(execution.status))
        .map((execution) => [execution.agentHandle, execution]),
    );
    const nodes = sources.organization.nodes.map((node): CollaborationGraphNode => {
      const assignment = assigned.get(node.handle);
      const execution = executing.get(node.handle);
      return {
        nodeId: node.nodeId,
        handle: node.handle,
        name: node.name,
        responsibility: node.responsibility,
        capabilities: [...node.capabilities],
        builtin: node.builtin,
        ...(node.parentHandle === undefined ? {} : { parentHandle: node.parentHandle }),
        status: node.status,
        role: node.role,
        scope: node.scope,
        ...(node.workId === undefined ? {} : { workId: node.workId }),
        ...(assignment === undefined ? {} : { currentTaskId: assignment.taskId, currentWorkId: assignment.workId }),
        ...(execution === undefined
          ? {}
          : {
              executionId: execution.executionId,
              executionStatus: execution.status,
              modelRoute: execution.modelRoute,
              inputTokens: execution.inputTokens,
              outputTokens: execution.outputTokens,
              costMicros: execution.costMicros,
            }),
      };
    });
    const works = sources.works.map((work): CollaborationGraphWork => ({
      workId: work.workId,
      status: work.status,
      revision: work.revision,
      artifactIds: [...work.artifactIds],
      ...(work.workspaceId === undefined ? {} : { workspaceId: work.workspaceId }),
      ...(work.autonomyMode === undefined ? {} : { autonomyMode: work.autonomyMode }),
      ...(work.autonomyRevision === undefined ? {} : { autonomyRevision: work.autonomyRevision }),
      taskIds: sources.tasks.filter((task) => task.workId === work.workId).map((task) => task.taskId),
      roomIds: sources.rooms.filter((room) => room.workId === work.workId).map((room) => room.roomId),
    }));
    return {
      schemaVersion: "massion.collaboration.snapshot.v1",
      revision: checksum(watermarks),
      sourceWatermarks: { ...watermarks },
      organization: {
        organizationId: sources.organization.organizationId,
        version: sources.organization.version,
      },
      nodes,
      works,
      tasks: sources.tasks.map((task) => ({
        workId: task.workId,
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        revision: task.revision,
      })),
      assignments: sources.assignments.map((assignment) => ({
        workId: assignment.workId,
        taskId: assignment.taskId,
        agentHandle: assignment.agentHandle,
        status: assignment.status,
        revision: assignment.revision,
      })),
      executions: sources.executions.map((execution) => ({
        executionId: execution.executionId,
        workId: execution.workId,
        ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
        agentHandle: execution.agentHandle,
        modelRoute: execution.modelRoute,
        status: execution.status,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        costMicros: execution.costMicros,
        ...(execution.autonomyMode === undefined ? {} : { autonomyMode: execution.autonomyMode }),
        ...(execution.autonomyRevision === undefined ? {} : { autonomyRevision: execution.autonomyRevision }),
      })),
      rooms: sources.rooms.map((room) => ({
        workId: room.workId,
        roomId: room.roomId,
        name: room.name,
        kind: room.kind,
        status: room.status,
        participantIds: [...room.participantIds],
        ...(room.participants === undefined ? {} : { participants: [...room.participants] }),
        lastMessageSequence: room.lastMessageSequence,
      })),
      pendingApprovals: sources.approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => ({
          approvalId: approval.approvalId,
          action: approval.action,
          status: approval.status,
          requestedBy: approval.requestedBy,
          expiresAt: approval.expiresAt,
          ...(approval.displayPreview === undefined ? {} : { displayPreview: approval.displayPreview }),
        })),
      extensions: sources.extensions.map((extension) => ({
        installationId: extension.installationId,
        packageName: extension.packageName,
        packageVersion: extension.packageVersion,
        state: extension.state,
        contributions: [...extension.contributions],
      })),
    };
  }
}
