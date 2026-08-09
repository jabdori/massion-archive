import type { TenantContext } from "@massion/identity";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { canTransitionWork, WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_RUN_STAGES,
  CoreWorkCoordinator,
  type CoreWorkStage,
  type CoreWorkStageExecutor,
} from "./core-work-coordinator.js";
import { createCoreWorkPipelineExecutors } from "./core-pipeline.js";
import { ApplicationRunStore } from "./run-store.js";
import { WorkDirectiveStore } from "./work-directive-store.js";

function executors(calls: string[]): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  return Object.fromEntries(
    APPLICATION_RUN_STAGES.map((stage) => [
      stage,
      {
        async execute(_context: TenantContext, input: { commandId: string }) {
          calls.push(`${stage}:${input.commandId}`);
          return {
            outcome: "advanced" as const,
            ...(stage === "intake" ? { workId: "work-core-run" } : {}),
            data: { stage },
          };
        },
      },
    ]),
  ) as unknown as Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
}

async function runningDeliveryWork(
  database: MassionDatabase,
  organizations: OrganizationService,
  context: TenantContext,
) {
  const graph = await OrganizationGraphService.create(database, organizations);
  await graph.bootstrap(context);
  const works = await WorkService.create(database, organizations, graph);
  const created = await works.createWork(context, {
    commandId: crypto.randomUUID(),
    text: "cancel fail fence",
    surface: "test",
    organizationVersionId: "org-version-cancel-fail-fence",
  });
  const plan = await works.addPlan(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: created.work.revision,
    content: { objective: "cancel fail fence" },
  });
  const planned = await works.transition(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: plan.work.revision,
    target: "planned",
  });
  const added = await works.addTask(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: planned.work.revision,
    title: "delivery",
    objective: "delivery",
    acceptanceCriteria: ["done"],
    dependencyIds: [],
  });
  const assigned = await works.assignTask(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: added.work.revision,
    taskId: added.task.task_id,
    agentHandle: "delivery-coordination",
  });
  const ready = await works.transition(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: assigned.work.revision,
    target: "ready",
  });
  const running = await works.transition(context, {
    commandId: crypto.randomUUID(),
    workId: created.work.work_id,
    expectedRevision: ready.work.revision,
    target: "running",
  });
  return { works, work: running.work, task: added.task };
}

describe("CoreWorkCoordinator", () => {
  it("intake→strategy→evidence→delivery→assurance→records를 결정적 command로 실행한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "coordinator@example.com", displayName: "Core" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, executors(calls));

    const completed = await coordinator.start(context, {
      commandId: "core-run-start-command-0001",
      correlationId: "core-run-correlation-0001",
      request: { text: "전체 파이프라인" },
    });
    expect(completed).toMatchObject({ status: "completed", workId: "work-core-run", stage: "terminal" });
    expect(calls.map((call) => call.split(":").at(-1))).toEqual(APPLICATION_RUN_STAGES);
    expect(calls.every((call) => call.includes(completed.runId))).toBe(true);
    expect(calls).toEqual(APPLICATION_RUN_STAGES.map((stage) => `${stage}:${completed.runId}:${stage}`));
  });

  it("approval 대기와 model unavailable을 명시 상태로 두고 승인 입력으로 재개한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "coordinator-wait@example.com", displayName: "Wait" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    let approved = false;
    const deliveryCommandIds: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        async execute(_context, input) {
          deliveryCommandIds.push(input.commandId);
          if (!approved && input.resumeInput === undefined) {
            return { outcome: "awaiting-approval", approvalId: "approval-core-run" };
          }
          approved = true;
          return { outcome: "advanced" };
        },
      },
    });
    const waiting = await coordinator.start(context, {
      commandId: "core-run-wait-command-0001",
      correlationId: "core-run-wait-correlation-0001",
      request: {},
    });
    expect(waiting).toMatchObject({ status: "awaiting-approval", stage: "delivery", approvalId: "approval-core-run" });
    await expect(
      coordinator.resume(context, waiting.runId, { approvalId: "approval-core-run" }),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    expect(deliveryCommandIds).toEqual([`${waiting.runId}:delivery`, `${waiting.runId}:delivery`]);

    let modelAvailable = false;
    const blockedCoordinator = new CoreWorkCoordinator(store, {
      ...stages,
      intake: {
        execute: async () =>
          modelAvailable ? { outcome: "advanced" } : { outcome: "blocked", reason: "model-unavailable" },
      },
    });
    const blocked = await blockedCoordinator.start(context, {
      commandId: "core-run-blocked-command-0001",
      correlationId: "core-run-blocked-correlation-0001",
      request: {},
    });
    expect(blocked).toMatchObject({ status: "blocked", stage: "intake", blockedReason: "model-unavailable" });
    modelAvailable = true;
    await expect(
      blockedCoordinator.retryBlocked(context, blocked.runId, "core-run-retry-command-0001"),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
  });

  it("승인 재개 stage 실패 뒤 새 retry prefix에도 원래 approval 입력을 보존한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-approval-retry@example.com",
      displayName: "Approval retry",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const calls: Array<{ readonly commandId: string; readonly resumeInput?: unknown }> = [];
    let resumedAttempts = 0;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      delivery: {
        async execute(_context, input) {
          calls.push({ commandId: input.commandId, resumeInput: input.resumeInput });
          if (input.resumeInput === undefined) {
            return { outcome: "awaiting-approval", approvalId: "approval-core-retry-0001" };
          }
          resumedAttempts += 1;
          if (resumedAttempts === 1) throw new Error("승인 뒤 delivery checkpoint 실패");
          return { outcome: "advanced" };
        },
      },
    });
    const waiting = await coordinator.start(context, {
      commandId: "core-run-approval-retry-start-0001",
      correlationId: "core-run-approval-retry-correlation-0001",
      request: {},
    });
    const approvalInput = { approvalId: "approval-core-retry-0001" };
    const blocked = await coordinator.resume(context, waiting.runId, approvalInput);
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "delivery-stage-failed" });

    const retryAttemptId = "core-run-approval-retry-attempt-0001";
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    expect(calls).toEqual([
      { commandId: `${waiting.runId}:delivery`, resumeInput: undefined },
      { commandId: `${waiting.runId}:delivery`, resumeInput: approvalInput },
      { commandId: `${waiting.runId}:delivery:retry:${retryAttemptId}`, resumeInput: approvalInput },
    ]);
  });

  it("승인 재개 입력을 정확한 approvalId allowlist로 검증하고 불일치하면 executor 전에 거부한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-approval-validation@example.com",
      displayName: "Approval validation",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-approval-validation-command-0001",
      correlationId: "core-run-approval-validation-correlation-0001",
      request: {},
    });
    const claim = await store.claim(context, run.runId);
    if (claim.outcome !== "claimed") throw new Error("승인 대기 준비 lease를 얻지 못했습니다");
    const approvalId = "approval-validation-0001";
    await store.suspend(context, run.runId, claim.leaseGeneration, approvalId);
    let executorCalls = 0;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute() {
          executorCalls += 1;
          return { outcome: "advanced", workId: "work-approval-validation" };
        },
      },
    });

    await expect(
      coordinator.resume(context, run.runId, { approvalId: "approval-validation-different-0001" }),
    ).rejects.toThrow("일치");
    await expect(coordinator.resume(context, run.runId, { approvalId, extra: true })).rejects.toThrow("승인 재개 입력");
    await expect(coordinator.resume(context, run.runId, { approvalId: " " })).rejects.toThrow("승인 재개 입력");
    await expect(coordinator.resume(context, run.runId, approvalId)).rejects.toThrow("승인 재개 입력");
    expect(executorCalls).toBe(0);
    await expect(store.get(context, run.runId)).resolves.toMatchObject({
      status: "awaiting-approval",
      approvalId,
    });
  });

  it("승인 claim 뒤 중단되어도 영속된 입력으로 복구하고 stage 전이 뒤에는 다시 전달하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-approval-recovery@example.com",
      displayName: "Approval recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const clock = { now: new Date("2026-07-22T02:00:00.000Z") };
    const store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 1_000 });
    const run = await store.start(context, {
      commandId: "core-run-approval-recovery-command-0001",
      correlationId: "core-run-approval-recovery-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("승인 대기 준비 lease를 얻지 못했습니다");
    const approvalId = "approval-recovery-0001";
    await store.suspend(context, run.runId, initialClaim.leaseGeneration, approvalId);

    let firstStageEntered!: () => void;
    let releaseFirstStage!: () => void;
    const firstStageEntry = new Promise<void>((resolve) => {
      firstStageEntered = resolve;
    });
    const firstStageRelease = new Promise<void>((resolve) => {
      releaseFirstStage = resolve;
    });
    const firstCoordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute() {
          firstStageEntered();
          await firstStageRelease;
          return { outcome: "advanced", workId: "work-approval-recovery" };
        },
      },
    });
    const firstResume = firstCoordinator.resume(context, run.runId, { approvalId });
    await firstStageEntry;
    await expect(store.get(context, run.runId)).resolves.toMatchObject({
      status: "running",
      resumeInput: { approvalId },
    });

    clock.now = new Date("2026-07-22T02:00:01.001Z");
    const recoveredIntakeInputs: unknown[] = [];
    const recoveryCoordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          recoveredIntakeInputs.push(input.resumeInput);
          return { outcome: "advanced", workId: "work-approval-recovery" };
        },
      },
      "context-strategy": {
        async execute() {
          return { outcome: "in-progress" };
        },
      },
    });
    await expect(recoveryCoordinator.recover(context, run.runId)).resolves.toMatchObject({
      status: "running",
      stage: "context-strategy",
    });
    expect(recoveredIntakeInputs).toEqual([{ approvalId }]);
    await expect(store.get(context, run.runId)).resolves.not.toHaveProperty("resumeInput");

    clock.now = new Date("2026-07-22T02:00:02.002Z");
    const postAdvanceInputs: unknown[] = [];
    const postAdvanceCoordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      "context-strategy": {
        async execute(_context, input) {
          postAdvanceInputs.push(input.resumeInput);
          return { outcome: "advanced" };
        },
      },
    });
    await expect(postAdvanceCoordinator.recover(context, run.runId)).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    expect(postAdvanceInputs).toEqual([undefined]);

    releaseFirstStage();
    await expect(firstResume).rejects.toThrow("lease generation");
  });

  it("늦은 recovery는 stale initial view가 아니라 실제 claim한 stage와 재개 입력만 실행한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-claimed-snapshot@example.com",
      displayName: "Claimed snapshot",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const started = await store.start(context, {
      commandId: "core-run-claimed-snapshot-command-0001",
      correlationId: "core-run-claimed-snapshot-correlation-0001",
      request: { text: "실제 claim stage만 실행" },
    });
    const initialClaim = await store.claim(context, started.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("승인 대기 준비 lease를 얻지 못했습니다");
    const approvalId = "approval-claimed-snapshot-0001";
    await store.suspend(context, started.runId, initialClaim.leaseGeneration, approvalId);
    const ready = await store.prepareApprovalResume(context, started.runId, approvalId);

    let reportLateClaimWaiting: () => void = () => undefined;
    const lateClaimWaiting = new Promise<void>((resolve) => {
      reportLateClaimWaiting = resolve;
    });
    let reportFirstAdvanced: () => void = () => undefined;
    const firstAdvanced = new Promise<void>((resolve) => {
      reportFirstAdvanced = resolve;
    });
    let releaseFirstAdvance: () => void = () => undefined;
    const firstAdvanceRelease = new Promise<void>((resolve) => {
      releaseFirstAdvance = resolve;
    });
    const firstStore = {
      get: store.get.bind(store),
      claim: store.claim.bind(store),
      async advance(...input: Parameters<ApplicationRunStore["advance"]>) {
        const advanced = await store.advance(...input);
        reportFirstAdvanced();
        await firstAdvanceRelease;
        return advanced;
      },
      block: store.block.bind(store),
      suspend: store.suspend.bind(store),
      fail: store.fail.bind(store),
      complete: store.complete.bind(store),
    };
    let lateReads = 0;
    const lateStore = {
      get: async (...input: Parameters<ApplicationRunStore["get"]>) =>
        lateReads++ === 0 ? ready : await store.get(...input),
      async claim(...input: Parameters<ApplicationRunStore["claim"]>) {
        reportLateClaimWaiting();
        await firstAdvanced;
        return await store.claim(...input);
      },
      advance: store.advance.bind(store),
      block: store.block.bind(store),
      suspend: store.suspend.bind(store),
      fail: store.fail.bind(store),
      complete: store.complete.bind(store),
    };
    const intakeInputs: Array<{ readonly workId?: string; readonly resumeInput?: unknown }> = [];
    const strategyInputs: Array<{ readonly workId?: string; readonly resumeInput?: unknown }> = [];
    const stages = executors([]);
    const pipeline = {
      ...stages,
      intake: {
        async execute(_context: TenantContext, input: { readonly workId?: string; readonly resumeInput?: unknown }) {
          intakeInputs.push({
            ...(input.workId === undefined ? {} : { workId: input.workId }),
            resumeInput: input.resumeInput,
          });
          return intakeInputs.length === 1
            ? { outcome: "advanced" as const, workId: "work-claimed-snapshot-0001" }
            : { outcome: "in-progress" as const };
        },
      },
      "context-strategy": {
        async execute(_context: TenantContext, input: { readonly workId?: string; readonly resumeInput?: unknown }) {
          strategyInputs.push({
            ...(input.workId === undefined ? {} : { workId: input.workId }),
            resumeInput: input.resumeInput,
          });
          return { outcome: "in-progress" as const };
        },
      },
    };
    const firstCoordinator = new CoreWorkCoordinator(firstStore as never, pipeline);
    const lateCoordinator = new CoreWorkCoordinator(lateStore as never, pipeline);

    const lateRecovery = lateCoordinator.recover(context, started.runId);
    await lateClaimWaiting;
    const firstRecovery = firstCoordinator.recover(context, started.runId);
    await firstAdvanced;
    await expect(lateRecovery).resolves.toMatchObject({ status: "running", stage: "context-strategy" });
    releaseFirstAdvance();
    await expect(firstRecovery).resolves.toMatchObject({ status: "running", stage: "context-strategy" });

    expect(intakeInputs).toEqual([{ resumeInput: { approvalId } }]);
    expect(strategyInputs).toEqual([{ workId: "work-claimed-snapshot-0001", resumeInput: undefined }]);
  });

  it.each([
    { name: "running이 아닌 상태", status: "ready" as const, stage: "intake" as const },
    { name: "terminal stage", status: "running" as const, stage: "terminal" as const },
  ])("claim된 snapshot의 $name 계보는 executor 전에 실패 폐쇄한다", async ({ status, stage }) => {
    const tenant: TenantContext = {
      userId: "user-malformed-claimed-snapshot-0001",
      organizationId: "organization-malformed-claimed-snapshot-0001",
      membershipId: "membership-malformed-claimed-snapshot-0001",
      role: "member",
    };
    const initial = {
      runId: "run-malformed-claimed-snapshot-0001",
      organizationId: tenant.organizationId,
      commandId: "run-malformed-claimed-snapshot-command-0001",
      correlationId: "run-malformed-claimed-snapshot-correlation-0001",
      request: {},
      stage: "intake" as const,
      status: "ready" as const,
      leaseGeneration: 0,
    };
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(
      {
        get: async () => initial,
        claim: async () => ({
          outcome: "claimed" as const,
          leaseGeneration: 1,
          recovered: false,
          run: { ...initial, status, stage, leaseGeneration: 1 },
        }),
      } as never,
      executors(calls),
    );

    await expect(coordinator.recover(tenant, initial.runId)).rejects.toThrow("claim된 Application run snapshot");
    expect(calls).toEqual([]);
  });

  it("stage 실행 예외는 run을 대기 상태로 남기지 않고 차단 상태로 끝낸다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-stage-failure@example.com",
      displayName: "Fail",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      delivery: {
        async execute() {
          throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
        },
      },
    });

    const blocked = await coordinator.start(context, {
      commandId: "core-run-stage-failure-command-0001",
      correlationId: "core-run-stage-failure-correlation-0001",
      request: {},
    });

    expect(blocked).toMatchObject({ status: "blocked", stage: "delivery", blockedReason: "delivery-stage-failed" });
    await expect(store.getByCommand(context, "core-run-stage-failure-command-0001")).resolves.toMatchObject({
      status: "blocked",
      stage: "delivery",
      blockedReason: "delivery-stage-failed",
    });
  });

  it("blocked stage의 bounded detail을 Application run 결과로 전달한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-blocked-detail@example.com",
      displayName: "Blocked detail",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute() {
          return {
            outcome: "blocked",
            reason: "assurance-verifier-rejected",
            blockedDetail: "산출물의 모순을 보완해야 합니다.",
          } as const;
        },
      },
    });

    await expect(
      coordinator.start(context, {
        commandId: "coordinator-blocked-detail-command-0001",
        correlationId: "coordinator-blocked-detail-correlation-0001",
        request: {},
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "assurance-verifier-rejected",
      result: { blockedDetail: "산출물의 모순을 보완해야 합니다." },
    });
  });

  it("terminal Delivery 실패는 failed로 확정하고 재생·복구·재시도로 다시 실행하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-terminal-delivery@example.com",
      displayName: "Terminal delivery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let deliveryCalls = 0;
    const stages = executors([]);
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        async execute() {
          deliveryCalls += 1;
          return {
            outcome: "failed" as const,
            reason: "software-delivery-failed",
            workId: "work-terminal-delivery",
          };
        },
      },
    });
    const request = {
      commandId: "core-run-terminal-delivery-command-0001",
      correlationId: "core-run-terminal-delivery-correlation-0001",
      request: {},
    };

    const failed = await coordinator.start(context, request);
    expect(failed).toMatchObject({
      status: "failed",
      stage: "terminal",
      workId: "work-terminal-delivery",
      blockedReason: "software-delivery-failed",
    });
    await expect(coordinator.start(context, request)).resolves.toMatchObject({ status: "failed", stage: "terminal" });
    await expect(coordinator.recover(context, failed.runId)).resolves.toMatchObject({
      status: "failed",
      stage: "terminal",
    });
    await expect(
      coordinator.retryBlocked(context, failed.runId, "core-run-terminal-delivery-retry-0001"),
    ).rejects.toThrow("차단되었거나");
    expect(await store.listStartupRecoverable()).not.toContainEqual(expect.objectContaining({ runId: failed.runId }));
    expect(deliveryCalls).toBe(1);
  });

  it("blocked 재시도에서 failed가 된 run은 같은 retry attempt와 새 attempt를 모두 거부한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-terminal-retry-lineage@example.com",
      displayName: "Terminal retry lineage",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let calls = 0;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute() {
          calls += 1;
          return calls === 1
            ? { outcome: "blocked", reason: "model-unavailable" }
            : { outcome: "failed", reason: "irrecoverable-delivery-failure" };
        },
      },
    });
    const blocked = await coordinator.start(context, {
      commandId: "core-run-terminal-retry-lineage-command-0001",
      correlationId: "core-run-terminal-retry-lineage-correlation-0001",
      request: {},
    });
    const retryAttemptId = "core-run-terminal-retry-lineage-attempt-0001";
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "failed",
      retryAttemptId,
    });
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).rejects.toThrow("terminal");
    await expect(
      coordinator.retryBlocked(context, blocked.runId, "core-run-terminal-retry-lineage-attempt-0002"),
    ).rejects.toThrow("terminal");
    expect(calls).toBe(2);
  });

  it("failed transaction이 먼저 이기면 뒤늦은 cancel은 Task·Work·ApplicationRun을 cancelled로 후퇴시키지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-fail-wins@example.com",
      displayName: "Fail wins",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const target = await runningDeliveryWork(database, organizations, context);
    const store = await ApplicationRunStore.create(database, organizations);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelCalls = 0;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: { execute: async () => ({ outcome: "advanced", workId: target.work.work_id }) },
      delivery: {
        async execute() {
          entered();
          await barrier;
          return { outcome: "failed", reason: "software-delivery-failed", workId: target.work.work_id };
        },
        async convergeFailure(_context, _result, transaction) {
          await target.works.transitionTask(
            context,
            {
              commandId: "coordinator-fail-wins-task-command-0001",
              workId: target.work.work_id,
              expectedRevision: target.work.revision,
              taskId: target.task.task_id,
              expectedTaskRevision: target.task.revision,
              target: "failed",
            },
            transaction,
          );
        },
        async cancel() {
          cancelCalls += 1;
        },
      },
    });
    const starting = coordinator.start(context, {
      commandId: "coordinator-fail-wins-run-command-0001",
      correlationId: "coordinator-fail-wins-run-correlation-0001",
      request: {},
    });
    await entry;
    release();
    const failed = await starting;
    await expect(coordinator.cancel(context, failed.runId)).resolves.toMatchObject({ status: "failed" });
    await expect(target.works.getWork(context, target.work.work_id)).resolves.toMatchObject({ status: "failed" });
    await expect(target.works.listTasks(context, target.work.work_id)).resolves.toEqual([
      expect.objectContaining({ task_id: target.task.task_id, status: "failed" }),
    ]);
    expect(cancelCalls).toBe(0);
  });

  it("cancel이 먼저 이기면 stale failed transaction은 Task·Work·ApplicationRun을 덮어쓰지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-wins@example.com",
      displayName: "Cancel wins",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const target = await runningDeliveryWork(database, organizations, context);
    const store = await ApplicationRunStore.create(database, organizations);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staleFailCalls = 0;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: { execute: async () => ({ outcome: "advanced", workId: target.work.work_id }) },
      delivery: {
        async execute() {
          entered();
          await barrier;
          return { outcome: "failed", reason: "software-delivery-failed", workId: target.work.work_id };
        },
        async convergeFailure(_context, _result, transaction) {
          staleFailCalls += 1;
          await target.works.transitionTask(
            context,
            {
              commandId: "coordinator-cancel-wins-stale-fail-command-0001",
              workId: target.work.work_id,
              expectedRevision: target.work.revision,
              taskId: target.task.task_id,
              expectedTaskRevision: target.task.revision,
              target: "failed",
            },
            transaction,
          );
        },
        async cancel() {
          const work = await target.works.getWork(context, target.work.work_id);
          if (!canTransitionWork(work.status, "cancelled")) return;
          await target.works.transition(context, {
            commandId: "coordinator-cancel-wins-work-command-0001",
            workId: work.work_id,
            expectedRevision: work.revision,
            target: "cancelled",
          });
        },
      },
    });
    const starting = coordinator.start(context, {
      commandId: "coordinator-cancel-wins-run-command-0001",
      correlationId: "coordinator-cancel-wins-run-correlation-0001",
      request: {},
    });
    await entry;
    const active = await store.getByCommand(context, "coordinator-cancel-wins-run-command-0001");
    await expect(coordinator.cancel(context, active.runId)).resolves.toMatchObject({ status: "cancelled" });
    release();
    await expect(starting).resolves.toMatchObject({ status: "cancelled" });
    await expect(target.works.getWork(context, target.work.work_id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(target.works.listTasks(context, target.work.work_id)).resolves.toEqual([
      expect.objectContaining({ task_id: target.task.task_id, status: "ready" }),
    ]);
    expect(staleFailCalls).toBe(0);
  });

  it("cancel이 running을 읽고 cleanup 대기 중일 때 failed transaction이 커밋되면 stale cancel CAS가 후퇴를 막는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-read-before-fail@example.com",
      displayName: "Cancel read before fail",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const target = await runningDeliveryWork(database, organizations, context);
    const store = await ApplicationRunStore.create(database, organizations);
    let failEntered!: () => void;
    let releaseFail!: () => void;
    let cleanupEntered!: () => void;
    let releaseCleanup!: () => void;
    const failEntry = new Promise<void>((resolve) => {
      failEntered = resolve;
    });
    const failBarrier = new Promise<void>((resolve) => {
      releaseFail = resolve;
    });
    const cleanupEntry = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    const cleanupBarrier = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: { execute: async () => ({ outcome: "advanced", workId: target.work.work_id }) },
      delivery: {
        execute: async () => ({
          outcome: "failed",
          reason: "software-delivery-failed",
          workId: target.work.work_id,
        }),
        async convergeFailure(_context, _result, transaction) {
          failEntered();
          await failBarrier;
          await target.works.transitionTask(
            context,
            {
              commandId: "coordinator-cancel-read-before-fail-task-0001",
              workId: target.work.work_id,
              expectedRevision: target.work.revision,
              taskId: target.task.task_id,
              expectedTaskRevision: target.task.revision,
              target: "failed",
            },
            transaction,
          );
        },
        async cancel() {
          const observed = await target.works.getWork(context, target.work.work_id);
          cleanupEntered();
          await cleanupBarrier;
          await target.works.transition(context, {
            commandId: "coordinator-cancel-read-before-fail-work-0001",
            workId: observed.work_id,
            expectedRevision: observed.revision,
            target: "cancelled",
          });
        },
      },
    });
    const starting = coordinator.start(context, {
      commandId: "coordinator-cancel-read-before-fail-run-0001",
      correlationId: "coordinator-cancel-read-before-fail-correlation-0001",
      request: {},
    });
    await failEntry;
    const active = await store.getByCommand(context, "coordinator-cancel-read-before-fail-run-0001");
    const cancelling = coordinator.cancel(context, active.runId);
    await cleanupEntry;
    releaseFail();
    await expect(starting).resolves.toMatchObject({ status: "failed" });
    releaseCleanup();
    await expect(cancelling).rejects.toThrow("revision");
    await expect(store.get(context, active.runId)).resolves.toMatchObject({ status: "failed" });
    await expect(target.works.getWork(context, target.work.work_id)).resolves.toMatchObject({ status: "failed" });
    await expect(target.works.listTasks(context, target.work.work_id)).resolves.toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("명시적 Delivery cancelled 결과도 기존 취소 drain을 거쳐 cancelled로 확정한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-terminal-cancelled@example.com",
      displayName: "Terminal cancelled",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const drains: string[] = [];
    const stages = executors([]);
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        execute: async () => ({ outcome: "cancelled", reason: "software-delivery-cancelled" }),
        cancel: async (_context, input) => {
          drains.push(input.commandId);
        },
      },
    });

    const cancelled = await coordinator.start(context, {
      commandId: "core-run-terminal-cancelled-command-0001",
      correlationId: "core-run-terminal-cancelled-correlation-0001",
      request: {},
    });

    expect(cancelled).toMatchObject({ status: "cancelled", stage: "terminal" });
    expect(drains).toEqual([`${cancelled.runId}:delivery:cancel`]);
  });

  it("차단된 재시도와 실행 중 취소는 같은 재시도 시도 command prefix를 사용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-prefix@example.com",
      displayName: "Retry prefix",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const calls: string[] = [];
    let retrying = false;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          calls.push(input.commandId);
          return retrying
            ? { outcome: "in-progress" as const }
            : { outcome: "blocked" as const, reason: "assurance-verifier-interrupted" };
        },
        async cancel(_context, input) {
          calls.push(input.commandId);
        },
      },
    });
    const blocked = await coordinator.start(context, {
      commandId: "core-run-retry-prefix-start-0001",
      correlationId: "core-run-retry-prefix-correlation-0001",
      request: {},
    });
    retrying = true;
    const retryAttemptId = "core-run-retry-prefix-resume-0001";
    const retried = await coordinator.retryBlocked(context, blocked.runId, retryAttemptId);
    expect(retried).toMatchObject({ status: "running", retryAttemptId });
    expect(calls).toEqual([`${blocked.runId}:intake`, `${blocked.runId}:intake:retry:${retryAttemptId}`]);

    await expect(coordinator.cancel(context, blocked.runId)).resolves.toMatchObject({ status: "cancelled" });
    expect(calls).toEqual([
      `${blocked.runId}:intake`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
      `${blocked.runId}:intake:retry:${retryAttemptId}:cancel`,
    ]);
  });

  it("같은 재시도 command는 실행 중에는 기다리고 만료 뒤에는 같은 prefix로 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-recovery@example.com",
      displayName: "Retry recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const clock = { now: new Date("2026-07-19T01:00:00.000Z") };
    const store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 1_000 });
    const calls: string[] = [];
    let retrying = false;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          calls.push(input.commandId);
          return retrying
            ? { outcome: "in-progress" as const }
            : { outcome: "blocked" as const, reason: "assurance-verifier-interrupted" };
        },
      },
    });
    const blocked = await coordinator.start(context, {
      commandId: "core-run-retry-recovery-start-0001",
      correlationId: "core-run-retry-recovery-correlation-0001",
      request: {},
    });
    const retryAttemptId = "core-run-retry-recovery-command-0001";
    retrying = true;
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
    });
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
    });
    expect(calls).toEqual([`${blocked.runId}:intake`, `${blocked.runId}:intake:retry:${retryAttemptId}`]);

    clock.now = new Date("2026-07-19T01:00:01.000Z");
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
      leaseGeneration: 3,
    });
    expect(calls).toEqual([
      `${blocked.runId}:intake`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
    ]);
  });

  it("같은 재시도 command는 approval 대기 상태를 다시 실행하지 않고 그대로 반환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-awaiting@example.com",
      displayName: "Retry awaiting",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-awaiting-start-0001",
      correlationId: "core-run-retry-awaiting-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const retryAttemptId = "core-run-retry-awaiting-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.suspend(context, run.runId, retryClaim.leaseGeneration, "approval-retry-awaiting");
    const coordinator = new CoreWorkCoordinator(store, executors([]));

    await expect(coordinator.retryBlocked(context, run.runId, retryAttemptId)).resolves.toMatchObject({
      status: "awaiting-approval",
      retryAttemptId,
    });
    await expect(
      coordinator.retryBlocked(context, run.runId, "core-run-retry-awaiting-other-command-0001"),
    ).rejects.toThrow("같은 재시도");
  });

  it("advance 뒤 같은 재시도 command는 ready stage를 일반 prefix로 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-replay@example.com",
      displayName: "Retry replay",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-replay-start-0001",
      correlationId: "core-run-retry-replay-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const retryAttemptId = "core-run-retry-replay-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, retryClaim.leaseGeneration, { stage: "context-strategy" });
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      "context-strategy": {
        async execute(_context, input) {
          calls.push(input.commandId);
          return { outcome: "in-progress" };
        },
      },
    });

    await expect(coordinator.retryBlocked(context, run.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryReplayId: retryAttemptId,
    });
    expect(calls).toEqual([`${run.runId}:context-strategy`]);
    await expect(
      coordinator.retryBlocked(context, run.runId, "core-run-retry-replay-other-command-0001"),
    ).rejects.toThrow("같은 재시도");
  });

  it("이전 재시도 command replay는 일반 prefix stage의 blocked 결과를 다시 실행하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-replay-blocked@example.com",
      displayName: "Retry replay blocked",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-replay-blocked-start-0001",
      correlationId: "core-run-retry-replay-blocked-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const replayAttemptId = "core-run-retry-replay-blocked-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId: replayAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, retryClaim.leaseGeneration, { stage: "context-strategy" });
    const normalClaim = await store.claim(context, run.runId);
    if (normalClaim.outcome !== "claimed") throw new Error("일반 stage lease를 얻지 못했습니다");
    await store.block(context, run.runId, normalClaim.leaseGeneration, "context-strategy-blocked");
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      "context-strategy": {
        async execute(_context, input) {
          calls.push(input.commandId);
          return { outcome: "in-progress" };
        },
      },
    });

    await expect(coordinator.retryBlocked(context, run.runId, replayAttemptId)).resolves.toMatchObject({
      status: "blocked",
      retryReplayId: replayAttemptId,
    });
    expect(calls).toEqual([]);

    const newRetryAttemptId = "core-run-retry-replay-blocked-command-0002";
    await expect(coordinator.retryBlocked(context, run.runId, newRetryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId: newRetryAttemptId,
    });
    expect(calls).toEqual([`${run.runId}:context-strategy:retry:${newRetryAttemptId}`]);
  });

  it("stage side effect 뒤 crash는 같은 command를 replay해 중복 없이 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-crash@example.com",
      displayName: "Crash",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations, { leaseMs: 1_000 });
    const sideEffects = new Set<string>();
    const stages = executors([]);
    let crash = true;
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...stages,
        evidence: {
          async execute(_context, input) {
            sideEffects.add(input.commandId);
            return { outcome: "advanced" };
          },
        },
      },
      {
        afterStage: (stage) => {
          if (stage === "evidence" && crash) {
            crash = false;
            throw new Error("coordinator crash injection");
          }
        },
      },
    );
    await expect(
      coordinator.start(context, {
        commandId: "core-run-crash-command-0001",
        correlationId: "core-run-crash-correlation-0001",
        request: {},
      }),
    ).rejects.toThrow("crash injection");
    const run = await store.getByCommand(context, "core-run-crash-command-0001");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(sideEffects.size).toBe(1);
  });

  it("cancel은 현재 stage drain을 먼저 요청하고 새 stage 실행을 막는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel@example.com",
      displayName: "Cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    const drains: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        execute: async () => ({ outcome: "awaiting-approval", approvalId: "approval-cancel" }),
        cancel: async (_context, input) => {
          drains.push(input.commandId);
        },
      },
    });
    const waiting = await coordinator.start(context, {
      commandId: "core-run-cancel-command-0001",
      correlationId: "core-run-cancel-correlation-0001",
      request: {},
    });
    const cancelled = await coordinator.cancel(context, waiting.runId);
    expect(cancelled).toMatchObject({ status: "cancelled", stage: "terminal" });
    expect(drains).toEqual([`${waiting.runId}:delivery:cancel`]);
    await expect(coordinator.recover(context, waiting.runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("실행 중 취소가 먼저 끝나면 늦은 stage 결과가 cancelled run을 덮어쓰지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-race@example.com",
      displayName: "Race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    let entered!: () => void;
    let release!: () => void;
    const enteredStage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseStage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      intake: {
        execute: async () => {
          entered();
          await releaseStage;
          return { outcome: "advanced", workId: "work-cancel-race" };
        },
        cancel: async () => undefined,
      },
    });

    const starting = coordinator.start(context, {
      commandId: "core-run-cancel-race-command-0001",
      correlationId: "core-run-cancel-race-correlation-0001",
      request: {},
    });
    await enteredStage;
    const active = await store.getByCommand(context, "core-run-cancel-race-command-0001");
    await expect(coordinator.cancel(context, active.runId)).resolves.toMatchObject({ status: "cancelled" });
    release();
    await expect(starting).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
  });

  it("intake snapshot 대기 중 취소하면 Work와 Representative를 시작하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-intake-preflight-cancel@example.com",
      displayName: "Intake preflight cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseSnapshot!: (value: { readonly version: { readonly version_id: string } }) => void;
    let enteredSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve;
    });
    const snapshot = new Promise<{ readonly version: { readonly version_id: string } }>((resolve) => {
      releaseSnapshot = resolve;
    });
    let createWorkCalls = 0;
    let representativeCalls = 0;
    const coordinator = new CoreWorkCoordinator(
      store,
      createCoreWorkPipelineExecutors({
        graph: {
          getCurrentSnapshot: async () => {
            enteredSnapshot();
            return await snapshot;
          },
        },
        works: {
          createWork: async () => {
            createWorkCalls += 1;
            return { work: { work_id: "work-should-not-exist", revision: 1, status: "draft" } };
          },
          getWork: async () => ({ work_id: "work-should-not-exist", revision: 1, status: "draft" }),
          transition: async () => ({}) as never,
        },
        runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
        representative: {
          execute: async () => {
            representativeCalls += 1;
            return { executionId: "representative-should-not-start", status: "succeeded" };
          },
          cancel: async () => undefined,
        },
        strategy: { plan: async () => ({}) as never },
        evidence: { execute: async () => ({ outcome: "advanced" }) },
        delivery: { execute: async () => ({ outcome: "advanced" }) },
        assurance: { execute: async () => ({ outcome: "advanced" }) },
        records: { execute: async () => ({ outcome: "advanced" }) },
      } as never),
    );

    const starting = coordinator.start(context, {
      commandId: "core-run-intake-preflight-cancel-command-0001",
      correlationId: "core-run-intake-preflight-cancel-correlation-0001",
      request: { text: "snapshot 대기 중 취소" },
    });
    await snapshotEntered;
    const active = await store.getByCommand(context, "core-run-intake-preflight-cancel-command-0001");
    await expect(coordinator.cancel(context, active.runId)).resolves.toMatchObject({ status: "cancelled" });
    releaseSnapshot({ version: { version_id: "organization-version" } });
    await expect(starting).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
    expect(createWorkCalls).toBe(0);
    expect(representativeCalls).toBe(0);
  });

  it("AbortSignal 뒤 stage cancel이 대기 중이어도 start는 최종 cancelled 결과를 반환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-result-race@example.com",
      displayName: "Cancel result race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseSnapshot!: () => void;
    let releaseStageCancel!: () => void;
    let enteredSnapshot!: () => void;
    let observedAbort!: () => void;
    let enteredStageCancel!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          enteredSnapshot();
          await snapshot;
          if (!input.signal?.aborted) throw new Error("취소 신호가 전달되지 않았습니다");
          observedAbort();
          throw new Error("Application run cancelled");
        },
        async cancel() {
          enteredStageCancel();
          await stageCancel;
        },
      },
    });

    const starting = coordinator.start(context, {
      commandId: "core-run-cancel-result-race-command-0001",
      correlationId: "core-run-cancel-result-race-correlation-0001",
      request: {},
    });
    const startingOutcome = starting.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await snapshotEntered;
    const active = await store.getByCommand(context, "core-run-cancel-result-race-command-0001");
    const cancelling = coordinator.cancel(context, active.runId);
    await stageCancelEntered;
    releaseSnapshot();
    await abortObserved;
    await expect(
      Promise.race([
        startingOutcome,
        new Promise<"pending">((resolve) => {
          setImmediate(() => resolve("pending"));
        }),
      ]),
    ).resolves.toBe("pending");
    releaseStageCancel();
    await expect(Promise.all([starting, cancelling])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
  });

  it("claim 직후 취소가 먼저 들어와도 intake side effect에는 aborted signal이 전달된다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-claim-cancel-race@example.com",
      displayName: "Claim cancel race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseStageCancel!: () => void;
    let enteredStageCancel!: () => void;
    let enteredStage!: () => void;
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const stageEntered = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    let sideEffects = 0;
    let receivedAborted: boolean | undefined;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          receivedAborted = input.signal?.aborted;
          if (!input.signal?.aborted) sideEffects += 1;
          enteredStage();
          if (input.signal?.aborted) throw new Error("Application run cancelled");
          return { outcome: "in-progress" };
        },
        async cancel() {
          enteredStageCancel();
          await stageCancel;
        },
      },
    });
    const run = await store.start(context, {
      commandId: "core-run-claim-cancel-race-command-0001",
      correlationId: "core-run-claim-cancel-race-correlation-0001",
      request: {},
    });
    const originalClaim = store.claim.bind(store);
    let cancelling: Promise<unknown> | undefined;
    (store as { claim: typeof store.claim }).claim = async (...args) => {
      const claimed = await originalClaim(...args);
      if (claimed.outcome === "claimed") {
        cancelling = coordinator.cancel(context, run.runId);
        await stageCancelEntered;
      }
      return claimed;
    };

    const recovering = coordinator.recover(context, run.runId);
    await stageEntered;
    const cancellation = cancelling;
    if (!cancellation) throw new Error("claim 직후 취소가 시작되지 않았습니다");
    releaseStageCancel();
    await expect(Promise.all([recovering, cancellation])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
    expect(receivedAborted).toBe(true);
    expect(sideEffects).toBe(0);
  });

  it("취소 중 stage가 advanced를 반환해도 hook이나 다음 stage를 실행하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-post-execute-cancel@example.com",
      displayName: "Post execute cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseStage!: () => void;
    let releaseStageCancel!: () => void;
    let enteredStage!: () => void;
    let enteredStageCancel!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const stage = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    let afterStageCalls = 0;
    let nextStageCalls = 0;
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...executors([]),
        intake: {
          async execute() {
            enteredStage();
            await stage;
            return { outcome: "advanced", workId: "post-execute-work" };
          },
          async cancel() {
            enteredStageCancel();
            await stageCancel;
          },
        },
        "context-strategy": {
          async execute() {
            nextStageCalls += 1;
            return { outcome: "in-progress" };
          },
        },
      },
      {
        afterStage: async () => {
          afterStageCalls += 1;
        },
      },
    );
    const starting = coordinator.start(context, {
      commandId: "core-run-post-execute-cancel-command-0001",
      correlationId: "core-run-post-execute-cancel-correlation-0001",
      request: {},
    });
    await stageEntered;
    const active = await store.getByCommand(context, "core-run-post-execute-cancel-command-0001");
    const cancelling = coordinator.cancel(context, active.runId);
    await stageCancelEntered;
    releaseStage();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const observedBeforeCancellationCompletes = { afterStageCalls, nextStageCalls };
    releaseStageCancel();
    await expect(Promise.all([starting, cancelling])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
    expect(observedBeforeCancellationCompletes).toEqual({ afterStageCalls: 0, nextStageCalls: 0 });
  });

  it("stage cancel 정리 실패 뒤 Work와 Application run을 cancelled로 끝내고 오류를 호출자에게 전파한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-cleanup-failure@example.com",
      displayName: "Cancel cleanup failure",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-cancel-cleanup-failure-command-0001",
      correlationId: "core-run-cancel-cleanup-failure-correlation-0001",
      request: {},
    });
    const claim = await store.claim(context, run.runId);
    if (claim.outcome !== "claimed") throw new Error("delivery 취소용 lease를 얻지 못했습니다");
    const delivery = await store.advance(context, run.runId, claim.leaseGeneration, {
      stage: "delivery",
      workId: "work-cancel-cleanup-failure",
    });
    const workTransitions: unknown[] = [];
    const coordinator = new CoreWorkCoordinator(
      store,
      createCoreWorkPipelineExecutors({
        graph: { getCurrentSnapshot: async () => ({ version: { version_id: "organization-version" } }) },
        works: {
          createWork: async () => ({ work: { work_id: "work-should-not-create", revision: 1, status: "draft" } }),
          getWork: async () => ({ work_id: "work-cancel-cleanup-failure", revision: 4, status: "draft" }),
          transition: async (_context: unknown, input: unknown) => {
            workTransitions.push(input);
            return {} as never;
          },
        },
        runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
        representative: {
          execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
          cancel: async () => undefined,
        },
        strategy: { plan: async () => ({}) as never },
        evidence: { execute: async () => ({ outcome: "advanced" }) },
        delivery: {
          execute: async () => ({ outcome: "advanced" }),
          cancel: async () => {
            throw new Error("stage cleanup failed");
          },
        },
        assurance: { execute: async () => ({ outcome: "advanced" }) },
        records: { execute: async () => ({ outcome: "advanced" }) },
      } as never),
    );

    await expect(coordinator.cancel(context, delivery.runId)).rejects.toThrow("stage cleanup failed");
    expect(workTransitions).toEqual([
      {
        commandId: `${delivery.runId}:work-cancel`,
        workId: "work-cancel-cleanup-failure",
        expectedRevision: 4,
        target: "cancelled",
      },
    ]);
    await expect(store.get(context, delivery.runId)).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
  });

  it("실행 중 제출된 지시를 현재 stage를 중단하지 않고 다음 안전 경계에 별도 입력으로 전달한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-directive@example.com",
      displayName: "Directive",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "coordinator-directive-work-command-0001",
      text: "실행 중 지시 반영",
      surface: "desktop",
      organizationVersionId: "coordinator-directive-org-version-0001",
    });
    const store = await ApplicationRunStore.create(database, organizations);
    const directives = await WorkDirectiveStore.create(database, organizations);
    let entered!: () => void;
    let release!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stageRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: Array<{
      stage: CoreWorkStage;
      resumeInput?: unknown;
      directives?: readonly { directiveId: string; content: string; mode: string }[];
    }> = [];
    const stages = executors([]);
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...stages,
        intake: {
          execute: async () => ({ outcome: "advanced", workId: work.work.work_id }),
        },
        "context-strategy": {
          async execute(_context, input) {
            received.push({
              stage: "context-strategy",
              ...(input.directives === undefined ? {} : { directives: input.directives }),
            });
            entered();
            await stageRelease;
            return { outcome: "advanced" };
          },
        },
        evidence: {
          async execute(_context, input) {
            received.push({
              stage: "evidence",
              resumeInput: input.resumeInput,
              ...(input.directives === undefined ? {} : { directives: input.directives }),
            });
            return { outcome: "advanced" };
          },
        },
        delivery: {
          async execute(_context, input) {
            received.push({
              stage: "delivery",
              resumeInput: input.resumeInput,
              ...(input.directives === undefined ? {} : { directives: input.directives }),
            });
            return {
              outcome: "advanced",
              appliedDirectiveIds: input.directives?.map((directive) => directive.directiveId) ?? [],
            };
          },
        },
      },
      {},
      directives,
    );
    const starting = coordinator.start(context, {
      commandId: "coordinator-directive-run-command-0001",
      correlationId: "coordinator-directive-run-correlation-0001",
      request: { text: "기존 요청" },
    });
    await stageEntered;
    const active = await store.getByCommand(context, "coordinator-directive-run-command-0001");
    const now = await directives.submit(context, {
      commandId: "coordinator-directive-now-command-0001",
      correlationId: "coordinator-directive-now-correlation-0001",
      expectedRevision: work.work.revision,
      workId: work.work.work_id,
      runId: active.runId,
      content: "가장 이른 안전 경계에서 반영",
      mode: "now",
    });
    const next = await directives.submit(context, {
      commandId: "coordinator-directive-next-command-0001",
      correlationId: "coordinator-directive-next-correlation-0001",
      expectedRevision: work.work.revision,
      workId: work.work.work_id,
      runId: active.runId,
      content: "다음 stage 시작 전에 반영",
      mode: "next-stage",
    });
    release();

    await expect(starting).resolves.toMatchObject({ status: "completed", stage: "terminal" });
    expect(received).toEqual([
      { stage: "context-strategy", directives: undefined },
      {
        stage: "evidence",
        resumeInput: undefined,
        directives: undefined,
      },
      {
        stage: "delivery",
        resumeInput: undefined,
        directives: [
          { directiveId: now.directiveId, content: now.content, mode: "now" },
          { directiveId: next.directiveId, content: next.content, mode: "next-stage" },
        ],
      },
    ]);
    await expect(directives.listByRun(context, active.runId)).resolves.toEqual([
      expect.objectContaining({ directiveId: now.directiveId, status: "applied" }),
      expect.objectContaining({ directiveId: next.directiveId, status: "applied" }),
    ]);
  });

  it.each(["evidence", "assurance", "records"] as const)(
    "소비하지 않는 %s stage는 queued 지시를 claim하거나 실행을 차단하지 않는다",
    async (unsupportedStage) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: `coordinator-directive-skip-${unsupportedStage}@example.com`,
        displayName: "Directive skip",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const works = await WorkService.create(database, organizations);
      const work = await works.createWork(context, {
        commandId: `coordinator-directive-skip-${unsupportedStage}-work-command-0001`,
        text: "미지원 단계 지시 선점 금지",
        surface: "desktop",
        organizationVersionId: `coordinator-directive-skip-${unsupportedStage}-org-version-0001`,
      });
      const store = await ApplicationRunStore.create(database, organizations);
      const run = await store.start(context, {
        commandId: `coordinator-directive-skip-${unsupportedStage}-run-command-0001`,
        correlationId: `coordinator-directive-skip-${unsupportedStage}-run-correlation-0001`,
        request: {},
      });
      const setupClaim = await store.claim(context, run.runId);
      if (setupClaim.outcome !== "claimed") throw new Error("미지원 stage 준비용 lease를 얻지 못했습니다");
      await store.advance(context, run.runId, setupClaim.leaseGeneration, {
        stage: unsupportedStage,
        workId: work.work.work_id,
      });
      const directives = await WorkDirectiveStore.create(database, organizations);
      const directive = await directives.submit(context, {
        commandId: `coordinator-directive-skip-${unsupportedStage}-command-0001`,
        correlationId: `coordinator-directive-skip-${unsupportedStage}-correlation-0001`,
        expectedRevision: work.work.revision,
        workId: work.work.work_id,
        runId: run.runId,
        content: "실제 소비 단계까지 보존해주세요",
        mode: "now",
      });
      const received: unknown[] = [];
      const stages = executors([]);
      const coordinator = new CoreWorkCoordinator(
        store,
        {
          ...stages,
          [unsupportedStage]: {
            async execute(_context: TenantContext, input: { readonly directives?: unknown }) {
              received.push(input.directives);
              return { outcome: "advanced" as const };
            },
          },
          delivery: {
            async execute(_context, input) {
              return {
                outcome: "advanced",
                appliedDirectiveIds: input.directives?.map((candidate) => candidate.directiveId) ?? [],
              };
            },
          },
        },
        {},
        directives,
      );

      await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({
        status: "completed",
        stage: "terminal",
      });
      expect(received).toEqual([undefined]);
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
        expect.objectContaining({
          directiveId: directive.directiveId,
          status: unsupportedStage === "evidence" ? "applied" : "unapplied",
        }),
      ]);
    },
  );

  const invalidDirectiveAcknowledgements: readonly (readonly [
    string,
    (directiveIds: readonly string[]) => readonly string[] | undefined,
  ])[] = [
    // 미사용 매개변수를 제거하고, 단정 문법(!) 대신 slice로 안전하게 값을 가져옵니다.
    ["확인 값 없음", (): readonly string[] | undefined => undefined],
    ["일부 누락", (directiveIds: readonly string[]): readonly string[] | undefined => directiveIds.slice(0, 1)],
    [
      "알 수 없는 ID 추가",
      (directiveIds: readonly string[]): readonly string[] | undefined => [...directiveIds, "unknown-directive"],
    ],
    [
      "ID 중복",
      (directiveIds: readonly string[]): readonly string[] | undefined => [
        ...directiveIds,
        ...directiveIds.slice(1, 2),
      ],
    ],
  ];

  it.each(invalidDirectiveAcknowledgements)(
    "claim한 지시의 반영 확인이 정확하지 않으면 모두 failed로 끝내고 stage를 차단한다: %s",
    async (_case, acknowledge) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: "coordinator-directive-unacknowledged@example.com",
        displayName: "Directive unacknowledged",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const works = await WorkService.create(database, organizations);
      const work = await works.createWork(context, {
        commandId: "coordinator-directive-unacknowledged-work-command-0001",
        text: "지시 반영 확인 검증",
        surface: "desktop",
        organizationVersionId: "coordinator-directive-unacknowledged-org-version-0001",
      });
      const store = await ApplicationRunStore.create(database, organizations);
      const run = await store.start(context, {
        commandId: "coordinator-directive-unacknowledged-run-command-0001",
        correlationId: "coordinator-directive-unacknowledged-run-correlation-0001",
        request: {},
      });
      const runClaim = await store.claim(context, run.runId);
      if (runClaim.outcome !== "claimed") throw new Error("delivery 준비용 lease를 얻지 못했습니다");
      await store.advance(context, run.runId, runClaim.leaseGeneration, {
        stage: "delivery",
        workId: work.work.work_id,
      });
      const directives = await WorkDirectiveStore.create(database, organizations);
      const submitted = [];
      for (const sequence of [1, 2]) {
        submitted.push(
          await directives.submit(context, {
            commandId: `coordinator-directive-unacknowledged-command-000${String(sequence)}`,
            correlationId: `coordinator-directive-unacknowledged-correlation-000${String(sequence)}`,
            expectedRevision: work.work.revision,
            workId: work.work.work_id,
            runId: run.runId,
            content: `${String(sequence)}번째 지시`,
            mode: "now",
          }),
        );
      }
      const directiveIds = submitted.map((directive) => directive.directiveId);
      const appliedDirectiveIds = acknowledge(directiveIds);
      let deliveryCalls = 0;
      const stages = executors([]);
      const coordinator = new CoreWorkCoordinator(
        store,
        {
          ...stages,
          delivery: {
            async execute() {
              deliveryCalls += 1;
              return {
                outcome: "advanced",
                ...(appliedDirectiveIds === undefined ? {} : { appliedDirectiveIds }),
              };
            },
          },
        },
        {},
        directives,
      );

      await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({
        status: "blocked",
        stage: "delivery",
        blockedReason: "delivery-directive-unacknowledged",
      });
      expect(deliveryCalls).toBe(1);
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual(
        submitted.map((directive) =>
          expect.objectContaining({
            directiveId: directive.directiveId,
            status: "failed",
            failureReason: "delivery-directive-unacknowledged",
          }),
        ),
      );
    },
  );

  it.each(["blocked", "failed"] as const)(
    "Delivery가 지시 소비 뒤 %s이면 false ack하지 않고 명시적 재시도로 다시 전달한다",
    async (terminalOutcome) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: `coordinator-directive-${terminalOutcome}-retry@example.com`,
        displayName: "Directive delivery retry",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const works = await WorkService.create(database, organizations);
      const work = await works.createWork(context, {
        commandId: `coordinator-directive-${terminalOutcome}-retry-work-command-0001`,
        text: "Delivery 실패 지시 재시도",
        surface: "desktop",
        organizationVersionId: `coordinator-directive-${terminalOutcome}-retry-org-version-0001`,
      });
      const store = await ApplicationRunStore.create(database, organizations);
      const run = await store.start(context, {
        commandId: `coordinator-directive-${terminalOutcome}-retry-run-command-0001`,
        correlationId: `coordinator-directive-${terminalOutcome}-retry-run-correlation-0001`,
        request: {},
      });
      const setupClaim = await store.claim(context, run.runId);
      if (setupClaim.outcome !== "claimed") throw new Error("delivery 실패 준비용 lease를 얻지 못했습니다");
      await store.advance(context, run.runId, setupClaim.leaseGeneration, {
        stage: "delivery",
        workId: work.work.work_id,
      });
      const directives = await WorkDirectiveStore.create(database, organizations);
      const directive = await directives.submit(context, {
        commandId: `coordinator-directive-${terminalOutcome}-retry-command-0001`,
        correlationId: `coordinator-directive-${terminalOutcome}-retry-correlation-0001`,
        expectedRevision: work.work.revision,
        workId: work.work.work_id,
        runId: run.runId,
        content: "실패한 Delivery에서 반영 완료로 처리하지 마세요",
        mode: "now",
      });
      let deliveryCalls = 0;
      const received: unknown[] = [];
      const stages = executors([]);
      const coordinator = new CoreWorkCoordinator(
        store,
        {
          ...stages,
          delivery: {
            async execute(_context, input) {
              deliveryCalls += 1;
              received.push(input.directives);
              if (deliveryCalls === 1) {
                return terminalOutcome === "blocked"
                  ? { outcome: "blocked", reason: "delivery-model-blocked" }
                  : { outcome: "failed", reason: "delivery-model-failed" };
              }
              return {
                outcome: "advanced",
                appliedDirectiveIds: input.directives?.map((candidate) => candidate.directiveId) ?? [],
              };
            },
          },
        },
        {},
        directives,
      );

      await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({
        status: "blocked",
        stage: "delivery",
        blockedReason: "delivery-directive-unacknowledged",
      });
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
        expect.objectContaining({
          directiveId: directive.directiveId,
          status: "failed",
          failureReason: "delivery-directive-unacknowledged",
        }),
      ]);

      await expect(
        coordinator.retryBlocked(context, run.runId, `coordinator-directive-${terminalOutcome}-retry-attempt-0001`),
      ).resolves.toMatchObject({ status: "completed", stage: "terminal" });
      expect(received).toEqual([
        [{ directiveId: directive.directiveId, content: directive.content, mode: directive.mode }],
        [{ directiveId: directive.directiveId, content: directive.content, mode: directive.mode }],
      ]);
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
        expect.objectContaining({ directiveId: directive.directiveId, status: "applied" }),
      ]);
    },
  );

  it("명시적 blocked 재시도에서만 failed 지시를 FIFO로 다시 전달하고 반영한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-directive-retry@example.com",
      displayName: "Directive retry",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "coordinator-directive-retry-work-command-0001",
      text: "실패 지시 재시도",
      surface: "desktop",
      organizationVersionId: "coordinator-directive-retry-org-version-0001",
    });
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "coordinator-directive-retry-run-command-0001",
      correlationId: "coordinator-directive-retry-run-correlation-0001",
      request: {},
    });
    const runClaim = await store.claim(context, run.runId);
    if (runClaim.outcome !== "claimed") throw new Error("evidence 준비용 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, runClaim.leaseGeneration, {
      stage: "evidence",
      workId: work.work.work_id,
    });
    const directives = await WorkDirectiveStore.create(database, organizations);
    const submitted = [];
    for (const sequence of [1, 2]) {
      submitted.push(
        await directives.submit(context, {
          commandId: `coordinator-directive-retry-command-000${String(sequence)}`,
          correlationId: `coordinator-directive-retry-correlation-000${String(sequence)}`,
          expectedRevision: work.work.revision,
          workId: work.work.work_id,
          runId: run.runId,
          content: `${String(sequence)}번째 재시도 지시`,
          mode: "now",
        }),
      );
    }
    const directiveIds = submitted.map((directive) => directive.directiveId);
    const failedRunClaim = await store.claim(context, run.runId);
    if (failedRunClaim.outcome !== "claimed") throw new Error("기존 evidence 실패 재현용 lease를 얻지 못했습니다");
    const legacyClaimed = await directives.claimEligible(
      context,
      run.runId,
      "evidence",
      failedRunClaim.leaseGeneration,
    );
    await Promise.all(
      legacyClaimed.map((directive) =>
        directives.markFailed(
          context,
          directive.directiveId,
          directive.leaseGeneration,
          "evidence-directive-unsupported",
        ),
      ),
    );
    await store.block(
      context,
      run.runId,
      failedRunClaim.leaseGeneration,
      "evidence-directive-unsupported",
      work.work.work_id,
    );

    const received: Array<{ readonly stage: CoreWorkStage; readonly directiveIds?: readonly string[] }> = [];
    const stages = executors([]);
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...stages,
        evidence: {
          async execute(_context, input) {
            const receivedIds = input.directives?.map((directive) => directive.directiveId);
            received.push({
              stage: "evidence",
              ...(receivedIds === undefined ? {} : { directiveIds: receivedIds }),
            });
            return { outcome: "advanced" };
          },
        },
        delivery: {
          async execute(_context, input) {
            const receivedIds = input.directives?.map((directive) => directive.directiveId);
            received.push({
              stage: "delivery",
              ...(receivedIds === undefined ? {} : { directiveIds: receivedIds }),
            });
            return { outcome: "advanced", appliedDirectiveIds: receivedIds ?? [] };
          },
        },
      },
      {},
      directives,
    );

    await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({
      status: "blocked",
      stage: "evidence",
      blockedReason: "evidence-directive-unsupported",
    });
    expect(received).toEqual([]);
    await expect(directives.listByRun(context, run.runId)).resolves.toEqual(
      submitted.map((directive) =>
        expect.objectContaining({
          directiveId: directive.directiveId,
          status: "failed",
          failureReason: "evidence-directive-unsupported",
        }),
      ),
    );

    await expect(
      coordinator.retryBlocked(context, run.runId, "coordinator-directive-retry-attempt-0001"),
    ).resolves.toMatchObject({ status: "completed", stage: "terminal" });
    expect(received).toEqual([
      { stage: "evidence", directiveIds: undefined },
      { stage: "delivery", directiveIds },
    ]);
    await expect(directives.listByRun(context, run.runId)).resolves.toEqual(
      submitted.map((directive) => expect.objectContaining({ directiveId: directive.directiveId, status: "applied" })),
    );
  });

  it.each(["awaiting-approval", "in-progress"] as const)(
    "Delivery가 모델 소비 전에 %s이면 applying 지시를 되돌리고 재개 시 한 번만 소비한다",
    async (preModelOutcome) => {
      await using database = await createDatabase({
        url: "mem://",
        namespace: "massion",
        database: crypto.randomUUID(),
      });
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: `coordinator-directive-${preModelOutcome}@example.com`,
        displayName: "Directive pre-model",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const works = await WorkService.create(database, organizations);
      const work = await works.createWork(context, {
        commandId: `coordinator-directive-${preModelOutcome}-work-command-0001`,
        text: "모델 소비 전 지시 lease 해제",
        surface: "desktop",
        organizationVersionId: `coordinator-directive-${preModelOutcome}-org-version-0001`,
      });
      const clock = { now: new Date("2026-07-22T03:00:00.000Z") };
      const store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 1_000 });
      const directives = await WorkDirectiveStore.create(database, organizations, { clock, leaseMs: 1_000 });
      const run = await store.start(context, {
        commandId: `coordinator-directive-${preModelOutcome}-run-command-0001`,
        correlationId: `coordinator-directive-${preModelOutcome}-run-correlation-0001`,
        request: {},
      });
      const setupClaim = await store.claim(context, run.runId);
      if (setupClaim.outcome !== "claimed") throw new Error("delivery 준비용 lease를 얻지 못했습니다");
      await store.advance(context, run.runId, setupClaim.leaseGeneration, {
        stage: "delivery",
        workId: work.work.work_id,
      });
      const directive = await directives.submit(context, {
        commandId: `coordinator-directive-${preModelOutcome}-command-0001`,
        correlationId: `coordinator-directive-${preModelOutcome}-correlation-0001`,
        expectedRevision: work.work.revision,
        workId: work.work.work_id,
        runId: run.runId,
        content: "재개 후 실제 모델 입력에서 한 번만 소비해주세요",
        mode: "now",
      });
      const received: unknown[] = [];
      let deliveryCalls = 0;
      let consumed = 0;
      const stages = executors([]);
      const coordinator = new CoreWorkCoordinator(
        store,
        {
          ...stages,
          delivery: {
            async execute(_context, input) {
              deliveryCalls += 1;
              received.push(input.directives);
              if (deliveryCalls === 1) {
                return preModelOutcome === "awaiting-approval"
                  ? { outcome: "awaiting-approval", approvalId: "directive-approval-0001" }
                  : { outcome: "in-progress" };
              }
              consumed += 1;
              return {
                outcome: "advanced",
                appliedDirectiveIds: input.directives?.map((candidate) => candidate.directiveId) ?? [],
              };
            },
          },
        },
        {},
        directives,
      );

      const paused = await coordinator.recover(context, run.runId);
      expect(paused).toMatchObject({
        status: preModelOutcome === "awaiting-approval" ? "awaiting-approval" : "running",
        stage: "delivery",
      });
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
        expect.objectContaining({
          directiveId: directive.directiveId,
          status: "queued",
          leaseGeneration: 1,
        }),
      ]);
      const [leaseRecords] = await database.query<[{ readonly lease_expires_at?: unknown }[]]>(
        "SELECT lease_expires_at FROM application_work_directive WHERE organization_id = $organization_id AND directive_id = $directive_id;",
        { organization_id: context.organizationId, directive_id: directive.directiveId },
      );
      expect(leaseRecords).toEqual([{}]);

      let completed;
      if (preModelOutcome === "awaiting-approval") {
        completed = await coordinator.resume(context, run.runId, { approvalId: "directive-approval-0001" });
      } else {
        clock.now = new Date("2026-07-22T03:00:01.001Z");
        completed = await coordinator.recover(context, run.runId);
      }
      expect(completed).toMatchObject({ status: "completed", stage: "terminal" });
      expect(received).toEqual([
        [{ directiveId: directive.directiveId, content: directive.content, mode: directive.mode }],
        [{ directiveId: directive.directiveId, content: directive.content, mode: directive.mode }],
      ]);
      expect(consumed).toBe(1);
      await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
        expect.objectContaining({
          directiveId: directive.directiveId,
          status: "applied",
          leaseGeneration: 2,
        }),
      ]);
    },
  );

  it("lease가 만료된 applying 지시를 자동 회수하지 않고 새 worker의 executor 진입을 차단한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-directive-applying@example.com",
      displayName: "Directive applying",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "coordinator-directive-applying-work-command-0001",
      text: "처리 중 지시 중복 실행 방지",
      surface: "desktop",
      organizationVersionId: "coordinator-directive-applying-org-version-0001",
    });
    const clock = { now: new Date("2026-07-22T01:00:00.000Z") };
    const store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 1_000 });
    const directives = await WorkDirectiveStore.create(database, organizations, { clock, leaseMs: 1_000 });
    const run = await store.start(context, {
      commandId: "coordinator-directive-applying-run-command-0001",
      correlationId: "coordinator-directive-applying-run-correlation-0001",
      request: {},
    });
    const intakeClaim = await store.claim(context, run.runId);
    if (intakeClaim.outcome !== "claimed") throw new Error("delivery 준비용 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, intakeClaim.leaseGeneration, {
      stage: "delivery",
      workId: work.work.work_id,
    });
    const directive = await directives.submit(context, {
      commandId: "coordinator-directive-applying-command-0001",
      correlationId: "coordinator-directive-applying-correlation-0001",
      expectedRevision: work.work.revision,
      workId: work.work.work_id,
      runId: run.runId,
      content: "외부 효과는 한 번만 실행해주세요",
      mode: "now",
    });
    const originalWorkerClaim = await store.claim(context, run.runId);
    if (originalWorkerClaim.outcome !== "claimed") throw new Error("기존 worker의 run lease를 얻지 못했습니다");
    const [applying] = await directives.claimEligible(
      context,
      run.runId,
      "delivery",
      originalWorkerClaim.leaseGeneration,
    );
    expect(applying).toMatchObject({ directiveId: directive.directiveId, status: "applying", leaseGeneration: 1 });

    clock.now = new Date("2026-07-22T01:00:01.001Z");
    let deliveryCalls = 0;
    const stages = executors([]);
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...stages,
        delivery: {
          async execute(_context, input) {
            deliveryCalls += 1;
            return {
              outcome: "advanced",
              appliedDirectiveIds: input.directives?.map((candidate) => candidate.directiveId) ?? [],
            };
          },
        },
      },
      {},
      directives,
    );

    await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({
      status: "blocked",
      stage: "delivery",
      blockedReason: "delivery-directive-busy",
    });
    expect(deliveryCalls).toBe(0);
    await expect(directives.listByRun(context, run.runId)).resolves.toEqual([
      expect.objectContaining({
        directiveId: directive.directiveId,
        status: "applying",
        leaseGeneration: 1,
      }),
    ]);
  });
});
