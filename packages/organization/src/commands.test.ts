import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OrganizationGraphService, type OrganizationCommand } from "./organization.js";

type CommandInput<Command> = Command extends unknown ? Omit<Command, "commandId" | "expectedVersion"> : never;

describe("버전 기반 조직 명령", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let version: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    version = Number((await graph.bootstrap(context)).version.version);
  });

  afterEach(async () => database.close());

  async function execute(command: CommandInput<OrganizationCommand>) {
    const result = await graph.execute(context, {
      ...command,
      commandId: crypto.randomUUID(),
      expectedVersion: version,
    } as OrganizationCommand);
    version = Number(result.version.version);
    return result;
  }

  async function create(handle: string, parentHandle = "delivery-coordination") {
    return await execute({
      kind: "create",
      handle,
      name: handle,
      responsibility: `${handle} 책임`,
      parentHandle,
      scope: "persistent",
    });
  }

  it("상태·이동·역할·승격을 각각 새 version으로 적용한다", async () => {
    const created = await create("engineering");
    const createdAt = String(created.nodes.find((node) => node.handle === "engineering")?.created_at);
    await create("backend", "engineering");
    await execute({ kind: "deactivate", handle: "backend" });
    await execute({ kind: "activate", handle: "backend" });
    await execute({ kind: "move", handle: "backend", parentHandle: "evidence-research" });
    await execute({ kind: "change-role", handle: "backend", role: "coordinator" });
    const result = await execute({ kind: "promote", handle: "backend", role: "orchestrator" });

    const backend = result.nodes.find((node) => node.handle === "backend");
    expect(backend).toMatchObject({ parent_handle: "evidence-research", status: "active", role: "orchestrator" });
    expect(String(result.nodes.find((node) => node.handle === "engineering")?.created_at)).toBe(createdAt);
    expect(version).toBe(8);
    await expect(execute({ kind: "promote", handle: "backend", role: "operator" })).rejects.toThrow("높은 역할");
  });

  it("자기 하위로 이동하는 cycle과 잘못된 work scope를 거부한다", async () => {
    await create("engineering");
    await create("backend", "engineering");

    await expect(execute({ kind: "move", handle: "engineering", parentHandle: "backend" })).rejects.toThrow("cycle");
    await expect(
      execute({
        kind: "create",
        handle: "temporary",
        name: "Temporary",
        responsibility: "임시",
        parentHandle: "delivery-coordination",
        scope: "work",
      }),
    ).rejects.toThrow("workId");
    await execute({
      kind: "create",
      handle: "temporary",
      name: "Temporary",
      responsibility: "임시",
      parentHandle: "delivery-coordination",
      scope: "work",
      workId: "work-owner",
    });
    await expect(
      execute({
        kind: "create",
        handle: "persistent-child",
        name: "Persistent Child",
        responsibility: "영속 자식",
        parentHandle: "temporary",
        scope: "persistent",
      }),
    ).rejects.toThrow("persistent");
    await expect(
      execute({
        kind: "create",
        handle: "foreign-work-child",
        name: "Foreign Work Child",
        responsibility: "다른 Work 자식",
        parentHandle: "temporary",
        scope: "work",
        workId: "work-other",
      }),
    ).rejects.toThrow("같은 Work");
    await expect(execute({ kind: "deactivate", handle: "engineering" })).rejects.toThrow("부모는 active");
  });

  it("split은 선택한 자식을 새 노드로 옮기고 merge는 자식을 생존 노드로 옮긴다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await create("frontend", "engineering");
    let result = await execute({
      kind: "split",
      sourceHandle: "engineering",
      newHandle: "platform",
      name: "Platform",
      responsibility: "플랫폼",
      childHandles: ["backend"],
      referencePlan: [],
    });
    expect(result.nodes.find((node) => node.handle === "backend")?.parent_handle).toBe("platform");

    result = await execute({
      kind: "merge",
      survivorHandle: "engineering",
      sourceHandle: "platform",
      referencePlan: [],
    });
    expect(result.nodes.find((node) => node.handle === "backend")?.parent_handle).toBe("engineering");
    expect(result.nodes.find((node) => node.handle === "platform")?.status).toBe("retired");
  });

  it("retire와 restore를 수행하고 과거 snapshot으로 revert해도 새 version을 만든다", async () => {
    await create("engineering");
    const createdVersion = version;
    await execute({ kind: "retire", handle: "engineering" });
    await execute({ kind: "restore", handle: "engineering" });
    await execute({ kind: "change-role", handle: "engineering", role: "coordinator" });
    const reverted = await execute({ kind: "revert", targetVersion: createdVersion });

    expect(reverted.nodes.find((node) => node.handle === "engineering")).toMatchObject({
      status: "active",
      role: "operator",
    });
    expect(Number(reverted.version.version)).toBe(6);
    expect(reverted.version.command_kind).toBe("revert");
    expect(reverted.impact.nodeHandles).toContain("engineering");
  });

  it("기존 빈 Core Office snapshot으로 revert해도 정본 역량을 유지한다", async () => {
    const [versions] = await database.query<[{ readonly after_json: string }[]]>(
      "SELECT after_json FROM organization_version WHERE organization_id = $organization_id AND version = 1;",
      { organization_id: context.organizationId },
    );
    const legacy = JSON.parse(versions[0]?.after_json ?? "[]") as Array<{ builtin?: boolean; capabilities?: string[] }>;
    await database.query(
      "UPDATE organization_version SET after_json = $after_json WHERE organization_id = $organization_id AND version = 1;",
      {
        organization_id: context.organizationId,
        after_json: JSON.stringify(legacy.map((node) => (node.builtin ? { ...node, capabilities: [] } : node))),
      },
    );

    await create("engineering");
    const reverted = await execute({ kind: "revert", targetVersion: 1 });

    expect(reverted.nodes.find((node) => node.handle === "evidence-research")?.capabilities).toEqual([
      "evidence-research",
    ]);
    expect(await graph.auditCompliance(context)).toEqual([]);
  });

  it("영향 분석에 모든 하위 노드와 등록된 참조를 포함한다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await graph.registerReference(context, "backend", "skill", "typescript");
    await graph.registerReference(context, "engineering", "work", "work-1");

    const impact = await graph.analyzeImpact(context, ["engineering"]);

    expect(impact.nodeHandles).toEqual(["backend", "engineering"]);
    expect(impact.references.map((reference) => `${reference.kind}:${reference.target_id}`).sort()).toEqual([
      "skill:typescript",
      "work:work-1",
    ]);
    await expect(graph.analyzeImpact(context, ["missing"])).rejects.toThrow("대상 노드");
  });

  it("Work 범위 Agent를 동일 정체성·역할·참조를 유지한 영구 Agent로 승격하고 재실행한다", async () => {
    const created = await execute({
      kind: "install-profile",
      profileId: "work-agent",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "work-specialist",
          name: "Work Specialist",
          responsibility: "Work 전용 구현",
          outputs: ["Delivery"],
          capabilities: ["typescript"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-owner",
          role: "coordinator",
        },
      ],
    });
    const before = created.nodes.find((node) => node.handle === "work-specialist");
    const reference = await graph.registerReference(context, "work-specialist", "task", "task-1");
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: version,
      kind: "promote-scope" as const,
      handle: "work-specialist",
      workId: "work-owner",
      governanceEnvironment: "local",
    };

    const promoted = await graph.execute(context, { ...command, governanceApprovalId: "approval-original" });
    const repeated = await graph.execute(context, command);
    const repeatedWithDifferentApproval = await graph.execute(context, {
      ...command,
      governanceApprovalId: "approval-different",
    });
    const promotedNode = promoted.nodes.find((node) => node.handle === "work-specialist");

    expect(promotedNode).toMatchObject({
      node_id: before?.node_id,
      handle: "work-specialist",
      scope: "persistent",
      work_id: undefined,
      role: "coordinator",
      capabilities: ["typescript"],
      status: "active",
    });
    expect(promotedNode?.created_at).toBe(before?.created_at);
    const expectedReference = {
      reference_id: reference.reference_id,
      organization_id: context.organizationId,
      node_handle: "work-specialist",
      kind: "task",
      target_id: "task-1",
    };
    expect(promoted.impact).toEqual({ nodeHandles: ["work-specialist"], references: [expectedReference] });
    expect(promoted.version).toMatchObject({
      version: 3,
      previous_version: 2,
      command_kind: "promote-scope",
      actor_user_id: context.userId,
    });
    expect(JSON.parse(promoted.version.before_json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "work-specialist", scope: "work", work_id: "work-owner" }),
      ]),
    );
    const afterAudit = JSON.parse(promoted.version.after_json) as Record<string, unknown>[];
    const promotedAuditNode = afterAudit.find((node) => node.handle === "work-specialist");
    expect(promotedAuditNode).toMatchObject({ handle: "work-specialist", scope: "persistent" });
    expect(promotedAuditNode).not.toHaveProperty("work_id");
    expect(repeated.version.version_id).toBe(promoted.version.version_id);
    expect(repeatedWithDifferentApproval.version.version_id).toBe(promoted.version.version_id);
    expect(promoted.version.request_json).not.toContain("approval-original");
    await expect(graph.execute(context, { ...command, workId: "work-other" })).rejects.toThrow(
      "같은 commandId에 다른 명령",
    );
    await expect(graph.execute(context, { ...command, handle: "other-specialist" })).rejects.toThrow(
      "같은 commandId에 다른 명령",
    );
    expect(await graph.analyzeImpact(context, ["work-specialist"])).toEqual({
      nodeHandles: ["work-specialist"],
      references: [expectedReference],
    });
  });

  it("영구 범위 승격은 대상 상태·원래 Work·부모 범위·version 경계를 모두 강제한다", async () => {
    await execute({
      kind: "install-profile",
      profileId: "scope-boundaries",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "persistent-agent",
          name: "Persistent Agent",
          responsibility: "영구 Agent",
          outputs: ["Delivery"],
          capabilities: ["delivery"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
        {
          handle: "active-work-agent",
          name: "Active Work Agent",
          responsibility: "활성 Work Agent",
          outputs: ["Delivery"],
          capabilities: ["delivery"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-owner",
          role: "operator",
        },
        {
          handle: "inactive-work-agent",
          name: "Inactive Work Agent",
          responsibility: "비활성 Work Agent",
          outputs: ["Delivery"],
          capabilities: ["delivery"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-owner",
          role: "operator",
        },
        {
          handle: "retired-work-agent",
          name: "Retired Work Agent",
          responsibility: "폐기 Work Agent",
          outputs: ["Delivery"],
          capabilities: ["delivery"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-owner",
          role: "operator",
        },
        {
          handle: "work-parent",
          name: "Work Parent",
          responsibility: "Work 부모",
          outputs: ["Coordination"],
          capabilities: ["coordination"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-owner",
          role: "coordinator",
        },
        {
          handle: "work-child",
          name: "Work Child",
          responsibility: "Work 자식",
          outputs: ["Delivery"],
          capabilities: ["delivery"],
          parentHandle: "work-parent",
          scope: "work",
          workId: "work-owner",
          role: "operator",
        },
      ],
    });
    await execute({ kind: "deactivate", handle: "inactive-work-agent" });
    await execute({ kind: "retire", handle: "retired-work-agent" });

    const currentVersion = version;
    const promote = (handle: string, workId = "work-owner", expectedVersion = currentVersion) =>
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion,
        kind: "promote-scope",
        handle,
        workId,
      });

    await expect(promote("representative")).rejects.toThrow("Core Office");
    await expect(promote("persistent-agent")).rejects.toThrow("Work 범위");
    await expect(promote("inactive-work-agent")).rejects.toThrow("active");
    await expect(promote("retired-work-agent")).rejects.toThrow("active");
    await expect(promote("active-work-agent", "work-other")).rejects.toThrow("다른 Work");
    await expect(promote("work-child")).rejects.toThrow("persistent 노드는 Work 범위 부모");
    await expect(promote("active-work-agent", "work-owner", currentVersion - 1)).rejects.toThrow(
      "현재 OrganizationVersion",
    );
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(currentVersion);
    expect((await graph.listNodes(context)).find((node) => node.handle === "active-work-agent")).toMatchObject({
      scope: "work",
      work_id: "work-owner",
      status: "active",
    });

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "scope-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(
      graph.execute(
        { ...otherContext, organizationId: context.organizationId },
        {
          commandId: crypto.randomUUID(),
          expectedVersion: currentVersion,
          kind: "promote-scope",
          handle: "active-work-agent",
          workId: "work-owner",
        },
      ),
    ).rejects.toThrow("TenantContext");
  });

  it("split과 merge는 source 참조 처리 계획을 강제하고 원자 이동한다", async () => {
    await create("engineering");
    const reference = await graph.registerReference(context, "engineering", "task", "task-1");

    await expect(
      execute({
        kind: "split",
        sourceHandle: "engineering",
        newHandle: "platform",
        name: "Platform",
        responsibility: "플랫폼",
        childHandles: [],
        referencePlan: [],
      }),
    ).rejects.toThrow("참조 처리 계획");
    const split = await execute({
      kind: "split",
      sourceHandle: "engineering",
      newHandle: "platform",
      name: "Platform",
      responsibility: "플랫폼",
      childHandles: [],
      referencePlan: [{ referenceId: reference.reference_id, action: "move", targetHandle: "platform" }],
    });

    expect(split.version.version).toBe(3);
    expect((await graph.analyzeImpact(context, ["platform"])).references[0]?.target_id).toBe("task-1");
  });

  it("다른 tenant의 Context로 그래프를 읽거나 변경하지 못한다", async () => {
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    await expect(graph.listNodes({ ...otherContext, organizationId: context.organizationId })).rejects.toThrow(
      "TenantContext",
    );
  });

  it("준수 검사는 변형과 고아 관계를 보고하되 자동 수정하지 않는다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await database.query(
      "UPDATE organization_node SET name = 'Changed' WHERE organization_id = $organization_id AND handle = 'governance'; UPDATE organization_node SET parent_handle = 'missing' WHERE organization_id = $organization_id AND handle = 'growth'; UPDATE organization_node SET parent_handle = 'backend' WHERE organization_id = $organization_id AND handle = 'engineering';",
      { organization_id: context.organizationId },
    );

    const findings = await graph.auditCompliance(context);

    expect(findings.map((finding) => `${finding.code}:${finding.handle}`)).toEqual(
      expect.arrayContaining(["core-office:governance", "core-office:growth", "orphan:growth"]),
    );
    expect(findings.some((finding) => finding.code === "cycle" && finding.handle === "engineering")).toBe(true);
    expect((await graph.listNodes(context)).find((node) => node.handle === "governance")?.name).toBe("Changed");
  });

  it("같은 version의 동시 변경은 하나만 commit한다", async () => {
    const results = await Promise.allSettled([
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        kind: "create",
        handle: "one",
        name: "One",
        responsibility: "One",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      }),
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        kind: "create",
        handle: "two",
        name: "Two",
        responsibility: "Two",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await graph.listNodes(context)).toHaveLength(9);
  });
});
