import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { WorkspaceService } from "@massion/workspace";

import { WorkService } from "../../../packages/work/src/work.js";

import { MassionSubscriptionExecutionContext } from "./subscription-execution-context.js";

const temporary: string[] = [];

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const works = {
  getWork: async (tenant: TenantContext, workId: string) => ({
    work_id: workId,
    organization_id: tenant.organizationId,
  }),
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label));
  temporary.push(path);
  return path;
}

async function projectFixture(
  directory: string,
  includeWorkspaces = true,
  beforeTransaction?: (transaction: number) => void | Promise<void>,
) {
  const project = join(directory, "project");
  await mkdir(project);
  const projectRoot = await realpath(project);
  const state = {
    workOrganizationId: context.organizationId,
    workStatus: "running",
    taskId: "task-1",
    taskStatus: "running",
    agentHandle: "work-wren-specialist",
    assignmentStatus: "assigned",
    workspaceStatus: "active",
    workspaceOrganizationId: context.organizationId,
    trust: "trusted",
    path: projectRoot,
  };
  const transactionExecutors: unknown[] = [];
  const readerExecutors: unknown[] = [];
  const service = new MassionSubscriptionExecutionContext(
    join(directory, "scratch"),
    {
      getWork: async (_tenant, _workId, executor) => {
        readerExecutors.push(executor);
        return {
          work_id: "work-1",
          organization_id: state.workOrganizationId,
          status: state.workStatus,
          workspace_id: "workspace-1",
        };
      },
      listTasks: async (_tenant, _workId, executor) => {
        readerExecutors.push(executor);
        return [{ task_id: state.taskId, status: state.taskStatus }];
      },
      listAssignments: async (_tenant, _workId, executor) => {
        readerExecutors.push(executor);
        return [{ task_id: state.taskId, agent_handle: state.agentHandle, status: state.assignmentStatus }];
      },
    },
    undefined,
    includeWorkspaces
      ? {
          get: async (_tenant, _workspaceId, executor) => {
            readerExecutors.push(executor);
            return {
              workspaceId: "workspace-1",
              organizationId: state.workspaceOrganizationId,
              path: state.path,
              status: state.workspaceStatus,
              trust: state.trust,
            };
          },
        }
      : undefined,
    {
      transaction: async (operation) => {
        const transaction = transactionExecutors.length + 1;
        await beforeTransaction?.(transaction);
        const transactionExecutor = { query: async () => [] };
        transactionExecutors.push(transactionExecutor);
        return await operation(transactionExecutor);
      },
    },
  );
  return { projectRoot, readerExecutors, service, state, transactionExecutors };
}

describe("구독 Agent 작업공간 권한", () => {
  it.each(["read-only", "workspace-write"] as const)(
    "신뢰된 활성 Task와 Assignment는 동적 Agent에게 %s 정확한 실제 Workspace root를 발급한다",
    async (workspaceAccess) => {
      const directory = await root("massion-subscription-trusted-workspace-");
      const { projectRoot, service } = await projectFixture(directory);

      const lineage = {
        executionId: "execution-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "work-wren-specialist",
        workspaceAccess,
      } as const;
      const resolved = await service.resolve(context, lineage);
      expect(resolved).toEqual({
        workspaceRoot: projectRoot,
        workspaceAccess,
        workspaceCapability: expect.any(String),
      });
      await expect(
        service.verify(context, {
          ...lineage,
          workspaceCapability: resolved.workspaceCapability,
          providerId: "openai-codex",
          accountId: "account-1",
          connectorId: "connector-1",
          requestedWorkspaceRoot: projectRoot,
        }),
      ).resolves.toEqual({ workspaceRoot: projectRoot, workspaceAccess, allowedTools: [], disallowedTools: [] });
    },
  );

  it("알 수 없는 runtime workspace access는 프로젝트 경로를 확인하기 전에 거부한다", async () => {
    const directory = await root("massion-subscription-invalid-access-");
    const { readerExecutors, service } = await projectFixture(directory);

    await expect(
      service.resolve(context, {
        executionId: "execution-invalid-access",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "work-wren-specialist",
        workspaceAccess: "write" as never,
      }),
    ).rejects.toThrow("workspace access");
    expect(readerExecutors).toEqual([]);
  });

  it("프로젝트 snapshot의 모든 정본 reader는 같은 transaction executor를 사용한다", async () => {
    const directory = await root("massion-subscription-transaction-snapshot-");
    const { readerExecutors, service, transactionExecutors } = await projectFixture(directory);
    const lineage = {
      executionId: "execution-transaction",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "work-wren-specialist",
      workspaceAccess: "workspace-write" as const,
    };
    const resolved = await service.resolve(context, lineage);
    expect(transactionExecutors).toHaveLength(2);
    expect(readerExecutors).toEqual(transactionExecutors.flatMap((transaction) => Array(4).fill(transaction)));
    readerExecutors.length = 0;
    transactionExecutors.length = 0;

    await service.verify(context, {
      ...lineage,
      workspaceCapability: resolved.workspaceCapability,
      providerId: "openai-codex",
      accountId: "account-1",
      connectorId: "connector-1",
      requestedWorkspaceRoot: resolved.workspaceRoot,
    });
    expect(transactionExecutors).toHaveLength(2);
    expect(readerExecutors).toEqual(transactionExecutors.flatMap((transaction) => Array(4).fill(transaction)));
  });

  it("실제 WorkService projectWorkspace transaction은 default client query 없이 계보를 검증한다", async () => {
    const directory = await root("massion-subscription-real-transaction-");
    const project = join(directory, "project");
    await mkdir(project);
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    try {
      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const workspaces = await WorkspaceService.create(database, organizations);
      const work = await WorkService.create(database, organizations, {
        verifyActiveNode: async () => undefined,
        releaseTerminalWorkScopedNodes: async () => undefined,
      });
      const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
      const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const pendingWorkspace = await workspaces.register(tenant, { path: project });
      const workspace = await workspaces.decideTrust(tenant, {
        workspaceId: pendingWorkspace.workspaceId,
        decision: "trusted",
        expectedRevision: pendingWorkspace.revision,
      });
      const created = await work.createWork(tenant, {
        commandId: crypto.randomUUID(),
        text: "project workspace transaction",
        surface: "test",
        organizationVersionId: "organization-version-1",
        workspaceId: workspace.workspaceId,
      });
      const planned = await work.addPlan(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        content: { objective: "실행" },
      });
      const plannedWork = await work.transition(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: planned.work.revision,
        target: "planned",
      });
      const task = await work.addTask(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: plannedWork.work.revision,
        title: "실행",
        objective: "검증",
        acceptanceCriteria: ["계보를 유지한다"],
        dependencyIds: [],
      });
      const agentHandle = "work-transaction-specialist";
      await database.query(
        "CREATE task_assignment CONTENT { assignment_id: $assignment_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, status: 'assigned', revision: 1, created_by: $created_by, created_at: time::now(), updated_at: time::now() };",
        {
          organization_id: tenant.organizationId,
          work_id: created.work.work_id,
          task_id: task.task.task_id,
          assignment_id: crypto.randomUUID(),
          agent_handle: agentHandle,
          created_by: tenant.userId,
        },
      );
      const ready = await work.transition(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: task.work.revision,
        target: "ready",
      });
      const runningTask = await work.transitionTask(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: ready.work.revision,
        taskId: task.task.task_id,
        expectedTaskRevision: task.task.revision,
        target: "running",
      });
      await work.transition(tenant, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: runningTask.work.revision,
        target: "running",
      });
      const defaultQuery = vi.spyOn(database, "query");
      const service = new MassionSubscriptionExecutionContext(
        join(directory, "scratch"),
        work,
        undefined,
        workspaces,
        database,
      );

      const resolved = await service.resolve(tenant, {
        executionId: "execution-real-transaction",
        workId: created.work.work_id,
        taskId: task.task.task_id,
        agentHandle,
        workspaceAccess: "workspace-write",
      });

      expect(resolved).toMatchObject({ workspaceRoot: await realpath(project), workspaceAccess: "workspace-write" });
      expect(defaultQuery).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await database.close();
    }
  });

  it.each([
    ["path identity", (state: Record<string, string>, alternatePath: string) => (state.path = alternatePath)],
    ["organization", (state: Record<string, string>) => (state.workspaceOrganizationId = "organization-other")],
    ["Work", (state: Record<string, string>) => (state.workStatus = "completed")],
    ["Task", (state: Record<string, string>) => (state.taskStatus = "completed")],
    ["Assignment", (state: Record<string, string>) => (state.assignmentStatus = "released")],
  ] as const)("filesystem snapshot 뒤 %s 계보가 바뀌면 capability를 발급하지 않는다", async (_label, mutate) => {
    const directory = await root("massion-subscription-final-lineage-");
    const alternate = join(directory, "alternate");
    await mkdir(alternate);
    const state: { current?: Record<string, string> } = {};
    const fixture = await projectFixture(directory, true, (transaction) => {
      if (transaction === 2 && state.current) mutate(state.current, alternate);
    });
    state.current = fixture.state;

    await expect(
      fixture.service.resolve(context, {
        executionId: "execution-final-lineage",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "work-wren-specialist",
        workspaceAccess: "workspace-write",
      }),
    ).rejects.toThrow("계보");
    expect(fixture.transactionExecutors).toHaveLength(2);
  });

  it("workspace capability 변조와 Task·access·root 불일치를 거부한다", async () => {
    const directory = await root("massion-subscription-capability-tamper-");
    const { projectRoot, service } = await projectFixture(directory);
    const lineage = {
      executionId: "execution-capability",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "work-wren-specialist",
      workspaceAccess: "workspace-write" as const,
    };
    const resolved = await service.resolve(context, lineage);
    const verifyInput = {
      ...lineage,
      workspaceCapability: resolved.workspaceCapability,
      providerId: "openai-codex",
      accountId: "account-1",
      connectorId: "connector-1",
      requestedWorkspaceRoot: projectRoot,
    };

    await expect(
      service.verify(context, { ...verifyInput, workspaceCapability: `${resolved.workspaceCapability}x` }),
    ).rejects.toThrow("일치하지");
    await expect(service.verify(context, { ...verifyInput, taskId: "task-forged" })).rejects.toThrow("일치하지");
    await expect(service.verify(context, { ...verifyInput, workspaceAccess: "read-only" })).rejects.toThrow("일치하지");
    await expect(service.verify(context, { ...verifyInput, requestedWorkspaceRoot: directory })).rejects.toThrow(
      "일치하지",
    );
  });

  it("같은 경로의 일반 directory로 교체해도 inode identity가 달라 verify가 거부한다", async () => {
    const directory = await root("massion-subscription-inode-replacement-");
    const { projectRoot, service } = await projectFixture(directory);
    const lineage = {
      executionId: "execution-inode",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "work-wren-specialist",
      workspaceAccess: "workspace-write" as const,
    };
    const resolved = await service.resolve(context, lineage);
    await rename(projectRoot, join(directory, "original-project"));
    await mkdir(projectRoot);

    await expect(
      service.verify(context, {
        ...lineage,
        workspaceCapability: resolved.workspaceCapability,
        providerId: "openai-codex",
        accountId: "account-1",
        connectorId: "connector-1",
        requestedWorkspaceRoot: projectRoot,
      }),
    ).rejects.toThrow("일치하지");
  });

  it("실행 context는 반복 resolve를 위해 mutable issuance registry를 두지 않는다", async () => {
    const source = await readFile(new URL("./subscription-execution-context.ts", import.meta.url), "utf8");
    expect(source).not.toContain("issued = new Map");
    const directory = await root("massion-subscription-stateless-capability-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const first = await service.resolve(context, {
      executionId: "execution-stateless-1",
      workId: "work-1",
      agentHandle: "representative",
    });
    await service.resolve(context, {
      executionId: "execution-stateless-2",
      workId: "work-1",
      agentHandle: "representative",
    });
    await expect(
      service.verify(context, {
        executionId: "execution-stateless-1",
        workId: "work-1",
        agentHandle: "representative",
        workspaceCapability: first.workspaceCapability,
        providerId: "anthropic-claude-code",
        accountId: "account-1",
        connectorId: "connector-1",
        requestedWorkspaceRoot: first.workspaceRoot,
      }),
    ).resolves.toMatchObject({ workspaceRoot: first.workspaceRoot, workspaceAccess: "isolated" });
  });

  it.each([
    ["workspace dependency missing", (state: Record<string, string>) => state, false],
    ["Work not running", (state: Record<string, string>) => Object.assign(state, { workStatus: "ready" }), true],
    ["Task missing", (state: Record<string, string>) => Object.assign(state, { taskId: "task-other" }), true],
    ["Task not running", (state: Record<string, string>) => Object.assign(state, { taskStatus: "ready" }), true],
    [
      "Assignment missing",
      (state: Record<string, string>) => Object.assign(state, { assignmentStatus: "released" }),
      true,
    ],
    ["wrong Agent", (state: Record<string, string>) => Object.assign(state, { agentHandle: "other-agent" }), true],
    ["pending Workspace", (state: Record<string, string>) => Object.assign(state, { trust: "pending" }), true],
    ["blocked Workspace", (state: Record<string, string>) => Object.assign(state, { trust: "blocked" }), true],
    [
      "archived Workspace",
      (state: Record<string, string>) => Object.assign(state, { workspaceStatus: "archived" }),
      true,
    ],
  ] as const)("%s 상태에서는 프로젝트 Workspace를 발급하지 않는다", async (_label, mutate, includeWorkspaces) => {
    const directory = await root("massion-subscription-invalid-lineage-");
    const { service, state } = await projectFixture(directory, includeWorkspaces);
    mutate(state);

    await expect(
      service.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "work-wren-specialist",
        workspaceAccess: "workspace-write",
      }),
    ).rejects.toThrow("계보");
  });

  it("verify는 위조된 Task·접근 의도와 resolve 이후 상태 변경을 독립적으로 거부한다", async () => {
    const directory = await root("massion-subscription-verify-lineage-");
    const { projectRoot, service, state } = await projectFixture(directory);
    const lineage = {
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "work-wren-specialist",
      workspaceAccess: "workspace-write" as const,
      providerId: "openai-codex",
      accountId: "account-1",
      connectorId: "connector-1",
      requestedWorkspaceRoot: projectRoot,
    };
    const resolved = await service.resolve(context, lineage);
    const verifiedLineage = { ...lineage, workspaceCapability: resolved.workspaceCapability };

    await expect(service.verify(context, { ...verifiedLineage, taskId: "task-forged" })).rejects.toThrow("일치하지");
    await expect(service.verify(context, { ...verifiedLineage, workspaceAccess: "read-only" })).rejects.toThrow(
      "일치하지",
    );
    state.taskStatus = "completed";
    await expect(service.verify(context, verifiedLineage)).rejects.toThrow("일치하지");
  });

  it("verify는 프로젝트 경로의 삭제·symlink 교체와 요청 root 불일치를 거부한다", async () => {
    const directory = await root("massion-subscription-verify-path-");
    const outside = join(directory, "outside");
    await mkdir(outside);
    const { projectRoot, service } = await projectFixture(directory);
    const lineage = {
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "work-wren-specialist",
      workspaceAccess: "workspace-write" as const,
      providerId: "openai-codex",
      accountId: "account-1",
      connectorId: "connector-1",
      requestedWorkspaceRoot: projectRoot,
    };
    const resolved = await service.resolve(context, lineage);
    const verifiedLineage = { ...lineage, workspaceCapability: resolved.workspaceCapability };

    await expect(service.verify(context, { ...verifiedLineage, requestedWorkspaceRoot: outside })).rejects.toThrow(
      "일치하지",
    );
    await rm(projectRoot, { recursive: true });
    await expect(service.verify(context, verifiedLineage)).rejects.toThrow("일치하지");
    await symlink(outside, projectRoot, "dir");
    await expect(service.verify(context, verifiedLineage)).rejects.toThrow("일치하지");
  });

  it("저장된 프로젝트 경로가 canonical 표기와 다르면 발급하지 않는다", async () => {
    const directory = await root("massion-subscription-noncanonical-project-");
    const { projectRoot, service, state } = await projectFixture(directory);
    state.path = `${projectRoot}/.`;

    await expect(
      service.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "work-wren-specialist",
        workspaceAccess: "workspace-write",
      }),
    ).rejects.toThrow("계보");
  });

  it("모델 평가 run도 조직 정본으로 확인한 뒤 격리 workspace를 발급한다", async () => {
    const directory = await root("massion-subscription-optimization-workspace-");
    const resolveInstruction = vi.fn();
    const service = new MassionSubscriptionExecutionContext(
      join(directory, "workspaces"),
      works,
      {
        hasOptimizationRun: async (tenant, runId) =>
          tenant.organizationId === context.organizationId && runId === "run-1",
      },
      undefined,
      undefined,
      { resolve: resolveInstruction },
    );

    const resolved = await service.resolve(context, {
      executionId: "run-1",
      workId: "optimization:run-1",
      agentHandle: "representative",
    });

    expect(resolved.workspaceRoot).toContain("workspaces");
    expect(resolved).toMatchObject({ workspaceAccess: "isolated", workspaceCapability: expect.any(String) });
    expect(resolveInstruction).not.toHaveBeenCalled();
    await expect(
      service.resolve(context, {
        executionId: "run-2",
        workId: "optimization:run-2",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("Work");
  });

  it("조직과 Work별 owner-only 작업공간을 발급하고 같은 요청만 검증한다", async () => {
    const directory = await root("massion-subscription-workspace-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const resolved = await service.resolve(context, {
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-development",
    });
    if (!resolved.workspaceRoot) throw new Error("테스트 작업공간이 없습니다");

    expect((await stat(resolved.workspaceRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(resolved.workspaceRoot)).isSymbolicLink()).toBe(false);
    await expect(
      service.verify(context, {
        executionId: "execution-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "software-development",
        workspaceCapability: resolved.workspaceCapability,
        providerId: "openai-codex",
        accountId: "account-1",
        connectorId: "connector-1",
        requestedWorkspaceRoot: resolved.workspaceRoot,
      }),
    ).resolves.toEqual({
      workspaceRoot: resolved.workspaceRoot,
      workspaceAccess: "isolated",
      allowedTools: [],
      disallowedTools: [],
    });
  });

  it("격리 workspace가 resolve 이후 사라지면 verify가 다시 만들지 않고 거부한다", async () => {
    const directory = await root("massion-subscription-scratch-disappeared-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const resolved = await service.resolve(context, {
      executionId: "execution-disappeared",
      workId: "work-1",
      agentHandle: "representative",
    });
    await rm(resolved.workspaceRoot, { recursive: true });

    await expect(
      service.verify(context, {
        executionId: "execution-disappeared",
        workId: "work-1",
        agentHandle: "representative",
        workspaceCapability: resolved.workspaceCapability,
        providerId: "anthropic-claude-code",
        accountId: "account-1",
        connectorId: "connector-1",
        requestedWorkspaceRoot: resolved.workspaceRoot,
      }),
    ).rejects.toThrow("일치하지");
    await expect(lstat(resolved.workspaceRoot)).rejects.toThrow();
  });

  it("다른 Work·조직 또는 관리 root 밖 경로를 거부한다", async () => {
    const directory = await root("massion-subscription-boundary-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const resolved = await service.resolve(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "representative",
    });
    if (!resolved.workspaceRoot) throw new Error("테스트 작업공간이 없습니다");
    const input = {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "representative",
      providerId: "anthropic-claude-code",
      accountId: "account-1",
      connectorId: "connector-1",
      workspaceCapability: resolved.workspaceCapability,
      requestedWorkspaceRoot: resolved.workspaceRoot,
    } as const;

    await expect(service.verify(context, { ...input, workId: "work-2" })).rejects.toThrow("발급된 작업공간");
    await expect(service.verify({ ...context, organizationId: "organization-2" }, input)).rejects.toThrow(
      "발급된 작업공간",
    );
    await expect(service.verify(context, { ...input, requestedWorkspaceRoot: directory })).rejects.toThrow(
      "발급된 작업공간",
    );
  });

  it("작업공간 root가 symbolic link이면 fail closed한다", async () => {
    const directory = await root("massion-subscription-symlink-");
    const outside = join(directory, "outside");
    const linked = join(directory, "linked");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linked, "dir");
    const service = new MassionSubscriptionExecutionContext(linked, works);

    await expect(
      service.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("안전하지 않습니다");
  });

  it("Work 정본에서 현재 조직 actor의 접근을 확인하지 못하면 workspace를 만들지 않는다", async () => {
    const directory = await root("massion-subscription-work-access-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), {
      getWork: async () => {
        throw new Error("Work를 찾을 수 없습니다");
      },
    });

    await expect(
      service.resolve(context, {
        executionId: "execution-unknown",
        workId: "work-unknown",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("Work");
  });
});
