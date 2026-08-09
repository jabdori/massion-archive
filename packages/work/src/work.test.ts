import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { canTransitionWork, WorkService, type WorkStatus } from "./work.js";

describe("Request와 Work 상태 머신", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let organizations: OrganizationService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await WorkService.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("Request와 draft Work, 첫 Event를 원자 생성한다", async () => {
    const result = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "제품을 구현해주세요",
      surface: "cli",
      outputLocale: "ko",
      organizationVersionId: "organization-version-1",
    });

    expect(result.request.text).toBe("제품을 구현해주세요");
    expect(result.request.output_locale).toBe("ko");
    expect(result.work).toMatchObject({ status: "draft", revision: 1 });
    expect(result.event).toMatchObject({ sequence: 1, event_type: "work_created" });
  });

  it("terminal Work hook은 Work commit 뒤 persisted 상태를 보고 호출한다", async () => {
    let observedStatus: string | undefined;
    const lifecycleService = await WorkService.create(database, organizations, {
      verifyActiveNode: async () => undefined,
      releaseTerminalWorkScopedNodes: async (_context, workId) => {
        const [records] = await database.query<[{ readonly status: string }[]]>(
          "SELECT status FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
          { organization_id: context.organizationId, work_id: workId },
        );
        observedStatus = records[0]?.status;
      },
    });
    const created = await lifecycleService.createWork(context, {
      commandId: "work-terminal-post-commit:create",
      text: "post-commit lifecycle hook",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });

    await lifecycleService.transition(context, {
      commandId: "work-terminal-post-commit:cancel",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      target: "cancelled",
    });

    expect(observedStatus).toBe("cancelled");
  });

  it("새 Work는 생성 시점의 자율성 snapshot을 고정하고 replay에서는 유지한다", async () => {
    let snapshot: { readonly mode: "automatic" | "review" | "full-access"; readonly revision: number } = {
      mode: "full-access",
      revision: 4,
    };
    const lineageService = await WorkService.create(
      database,
      organizations,
      undefined,
      undefined,
      undefined,
      async () => snapshot,
    );
    const input = {
      commandId: crypto.randomUUID(),
      text: "자율성 계보 요청",
      surface: "desktop",
      organizationVersionId: "org-v1",
    };
    const first = await lineageService.createWork(context, input);
    snapshot = { mode: "review", revision: 5 };
    const replay = await lineageService.createWork(context, input);
    const followUp = await lineageService.createFollowUpWork(context, {
      commandId: crypto.randomUUID(),
      parentWorkId: first.work.work_id,
      text: "새 모드의 후속 요청",
      surface: "desktop",
    });

    expect(first.work).toMatchObject({ autonomy_mode: "full-access", autonomy_revision: 4 });
    expect(replay.work).toMatchObject({ autonomy_mode: "full-access", autonomy_revision: 4 });
    expect(followUp.work).toMatchObject({ autonomy_mode: "review", autonomy_revision: 5 });
  });

  it("명세의 모든 Work 상태 전이 간선을 정확히 허용한다", () => {
    const expected: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
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
    const statuses = Object.keys(expected) as WorkStatus[];
    for (const current of statuses) {
      for (const target of statuses)
        expect(canTransitionWork(current, target)).toBe(expected[current].includes(target));
    }
  });

  it("같은 command는 같은 결과를 반환하고 다른 payload 재사용은 거부한다", async () => {
    const input = { commandId: crypto.randomUUID(), text: "요청", surface: "api", organizationVersionId: "org-v1" };
    const first = await service.createWork(context, input);
    const repeated = await service.createWork(context, input);

    expect(repeated.work.work_id).toBe(first.work.work_id);
    await expect(service.createWork(context, { ...input, text: "다른 요청" })).rejects.toThrow("다른 명령");
  });

  it("유효한 PlanVersion 없이는 planned가 될 수 없고 금지 전이를 거부한다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "요청",
      surface: "desktop",
      organizationVersionId: "org-v1",
    });

    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: 1,
        target: "planned",
      }),
    ).rejects.toThrow("PlanVersion");
    const planned = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: 1,
      content: { objective: "완성" },
    });
    const transitioned = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      target: "planned",
    });

    expect(transitioned.work.status).toBe("planned");
    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: transitioned.work.revision,
        target: "running",
      }),
    ).rejects.toThrow("허용되지 않은 Work 상태 전이");
  });

  it("같은 revision의 동시 변경은 하나만 commit하고 Event sequence를 보존한다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "요청",
      surface: "api",
      organizationVersionId: "org-v1",
    });
    const commands = ["첫 계획", "둘째 계획"].map((objective) =>
      service.addPlan(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: 1,
        content: { objective },
      }),
    );

    const results = await Promise.allSettled(commands);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await service.listEvents(context, created.work.work_id)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("cross-tenant 접근을 거부하고 저장소 우회 위반을 준수 검사로 찾는다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "검사",
      surface: "api",
      organizationVersionId: "org-v1",
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    await expect(
      service.getWork({ ...otherContext, organizationId: context.organizationId }, created.work.work_id),
    ).rejects.toThrow("TenantContext");
    await expect(
      database.query(
        "UPDATE work SET status = 'completed' WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: created.work.work_id },
      ),
    ).rejects.toThrow("Assurance bootstrap");
    await database.query(
      "UPDATE work SET revision = 99 WHERE organization_id = $organization_id AND work_id = $work_id;",
      {
        organization_id: context.organizationId,
        work_id: created.work.work_id,
      },
    );
    const findings = await service.auditWork(context, created.work.work_id);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["revision"]));
  });
});

describe("Work workspace 바인딩", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await WorkService.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("workspaceId를 지정하면 Work에 저장되고 follow-up Work가 상속한다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "환불 API를 추가한다",
      surface: "cli",
      organizationVersionId: "organization-version-1",
      workspaceId: "workspace-shop-api",
    });
    expect(created.work.workspace_id).toBe("workspace-shop-api");

    await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      target: "cancelled",
    });
    const followUp = await service.createFollowUpWork(context, {
      commandId: crypto.randomUUID(),
      parentWorkId: created.work.work_id,
      text: "후속 지시를 반영한다",
      surface: "cli",
    });
    expect(followUp.work.workspace_id).toBe("workspace-shop-api");
  });

  it("workspaceId 없이 만든 Work는 workspace 바인딩이 없다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "일반 요청",
      surface: "cli",
      organizationVersionId: "organization-version-1",
    });
    expect(created.work.workspace_id).toBeUndefined();
  });

  it("Task 목록 조회는 전달된 transaction executor로 Work와 Task를 함께 읽는다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "transaction snapshot",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    const queries: string[] = [];
    const defaultQuery = database.query.bind(database);
    const defaultQuerySpy = vi.spyOn(database, "query");
    const executor: QueryExecutor = {
      query: async <R>(surql: string, bindings?: Record<string, unknown>) => {
        queries.push(surql);
        return await defaultQuery<R>(surql, bindings);
      },
    };

    await service.listTasks(context, created.work.work_id, executor);

    expect(defaultQuerySpy).not.toHaveBeenCalled();
    expect(queries.some((query) => query.includes("FROM membership"))).toBe(true);
    expect(queries.some((query) => query.includes("FROM work "))).toBe(true);
    expect(queries.some((query) => query.includes("FROM work_task "))).toBe(true);
  });
});
