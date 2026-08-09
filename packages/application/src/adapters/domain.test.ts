import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AutonomyStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  ApprovalStore,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { SubscriptionPolicyStore } from "@massion/subscriptions";
import { WorkService } from "@massion/work";
import { WorkspaceService } from "@massion/workspace";
import { describe, expect, it, vi } from "vitest";

import { ApplicationCommandRegistry } from "../command-registry.js";
import { ApplicationCommandStore } from "../command-store.js";
import { registerApplicationDomainCommands } from "./domain.js";

describe("Application domain adapters", () => {
  it("Growth 승인은 저장된 Approval을 결정한 뒤 원래 Adoption command를 replay한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "growth-approve@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const getSuggestionDetails = vi.fn().mockResolvedValue({
      suggestion: { suggestion_id: "suggestion-approve", revision: 2 },
      evaluation: { evaluationRunId: "evaluation-approve", outcome: "eligible", inputHash: "e".repeat(64) },
      adoption: {
        adoptionId: "adoption-approve",
        status: "awaiting-review",
        commandId: "adoption-original-command",
        approvalId: "approval-approve",
        evaluationRunId: "evaluation-approve",
        evaluationInputHash: "e".repeat(64),
        beforeVersionId: "prompt-v1",
        beforeChecksum: "b".repeat(64),
      },
    });
    const adopt = vi.fn().mockResolvedValue({ adoption: { adoption_id: "adoption-approve", status: "observing" } });
    const vote = vi.fn().mockResolvedValue({ approval_id: "approval-approve", status: "approved", revision: 2 });
    registerApplicationDomainCommands(registry, {
      growth: { getSuggestionDetails, adopt } as never,
      approvals: {
        get: vi.fn().mockResolvedValue({ approval_id: "approval-approve", status: "pending", revision: 1 }),
        vote,
        cancel: vi.fn(),
      } as never,
    });

    await registry.dispatch(context, ["growth:write", "approval:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "growth-approve-command",
      correlationId: "growth-approve-correlation",
      operation: "growth.suggestion.approve",
      payload: { suggestionId: "suggestion-approve", expectedRevision: 2, reason: "근거를 확인했습니다" },
    });

    expect(vote).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        commandId: "growth-approve-command:approval",
        approvalId: "approval-approve",
        expectedRevision: 1,
        vote: "approve",
      }),
    );
    expect(adopt).toHaveBeenCalledWith(context, {
      commandId: "adoption-original-command",
      suggestionId: "suggestion-approve",
      suggestionRevision: 2,
      evaluationRunId: "evaluation-approve",
      expectedEvaluationInputHash: "e".repeat(64),
      expectedTargetChecksum: "b".repeat(64),
      approvalId: "approval-approve",
    });
  });

  it("Growth 거절은 연결된 pending Approval을 먼저 취소한 뒤 Suggestion을 같은 명령 계보로 종료한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "growth-reject@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const reject = vi.fn().mockResolvedValue({ suggestionId: "suggestion-reject", status: "rejected", revision: 3 });
    const cancel = vi
      .fn()
      .mockResolvedValue({ approval_id: "approval-growth-reject", status: "cancelled", revision: 4 });
    registerApplicationDomainCommands(registry, {
      growth: {
        getSuggestionDetails: vi.fn().mockResolvedValue({
          suggestion: { suggestion_id: "suggestion-reject", revision: 3 },
          adoption: {
            adoptionId: "adoption-reject",
            status: "awaiting-review",
            approvalId: "approval-growth-reject",
          },
        }),
        reject,
      } as never,
      approvals: {
        get: vi.fn().mockResolvedValue({ approval_id: "approval-growth-reject", status: "pending", revision: 3 }),
        vote: vi.fn(),
        cancel,
      } as never,
    });

    await registry.dispatch(context, ["growth:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "growth-reject-command",
      correlationId: "growth-reject-correlation",
      operation: "growth.suggestion.reject",
      payload: { suggestionId: "suggestion-reject", expectedRevision: 3, reason: "효과 대비 위험이 큽니다" },
    });

    expect(reject).toHaveBeenCalledWith(context, {
      commandId: "growth-reject-command",
      suggestionId: "suggestion-reject",
      expectedRevision: 3,
      reason: "효과 대비 위험이 큽니다",
    });
    expect(cancel).toHaveBeenCalledWith(context, {
      commandId: "growth-reject-command:approval-cancel",
      approvalId: "approval-growth-reject",
      reason: "연결된 Growth Suggestion이 거절되었습니다",
    });
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(reject.mock.invocationCallOrder[0] ?? 0);
  });

  it("Growth 거절 권한이 없는 member는 연결 Approval과 Suggestion을 모두 변경하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "growth-member-owner@example.com",
      displayName: "Owner",
    });
    const member = await identities.registerPersonalUser({ email: "growth-member@example.com", displayName: "Member" });
    const ownerContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, ownerContext.organizationId);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const cancel = vi.fn();
    const reject = vi.fn();
    registerApplicationDomainCommands(registry, {
      growth: { getSuggestionDetails: vi.fn(), reject } as never,
      approvals: { get: vi.fn(), vote: vi.fn(), cancel } as never,
    });

    await expect(
      registry.dispatch(memberContext, ["growth:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "growth-member-reject-command",
        correlationId: "growth-member-reject-correlation",
        operation: "growth.suggestion.reject",
        payload: { suggestionId: "suggestion-member-reject", expectedRevision: 1, reason: "거절" },
      }),
    ).rejects.toMatchObject({ category: "authorization" });
    expect(cancel).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("연결 Approval 취소가 실패하면 Growth Suggestion을 먼저 거절하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "growth-cancel-fail@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const reject = vi.fn();
    registerApplicationDomainCommands(registry, {
      growth: {
        getSuggestionDetails: vi.fn().mockResolvedValue({
          suggestion: { suggestion_id: "suggestion-cancel-fail", revision: 2 },
          adoption: {
            adoptionId: "adoption-cancel-fail",
            status: "awaiting-review",
            approvalId: "approval-cancel-fail",
          },
        }),
        reject,
      } as never,
      approvals: {
        get: vi.fn().mockResolvedValue({ approval_id: "approval-cancel-fail", status: "pending", revision: 1 }),
        vote: vi.fn(),
        cancel: vi.fn().mockRejectedValue(new Error("Approval cancellation 실패")),
      } as never,
    });

    await expect(
      registry.dispatch(context, ["growth:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "growth-cancel-fail-command",
        correlationId: "growth-cancel-fail-correlation",
        operation: "growth.suggestion.reject",
        payload: { suggestionId: "suggestion-cancel-fail", expectedRevision: 2, reason: "위험이 큽니다" },
      }),
    ).rejects.toMatchObject({ operatorCode: "APP_INTERNAL" });
    expect(reject).not.toHaveBeenCalled();
  });

  it("Growth 승인 투표가 quorum 대기이면 Adoption을 실행하지 않고 최종 Approval 상태를 반환한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "growth-quorum@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const adopt = vi.fn();
    registerApplicationDomainCommands(registry, {
      growth: {
        getSuggestionDetails: vi.fn().mockResolvedValue({
          suggestion: { suggestion_id: "suggestion-quorum", revision: 2 },
          evaluation: { evaluationRunId: "evaluation-quorum", outcome: "eligible", inputHash: "e".repeat(64) },
          adoption: {
            adoptionId: "adoption-quorum",
            status: "awaiting-review",
            commandId: "adoption-quorum-command",
            approvalId: "approval-quorum",
            evaluationRunId: "evaluation-quorum",
            evaluationInputHash: "e".repeat(64),
            beforeVersionId: "prompt-v1",
            beforeChecksum: "b".repeat(64),
          },
        }),
        adopt,
      } as never,
      approvals: {
        get: vi.fn().mockResolvedValue({ approval_id: "approval-quorum", status: "pending", revision: 4 }),
        vote: vi.fn().mockResolvedValue({ approval_id: "approval-quorum", status: "pending", revision: 5 }),
        cancel: vi.fn(),
      } as never,
    });

    await expect(
      registry.dispatch(context, ["growth:write", "approval:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "growth-quorum-command",
        correlationId: "growth-quorum-correlation",
        operation: "growth.suggestion.approve",
        payload: { suggestionId: "suggestion-quorum", expectedRevision: 2, reason: "첫 번째 승인 투표" },
      }),
    ).resolves.toMatchObject({
      outcome: "accepted",
      data: { approvalId: "approval-quorum", approvalStatus: "pending", approvalRevision: 5 },
    });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("만료된 Growth Approval은 내부 오류가 아니라 사용자 검증 오류로 반환한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "growth-expired@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      growth: {
        getSuggestionDetails: async () =>
          ({
            suggestion: { suggestion_id: "suggestion-expired", revision: 1 },
            evaluation: { evaluationRunId: "evaluation-expired", outcome: "eligible", inputHash: "e".repeat(64) },
            adoption: {
              adoptionId: "adoption-expired",
              status: "awaiting-review",
              commandId: "adoption-expired-command",
              approvalId: "approval-expired",
              evaluationRunId: "evaluation-expired",
              evaluationInputHash: "e".repeat(64),
              beforeVersionId: "before",
              beforeChecksum: "b".repeat(64),
            },
          }) as never,
        adopt: vi.fn(),
      } as never,
      approvals: {
        get: vi.fn().mockResolvedValue({ approval_id: "approval-expired", status: "expired", revision: 2 }),
        vote: vi.fn().mockRejectedValue(new Error("Approval이 만료됐습니다")),
        cancel: vi.fn(),
      } as never,
    });

    await expect(
      registry.dispatch(context, ["growth:write", "approval:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "growth-expired-command",
        correlationId: "growth-expired-correlation",
        operation: "growth.suggestion.approve",
        payload: { suggestionId: "suggestion-expired", expectedRevision: 1, reason: "승인" },
      }),
    ).rejects.toMatchObject({ operatorCode: "APP_DOMAIN_VALIDATION" });
  });

  it("승인 vote가 terminal이면 연결된 구독 Runtime 실행을 approvalId만으로 재개한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "approval-resume@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const resume = vi.fn().mockResolvedValue({ executionId: "execution-review", status: "succeeded" });
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      runtime: { resume } as never,
      approvals: {
        vote: async () => ({
          approval_id: "approval-review",
          execution_id: "execution-review",
          resume_target: "runtime-subscription",
          status: "approved",
          revision: 2,
        }),
        cancel: vi.fn(),
      } as never,
    });

    await registry.dispatch(context, ["approval:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "approval-vote-resume-command",
      correlationId: "approval-vote-resume-correlation",
      operation: "approval.vote",
      payload: { approvalId: "approval-review", vote: "approve", reason: "검증 완료" },
    });

    expect(resume).toHaveBeenCalledWith(context, "execution-review", { approvalId: "approval-review" });
  });

  it("실제 Work·Organization public service를 command registry에 연결하고 tenant·revision을 보존한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "domain@example.com", displayName: "Domain" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { works, organization: graph });

    const created = await registry.dispatch(context, ["work:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-work-create-command-0001",
      correlationId: "domain-work-create-correlation-0001",
      operation: "work.create",
      payload: {
        text: "Application 경계에서 Work 생성",
        surface: "cli",
        organizationVersionId: core.version.version_id,
      },
    });
    expect(created).toMatchObject({ outcome: "succeeded", resource: { type: "Work", revision: 1 } });
    const workId = (created.data as { workId: string }).workId;
    await expect(
      registry.dispatch(context, ["work:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-work-cancel-command-0001",
        correlationId: "domain-work-cancel-correlation-0001",
        operation: "work.cancel",
        expectedRevision: 1,
        payload: { workId },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "cancelled" } });

    await expect(
      registry.dispatch(context, ["organization:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-organization-command-0001",
        correlationId: "domain-organization-correlation-0001",
        operation: "organization.command",
        expectedRevision: 1,
        payload: {
          kind: "create",
          handle: "domain-specialist",
          name: "Domain Specialist",
          responsibility: "Application adapter 검증",
          parentHandle: "representative",
          scope: "persistent",
        },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "Organization", revision: 2 } });
  });

  it("governance.autonomy.set은 owner가 모드를 전환하고 revision을 보존한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "autonomy@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const autonomy = await AutonomyStore.create(database, organizations);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { autonomy });

    await expect(
      registry.dispatch(context, ["governance:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "autonomy-set-command-0001",
        correlationId: "autonomy-set-correlation-0001",
        operation: "governance.autonomy.set",
        expectedRevision: 0,
        payload: { mode: "review" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { mode: "review", revision: 1 } });
    await expect(autonomy.get(context)).resolves.toEqual({ mode: "review", revision: 1 });
  });

  it("긴급 정지 command는 상태를 활성화한 뒤 같은 조직의 실행을 취소한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "emergency-command@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const cancelOrganization = vi.fn().mockResolvedValue(undefined);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      emergency,
      runtime: { cancelOrganization } as never,
    });

    await expect(
      registry.dispatch(context, ["governance:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "emergency-command-0001",
        correlationId: "emergency-correlation-0001",
        operation: "governance.emergency.activate",
        payload: { reason: "비밀값 노출 대응" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { active: true, revision: 1 } });
    expect(cancelOrganization).toHaveBeenCalledWith(context, "emergency_stop");
    await expect(emergency.get(context)).resolves.toMatchObject({ active: true, revision: 1 });
  });

  it("긴급 정지 뒤 수신함 승인으로 해제 command가 Permit을 한 번 소비한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "emergency-release@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: "emergency-release-policy-draft",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, {
      commandId: "emergency-release-policy-activate",
      policyVersionId: draft.policy_version_id,
    });
    const cancelOrganization = vi.fn().mockResolvedValue(undefined);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      emergency,
      approvals,
      governanceGate: gate,
      runtime: { cancelOrganization } as never,
    });

    const activated = await registry.dispatch(context, ["governance:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "emergency-release-activate",
      correlationId: "emergency-release-activate-correlation",
      operation: "governance.emergency.activate",
      payload: { reason: "credential 유출 대응" },
    });
    expect(activated).toMatchObject({ outcome: "succeeded", data: { active: true, revision: 1 } });
    const requested = await registry.dispatch(context, ["governance:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "emergency-release-command",
      correlationId: "emergency-release-correlation",
      operation: "governance.emergency.release",
      payload: { reason: "복구 확인" },
    });
    expect(requested).toMatchObject({
      outcome: "awaiting-approval",
      data: { active: true, approvalId: expect.any(String) },
    });
    const approvalId = (requested.data as { approvalId: string }).approvalId;
    const pending = await approvals.get(context, approvalId);
    expect(pending).toMatchObject({ status: "pending", resource_revision: 1 });
    const approved = await approvals.vote(context, {
      commandId: "emergency-release-approval-vote",
      approvalId,
      expectedRevision: pending.revision,
      vote: "approve",
      reason: "incident resolved",
    });

    await expect(
      registry.dispatch(context, ["governance:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "emergency-release-command",
        correlationId: "emergency-release-correlation",
        operation: "governance.emergency.release",
        payload: { approvalId: approved.approval_id, reason: "복구 확인" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { active: false, revision: 2 } });
    expect((await approvals.get(context, approvalId)).status).toBe("consumed");
    expect((await emergency.listEvents(context)).map((event) => event.event_type)).toEqual([
      "emergency_stop_activated",
      "emergency_stop_released",
    ]);
  });

  it("workspace 명령을 command registry에 연결하고 등록·신뢰·archive를 처리한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "workspace@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const workspaces = await WorkspaceService.create(database, organizations);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { workspaces });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "massion-domain-workspace-"));
    const workspacePath = join(temporaryRoot, "shop-api");
    await mkdir(workspacePath);
    const canonicalWorkspacePath = await realpath(workspacePath);

    try {
      const registered = await registry.dispatch(context, ["workspace:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "workspace-register-command-0001",
        correlationId: "workspace-register-correlation-0001",
        operation: "workspace.register",
        payload: { path: workspacePath },
      });
      expect(registered).toMatchObject({
        outcome: "succeeded",
        resource: { type: "Workspace", revision: 0 },
        data: {
          path: canonicalWorkspacePath,
          trust: "pending",
          status: "active",
          createdAt: expect.any(String),
          lastUsedAt: expect.any(String),
        },
      });
      const workspaceId = (registered.data as { workspaceId: string }).workspaceId;

      await expect(
        registry.dispatch(context, ["workspace:write"], {
          schemaVersion: "massion.application.v1",
          commandId: "workspace-trust-command-0001",
          correlationId: "workspace-trust-correlation-0001",
          operation: "workspace.trust",
          expectedRevision: 0,
          payload: { workspaceId, decision: "trusted" },
        }),
      ).resolves.toMatchObject({ outcome: "succeeded", data: { trust: "trusted" }, resource: { revision: 1 } });

      await expect(
        registry.dispatch(context, ["workspace:write"], {
          schemaVersion: "massion.application.v1",
          commandId: "workspace-archive-command-0001",
          correlationId: "workspace-archive-correlation-0001",
          operation: "workspace.archive",
          expectedRevision: 1,
          payload: { workspaceId },
        }),
      ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "archived" } });

      await expect(
        registry.dispatch(context, ["work:write"], {
          schemaVersion: "massion.application.v1",
          commandId: "workspace-scope-command-0001",
          correlationId: "workspace-scope-correlation-0001",
          operation: "workspace.register",
          payload: { path: join(temporaryRoot, "other") },
        }),
      ).rejects.toMatchObject({ category: "authorization" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("Extension review는 awaiting-approval로 반환하고 같은 command·artifact로 승인 재개한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "extension-domain@example.com", displayName: "Ext" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const extension = {
      async install(_context: unknown, input: { installApprovalId?: string }) {
        if (!input.installApprovalId)
          throw new GovernanceApprovalRequiredError("decision-extension", "approval-extension");
        return {
          installationId: "installation-domain",
          versionId: "version-domain",
          packageName: "@massion-ext/domain",
          packageVersion: "1.0.0",
          activationGeneration: 1,
          state: "active",
        };
      },
    };
    registerApplicationDomainCommands(registry, { extension: extension as never });
    const initial = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "domain-extension-install-command-0001",
      correlationId: "domain-extension-install-correlation-0001",
      operation: "extension.install",
      payload: { archiveBase64: Buffer.from("archive").toString("base64") },
    };
    await expect(registry.dispatch(context, ["extension:write"], initial)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { approvalId: "approval-extension" },
    });
    await expect(
      registry.dispatch(context, ["extension:write"], {
        ...initial,
        payload: { ...initial.payload, installApprovalId: "approval-extension" },
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      data: { installationId: "installation-domain", packageName: "@massion-ext/domain" },
    });
  });

  it("active 정책이 allow인 Extension은 사람 승인 없이 바로 succeeded를 반환한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "auto-domain@example.com", displayName: "Auto" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      extension: {
        async install() {
          return {
            installationId: "installation-auto",
            versionId: "version-auto",
            packageName: "@massion-ext/auto",
            packageVersion: "1.0.0",
            activationGeneration: 1,
            state: "active",
          };
        },
      } as never,
    });
    await expect(
      registry.dispatch(context, ["extension:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-extension-auto-command-0001",
        correlationId: "domain-extension-auto-correlation-0001",
        operation: "extension.install",
        payload: { archiveBase64: Buffer.from("archive").toString("base64") },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("Extension source의 local link와 pack을 공개 Gateway에 위임하고 host path는 반환하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "package-domain@example.com", displayName: "Pack" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      extension: {
        link: async () => ({
          sourcePath: "/private/source",
          sourceDigest: "a".repeat(64),
          trustLevel: "untrusted-local",
          validatedAt: "2026-07-11T00:00:00.000Z",
        }),
        pack: async () => ({
          tarballPath: "/private/output/package.tgz",
          artifactDigest: "b".repeat(64),
          packageName: "@massion-ext/example",
          packageVersion: "1.0.0",
        }),
      } as never,
    });
    const link = await registry.dispatch(context, ["extension:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-extension-link-command-0001",
      correlationId: "domain-extension-link-correlation-0001",
      operation: "extension.link",
      payload: { source: "/workspace/ext", environment: "development" },
    });
    const pack = await registry.dispatch(context, ["extension:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-extension-pack-command-0001",
      correlationId: "domain-extension-pack-correlation-0001",
      operation: "extension.pack",
      payload: { source: "/workspace/ext", destination: "/workspace/dist" },
    });
    expect(link).toMatchObject({ outcome: "succeeded", data: { trustLevel: "untrusted-local" } });
    expect(pack).toMatchObject({ outcome: "succeeded", data: { packageName: "@massion-ext/example" } });
    expect(JSON.stringify([link, pack])).not.toContain("/private/");
  });

  it("Provider·endpoint·model·route candidate를 공개 command로 구성한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "router-domain@example.com", displayName: "Router" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      providers: {
        registerProvider: async () => ({ provider: { provider_id: "openai" } }),
        registerEndpoint: async () => ({ endpoint: { endpoint_id: "endpoint-1", provider_id: "openai" } }),
      },
      router: {
        registerModel: async () => ({ profile: { model_profile_id: "profile-1", model_id: "gpt" } }),
        addCandidate: async () => ({ candidate: { candidate_id: "candidate-1", route_id: "route-1" } }),
      },
    } as never);
    const cases = [
      ["router.provider.register", { providerId: "openai", displayName: "OpenAI", adapterKind: "openai-compatible" }],
      [
        "router.endpoint.register",
        { providerId: "openai", name: "API", baseUrl: "https://api.openai.com/v1", local: false },
      ],
      [
        "router.model.register",
        {
          providerId: "openai",
          endpointId: "endpoint-1",
          modelId: "gpt",
          routeKind: "chat",
          contextWindow: 128000,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsVision: true,
          supportsStreaming: true,
          equivalenceGroup: "general",
          evalScore: 0.9,
          inputCostMicrosPerMillion: 1,
          outputCostMicrosPerMillion: 1,
          verified: true,
        },
      ],
      ["router.candidate.add", { routeId: "route-1", modelProfileId: "profile-1", priority: 1 }],
    ] as const;
    for (const [operation, payload] of cases) {
      await expect(
        registry.dispatch(context, ["router:write"], {
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          payload,
        }),
      ).resolves.toMatchObject({ outcome: "succeeded" });
    }
  });

  it("모델 카탈로그 동기화는 owner·admin과 strict endpoint payload만 허용한다", async () => {
    const begin = vi.fn().mockResolvedValue({ outcome: "claimed", commandRecordId: "record-1", leaseGeneration: 1 });
    const complete = vi.fn().mockResolvedValue(undefined);
    const synchronizeModelCatalog = vi.fn().mockResolvedValue({
      status: "available",
      activeCount: 2,
      invalidCount: 1,
      duplicateCount: 1,
      snapshotId: "snapshot-1",
    });
    const registry = new ApplicationCommandRegistry({
      begin,
      complete,
      fail: vi.fn().mockResolvedValue(undefined),
    } as never);
    registerApplicationDomainCommands(registry, {
      providers: { synchronizeModelCatalog },
    } as never);
    const command = (commandId: string, payload: unknown) => ({
      schemaVersion: "massion.application.v1" as const,
      commandId,
      correlationId: `${commandId}-correlation`,
      operation: "router.models.sync",
      payload,
    });
    const owner = { organizationId: "org-1", userId: "owner-1", role: "owner" } as never;
    const admin = { organizationId: "org-1", userId: "admin-1", role: "admin" } as never;
    const member = { organizationId: "org-1", userId: "member-1", role: "member" } as never;

    await expect(
      registry.dispatch(owner, [], command("sync-no-scope", { endpointId: "endpoint-1" })),
    ).rejects.toMatchObject({ operatorCode: "APP_SCOPE_REQUIRED" });
    await expect(
      registry.dispatch(member, ["router:write"], command("sync-member", { endpointId: "endpoint-1" })),
    ).rejects.toMatchObject({ operatorCode: "APP_ROLE_REQUIRED" });
    await expect(registry.dispatch(owner, ["router:write"], command("sync-missing", {}))).rejects.toMatchObject({
      operatorCode: "APP_COMMAND_VALIDATION",
    });
    await expect(
      registry.dispatch(owner, ["router:write"], command("sync-extra", { endpointId: "endpoint-1", secret: "leak" })),
    ).rejects.toMatchObject({ operatorCode: "APP_COMMAND_VALIDATION" });
    await expect(
      registry.dispatch(owner, ["router:write"], command("sync-empty", { endpointId: "" })),
    ).rejects.toMatchObject({ operatorCode: "APP_COMMAND_VALIDATION" });

    await expect(
      registry.dispatch(owner, ["router:write"], command("sync-owner", { endpointId: "endpoint-1" })),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      resource: { type: "ProviderModelCatalog", id: "endpoint-1" },
      data: {
        endpointId: "endpoint-1",
        status: "available",
        activeCount: 2,
        invalidCount: 1,
        duplicateCount: 1,
        snapshotId: "snapshot-1",
      },
    });
    await expect(
      registry.dispatch(owner, ["router:write"], command("sync-normalized", { endpointId: " endpoint-3 " })),
    ).resolves.toMatchObject({
      resource: { type: "ProviderModelCatalog", id: "endpoint-3" },
      data: { endpointId: "endpoint-3" },
    });
    await expect(
      registry.dispatch(admin, ["router:write"], command("sync-admin", { endpointId: "endpoint-2" })),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    expect(synchronizeModelCatalog).toHaveBeenNthCalledWith(1, owner, {
      commandId: "sync-owner",
      endpointId: "endpoint-1",
    });
    expect(synchronizeModelCatalog).toHaveBeenNthCalledWith(2, owner, {
      commandId: "sync-normalized",
      endpointId: "endpoint-3",
    });
    expect(synchronizeModelCatalog).toHaveBeenNthCalledWith(3, admin, {
      commandId: "sync-admin",
      endpointId: "endpoint-2",
    });
    expect(begin).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("Provider 제거 거부는 사용자가 조치할 수 있는 사유로 전달한다", async () => {
    const registry = new ApplicationCommandRegistry(
      new (class {
        public begin = async () => ({ outcome: "claimed", commandRecordId: "record-1", leaseGeneration: 1 });
        public complete = async () => undefined;
        public fail = async () => undefined;
      })() as never,
    );
    registerApplicationDomainCommands(registry, {
      providers: {
        removeProvider: async () => {
          throw new Error("구독으로 연결한 Provider는 구독 해제로만 정리할 수 있습니다");
        },
      },
    } as never);

    await expect(
      registry.dispatch({ organizationId: "org-1", userId: "user-1", role: "owner" } as never, ["application:*"], {
        schemaVersion: "massion.application.v1",
        commandId: "remove-blocked-command",
        correlationId: "remove-blocked-correlation",
        operation: "router.provider.remove",
        payload: { providerId: "openai-codex" },
      }),
    ).rejects.toMatchObject({
      category: "conflict",
      operatorCode: "APP_PROVIDER_REMOVE_BLOCKED",
      userMessage: "구독으로 연결한 Provider는 구독 해제로만 정리할 수 있습니다",
    });
  });

  it("Assurance binding 제안과 정책 승인 재개를 공개 command로 제공한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "binding-domain@example.com",
      displayName: "Binding",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      assuranceBindings: {
        propose: async () => ({ bindingVersionId: "binding-1", revision: 1, status: "draft" }),
        activate: async (_context: unknown, input: { approvalId?: string }) => {
          if (!input.approvalId) throw new GovernanceApprovalRequiredError("decision-1", "approval-1");
          return { bindingVersionId: "binding-1", revision: 2, status: "active" };
        },
      },
    } as never);
    const base = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "binding-propose-command-0001",
      correlationId: "binding-propose-correlation-0001",
      operation: "assurance.binding.propose",
      payload: {
        workId: "work-1",
        planVersionId: "plan-1",
        profileId: "profile",
        profileVersion: "1",
        authorHandle: "assurance",
        requiredCriteria: [],
        bindings: [],
      },
    };
    await expect(registry.dispatch(context, ["assurance:write"], base)).resolves.toMatchObject({
      outcome: "succeeded",
    });
    const activation = {
      ...base,
      commandId: "binding-activate-command-0001",
      operation: "assurance.binding.activate",
      payload: { bindingVersionId: "binding-1", expectedRevision: 1 },
    };
    await expect(registry.dispatch(context, ["assurance:write"], activation)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { approvalId: "approval-1" },
    });
    await expect(
      registry.dispatch(context, ["assurance:write"], {
        ...activation,
        payload: { ...activation.payload, approvalId: "approval-1" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "active" } });
  });

  it("구독 Connector·계정·공유·정책 변경을 공개 command로 위임하고 민감한 식별자를 반환하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "subscription-domain@example.com",
      displayName: "Subscription",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
    const account = (scope: "personal" | "organization", status: "active" | "revoked", version: number) => ({
      account_id: "subscription-account-1",
      organization_id: "organization-secret",
      owner_user_id: "owner-secret",
      provider_id: "verified-provider",
      alias: "업무 계정",
      scope,
      connector_id: "connector-1",
      profile_fingerprint: "profile-fingerprint-secret",
      billing_kind: "subscription",
      status,
      consent_version: scope === "organization" ? 1 : 0,
      version,
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z",
    });
    registerApplicationDomainCommands(registry, {
      subscriptionConnectors: {
        enroll: async (input: unknown) => {
          calls.push({ operation: "connector.enroll", input });
          return {
            connector_id: "connector-1",
            organization_id: "organization-secret",
            owner_user_id: "owner-secret",
            location: "edge",
            execution_kind: "agent-runtime",
            protocol: "massion-connector-v1",
            version: "1.0.0",
            public_key: "connector-public-key-secret",
            capabilities: ["session.execute"],
            status: "ready",
            expires_at: "2026-07-12T00:05:00.000Z",
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          };
        },
        revoke: async (_context: unknown, connectorId: string) => {
          calls.push({ operation: "connector.revoke", input: { connectorId } });
          return {
            connector_id: connectorId,
            organization_id: "organization-secret",
            owner_user_id: "owner-secret",
            location: "edge",
            execution_kind: "agent-runtime",
            protocol: "massion-connector-v1",
            version: "1.0.0",
            public_key: "connector-public-key-secret",
            capabilities: ["session.execute"],
            status: "revoked",
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          };
        },
      },
      subscriptionAccounts: {
        register: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "account.register", input });
          return account("personal", "active", 1);
        },
        share: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "account.share", input });
          return account("organization", "active", 2);
        },
        unshare: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "account.unshare", input });
          return account("personal", "active", 3);
        },
        disconnect: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "account.disconnect", input });
          return account("personal", "revoked", 4);
        },
      },
      subscriptionConnections: {
        connect: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "connection.connect", input });
          return {
            account: account("personal", "active", 1),
            binding: {
              providerId: "verified-provider",
              endpointId: "endpoint-internal",
              endpointUrl: "massion-connector:///verified-provider/acp",
              protocol: "acp",
              executionKind: "agent-runtime",
              credentialId: "credential-internal",
            },
          };
        },
        disconnect: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "connection.disconnect", input });
          return { account: account("personal", "revoked", 4), revokedCredentialCount: 1 };
        },
      },
      subscriptionPolicy: {
        configure: async (_context: unknown, input: unknown) => {
          calls.push({ operation: "policy.configure", input });
          return {
            providerId: "verified-provider",
            credentialPolicy: "quota-headroom",
            approvalMode: "automatic",
            version: 2,
            source: "configured",
            updatedAt: "2026-07-12T00:00:00.000Z",
            token: "policy-token-secret",
          };
        },
        list: async () => [],
      },
    } as never);

    const commands = [
      {
        operation: "subscription.connector.enroll",
        payload: {
          enrollmentId: "enrollment-1",
          enrollmentCode: "enrollment-code-secret",
          challengeNonce: "challenge-secret",
          expiresAt: "2026-07-12T00:05:00.000Z",
          connectorId: "connector-1",
          publicKey: "connector-public-key-secret",
          protocol: "massion-connector-v1",
          version: "1.0.0",
          capabilities: ["session.execute"],
          signature: "connector-signature-secret",
        },
      },
      {
        operation: "subscription.connector.revoke",
        payload: { connectorId: "connector-1" },
      },
      {
        operation: "subscription.account.register",
        payload: {
          providerId: "verified-provider",
          alias: "업무 계정",
          connectorId: "connector-1",
          profileLocator: "external-account@example.com",
          authKind: "acp",
          billingKind: "subscription",
        },
      },
      {
        operation: "subscription.account.share",
        expectedRevision: 1,
        payload: { accountId: "subscription-account-1" },
      },
      {
        operation: "subscription.account.unshare",
        expectedRevision: 2,
        payload: { accountId: "subscription-account-1" },
      },
      {
        operation: "subscription.account.disconnect",
        expectedRevision: 3,
        payload: { accountId: "subscription-account-1" },
      },
      {
        operation: "subscription.policy.configure",
        payload: {
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          approvalMode: "automatic",
        },
      },
    ] as const;
    const results = [];
    for (const command of commands) {
      results.push(
        await registry.dispatch(context, ["subscription:write"], {
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          ...command,
        }),
      );
    }

    expect(results).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ connectorId: "connector-1", status: "ready" }) }),
      expect.objectContaining({ data: expect.objectContaining({ connectorId: "connector-1", status: "revoked" }) }),
      expect.objectContaining({ data: expect.objectContaining({ accountId: "subscription-account-1", version: 1 }) }),
      expect.objectContaining({ data: expect.objectContaining({ scope: "organization", version: 2 }) }),
      expect.objectContaining({ data: expect.objectContaining({ scope: "personal", version: 3 }) }),
      expect.objectContaining({ data: expect.objectContaining({ status: "revoked", version: 4 }) }),
      expect.objectContaining({
        data: expect.objectContaining({
          credentialPolicy: "quota-headroom",
          approvalMode: "automatic",
          version: 2,
          source: "configured",
        }),
      }),
    ]);
    await expect(
      registry.dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "subscription.policy.configure",
        payload: { providerId: "openai-codex", credentialPolicy: "adaptive", approvalMode: "review" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    for (const [providerId, approvalMode] of [
      ["github-copilot", "review"],
      ["google-antigravity-cli", "automatic"],
    ] as const) {
      await expect(
        registry.dispatch(context, ["subscription:write"], {
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation: "subscription.policy.configure",
          payload: { providerId, credentialPolicy: "adaptive", approvalMode },
        }),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([
      expect.objectContaining({ operation: "connector.enroll" }),
      expect.objectContaining({ operation: "connector.revoke", input: { connectorId: "connector-1" } }),
      expect.objectContaining({ operation: "connection.connect", input: expect.objectContaining({ authKind: "acp" }) }),
      expect.objectContaining({ operation: "account.share", input: expect.objectContaining({ expectedVersion: 1 }) }),
      expect.objectContaining({ operation: "account.unshare", input: expect.objectContaining({ expectedVersion: 2 }) }),
      expect.objectContaining({
        operation: "connection.disconnect",
        input: expect.objectContaining({ expectedVersion: 3 }),
      }),
      expect.objectContaining({ operation: "policy.configure" }),
      expect.objectContaining({
        operation: "policy.configure",
        input: expect.objectContaining({ providerId: "openai-codex", approvalMode: "review" }),
      }),
    ]);
    const serialized = JSON.stringify(results);
    for (const forbidden of [
      "organization-secret",
      "owner-secret",
      "profile-fingerprint-secret",
      "external-account@example.com",
      "enrollment-code-secret",
      "challenge-secret",
      "connector-public-key-secret",
      "connector-signature-secret",
      "policy-token-secret",
      "endpoint-internal",
      "credential-internal",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("구독 승인 방식 생략은 실제 Store의 공통·활성 기본값과 연결 불가 계약에 위임한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "policy-default@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await SubscriptionPolicyStore.create(database, organizations);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { subscriptionPolicy: policies });
    const configure = async (providerId: string, approvalMode?: unknown, expectedRevision?: number) =>
      await registry.dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "subscription.policy.configure",
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        payload: {
          providerId,
          credentialPolicy: "adaptive",
          ...(approvalMode === undefined ? {} : { approvalMode }),
        },
      });

    await expect(configure("openai-codex")).resolves.toMatchObject({
      data: { providerId: "openai-codex", approvalMode: "automatic", version: 1 },
    });
    await expect(configure("openai-codex", "automatic", 1)).resolves.toMatchObject({
      data: { approvalMode: "automatic", version: 2 },
    });
    await expect(configure("openai-codex", undefined, 2)).resolves.toMatchObject({
      data: { approvalMode: "automatic", version: 3 },
    });
    await expect(configure("private-provider")).resolves.toMatchObject({
      data: { providerId: "private-provider", approvalMode: "deny", version: 1 },
    });
    await expect(configure("google-antigravity-cli")).rejects.toThrow();
    await expect(configure("openai-codex", "unknown", 3)).rejects.toThrow();
  });

  it("구독 공유는 조직 정책이 요구할 때만 awaiting-approval이 되고 같은 명령으로 재개된다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "share@example.com", displayName: "Share" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const calls: unknown[] = [];
    registerApplicationDomainCommands(registry, {
      subscriptionAccounts: {
        share: async (_context: unknown, input: { approvalId?: string }) => {
          calls.push(input);
          if (!input.approvalId) throw new GovernanceApprovalRequiredError("decision-share", "approval-share");
          return {
            account_id: "subscription-account-1",
            organization_id: context.organizationId,
            owner_user_id: context.userId,
            provider_id: "openai-codex",
            alias: "공유 계정",
            scope: "organization",
            connector_id: "connector-1",
            profile_fingerprint: "redacted",
            billing_kind: "consumer-subscription",
            status: "active",
            consent_version: 1,
            version: 2,
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          };
        },
      },
    } as never);
    const initial = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "subscription-share-command-0001",
      correlationId: "subscription-share-correlation-0001",
      operation: "subscription.account.share",
      expectedRevision: 1,
      payload: { accountId: "subscription-account-1" },
    };

    await expect(registry.dispatch(context, ["subscription:write"], initial)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { decisionId: "decision-share", approvalId: "approval-share" },
    });
    await expect(
      registry.dispatch(context, ["subscription:write"], {
        ...initial,
        payload: { ...initial.payload, approvalId: "approval-share" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { scope: "organization", version: 2 } });
    expect(calls).toEqual([
      expect.not.objectContaining({ approvalId: expect.anything() }),
      expect.objectContaining({ approvalId: "approval-share" }),
    ]);
  });
});
