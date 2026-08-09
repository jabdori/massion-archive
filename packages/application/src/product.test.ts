import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it, vi } from "vitest";

import { ApplicationHttpClient } from "./http-client.js";
import { ApplicationBootstrapCapability } from "./http-server.js";
import { ApplicationProduct } from "./product.js";

const bootstrapCapability = Buffer.alloc(32, 7).toString("base64url");

function bootstrapAuthorization() {
  return new ApplicationBootstrapCapability({
    capability: Buffer.from(bootstrapCapability, "base64url"),
    expiresAt: Date.now() + 60_000,
  });
}

describe("ApplicationProduct", () => {
  it("제품 조립의 approval.decide가 Growth 연결을 찾아 Adoption까지 같은 명령에서 완료한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const owner = await identities.registerPersonalUser({
      email: "approval-growth-product@example.com",
      displayName: "Growth approval owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const approvalId = "approval-growth-product-0001";
    const adopt = vi.fn().mockResolvedValue({
      adoption: { adoption_id: "adoption-growth-product-0001", status: "observing" },
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        { execute: async () => ({ outcome: "advanced" as const }) },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "approval-growth-product-key", key: randomBytes(32) },
      executors,
      domain: {
        approvals: {
          get: vi.fn().mockResolvedValue({ approval_id: approvalId, status: "pending", revision: 1 }),
          vote: vi.fn().mockResolvedValue({ approval_id: approvalId, status: "approved", revision: 2 }),
          cancel: vi.fn(),
        } as never,
        growth: {
          getSuggestionDetailsByApproval: vi.fn().mockResolvedValue({
            suggestion: { suggestion_id: "suggestion-growth-product-0001", revision: 3 },
            evaluation: {
              evaluationRunId: "evaluation-growth-product-0001",
              outcome: "eligible",
              inputHash: "e".repeat(64),
            },
            adoption: {
              adoptionId: "adoption-growth-product-0001",
              status: "awaiting-review",
              commandId: "adoption-command-growth-product-0001",
              approvalId,
              evaluationRunId: "evaluation-growth-product-0001",
              evaluationInputHash: "e".repeat(64),
              beforeVersionId: "memory-growth-product-before",
              beforeChecksum: "b".repeat(64),
            },
          }),
          adopt,
          reject: vi.fn(),
        } as never,
      },
      queries: { status: async () => ({ status: "ready" }) },
    });

    await expect(
      product.commands.dispatch(context, ["approval:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "approval-growth-product-command-0001",
        correlationId: "approval-growth-product-correlation-0001",
        operation: "approval.decide",
        payload: {
          approvalId,
          expectedApprovalRevision: 1,
          vote: "approve",
          reason: "제품 Work 표면에서 승인했습니다",
        },
      }),
    ).resolves.toMatchObject({ data: { approvalId, status: "approved", revision: 2 } });
    expect(adopt).toHaveBeenCalledOnce();
  });

  it("공개 approval.decide를 실제 제품 명령 레지스트리에 조립한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const owner = await identities.registerPersonalUser({
      email: "approval-decide-product@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    let releaseResume: () => void = () => undefined;
    const resumeCompletion = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const vote = vi.fn().mockResolvedValue({
      approval_id: "approval-product-0001",
      execution_id: "approval-product-execution-0001",
      resume_target: "runtime-subscription",
      status: "approved",
      revision: 2,
    });
    const runtimeResume = vi.fn().mockImplementation(async () => {
      await resumeCompletion;
      return { executionId: "approval-product-execution-0001", status: "succeeded" };
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        { execute: async () => ({ outcome: "advanced" as const }) },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "approval-decide-product-key", key: randomBytes(32) },
      executors,
      domain: {
        approvals: { vote, cancel: vi.fn() } as never,
        runtime: { resume: runtimeResume } as never,
      },
      queries: { status: async () => ({ status: "ready" }) },
    });
    const projectPending = vi.spyOn(product.projector, "projectPending");
    const input = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "approval-decide-product-command-0001",
      correlationId: "approval-decide-product-correlation-0001",
      operation: "approval.decide",
      payload: {
        approvalId: "approval-product-0001",
        expectedApprovalRevision: 1,
        vote: "approve",
        reason: "검토 완료",
      },
    };

    const first = product.commands.dispatch(context, ["approval:write"], input);
    await vi.waitFor(() => expect(runtimeResume).toHaveBeenCalledOnce());
    const firstBeforeRelease = await Promise.race([
      first.then(
        (value) => ({ state: "settled" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      new Promise<{ readonly state: "pending" }>((resolve) => {
        setTimeout(() => resolve({ state: "pending" }), 100);
      }),
    ]);
    releaseResume();
    const firstResult = await first;
    const replayed = await product.commands.dispatch(context, ["approval:write"], input);
    await product.drain();

    expect(firstBeforeRelease).toEqual({ state: "pending" });
    expect(firstResult).toMatchObject({
      outcome: "succeeded",
      resource: { type: "Approval", id: "approval-product-0001", revision: 2 },
    });
    expect(replayed).toMatchObject({ outcome: "succeeded" });
    expect(vote).toHaveBeenCalledWith(context, {
      commandId: "approval-decide-product-command-0001",
      approvalId: "approval-product-0001",
      expectedRevision: 1,
      vote: "approve",
      reason: "검토 완료",
    });
    expect(vote).toHaveBeenCalledOnce();
    expect(runtimeResume).toHaveBeenCalledOnce();
    expect(projectPending).not.toHaveBeenCalled();
  });

  it("ApplicationRun Approval은 성공 응답 전 재개 입력을 영속하고 제품 background 복구로 완료한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const owner = await identities.registerPersonalUser({
      email: "approval-run-product@example.com",
      displayName: "Approval run owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const approvalId = "approval-run-product-0001";
    let releaseRun: () => void = () => undefined;
    let reportRunEntered: () => void = () => undefined;
    const runEntered = new Promise<void>((resolve) => {
      reportRunEntered = resolve;
    });
    const runRelease = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const intake = vi.fn().mockImplementation(async () => {
      reportRunEntered();
      await runRelease;
      return { outcome: "advanced" as const, workId: "approval-run-product-work-0001" };
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        { execute: stage === "intake" ? intake : async () => ({ outcome: "advanced" as const }) },
      ]),
    ) as never;
    const vote = vi.fn().mockResolvedValue({ approval_id: approvalId, status: "approved", revision: 2 });
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "approval-run-product-key", key: randomBytes(32) },
      executors,
      domain: { approvals: { vote, cancel: vi.fn() } as never },
      queries: { status: async () => ({ status: "ready" }) },
    });
    const started = await product.runs.start(context, {
      commandId: "approval-run-product-start-0001",
      correlationId: "approval-run-product-start-correlation-0001",
      request: {},
    });
    const claim = await product.runs.claim(context, started.runId);
    if (claim.outcome !== "claimed") throw new Error("제품 승인 대기 준비 lease를 얻지 못했습니다");
    await product.runs.suspend(context, started.runId, claim.leaseGeneration, approvalId);
    const projectPending = vi.spyOn(product.projector, "projectPending");
    const input = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "approval-run-product-decide-0001",
      correlationId: "approval-run-product-decide-correlation-0001",
      operation: "approval.decide",
      payload: {
        approvalId,
        expectedApprovalRevision: 1,
        vote: "approve",
        reason: "제품 복구 승인",
      },
    };

    const handled = product.commands.dispatch(context, ["approval:write"], input);
    await runEntered;
    const beforeRelease = await Promise.race([
      handled.then((value) => ({ state: "settled" as const, value })),
      new Promise<{ readonly state: "pending" }>((resolve) => {
        setTimeout(() => resolve({ state: "pending" }), 100);
      }),
    ]);
    const replayed = await product.commands.dispatch(context, ["approval:write"], input);
    releaseRun();
    await product.drain();

    expect(beforeRelease).toMatchObject({ state: "settled", value: { outcome: "succeeded" } });
    expect(replayed).toMatchObject({ outcome: "succeeded" });
    expect(vote).toHaveBeenCalledOnce();
    expect(intake).toHaveBeenCalledOnce();
    await expect(product.runs.get(context, started.runId)).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
      workId: "approval-run-product-work-0001",
    });
    expect(projectPending).toHaveBeenCalledTimes(1);
  });

  it("한 번에 다 못 비운 outbox는 명령을 더 받지 않아도 계속 비운다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const owner = await identities.registerPersonalUser({
      email: "projection-drain@example.com",
      displayName: "Projection drain owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        { execute: async () => ({ outcome: "advanced" as const, workId: "projection-drain-work-0001" }) },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "projection-drain-key", key: randomBytes(32) },
      executors,
      domain: {} as never,
    });
    // 상한(1,000)까지 꽉 채운 두 번을 지나 세 번째에 남은 것이 없다고 답합니다. 예전에는 한 번만
    // 투영하고 멈춰, 남은 것을 비우려면 사람이 명령을 다시 보내야 했습니다(관측: pending 27,032건).
    const remaining = [1_000, 1_000, 7];
    const projectPending = vi
      .spyOn(product.projector, "projectPending")
      .mockImplementation(async () => remaining.shift() ?? 0);

    await product.commands.dispatch(context, ["work:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "projection-drain-start-0001",
      correlationId: "projection-drain-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "outbox 수렴 검증" } },
    });
    await product.drain();

    expect(projectPending.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(remaining).toHaveLength(0);
    projectPending.mockRestore();
  });

  it("인증·명령·Core run·event를 하나의 실제 HTTP 제품 경계로 조립한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const works = await WorkService.create(database, organizations, graph);
    const policies = await PolicyStore.create(database, organizations);
    const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
    const executors = Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          execute: async () =>
            stage === "intake"
              ? { outcome: "advanced" as const, workId: "product-work-0001" }
              : { outcome: "advanced" as const },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-test-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-bootstrap-command-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
      coreOffice: { version: { version_id: string } };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    await expect(client.status()).resolves.toMatchObject({ data: { status: "ready" } });
    let releaseProjection: () => void = () => undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let activeProjections = 0;
    let maximumActiveProjections = 0;
    const projectPending = vi.spyOn(product.projector, "projectPending").mockImplementation(async () => {
      activeProjections += 1;
      maximumActiveProjections = Math.max(maximumActiveProjections, activeProjections);
      try {
        await projectionGate;
        return 0;
      } finally {
        activeProjections -= 1;
      }
    });
    const command = {
      schemaVersion: "massion.application.v1",
      commandId: "product-run-command-0001",
      correlationId: "product-run-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "제품 경계 검증" } },
    } as const;
    const startCommand = client.command(command);
    await vi.waitFor(() => expect(projectPending).toHaveBeenCalledOnce());
    const responseBeforeProjection = await Promise.race([
      startCommand.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    const replayedCommand = client.command(command);
    const replayBeforeProjection = await Promise.race([
      replayedCommand.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    expect(projectPending).toHaveBeenCalledOnce();
    releaseProjection();
    const started = (await startCommand) as {
      readonly outcome: string;
      readonly data?: { readonly runId?: string; readonly status?: string };
    };
    await replayedCommand;
    await product.drain();
    expect(responseBeforeProjection).toBe("settled");
    expect(replayBeforeProjection).toBe("settled");
    expect(projectPending.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(maximumActiveProjections).toBe(1);
    projectPending.mockRestore();
    expect(started).toMatchObject({ outcome: "accepted", data: { status: "ready", runId: expect.any(String) } });
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      operation: "run.get",
      data: { runId, workId: "product-work-0001", status: "completed", stage: "terminal" },
    });
    await expect(product.runs.getByCommand(initialized.context, "product-run-command-0001")).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    await expect(product.metrics.aggregate(initialized.context, "application_command_total")).resolves.toEqual([
      { dimensions: { operationClass: "run", result: "accepted" }, value: 1 },
    ]);
    await expect(product.metrics.aggregate(initialized.context, "application_run_total")).resolves.toEqual([
      { dimensions: { stage: "terminal", result: "completed" }, value: 1 },
    ]);
    const streamProjection = vi.spyOn(product.projector, "projectPending");
    const streamAbort = new AbortController();
    const stream = client.streamEvents(0, streamAbort.signal);
    await expect(stream.next()).resolves.toMatchObject({ done: false });
    await delay(250);
    expect(streamProjection).toHaveBeenCalledOnce();
    streamAbort.abort();
    await stream.return(undefined).catch(() => undefined);
    streamProjection.mockRestore();
    const pendingWork = await works.createWork(initialized.context, {
      commandId: "product-event-recovery-work-0001",
      text: "일반 event GET 복구 검증",
      surface: "test",
      organizationVersionId: initialized.coreOffice.version.version_id,
    });
    await expect(client.events()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "work.created",
          resource: expect.objectContaining({ type: "Work", id: pendingWork.work.work_id }),
        }),
      ]),
    });
  });

  it("run.resume은 background retry를 한 번 예약하고 같은 command를 accepted로 replay한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    let deliveryAttempts = 0;
    let releaseRetry: () => void = () => undefined;
    const retryCompletion = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        {
          async execute() {
            if (stage === "intake") return { outcome: "advanced" as const, workId: "product-resume-work-0001" };
            if (stage !== "delivery") return { outcome: "advanced" as const };
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) return { outcome: "blocked" as const, reason: "delivery-retry-required" };
            await retryCompletion;
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-resume-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-resume-bootstrap-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-resume-start-0001",
      correlationId: "product-resume-start-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "차단 뒤 비동기 재시도" } },
    })) as { readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await product.drain();
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: { status: "blocked", stage: "delivery", blockedReason: "delivery-retry-required" },
    });

    const resumeCommand = {
      schemaVersion: "massion.application.v1",
      commandId: "product-resume-command-0001",
      correlationId: "product-resume-correlation-0001",
      operation: "run.resume",
      payload: { runId, retryBlocked: true },
    };
    const first = client.command(resumeCommand);
    await vi.waitFor(() => expect(deliveryAttempts).toBe(2));
    const firstBeforeRelease = await Promise.race([
      first.then(
        (value) => ({ state: "settled" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      new Promise<{ readonly state: "pending" }>((resolve) => {
        setTimeout(() => resolve({ state: "pending" }), 100);
      }),
    ]);
    const replayBeforeRelease = await client.command(resumeCommand).then(
      (value) => ({ state: "settled" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );

    releaseRetry();
    const firstResult = await first;
    await product.drain();

    expect(firstBeforeRelease).toMatchObject({ state: "settled", value: { outcome: "accepted" } });
    expect(replayBeforeRelease).toMatchObject({ state: "settled", value: { outcome: "accepted" } });
    expect(firstResult).toMatchObject({ outcome: "accepted", data: { runId } });
    expect(deliveryAttempts).toBe(2);
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: { status: "completed", stage: "terminal" },
    });
  });

  it("백그라운드 stage 예외도 run.blocked 이벤트로 종료한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
    const executors = Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          async execute() {
            if (stage === "intake") return { outcome: "advanced" as const, workId: "product-failed-work-0001" };
            if (stage === "delivery") throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-stage-failure-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-stage-failure-bootstrap-0001",
      capability: bootstrapCapability,
    })) as { access: { token: string } };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const correlationId = "product-stage-failure-correlation-0001";
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-stage-failure-run-0001",
      correlationId,
      operation: "run.start",
      payload: { request: { text: "실패 종료 검증" } },
    })) as { readonly outcome: string; readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");

    await expect(product.drain()).resolves.toBeUndefined();
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: {
        runId,
        workId: "product-failed-work-0001",
        status: "blocked",
        stage: "delivery",
        blockedReason: "delivery-stage-failed",
      },
    });
    await expect(client.events()).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ type: "run.blocked", correlationId })]),
    });
  });

  it("실제 HTTP work.directive.submit을 영속화하고 다음 stage executor에 전달한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const works = await WorkService.create(database, organizations);
    let workId = "";
    let entered!: () => void;
    let release!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stageRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: unknown[] = [];
    const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
    const executors = Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          claimDirectives: stage === "evidence",
          async execute(
            _context: unknown,
            input: { readonly directives?: readonly { readonly directiveId: string }[] },
          ) {
            if (stage === "intake") return { outcome: "advanced" as const, workId };
            if (stage === "context-strategy") {
              entered();
              await stageRelease;
              return { outcome: "advanced" as const };
            }
            if (stage === "evidence") {
              received.push(input.directives);
              return {
                outcome: "advanced" as const,
                appliedDirectiveIds: input.directives?.map((directive) => directive.directiveId) ?? [],
              };
            }
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-directive-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: { works },
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-directive-bootstrap-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const work = await works.createWork(initialized.context, {
      commandId: "product-directive-work-command-0001",
      text: "실제 HTTP 지시 전달",
      surface: "desktop",
      organizationVersionId: "product-directive-org-version-0001",
    });
    workId = work.work.work_id;
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-directive-run-command-0001",
      correlationId: "product-directive-run-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "기존 요청" } },
    })) as { readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await stageEntered;

    try {
      await expect(
        client.command({
          schemaVersion: "massion.application.v1",
          commandId: "product-directive-submit-command-0001",
          correlationId: "product-directive-submit-correlation-0001",
          operation: "work.directive.submit",
          expectedRevision: work.work.revision,
          payload: {
            workId,
            runId,
            content: "최종 보고서에서 개인정보를 제외해주세요",
            mode: "now",
          },
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        resource: { type: "WorkDirective", id: expect.any(String), revision: 1 },
        data: { workId, runId, status: "queued" },
      });
    } finally {
      release();
    }
    await product.drain();

    expect(received).toEqual([
      [
        expect.objectContaining({
          content: "최종 보고서에서 개인정보를 제외해주세요",
          mode: "now",
        }),
      ],
    ]);
    await expect(product.directives.listByRun(initialized.context, runId)).resolves.toEqual([
      expect.objectContaining({ status: "applied", workId, runId }),
    ]);
  }, 20_000);
});
