import { beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OrganizationGraphService } from "./organization.js";

describe("Organization Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let approvals: ApprovalStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "org-gate@example.com", displayName: "Org Gate" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
    graph = await OrganizationGraphService.create(database, organizations, gate);
    await graph.bootstrap(context);
  });

  it("승인과 일회 Permit 없이는 조직 version을 변경하지 않는다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "engineering",
      name: "Engineering",
      responsibility: "개발",
      parentHandle: "delivery-coordination",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    expect(await graph.listNodes(context)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ handle: "engineering" })]),
    );
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    const changed = await graph.execute(context, { ...command, governanceApprovalId: required.approvalId });

    expect(changed.version.version).toBe(2);
    expect(changed.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ handle: "engineering" })]));
  });

  it("단일 Work profile 승인을 연결하고 외부 transaction 취소 시 조직 변경과 승인 소비를 함께 rollback한다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile" as const,
      profileId: "transactional-staffing",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "transactional-engineering",
          name: "Transactional Engineering",
          responsibility: "원자적 조직 변경",
          outputs: ["Delivery"],
          capabilities: ["transactional-staffing"],
          parentHandle: "delivery-coordination",
          scope: "work" as const,
          workId: "work-transactional-staffing",
          role: "operator" as const,
        },
      ],
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    expect((await approvals.get(context, required.approvalId)).work_id).toBe("work-transactional-staffing");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    await expect(
      database.transaction(async (transaction) => {
        const changed = await graph.execute(
          context,
          { ...command, governanceApprovalId: required.approvalId },
          transaction,
        );
        expect(changed.version.version).toBe(2);
        throw new Error("상위 Dynamic Staffing 실패");
      }),
    ).rejects.toThrow("상위 Dynamic Staffing 실패");

    expect(await graph.listNodes(context)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ handle: "transactional-engineering" })]),
    );
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);
    expect((await approvals.get(context, required.approvalId)).status).toBe("approved");
    const [permits] = await database.query<[Array<{ readonly permit_id: string }>]>(
      "SELECT permit_id FROM governance_execution_permit WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: required.approvalId },
    );
    expect(permits).toHaveLength(0);
  });

  it("외부 transaction 전에 발생한 승인 필요 기록은 이후 원자 적용과 분리해 유지한다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "approval-persistence",
      name: "Approval Persistence",
      responsibility: "승인 기록 보존",
      parentHandle: "delivery-coordination",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;

    try {
      await graph.authorizeExecution(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }

    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    await expect(approvals.get(context, required.approvalId)).resolves.toMatchObject({ status: "pending" });
    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);
  });

  it("조직 변경 적용 전 transaction 검증이 실패하면 승인 소비도 rollback한다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "orphan",
      name: "Orphan",
      responsibility: "invalid",
      parentHandle: "missing-parent",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    await expect(graph.execute(context, { ...command, governanceApprovalId: required.approvalId })).rejects.toThrow(
      "대상 노드를 찾을 수 없습니다",
    );

    expect((await approvals.get(context, required.approvalId)).status).toBe("approved");
  });

  it.each([
    {
      name: "node payload",
      mutate: (command: {
        readonly commandId: string;
        readonly expectedVersion: number;
        readonly kind: "install-profile";
        readonly profileId: string;
        readonly profileVersion: string;
        readonly nodes: readonly {
          readonly handle: string;
          readonly name: string;
          readonly responsibility: string;
          readonly outputs: readonly string[];
          readonly capabilities: readonly string[];
          readonly parentHandle: string;
          readonly scope: "work";
          readonly workId: string;
          readonly role: "operator";
        }[];
      }) => ({
        ...command,
        nodes: command.nodes.map((node) => ({ ...node, capabilities: ["tampered-capability"] })),
      }),
    },
    {
      name: "command kind",
      mutate: (command: {
        readonly commandId: string;
        readonly expectedVersion: number;
        readonly kind: "install-profile";
        readonly profileId: string;
        readonly profileVersion: string;
        readonly nodes: readonly {
          readonly handle: string;
          readonly name: string;
          readonly responsibility: string;
          readonly outputs: readonly string[];
          readonly capabilities: readonly string[];
          readonly parentHandle: string;
          readonly scope: "work";
          readonly workId: string;
          readonly role: "operator";
        }[];
      }) => ({
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        kind: "create" as const,
        handle: "payload-bound-create",
        name: "Payload Bound Create",
        responsibility: "승인되지 않은 kind 변경",
        parentHandle: "delivery-coordination",
        scope: "persistent" as const,
      }),
    },
  ])("승인된 $name 변경 payload를 같은 ID로 바꾸면 Permit과 graph를 만들지 않는다", async ({ mutate }) => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile" as const,
      profileId: "payload-bound-profile",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "payload-bound-agent",
          name: "Payload Bound Agent",
          responsibility: "승인된 payload만 적용한다",
          outputs: ["Bound Output"],
          capabilities: ["payload-binding"],
          parentHandle: "delivery-coordination",
          scope: "work" as const,
          workId: "work-payload-binding",
          role: "operator" as const,
        },
      ],
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "원래 payload만 승인합니다",
    });

    await expect(
      graph.execute(context, { ...mutate(command), governanceApprovalId: required.approvalId }),
    ).rejects.toThrow("request hash precondition");

    expect((await graph.getCurrentSnapshot(context)).version.version).toBe(1);
    expect((await approvals.get(context, required.approvalId)).status).toBe("approved");
    const [permits] = await database.query<[Array<{ readonly permit_id: string }>]>(
      "SELECT permit_id FROM governance_execution_permit WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: required.approvalId },
    );
    expect(permits).toHaveLength(0);
  });

  it("외부 transaction의 이미 적용된 command replay는 새 승인 없이 기존 결과를 반환한다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "external-replay",
      name: "External Replay",
      responsibility: "외부 transaction replay를 검증한다",
      parentHandle: "delivery-coordination",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "외부 transaction 적용을 승인합니다",
    });
    await database.transaction(
      async (transaction) =>
        await graph.execute(context, { ...command, governanceApprovalId: required.approvalId }, transaction),
    );
    const [beforeApprovals] = await database.query<[Array<{ readonly approval_id: string }>]>(
      "SELECT approval_id FROM governance_approval WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );

    const replayed = await database.transaction(
      async (transaction) => await graph.execute(context, command, transaction),
    );

    expect(replayed.version.version).toBe(2);
    expect(replayed.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ handle: "external-replay" })]));
    const [afterApprovals] = await database.query<[Array<{ readonly approval_id: string }>]>(
      "SELECT approval_id FROM governance_approval WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(afterApprovals).toEqual(beforeApprovals);
    expect((await approvals.get(context, required.approvalId)).status).toBe("consumed");
  });
});
