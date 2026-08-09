import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { TenantContext } from "@massion/identity";
import type { RoutedExecutionContextResolver } from "@massion/runtime";
import type { QueryExecutor } from "@massion/storage";

import type {
  SubscriptionWorkspaceCapabilityVerifier,
  WorkspaceCapabilityView,
} from "./subscription-runtime-resolver.js";

type WorkspaceAccess = "isolated" | "read-only" | "workspace-write";

interface SubscriptionWorkAccessReader {
  getWork(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<{
    readonly work_id: string;
    readonly organization_id: string;
    readonly status?: string;
    readonly workspace_id?: string;
  }>;
  listTasks?(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<readonly { readonly task_id: string; readonly status: string }[]>;
  listAssignments?(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<
    readonly {
      readonly task_id: string;
      readonly agent_handle: string;
      readonly status: string;
    }[]
  >;
}

interface SubscriptionOptimizationWorkAccessReader {
  hasOptimizationRun(context: TenantContext, runId: string): Promise<boolean>;
}

interface SubscriptionWorkspaceReader {
  get(
    context: TenantContext,
    workspaceId: string,
    executor?: QueryExecutor,
  ): Promise<{
    readonly workspaceId: string;
    readonly organizationId: string;
    readonly path: string;
    readonly status: string;
    readonly trust: string;
  }>;
}

interface TransactionRunner {
  transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
}

interface WorkspaceSnapshot {
  readonly workspaceRoot: string;
  readonly device: string;
  readonly inode: string;
}

interface WorkspaceCapabilityPayload extends WorkspaceSnapshot {
  readonly version: 1;
  readonly executionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly agentHandle: string;
  readonly workspaceAccess: WorkspaceAccess;
}

function segment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function requireWorkspaceAccess(value: unknown): WorkspaceAccess {
  if (value === undefined || value === "isolated") return "isolated";
  if (value === "read-only" || value === "workspace-write") return value;
  throw new Error("runtime workspace access가 유효하지 않습니다");
}

async function ownerOnlyDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("구독 Agent 작업공간이 안전하지 않습니다");
  await chmod(path, 0o700);
  return await realpath(path);
}

async function directorySnapshot(path: string): Promise<WorkspaceSnapshot> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe-directory");
  const workspaceRoot = await realpath(path);
  const canonicalMetadata = await lstat(workspaceRoot, { bigint: true });
  if (
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    metadata.dev !== canonicalMetadata.dev ||
    metadata.ino !== canonicalMetadata.ino
  ) {
    throw new Error("directory-replaced");
  }
  return { workspaceRoot, device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function capabilityPayload(value: unknown): WorkspaceCapabilityPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-capability");
  const candidate = value as Partial<Record<keyof WorkspaceCapabilityPayload, unknown>>;
  const workspaceAccess = requireWorkspaceAccess(candidate.workspaceAccess);
  if (
    candidate.version !== 1 ||
    typeof candidate.executionId !== "string" ||
    typeof candidate.organizationId !== "string" ||
    typeof candidate.workId !== "string" ||
    (candidate.taskId !== undefined && typeof candidate.taskId !== "string") ||
    typeof candidate.agentHandle !== "string" ||
    typeof candidate.workspaceRoot !== "string" ||
    typeof candidate.device !== "string" ||
    typeof candidate.inode !== "string"
  ) {
    throw new Error("invalid-capability");
  }
  return {
    version: 1,
    executionId: candidate.executionId,
    organizationId: candidate.organizationId,
    workId: candidate.workId,
    ...(candidate.taskId === undefined ? {} : { taskId: candidate.taskId }),
    agentHandle: candidate.agentHandle,
    workspaceAccess,
    workspaceRoot: candidate.workspaceRoot,
    device: candidate.device,
    inode: candidate.inode,
  };
}

export class MassionSubscriptionExecutionContext
  implements RoutedExecutionContextResolver, SubscriptionWorkspaceCapabilityVerifier
{
  private readonly capabilityKey = randomBytes(32);

  public constructor(
    private readonly workspaceRoot: string,
    private readonly works: SubscriptionWorkAccessReader,
    private readonly optimizationRuns?: SubscriptionOptimizationWorkAccessReader,
    private readonly workspaces?: SubscriptionWorkspaceReader,
    private readonly transactions?: TransactionRunner,
    private readonly instructions?: {
      resolve(
        context: TenantContext,
        input: { readonly executionId: string; readonly workId: string; readonly agentHandle: string },
      ): Promise<{ readonly instruction: string }>;
    },
  ) {
    if (!isAbsolute(workspaceRoot)) throw new Error("구독 Agent 작업공간 root는 절대 경로여야 합니다");
  }

  public async resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
      readonly workspaceAccess?: WorkspaceAccess;
    },
  ): Promise<{
    readonly workspaceRoot: string;
    readonly workspaceAccess: WorkspaceAccess;
    readonly workspaceCapability: string;
    readonly instruction?: string;
  }> {
    const requestedAccess = requireWorkspaceAccess(input.workspaceAccess);
    const optimization = input.workId.startsWith("optimization:");
    const workspaceAccess = optimization ? "isolated" : requestedAccess;
    let snapshot: WorkspaceSnapshot;
    if (workspaceAccess === "isolated") {
      await this.requireWorkAccess(context, input.workId);
      snapshot = await this.scratchWorkspace(context, input.workId);
    } else {
      snapshot = await this.projectWorkspace(context, input);
    }
    const payload: WorkspaceCapabilityPayload = {
      version: 1,
      executionId: input.executionId,
      organizationId: context.organizationId,
      workId: input.workId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentHandle: input.agentHandle,
      workspaceAccess,
      ...snapshot,
    };
    const configuration = optimization
      ? undefined
      : await this.instructions?.resolve(context, {
          executionId: input.executionId,
          workId: input.workId,
          agentHandle: input.agentHandle,
        });
    return {
      workspaceRoot: snapshot.workspaceRoot,
      workspaceAccess,
      workspaceCapability: this.sign(payload),
      ...(configuration?.instruction ? { instruction: configuration.instruction } : {}),
    };
  }

  public async verify(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
      readonly workspaceAccess?: WorkspaceAccess;
      readonly workspaceCapability: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly connectorId: string;
      readonly requestedWorkspaceRoot: string;
    },
  ): Promise<WorkspaceCapabilityView> {
    void input.providerId;
    void input.accountId;
    void input.connectorId;
    try {
      const workspaceAccess = requireWorkspaceAccess(input.workspaceAccess);
      const payload = this.authenticate(input.workspaceCapability);
      if (
        payload.executionId !== input.executionId ||
        payload.organizationId !== context.organizationId ||
        payload.workId !== input.workId ||
        payload.taskId !== input.taskId ||
        payload.agentHandle !== input.agentHandle ||
        payload.workspaceAccess !== workspaceAccess ||
        payload.workspaceRoot !== input.requestedWorkspaceRoot ||
        !isAbsolute(input.requestedWorkspaceRoot)
      ) {
        throw new Error("lineage-mismatch");
      }
      const snapshot =
        workspaceAccess === "isolated"
          ? await this.isolatedSnapshot(context, input.workId)
          : await this.projectWorkspace(context, input);
      if (
        snapshot.workspaceRoot !== payload.workspaceRoot ||
        snapshot.device !== payload.device ||
        snapshot.inode !== payload.inode
      ) {
        throw new Error("filesystem-identity-mismatch");
      }
      return {
        workspaceRoot: snapshot.workspaceRoot,
        workspaceAccess,
        allowedTools: [],
        disallowedTools: [],
      };
    } catch (error) {
      throw new Error("발급된 작업공간과 요청 경로가 일치하지 않습니다", { cause: error });
    }
  }

  private sign(payload: WorkspaceCapabilityPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.capabilityKey).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private authenticate(capability: string): WorkspaceCapabilityPayload {
    if (typeof capability !== "string") throw new Error("invalid-capability");
    const parts = capability.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid-capability");
    const expected = createHmac("sha256", this.capabilityKey).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid-capability");
    return capabilityPayload(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown);
  }

  private async scratchWorkspace(context: TenantContext, workId: string): Promise<WorkspaceSnapshot> {
    const root = await ownerOnlyDirectory(resolve(this.workspaceRoot));
    const organizationRoot = await ownerOnlyDirectory(resolve(root, segment(context.organizationId)));
    const workRoot = await ownerOnlyDirectory(resolve(organizationRoot, segment(workId)));
    if (!within(root, organizationRoot) || !within(organizationRoot, workRoot)) {
      throw new Error("구독 Agent 작업공간이 관리 root 밖입니다");
    }
    return await directorySnapshot(workRoot);
  }

  private async isolatedSnapshot(context: TenantContext, workId: string): Promise<WorkspaceSnapshot> {
    await this.requireWorkAccess(context, workId);
    const configuredRoot = resolve(this.workspaceRoot);
    const rootMetadata = await lstat(configuredRoot, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("unsafe-root");
    const root = await realpath(configuredRoot);
    const organizationRoot = resolve(root, segment(context.organizationId));
    const workRoot = resolve(organizationRoot, segment(workId));
    const [organizationMetadata, workMetadata, snapshot] = await Promise.all([
      lstat(organizationRoot, { bigint: true }),
      lstat(workRoot, { bigint: true }),
      directorySnapshot(workRoot),
    ]);
    if (
      !organizationMetadata.isDirectory() ||
      organizationMetadata.isSymbolicLink() ||
      (organizationMetadata.mode & 0o077n) !== 0n ||
      !workMetadata.isDirectory() ||
      workMetadata.isSymbolicLink() ||
      (workMetadata.mode & 0o077n) !== 0n ||
      snapshot.workspaceRoot !== workRoot ||
      !within(root, organizationRoot) ||
      !within(organizationRoot, snapshot.workspaceRoot)
    ) {
      throw new Error("unsafe-scratch");
    }
    return snapshot;
  }

  private async requireWorkAccess(
    context: TenantContext,
    workId: string,
    executor?: QueryExecutor,
  ): Promise<Awaited<ReturnType<SubscriptionWorkAccessReader["getWork"]>> | undefined> {
    if (workId.startsWith("optimization:")) {
      const runId = workId.slice("optimization:".length);
      if (!runId || !this.optimizationRuns || !(await this.optimizationRuns.hasOptimizationRun(context, runId))) {
        throw new Error("Work 또는 모델 평가 run을 찾을 수 없습니다");
      }
      return undefined;
    }
    const work = await this.works.getWork(context, workId, executor);
    if (work.work_id !== workId || work.organization_id !== context.organizationId) {
      throw new Error("현재 조직 actor가 실행할 수 있는 Work가 아닙니다");
    }
    return work;
  }

  private async projectWorkspace(
    context: TenantContext,
    input: { readonly workId: string; readonly taskId?: string; readonly agentHandle: string },
  ): Promise<WorkspaceSnapshot> {
    if (!this.transactions) throw new Error("Task Workspace transaction이 구성되지 않았습니다");
    try {
      const preflight = await this.transactions.transaction(
        async (transaction) => await this.readProjectWorkspace(context, input, transaction),
      );
      const snapshot = await directorySnapshot(preflight.path);
      if (snapshot.workspaceRoot !== preflight.path) throw new Error("noncanonical");
      return await this.transactions.transaction(async (transaction) => {
        const confirmed = await this.readProjectWorkspace(context, input, transaction);
        if (
          confirmed.workspaceId !== preflight.workspaceId ||
          confirmed.path !== preflight.path ||
          snapshot.workspaceRoot !== confirmed.path
        ) {
          throw new Error("workspace-changed");
        }
        return snapshot;
      });
    } catch (error) {
      throw new Error("Task Workspace 실행 계보가 유효하지 않습니다", { cause: error });
    }
  }

  private async readProjectWorkspace(
    context: TenantContext,
    input: { readonly workId: string; readonly taskId?: string; readonly agentHandle: string },
    transaction: QueryExecutor,
  ): Promise<Awaited<ReturnType<SubscriptionWorkspaceReader["get"]>>> {
    const work = await this.requireWorkAccess(context, input.workId, transaction);
    const taskId = input.taskId;
    if (!work || !taskId || work.status !== "running" || !work.workspace_id) {
      throw new Error("invalid-work");
    }
    const tasks = await this.works.listTasks?.(context, input.workId, transaction);
    const assignments = await this.works.listAssignments?.(context, input.workId, transaction);
    const task = tasks?.find((candidate) => candidate.task_id === taskId);
    const assignment = assignments?.find(
      (candidate) =>
        candidate.task_id === taskId && candidate.agent_handle === input.agentHandle && candidate.status === "assigned",
    );
    if (task?.status !== "running" || !assignment || !this.workspaces) throw new Error("invalid-task-lineage");
    const workspace = await this.workspaces.get(context, work.workspace_id, transaction);
    if (
      workspace.workspaceId !== work.workspace_id ||
      workspace.organizationId !== context.organizationId ||
      workspace.status !== "active" ||
      workspace.trust !== "trusted" ||
      !isAbsolute(workspace.path) ||
      resolve(workspace.path) !== workspace.path
    ) {
      throw new Error("invalid-workspace");
    }
    return workspace;
  }
}
