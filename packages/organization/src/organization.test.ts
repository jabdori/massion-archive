import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { CORE_OFFICE_HANDLES, OrganizationGraphService } from "./organization.js";

describe("Organization Graph와 Core Office", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let graph: OrganizationGraphService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  it("Core Office 8개와 bootstrap version을 멱등 생성한다", async () => {
    const first = await graph.bootstrap(context);
    const second = await graph.bootstrap(context);

    expect(first.nodes.map((node) => node.handle).sort()).toEqual([...CORE_OFFICE_HANDLES].sort());
    expect(first.nodes.find((node) => node.handle === "representative")?.outputs).toEqual([
      "Request",
      "Work",
      "FinalResult",
    ]);
    expect(first.version.version).toBe(1);
    expect(second.version.version).toBe(1);
    expect(await graph.listNodes(context)).toHaveLength(8);
  });

  it("Core Office는 비활성화하거나 이동할 수 없다", async () => {
    await graph.bootstrap(context);

    await expect(
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        kind: "deactivate",
        handle: "governance",
      }),
    ).rejects.toThrow("Core Office");
  });

  it("stale version을 거부하고 같은 command는 같은 결과를 반환한다", async () => {
    await graph.bootstrap(context);
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "specialists",
      name: "Specialists",
      responsibility: "전문 업무",
      parentHandle: "delivery-coordination",
      scope: "persistent" as const,
    };

    const first = await graph.execute(context, { ...command, governanceApprovalId: "approval-original" });
    const repeated = await graph.execute(context, command);
    const repeatedWithDifferentApproval = await graph.execute(context, {
      ...command,
      governanceApprovalId: "approval-different",
    });
    expect(first.version.version).toBe(2);
    expect(repeated.version.version).toBe(2);
    expect(repeatedWithDifferentApproval.version.version_id).toBe(first.version.version_id);
    expect(first.version.request_json).not.toContain("approval-original");
    await expect(graph.execute(context, { ...command, handle: "different" })).rejects.toThrow(
      "같은 commandId에 다른 명령",
    );
    await expect(graph.execute(context, { ...command, commandId: crypto.randomUUID() })).rejects.toThrow(
      "현재 OrganizationVersion",
    );
  });

  it("profile의 누락 부모와 cycle을 거부하고 조직 노드를 원자적으로 보존한다", async () => {
    await graph.bootstrap(context);
    const base = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile" as const,
      profileId: "invalid-profile",
      profileVersion: "1.0.0",
    };
    await expect(
      graph.execute(context, {
        ...base,
        nodes: [
          {
            handle: "orphan-specialist",
            name: "Orphan",
            responsibility: "누락 부모 검증",
            outputs: ["Finding"],
            capabilities: ["testing"],
            parentHandle: "missing-parent",
            scope: "persistent",
            role: "operator",
          },
        ],
      }),
    ).rejects.toThrow("고아 부모");
    expect(await graph.listNodes(context)).toHaveLength(8);

    await expect(
      graph.execute(context, {
        ...base,
        commandId: crypto.randomUUID(),
        nodes: [
          {
            handle: "cycle-a",
            name: "Cycle A",
            responsibility: "cycle 검증",
            outputs: ["Finding"],
            capabilities: ["testing-a"],
            parentHandle: "cycle-b",
            scope: "persistent",
            role: "operator",
          },
          {
            handle: "cycle-b",
            name: "Cycle B",
            responsibility: "cycle 검증",
            outputs: ["Finding"],
            capabilities: ["testing-b"],
            parentHandle: "cycle-a",
            scope: "persistent",
            role: "operator",
          },
        ],
      }),
    ).rejects.toThrow("cycle");
    expect(await graph.listNodes(context)).toHaveLength(8);
  });

  it("profile 설치는 owner와 Governance를 정확히 한 번 통과한다", async () => {
    await graph.bootstrap(context);
    let authorizationCount = 0;
    const governed = await OrganizationGraphService.create(database, organizations, {
      authorize: async () => {
        authorizationCount += 1;
      },
    });
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile" as const,
      profileId: "governed-profile",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "governed-specialist",
          name: "Governed Specialist",
          responsibility: "Governance 검증",
          outputs: ["Finding"],
          capabilities: ["governed-testing"],
          parentHandle: "delivery-coordination",
          scope: "persistent" as const,
          role: "operator" as const,
        },
      ],
    };
    const first = await governed.execute(context, command);
    const repeated = await governed.execute(context, command);
    expect(repeated.version.version_id).toBe(first.version.version_id);
    expect(authorizationCount).toBe(1);

    const memberContext = { ...context, role: "member" as const };
    await expect(
      governed.execute(memberContext, { ...command, commandId: crypto.randomUUID(), expectedVersion: 2 }),
    ).rejects.toThrow("owner");
    expect(authorizationCount).toBe(1);
  });

  it("사전 승인 receipt는 원자 transaction의 정확한 command에만 쓰이고 crash 뒤 재승인으로 수렴한다", async () => {
    await graph.bootstrap(context);
    let authorizationCount = 0;
    const governed = await OrganizationGraphService.create(database, organizations, {
      authorize: async () => {
        authorizationCount += 1;
        return { outcome: "allow" };
      },
    });
    const command = {
      commandId: "organization-preauthorization-command-0001",
      expectedVersion: 1,
      kind: "install-profile" as const,
      profileId: "preauthorization-profile",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "preauthorized-specialist",
          name: "Preauthorized Specialist",
          responsibility: "사전 승인 원자 적용 검증",
          outputs: ["Finding"],
          capabilities: ["preauthorization-testing"],
          parentHandle: "delivery-coordination",
          scope: "persistent" as const,
          role: "operator" as const,
        },
      ],
    };

    await expect(
      database.transaction(async (transaction) => await governed.execute(context, command, transaction)),
    ).rejects.toThrow("검증된 사전 승인");
    expect(authorizationCount).toBe(0);

    const crashedAuthorization = await governed.authorizeExecution(context, command);
    await expect(
      database.transaction(async (transaction) => {
        await governed.execute(context, command, transaction, crashedAuthorization);
        throw new Error("organization-preauthorization-checkpoint-crash");
      }),
    ).rejects.toThrow("organization-preauthorization-checkpoint-crash");
    expect((await governed.getCurrentSnapshot(context)).version.version).toBe(1);
    expect(await governed.listNodes(context)).toHaveLength(8);
    await expect(
      database.transaction(
        async (transaction) => await governed.execute(context, command, transaction, crashedAuthorization),
      ),
    ).rejects.toThrow("검증된 사전 승인");

    const recoveredAuthorization = await governed.authorizeExecution(context, command);
    await expect(
      database.transaction(
        async (transaction) => await governed.execute(context, command, transaction, recoveredAuthorization),
      ),
    ).resolves.toMatchObject({ version: { version: 2 } });
    expect(authorizationCount).toBe(2);
    await expect(
      database.transaction(
        async (transaction) => await governed.execute(context, command, transaction, recoveredAuthorization),
      ),
    ).resolves.toMatchObject({ version: { version: 2 } });

    const nextCommand = {
      ...command,
      commandId: "organization-preauthorization-command-0002",
      expectedVersion: 2,
      profileId: "preauthorization-profile-next",
      nodes: command.nodes.map((node) => ({ ...node, handle: "preauthorized-specialist-next" })),
    };
    const nextAuthorization = await governed.authorizeExecution(context, nextCommand);
    await expect(
      database.transaction(
        async (transaction) =>
          await governed.execute(
            context,
            { ...nextCommand, profileVersion: "tampered" },
            transaction,
            nextAuthorization,
          ),
      ),
    ).rejects.toThrow("검증된 사전 승인");
    await expect(
      database.transaction(
        async (transaction) => await governed.execute(context, nextCommand, transaction, nextAuthorization),
      ),
    ).resolves.toMatchObject({ version: { version: 3 } });
  });
});
