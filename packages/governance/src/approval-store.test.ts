import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PolicyStore } from "./policy-store.js";

describe("Approval Inbox", () => {
  let database: MassionDatabase;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let context: TenantContext;
  let policies: PolicyStore;
  let governance: GovernanceService;
  let approvals: ApprovalStore;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "approval@example.com", displayName: "Approval" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    now = new Date("2026-07-10T00:00:00.000Z");
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
  });

  async function decision(kind: "personal" | "team" = "personal", quorum = 1, activatePolicy = true) {
    if (activatePolicy) {
      const defaults = createDefaultPolicy(kind);
      const requirements = defaults.requirements.map((requirement) => ({ ...requirement, quorum }));
      const draft = await policies.createDraft(context, {
        commandId: crypto.randomUUID(),
        bundle: defaults.bundle,
        requirements,
      });
      const active = await policies.getActive(context);
      await policies.activate(context, {
        commandId: crypto.randomUUID(),
        policyVersionId: draft.policy_version_id,
        ...(active ? { expectedActivePolicyVersionId: active.policy_version_id } : {}),
      });
    }
    return await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: {
        principal: {
          type: "Human",
          id: context.userId,
          organizationId: context.organizationId,
          attributes: { kind: "human", role: context.role },
        },
        action: "tool.call",
        resource: {
          type: "Work",
          id: "work-1",
          organizationId: context.organizationId,
          revision: 3,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: kind === "team" ? "production" : "local", riskClass: "write", external: false },
      },
    });
  }

  it("pending 요청을 만들고 개인 owner의 명시적 표로 승인한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
      workId: "work-1",
    });
    const approved = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "확인했습니다",
    });

    expect(request.status).toBe("pending");
    expect(approved.status).toBe("approved");
    expect((await approvals.listEvents(context, request.approval_id)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("동일한 기대 revision의 동시 terminal vote는 하나만 반영하고 다른 하나는 충돌한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });

    const results = await Promise.allSettled([
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        expectedRevision: request.revision,
        vote: "approve",
        reason: "first",
      }),
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        expectedRevision: request.revision,
        vote: "reject",
        reason: "second",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ message: expect.stringContaining("revision 충돌") }),
      }),
    ]);
    expect(["approved", "rejected"]).toContain((await approvals.get(context, request.approval_id)).status);
    expect(
      (await approvals.listEvents(context, request.approval_id)).filter((event) =>
        ["approval_approved", "approval_rejected"].includes(event.event_type),
      ),
    ).toHaveLength(1);
  });

  it("오래된 기대 revision은 표와 상태와 사건을 만들기 전에 충돌한다", async () => {
    const governed = await decision("personal", 2);
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const current = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "first",
    });

    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        expectedRevision: request.revision,
        vote: "reject",
        reason: "stale",
      }),
    ).rejects.toThrow("revision 충돌");

    expect(await approvals.get(context, request.approval_id)).toMatchObject({
      status: "pending",
      revision: current.revision,
      event_sequence: current.event_sequence,
    });
    const [votes] = await database.query<[unknown[]]>(
      "SELECT vote FROM governance_approval_vote WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: request.approval_id },
    );
    expect(votes).toHaveLength(1);
    expect(await approvals.listEvents(context, request.approval_id)).toHaveLength(2);
  });

  it("기대 revision은 제공되면 0 이상의 safe integer여야 한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });

    for (const expectedRevision of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        approvals.vote(context, {
          commandId: crypto.randomUUID(),
          approvalId: request.approval_id,
          expectedRevision,
          vote: "approve",
          reason: "invalid revision",
        }),
      ).rejects.toThrow("expectedRevision이 올바르지 않습니다");
    }
    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        expectedRevision: 0,
        vote: "approve",
        reason: "valid but stale revision",
      }),
    ).rejects.toThrow("revision 충돌");

    expect(await approvals.get(context, request.approval_id)).toMatchObject({ status: "pending", revision: 1 });
    expect(await approvals.listEvents(context, request.approval_id)).toHaveLength(1);
  });

  it("team separation-of-duty는 요청자의 자기 승인을 거부하고 다른 admin을 허용한다", async () => {
    const team = await organizations.createTeam(context.userId, "Governed Team");
    context = await organizations.resolveTenantContext(context.userId, team.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
    const admin = await identity.registerPersonalUser({ email: "admin@example.com", displayName: "Admin" });
    await organizations.addMember(context, admin.user.user_id, "admin");
    const adminContext = await organizations.resolveTenantContext(admin.user.user_id, context.organizationId);
    const governed = await decision("team");
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });

    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "self",
      }),
    ).rejects.toThrow("요청자와 승인자를 분리");
    await expect(
      approvals.vote(adminContext, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "reviewed",
      }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("정족수를 만족할 때만 승인하고 reject 표는 즉시 거절한다", async () => {
    const governed = await decision("personal", 2);
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const first = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "first",
    });

    expect(first.status).toBe("pending");
    const rejectedDecision = await decision("personal", 2, false);
    const rejectedRequest = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: rejectedDecision.decisionId,
      resourceRevision: 3,
    });
    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: rejectedRequest.approval_id,
        vote: "reject",
        reason: "unsafe",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("만료된 요청의 vote를 거부하고 expired 사건을 한 번만 기록한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    now = new Date("2026-07-10T02:00:00.000Z");

    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        expectedRevision: request.revision,
        vote: "approve",
        reason: "late",
      }),
    ).rejects.toThrow("만료");
    await approvals.expire(context, request.approval_id);
    await approvals.expire(context, request.approval_id);

    expect((await approvals.get(context, request.approval_id)).status).toBe("expired");
    expect(
      (await approvals.listEvents(context, request.approval_id)).filter(
        (event) => event.event_type === "approval_expired",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["terminal vote", "approved", 1, ["approval_requested", "approval_approved"]],
    ["cancel", "cancelled", 1, ["approval_requested", "approval_cancelled"]],
    ["pending vote", "expired", 2, ["approval_requested", "approval_voted", "approval_expired"]],
  ] as const)(
    "만료 갱신 경쟁이 먼저 반영된 %s 이후 안전한 상태를 반환한다",
    async (concurrentOperation, expectedStatus, revisionDelta, expectedEvents) => {
      const governed = await decision("personal", concurrentOperation === "pending vote" ? 2 : 1);
      const request = await approvals.request(context, {
        commandId: crypto.randomUUID(),
        decisionId: governed.decisionId,
        resourceRevision: 3,
      });
      const activeApprovals = await ApprovalStore.create(database, organizations, governance, {
        now: () => new Date("2026-07-10T00:00:00.000Z"),
      });
      const originalTransaction = database.transaction.bind(database);
      const originalQuery = database.query.bind(database);
      let raced = false;
      let applyConcurrentOperation = false;
      database.query = async <R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> => {
        if (applyConcurrentOperation) {
          applyConcurrentOperation = false;
          if (concurrentOperation !== "cancel") {
            await activeApprovals.vote(context, {
              commandId: crypto.randomUUID(),
              approvalId: request.approval_id,
              expectedRevision: request.revision,
              vote: "approve",
              reason: "동시 승인",
            });
          } else {
            await approvals.cancel(context, {
              commandId: crypto.randomUUID(),
              approvalId: request.approval_id,
              reason: "동시 취소",
            });
          }
        }
        return await originalQuery<R>(surql, bindings);
      };
      database.transaction = async <T>(transactionOperation: (transaction: QueryExecutor) => Promise<T>): Promise<T> =>
        await originalTransaction(
          async (transaction) =>
            await transactionOperation({
              query: async <R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> => {
                if (!raced && surql.includes("SET status = 'expired'")) {
                  expect(surql).toContain("status = 'pending'");
                  expect(surql).toContain("revision = $current_revision");
                  raced = true;
                  applyConcurrentOperation = true;
                  return [[]] as unknown as R;
                }
                return await transaction.query<R>(surql, bindings);
              },
            }),
        );
      now = new Date("2026-07-10T02:00:00.000Z");

      await expect(approvals.expire(context, request.approval_id)).resolves.toMatchObject({
        status: expectedStatus,
        revision: request.revision + revisionDelta,
      });
      expect(raced).toBe(true);
      expect((await approvals.listEvents(context, request.approval_id)).map((event) => event.event_type)).toEqual(
        expectedEvents,
      );
    },
  );

  it("만료 CAS가 재시도 한도까지 계속 충돌하면 만료된 pending을 성공처럼 반환하지 않는다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const originalTransaction = database.transaction.bind(database);
    let conflicts = 0;
    database.transaction = async <T>(transactionOperation: (transaction: QueryExecutor) => Promise<T>): Promise<T> =>
      await originalTransaction(
        async (transaction) =>
          await transactionOperation({
            query: async <R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> => {
              if (surql.includes("SET status = 'expired'")) {
                conflicts += 1;
                return [[]] as unknown as R;
              }
              return await transaction.query<R>(surql, bindings);
            },
          }),
      );
    now = new Date("2026-07-10T02:00:00.000Z");

    await expect(approvals.expire(context, request.approval_id)).rejects.toThrow("동시성 충돌");
    expect(conflicts).toBe(4);
    await expect(approvals.get(context, request.approval_id)).resolves.toMatchObject({
      status: "pending",
      revision: request.revision,
    });
  });

  it("같은 command vote는 멱등이고 다른 조직은 승인 요청을 볼 수 없다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      approvalId: request.approval_id,
      expectedRevision: request.revision,
      vote: "approve" as const,
      reason: "ok",
    };
    const first = await approvals.vote(context, input);
    const repeated = await approvals.vote(context, input);
    const other = await identity.registerPersonalUser({ email: "approval-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    expect(repeated).toEqual(first);
    await expect(approvals.vote(context, { ...input, reason: "different" })).rejects.toThrow("같은 commandId");
    await expect(approvals.get(otherContext, request.approval_id)).rejects.toThrow("Approval을 찾을 수 없습니다");
  });

  it("requester가 pending 요청을 취소하고 같은 명령을 멱등 재생한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const commandId = crypto.randomUUID();

    const cancelled = await approvals.cancel(context, {
      commandId,
      approvalId: request.approval_id,
      reason: "요청 철회",
    });
    const repeated = await approvals.cancel(context, {
      commandId,
      approvalId: request.approval_id,
      reason: "요청 철회",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(repeated).toEqual(cancelled);
  });

  it("provider process가 사라지면 승인됐지만 아직 소비되지 않은 요청도 취소할 수 있다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "승인",
    });

    await expect(
      approvals.cancel(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        reason: "provider process 복구 불가",
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("안전한 표시 미리보기를 전용 필드에 저장하고 기존 승인 명령의 멱등성에는 포함하지 않는다", async () => {
    const governed = await decision();
    const commandId = crypto.randomUUID();
    const first = await approvals.request(context, {
      commandId,
      decisionId: governed.decisionId,
      resourceRevision: 3,
      displayPreview: {
        kind: "command",
        title: "명령 실행",
        executable: "git",
        arguments: ["status", "--token", "approval-secret-never-store"],
        cwd: "/workspace/project",
      },
    });
    const repeated = await approvals.request(context, {
      commandId,
      decisionId: governed.decisionId,
      resourceRevision: 3,
      displayPreview: {
        kind: "provider",
        title: "재시도에서 바뀐 미리보기",
      },
    });

    expect(repeated.approval_id).toBe(first.approval_id);
    expect(JSON.parse(first.display_preview_json ?? "null")).toEqual({
      kind: "command",
      title: "명령 실행",
      executable: "git",
      arguments: ["status", "--token", "[민감값 제거]"],
      cwd: "/workspace/project",
    });
    const events = await approvals.listEvents(context, first.approval_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.request_json).not.toContain("approval-secret-never-store");
    expect(events[0]?.request_json).not.toContain("재시도에서 바뀐 미리보기");
  });
});
