import {
  ApplicationBootstrapCapability,
  ApplicationHttpClient,
  ApplicationRunStore,
  type ApplicationRunClock,
} from "@massion/application";
import { ContextStore, hashContextContent, StrategyGenerator } from "@massion/context-strategy";
import {
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryRevisionCollector,
  RepositoryScanner,
  RepositoryStore,
} from "@massion/evidence";
import { PromptMemoryStore, growthChecksum } from "@massion/growth";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import {
  normalizeCodexExecutionEvidence,
  OpenAICompatibleModelBuilder,
  RuntimeExecutionStore,
  type SubscriptionAgentAdapter,
} from "@massion/runtime";
import { ExtensionPackageService } from "@massion/extension-host";
import { SOFTWARE_ENGINEERING_TEAM_PROFILE } from "@massion/software-engineering";
import { createDatabase } from "@massion/storage";
import { type ConnectorEvent, type ConnectorTransportDirectory } from "@massion/subscriptions";
import { WorkService } from "@massion/work";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { EdgeRequestExecutor } from "../../connector/src/executor.js";
import { ConnectorIdentityStore } from "../../connector/src/identity-store.js";
import type { ConnectorRequestFrame } from "../../connector/src/protocol.js";
import { createApplicationDesktopService } from "../../desktop/src/desktop-service.js";
import { loadServerConfig, parseDatabaseProvisionConfig, parseServerConfig } from "./config.js";
import {
  createLimitedExecutors,
  createMassionDaemon as createProductDaemon,
  deriveSubscriptionFingerprintKey,
  provisionRemoteDatabase,
} from "./product.js";

const bootstrapCapability = Buffer.alloc(32, 71).toString("base64url");

async function createMassionDaemon(
  config: Parameters<typeof createProductDaemon>[0],
  options?: Parameters<typeof createProductDaemon>[1],
) {
  return await createProductDaemon(config, {
    ...options,
    bootstrapAuthorization: new ApplicationBootstrapCapability({
      capability: Buffer.from(bootstrapCapability, "base64url"),
      expiresAt: Date.now() + 60_000,
    }),
  });
}

async function connectorUpgradeStatus(baseUrl: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const target = new URL("/connectors", baseUrl);
    const upgrade = request(target, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
        "sec-websocket-version": "13",
        "x-forwarded-proto": "https",
      },
    });
    upgrade.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    upgrade.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgrade.once("error", reject);
    upgrade.setTimeout(2_000, () => {
      upgrade.destroy(new Error("Connector WebSocket upgrade 응답 시간이 초과되었습니다"));
    });
    upgrade.end();
  });
}

async function productWorkState(client: ApplicationHttpClient) {
  const listed = (await client.query("work.list", {})) as {
    data?: readonly { workId: string; status: string; artifactIds: readonly string[] }[];
  };
  const works = listed.data ?? [];
  const executions = (
    await Promise.all(
      works.map(async (work) => {
        const response = (await client.query("work.executions", { workId: work.workId })) as {
          data?: readonly { agentHandle: string; status: string }[];
        };
        return response.data ?? [];
      }),
    )
  ).flat();
  return { data: { works, executions } };
}

function openAiCompatibleFixtureResponse(
  request: { readonly messages?: unknown; readonly stream?: unknown },
  fallbackContent: string,
  model: string,
): { readonly contentType: string; readonly body: string } {
  let content = fallbackContent;
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const candidate = (message as { readonly content?: unknown }).content;
      if (typeof candidate !== "string" || !candidate.includes('"operation":"verify_work"')) continue;
      const input = JSON.parse(candidate) as {
        readonly snapshotHash?: unknown;
        readonly material?: {
          readonly tasks?: readonly { readonly taskId?: unknown; readonly status?: unknown }[];
          readonly artifactVersions?: readonly { readonly taskId?: unknown; readonly content?: unknown }[];
        };
      };
      if (typeof input.snapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.snapshotHash)) break;
      const tasks = input.material?.tasks ?? [];
      const artifacts = input.material?.artifactVersions ?? [];
      const verified =
        tasks.length > 0 &&
        tasks.every(
          (task) =>
            typeof task.taskId === "string" &&
            task.status === "completed" &&
            artifacts.some(
              (artifact) =>
                artifact.taskId === task.taskId &&
                artifact.content !== undefined &&
                artifact.content !== null &&
                (typeof artifact.content !== "string" || artifact.content.trim().length > 0),
            ),
        );
      content = JSON.stringify({
        snapshotHash: input.snapshotHash,
        verified,
        reason: verified
          ? "완료된 모든 작업에 연결된 산출물 본문을 확인했습니다."
          : "완료 작업 또는 연결된 산출물 본문이 부족합니다.",
      });
      break;
    }
  }
  const id = crypto.randomUUID();
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (request.stream === true) {
    const chunks = [
      {
        id,
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      },
      {
        id,
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      },
    ];
    return {
      contentType: "text/event-stream",
      body: `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    };
  }
  return {
    contentType: "application/json",
    body: JSON.stringify({
      id,
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    }),
  };
}

describe("Massion server product", () => {
  it("구독 profile fingerprint key를 credential key와 도메인 분리해 결정론적으로 파생한다", () => {
    const credentialKey = Buffer.alloc(32, 31);
    const first = deriveSubscriptionFingerprintKey(credentialKey);
    expect(first).toEqual(deriveSubscriptionFingerprintKey(credentialKey));
    expect(first).toHaveLength(32);
    expect(first).not.toEqual(credentialKey);
    expect(first).not.toEqual(deriveSubscriptionFingerprintKey(Buffer.alloc(32, 32)));
  });

  it("team mode는 SDK 연결 전에 인증된 namespace와 database를 준비한다", async () => {
    const parsed = parseDatabaseProvisionConfig({
      MASSION_DATABASE_URL: "ws://database:8000/rpc",
      MASSION_DATABASE_PROVISION_USER: "root",
      MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: 'runtime-password"; REMOVE DATABASE massion; --',
    });
    const calls: { url: string; authorization: string; body: string }[] = [];
    await provisionRemoteDatabase(parsed, async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: String(init?.body),
      });
      return Response.json(Array.from({ length: 5 }, () => ({ status: "OK", result: null })));
    });
    expect(calls).toEqual([
      {
        url: "http://database:8000/sql",
        authorization: `Basic ${Buffer.from("root:owner-password").toString("base64")}`,
        body: 'DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS massion; USE DB massion; DEFINE USER OVERWRITE massion_runtime ON DATABASE PASSWORD "runtime-password\\"; REMOVE DATABASE massion; --" ROLES EDITOR;',
      },
    ]);
  });

  it("HTTP 200 내부 SurrealQL 오류를 provisioning 성공으로 오인하지 않는다", async () => {
    const parsed = parseDatabaseProvisionConfig({
      MASSION_DATABASE_URL: "ws://database:8000/rpc",
      MASSION_DATABASE_PROVISION_USER: "root",
      MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: "runtime-password",
    });
    await expect(
      provisionRemoteDatabase(parsed, async () =>
        Response.json([
          { status: "OK", result: null },
          { status: "ERR", result: "권한 오류" },
        ]),
      ),
    ).rejects.toThrow("준비에 실패");
  });

  it("기존 Application outbox가 만든 growth_event 테이블이 있어도 Growth 조립 후 수신을 시작한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-growth-event-upgrade-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 42).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    await database.query("DEFINE TABLE growth_event SCHEMALESS;");
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database },
    );
    try {
      await expect(daemon.start()).resolves.toMatchObject({ host: "127.0.0.1" });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("서버 수신 전에 중단된 직접 Agent 실행을 복구하고 정상 종료 때 Runtime을 먼저 비운다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-runtime-recovery-"));
    const databaseUrl = `rocksdb://${join(workspaceRoot, "massion.db")}`;
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 51).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 52).toString("base64url"),
      MASSION_DATABASE_URL: databaseUrl,
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const seedDatabase = await createDatabase(parsed.database);
    const identities = await IdentityService.create(seedDatabase);
    const organizations = await OrganizationService.create(seedDatabase);
    const owner = await identities.registerPersonalUser({
      email: "runtime-recovery@example.com",
      displayName: "Runtime Recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const executions = await RuntimeExecutionStore.create(seedDatabase, organizations);
    const created = await executions.createExecution(context, {
      commandId: "runtime-recovery-seed-command-0001",
      workId: "work-before-restart",
      agentHandle: "representative",
      modelRoute: "orchestration-balanced",
      correlationId: "runtime-recovery-seed-correlation-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: "재시작 전에 중단된 직접 실행",
    });
    await executions.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: { agentHandle: "representative" },
    });

    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database: seedDatabase },
    );
    const address = await daemon.start();
    try {
      await vi.waitFor(async () => {
        const ready = await fetch(`${address.url}/health/ready`);
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({
          components: { "runtime-recovery": "ready" },
        });
      });
      const [recovered] = await seedDatabase.query<[{ status: string }[]]>(
        "SELECT status FROM runtime_execution WHERE execution_id = $execution_id LIMIT 1;",
        { execution_id: created.execution.execution_id },
      );
      expect(recovered).toEqual([{ status: "interrupted" }]);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("서버 수신 전에 이전 process lease의 pending Strategy를 안전하게 terminal로 복구한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-strategy-recovery-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 62).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const seedDatabase = await createDatabase(parsed.database);
    const identities = await IdentityService.create(seedDatabase);
    const organizations = await OrganizationService.create(seedDatabase);
    const owner = await identities.registerPersonalUser({
      email: "strategy-startup-recovery@example.com",
      displayName: "Strategy Startup Recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(seedDatabase, organizations);
    const work = await works.createWork(context, {
      commandId: "strategy-startup-work",
      text: "재시작 뒤 복구할 계획",
      surface: "test",
      organizationVersionId: "organization-v1",
    });
    const contexts = await ContextStore.create(seedDatabase, organizations, works);
    const content = "재시작 뒤 복구할 계획";
    const version = await contexts.create(context, {
      commandId: "strategy-startup-context",
      workId: work.work.work_id,
      tokenBudget: 1_000,
      objective: "Strategy 시작 복구",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "strategy-startup-request",
          revision: "1",
          contentHash: hashContextContent(content),
          observedAt: "2026-07-30T00:00:00.000Z",
          classification: "internal",
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
    const seedGenerator = await StrategyGenerator.create(
      seedDatabase,
      organizations,
      { executeStructured: vi.fn() },
      contexts,
      works,
    );
    const strategyGenerationId = crypto.randomUUID();
    await seedDatabase.query(
      "CREATE strategy_generation CONTENT { strategy_generation_id: $strategy_generation_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: 'strategy-startup:generate', request_hash: $request_hash, expected_work_revision: 1, status: 'pending', execution_claim_id: 'previous-process', execution_claim_expires_at: type::datetime('2099-01-01T00:00:00.000Z'), created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() };",
      {
        strategy_generation_id: strategyGenerationId,
        organization_id: context.organizationId,
        work_id: work.work.work_id,
        context_version_id: version.contextVersionId,
        request_hash: "0".repeat(64),
        created_by_user_id: context.userId,
      },
    );
    await expect(seedGenerator.listStartupRecoverable()).resolves.toEqual([
      {
        strategyGenerationId,
        organizationId: context.organizationId,
        actorUserId: context.userId,
      },
    ]);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database: seedDatabase },
    );
    await seedDatabase.query(
      "UPDATE strategy_generation SET execution_claim_expires_at = type::datetime($expires_at) WHERE strategy_generation_id = $strategy_generation_id;",
      {
        strategy_generation_id: strategyGenerationId,
        expires_at: new Date(Date.now() + 100).toISOString(),
      },
    );

    const address = await daemon.start();
    try {
      const ready = await fetch(`${address.url}/health/ready`);
      await expect(ready.json()).resolves.toMatchObject({ components: { "strategy-recovery": "ready" } });
      const [rows] = await seedDatabase.query<[{ readonly status: string }[]]>(
        "SELECT status FROM strategy_generation WHERE strategy_generation_id = $strategy_generation_id;",
        { strategy_generation_id: strategyGenerationId },
      );
      expect(rows[0]?.status).not.toBe("pending");
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("서버 수신 전에 원래 사용자 문맥으로 복구 가능한 ApplicationRun을 표준 Core 경로에 재진입시킨다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-application-run-recovery-"));
    const databaseUrl = `rocksdb://${join(workspaceRoot, "massion.db")}`;
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 53).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 54).toString("base64url"),
      MASSION_DATABASE_URL: databaseUrl,
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const seedDatabase = await createDatabase(parsed.database);
    const identities = await IdentityService.create(seedDatabase);
    const organizations = await OrganizationService.create(seedDatabase);
    const owner = await identities.registerPersonalUser({
      email: "application-run-recovery-owner@example.com",
      displayName: "Application Run Recovery Owner",
    });
    const member = await identities.registerPersonalUser({
      email: "application-run-recovery-member@example.com",
      displayName: "Application Run Recovery Member",
    });
    const ownerPersonalContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    const team = await organizations.createTeam(owner.user.user_id, "Application Run Recovery Team");
    const ownerContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      team.organization.organization_id,
    );
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(
      member.user.user_id,
      team.organization.organization_id,
    );
    const graph = await OrganizationGraphService.create(seedDatabase, organizations);
    await graph.bootstrap(ownerContext);
    await graph.bootstrap(ownerPersonalContext);
    const prompts = await PromptMemoryStore.create(seedDatabase, organizations);
    await prompts.bootstrap(ownerContext, await graph.listNodes(ownerContext));
    await prompts.bootstrap(ownerPersonalContext, await graph.listNodes(ownerPersonalContext));
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database: seedDatabase },
    );
    let now = new Date(Date.now() - 60_000);
    const clock: ApplicationRunClock = {
      get now() {
        return now;
      },
    };
    const runs = await ApplicationRunStore.create(seedDatabase, organizations, { leaseMs: 1_000, clock });
    const ready = await runs.start(ownerContext, {
      commandId: "application-run-startup-ready-command-0001",
      correlationId: "application-run-startup-ready-correlation-0001",
      request: { text: "재시작 전에 준비된 실행" },
    });
    const expired = await runs.start(memberContext, {
      commandId: "application-run-startup-expired-command-0001",
      correlationId: "application-run-startup-expired-correlation-0001",
      request: { text: "재시작 전에 lease가 만료된 실행" },
    });
    const expiredClaim = await runs.claim(memberContext, expired.runId);
    if (expiredClaim.outcome !== "claimed") throw new Error("만료 대상 ApplicationRun lease를 얻지 못했습니다");
    now = new Date(Date.now() + 60_000);
    const active = await runs.start(ownerPersonalContext, {
      commandId: "application-run-startup-active-command-0001",
      correlationId: "application-run-startup-active-correlation-0001",
      request: { text: "다른 조직에서 아직 lease가 유효한 실행" },
    });
    const activeClaim = await runs.claim(ownerPersonalContext, active.runId);
    if (activeClaim.outcome !== "claimed") throw new Error("활성 ApplicationRun lease를 얻지 못했습니다");

    const preflight = await runs.listStartupRecoverable(100);
    expect(preflight).toHaveLength(2);
    expect(preflight.map(({ runId, organizationId, actorUserId }) => ({ runId, organizationId, actorUserId }))).toEqual(
      [
        {
          runId: ready.runId,
          organizationId: ownerContext.organizationId,
          actorUserId: ownerContext.userId,
        },
        {
          runId: expired.runId,
          organizationId: memberContext.organizationId,
          actorUserId: memberContext.userId,
        },
      ].sort((left, right) => left.runId.localeCompare(right.runId)),
    );
    expect(preflight.every((candidate) => new Date(candidate.createdAt).toISOString() === candidate.createdAt)).toBe(
      true,
    );

    const address = await daemon.start();
    try {
      // 시작 복구는 `start()`가 돌려준 뒤에도 계속 돕니다. probe는 그동안 정직하게 not-ready를
      // 답하므로, 즉시 단언하면 빠른 머신에서만 우연히 통과합니다. 이 테스트는 `pnpm verify`
      // 안에 있어서 그 우연이 곧 릴리스 게이트의 간헐적 거짓말이 됩니다. 결과를 기다립니다.
      await vi.waitFor(async () => {
        const readyResponse = await fetch(`${address.url}/health/ready`);
        expect(readyResponse.status).toBe(200);
        await expect(readyResponse.json()).resolves.toMatchObject({
          components: { "application-run-recovery": "ready" },
        });
      });
      await vi.waitFor(
        async () => {
          const [records] = await seedDatabase.query<
            [{ run_id: string; organization_id: string; status: string; lease_generation: number; work_id?: string }[]]
          >(
            "SELECT run_id, organization_id, status, lease_generation, work_id FROM application_run WHERE run_id IN $run_ids;",
            { run_ids: [ready.runId, expired.runId, active.runId] },
          );
          const byId = new Map(records.map((record) => [record.run_id, record]));
          expect(byId.get(ready.runId)).toMatchObject({
            organization_id: ownerContext.organizationId,
            status: "blocked",
            lease_generation: 1,
          });
          expect(byId.get(expired.runId)).toMatchObject({
            organization_id: memberContext.organizationId,
            status: "blocked",
            lease_generation: expiredClaim.leaseGeneration + 1,
          });
          expect(byId.get(active.runId)).toMatchObject({
            organization_id: ownerPersonalContext.organizationId,
            status: "running",
            lease_generation: activeClaim.leaseGeneration,
          });
        },
        { timeout: 5_000 },
      );
      const [requests] = await seedDatabase.query<[{ requester_user_id: string; text: string }[]]>(
        "SELECT requester_user_id, text FROM work_request WHERE text IN $texts ORDER BY text ASC;",
        { texts: ["재시작 전에 준비된 실행", "재시작 전에 lease가 만료된 실행"] },
      );
      expect(requests).toEqual([
        {
          requester_user_id: memberContext.userId,
          text: "재시작 전에 lease가 만료된 실행",
        },
        {
          requester_user_id: ownerContext.userId,
          text: "재시작 전에 준비된 실행",
        },
      ]);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("로컬 daemon과 owner 접근 토큰으로 extension.list를 조회하고 registry.info 누락 버전이 fallback 메시지로 실패하지 않는다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-extension-registry-wiring-"));
    const capabilityDirectory = join(workspaceRoot, "bootstrap");
    const rawCapability = Buffer.alloc(32, 71);
    await mkdir(capabilityDirectory, { mode: 0o700 });
    await chmod(capabilityDirectory, 0o700);
    const capabilityPath = join(await realpath(capabilityDirectory), "instance.cap");
    await writeFile(capabilityPath, rawCapability, { mode: 0o600, flag: "wx" });
    const fractionalSeconds = Date.now() / 1_000 - 0.456_789;
    await utimes(capabilityPath, fractionalSeconds, fractionalSeconds);
    const parsed = await loadServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 8).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
      MASSION_BOOTSTRAP_CAPABILITY_FILE: capabilityPath,
    });
    const config = {
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    };
    const daemon = await createProductDaemon(config);
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "extension-registry-wiring-bootstrap-0001",
        capability: rawCapability.toString("base64url"),
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      // extension.list: governance 승인 기반 lifecycle/gateway가 연결되어 빈 설치 목록을 반환한다.
      await expect(client.query("extension.list", {})).resolves.toMatchObject({ data: [] });
      // registry.info: 누락 버전은 not-found로 실패해야 하며 ApplicationProduct fallback 텍스트가 아니어야 한다.
      let registryInfoError: unknown = "did-not-throw";
      try {
        await client.query("registry.info", { versionId: "missing-registry-version" });
      } catch (error) {
        registryInfoError = error;
      }
      expect(registryInfoError).toBeInstanceOf(Error);
      expect(String((registryInfoError as Error).message)).not.toContain("Registry가 구성되지 않았습니다");
    } finally {
      await daemon.close();
      rawCapability.fill(0);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("번들 Slack Registry 설치는 승인 뒤 같은 commandId로 재개해 active installation을 반환한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-registry-resume-"));
    const bundledRoot = join(workspaceRoot, "bundled-extensions");
    const runtime = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" };
    const packed = await new ExtensionPackageService({ runtime }).pack(
      resolve(process.cwd(), "../../extensions/slack"),
      bundledRoot,
    );
    const archive = packed.tarballPath.split("/").pop();
    if (!archive) throw new Error("번들 Slack archive 이름이 없습니다");
    await writeFile(
      join(bundledRoot, "official-extensions.json"),
      JSON.stringify([
        {
          packageName: packed.artifact.manifest.name,
          packageVersion: packed.artifact.manifest.version,
          archive,
          artifactDigest: packed.artifact.artifactDigest,
        },
      ]),
    );
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 75).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 76).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
      MASSION_REGISTRY_ARTIFACT_ROOT: join(workspaceRoot, "registry"),
      MASSION_REGISTRY_BUNDLED_EXTENSIONS: bundledRoot,
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database },
    );
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "registry-resume-bootstrap-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const search = (await client.query("registry.search", { query: "slack", limit: 20 })) as {
        data: { items: Array<{ versionId: string }> };
      };
      const command = {
        schemaVersion: "massion.application.v1" as const,
        commandId: "registry-resume-install-0001",
        correlationId: "registry-resume-correlation-0001",
        operation: "registry.install",
        payload: {
          versionId: search.data.items[0]?.versionId,
          environment: "production",
          riskClass: "medium",
          executionId: "registry-resume-execution-0001",
        },
      };
      if (!command.payload.versionId) throw new Error("번들 Slack Registry version이 없습니다");
      const awaiting = (await client.command(command)) as { data: { approvalId: string } };
      const pending = (await client.query("governance.approval.list", { status: "pending" })) as {
        data: Array<{ approvalId: string; revision: number }>;
      };
      const approval = pending.data.find((item) => item.approvalId === awaiting.data.approvalId);
      if (!approval) throw new Error("Registry 설치 Approval이 없습니다");
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "registry-resume-decide-0001",
        correlationId: "registry-resume-decide-correlation-0001",
        operation: "approval.decide",
        payload: {
          approvalId: approval.approvalId,
          expectedApprovalRevision: approval.revision,
          vote: "approve",
          reason: "번들 Slack 설치 승인",
        },
      });
      await expect(
        client.command({ ...command, payload: { ...command.payload, installApprovalId: approval.approvalId } }),
      ).resolves.toMatchObject({ outcome: "succeeded", data: { packageName: "@massion-ext/slack" } });
      await expect(client.query("extension.list", {})).resolves.toMatchObject({
        data: [{ packageName: "@massion-ext/slack", state: "active", activeVersionId: expect.any(String) }],
      });
      const [sessions] = await database.query<[{ state: string; process_id: number }[]]>(
        "SELECT state, process_id FROM extension_worker_session;",
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ state: "healthy" });
      expect(sessions[0]?.process_id).toBeGreaterThan(0);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("초기 설치의 결정 화면은 빈 승인 목록과 자율성 상태를 함께 조회한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-decisions-query-wiring-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 73).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 74).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database },
    );
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "decisions-query-wiring-bootstrap-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });

      await expect(client.query("governance.approval.list", { status: "pending" })).resolves.toMatchObject({
        data: [],
      });
      await expect(client.query("governance.autonomy", {})).resolves.toMatchObject({
        data: { mode: "automatic", revision: 0 },
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("trusted Workspace Work는 실제 코드 지식 조립을 거쳐 모델 경계까지 진행한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-knowledge-wiring-"));
    const repositoryRoot = join(workspaceRoot, "repository");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(
      join(repositoryRoot, "src", "order.ts"),
      "export function calculateTotal(items: number[]): number { return items.reduce((sum, item) => sum + item, 0); }\n",
    );
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 81).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 82).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const daemon = await createMassionDaemon({
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    });
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "knowledge-wiring-bootstrap-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const registered = (await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "knowledge-wiring-workspace-register-0001",
        correlationId: "knowledge-wiring-workspace-register-correlation-0001",
        operation: "workspace.register",
        payload: { path: repositoryRoot },
      })) as { data: { workspaceId: string; revision: number } };
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "knowledge-wiring-workspace-trust-0001",
        correlationId: "knowledge-wiring-workspace-trust-correlation-0001",
        operation: "workspace.trust",
        expectedRevision: registered.data.revision,
        payload: { workspaceId: registered.data.workspaceId, decision: "trusted" },
      });
      const accepted = (await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "knowledge-wiring-run-0001",
        correlationId: "knowledge-wiring-run-correlation-0001",
        operation: "run.start",
        payload: {
          request: {
            text: "calculateTotal 함수의 동작을 설명해주세요",
            workspaceId: registered.data.workspaceId,
            workspacePaths: ["src/order.ts"],
          },
        },
      })) as { data: { runId: string } };

      let run: { readonly workId?: string; readonly status?: string; readonly blockedReason?: string } | undefined;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const response = (await client.query("run.get", { runId: accepted.data.runId })) as { data: typeof run };
        run = response.data;
        if (run?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(run).toMatchObject({ status: "blocked", blockedReason: "model-unavailable", workId: expect.any(String) });
      await expect(client.query("work.knowledge", { workId: run?.workId })).resolves.toMatchObject({
        data: {
          status: "blocked",
          references: [],
          failureReason: "knowledge-integrity-check-failed",
        },
      });
      const shared = (await client.query("work.shared-contexts", { workId: run?.workId })) as {
        data: readonly unknown[];
      };
      expect(shared.data).toEqual([
        expect.objectContaining({
          sourceKind: "evidence-brief",
          versionId: expect.any(String),
          checksum: expect.any(String),
        }),
      ]);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("초기 설치에서 개인 기억은 비어 있고 제안·효과를 반환한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-growth-query-wiring-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 71).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 72).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const daemon = await createMassionDaemon({
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    });
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "growth-query-wiring-bootstrap-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });

      await expect(client.query("growth.configuration.get", {})).resolves.toMatchObject({
        data: { reflectionEnabled: true, adoptionMode: "review" },
      });
      await expect(client.query("growth.memories", {})).resolves.toMatchObject({ data: [] });
      await expect(client.query("growth.suggestions", { limit: 50 })).resolves.toMatchObject({ data: [] });
      await expect(client.query("growth.effects", { limit: 50 })).resolves.toMatchObject({ data: [] });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-product-software-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 10).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
      MASSION_EDGE_CONNECTOR_ENABLED: "true",
      MASSION_TRUSTED_PROXIES: "127.0.0.1",
    });
    const config = {
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    };
    const daemon = await createMassionDaemon(config);
    expect((await stat(join(workspaceRoot, "connectors"))).mode & 0o777).toBe(0o700);
    const address = await daemon.start();
    try {
      await vi.waitFor(async () => {
        const ready = await fetch(`${address.url}/health/ready`);
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({
          status: "ready",
          components: {
            database: "ready",
            migrations: "ready",
            connectors: "ready",
            "server-connectors": "ready",
            "subscription-quota": "ready",
            "runtime-recovery": "ready",
          },
        });
      });
      await expect(connectorUpgradeStatus(address.url)).resolves.toBe(101);
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "server-bootstrap-command-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      await expect(
        client.issueConnectorEnrollment({
          commandId: "server-connector-enrollment-0001",
          location: "edge",
          executionKind: "agent-runtime",
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({
        enrollmentId: expect.any(String),
        enrollmentCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        challengeNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(String),
      });
      await expect(client.query("subscription.providers", {})).resolves.toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ providerId: "openai-codex" })]),
      });
      await expect(client.query("subscription.accounts", {})).resolves.toMatchObject({ data: [] });
      await expect(client.query("subscription.policy", {})).resolves.toMatchObject({ data: [] });
      const preparedSubscription = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "server-subscription-prepare-0001",
        correlationId: "server-subscription-correlation-0001",
        operation: "subscription.server.prepare",
        payload: {
          providerId: "openai-codex",
          alias: "Codex Personal",
          authKind: "cli-profile",
          billingKind: "consumer-subscription",
          priority: 1,
          weight: 1,
        },
      });
      expect(preparedSubscription).toMatchObject({
        outcome: "succeeded",
        resource: { type: "SubscriptionAccount", id: expect.any(String) },
        data: {
          providerId: "openai-codex",
          alias: "Codex Personal",
          scope: "personal",
          status: "offline",
          connectorStatus: "offline",
          loginRequired: true,
          profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
        },
      });
      expect(JSON.stringify(preparedSubscription)).not.toMatch(/runtimeArtifactDigest|profileLocator|publicKey/u);
      await expect(client.status()).resolves.toMatchObject({
        data: { status: "ready", mode: "local", modelRuntime: "limited" },
      });
      const accepted = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "server-run-command-0001",
        correlationId: "server-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "모델 없는 제한 모드" } },
      });
      expect(accepted).toMatchObject({ outcome: "accepted", data: { status: "ready" } });
      let snapshot:
        | {
            data?: {
              works?: readonly { workId: string; status: string }[];
              executions?: readonly { agentHandle: string; status: string }[];
            };
          }
        | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        snapshot = (await productWorkState(client)) as typeof snapshot;
        if (
          snapshot?.data?.executions?.some(
            (execution) =>
              execution.agentHandle === "representative" && execution.status === "blocked_model_unavailable",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot?.data?.works).toEqual([expect.objectContaining({ status: "draft" })]);
      expect(snapshot?.data?.executions).toEqual([
        expect.objectContaining({ agentHandle: "representative", status: "blocked_model_unavailable" }),
      ]);
      const failedWorkId = snapshot?.data?.works?.[0]?.workId;
      if (!failedWorkId) throw new Error("제한 모드에서 생성된 Work를 찾을 수 없습니다");
      const failedRooms = (await client.query("work.rooms", { workId: failedWorkId })) as {
        data: readonly { roomId: string }[];
      };
      const failedRoomId = failedRooms.data[0]?.roomId;
      if (!failedRoomId) throw new Error("제한 모드의 Core Office 방을 찾을 수 없습니다");
      await expect(
        client.query("work.messages", { workId: failedWorkId, roomId: failedRoomId }),
      ).resolves.toMatchObject({
        data: [{ sequence: 1, messageType: "question", authorKind: "user" }],
      });
      await expect(
        createLimitedExecutors().intake.execute(
          { userId: "user", organizationId: "organization", membershipId: "membership", role: "owner" },
          {
            runId: "run",
            commandId: "command",
            correlationId: "correlation",
            request: { text: "모델 없는 제한 모드" },
          },
        ),
      ).resolves.toEqual({ outcome: "blocked", reason: "model-unavailable" });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    expect(daemon.state).toBe("stopped");
  }, 20_000);

  it("OpenAI 호환 route에서 역량 공백을 승인받아 Work Agent로 실제 Core 경로를 완료한다", async () => {
    const sourceSecret = "sk-knowledge-secret-1234567890";
    const providerOutputSecret = "sk-provider-output-secret-1234567890";
    const modelRequests: string[] = [];
    const connectorEvents: ConnectorEvent[] = [];
    const deliveryEvidence = normalizeCodexExecutionEvidence(
      [
        {
          id: "live-core-command-1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "calculateTotal tests passed",
          exit_code: 0,
          status: "completed",
        },
        {
          id: "live-core-file-1",
          type: "file_change",
          changes: [{ path: "src/order.ts", kind: "update" }],
          status: "completed",
        },
      ],
      "/workspace",
    );
    if (!deliveryEvidence) throw new Error("제품 실행 근거 fixture를 만들지 못했습니다");
    let edgeExecutor: EdgeRequestExecutor | undefined;
    const connectorTransport: ConnectorTransportDirectory = {
      async *invoke(_organizationId, connectorId, connectorRequest): AsyncIterable<ConnectorEvent> {
        if (connectorId !== "live-core-agent-runtime" || connectorRequest.operation !== "agent-turn") {
          throw new Error("제품 fixture Connector 요청이 유효하지 않습니다");
        }
        if (!edgeExecutor) throw new Error("제품 fixture Edge executor가 준비되지 않았습니다");
        const events: ConnectorEvent[] = [];
        await edgeExecutor.execute({ ...connectorRequest, type: "request" } as ConnectorRequestFrame, (event) => {
          const connectorEvent = { kind: event.kind, sequence: event.sequence, payload: event.payload } as const;
          events.push(connectorEvent);
          connectorEvents.push(connectorEvent);
        });
        for (const event of events) yield event;
      },
    };
    const plan = {
      objective: "실제 Core 경로 검증",
      summary: "한 작업을 전달하고 검증 단계까지 진행한다",
      scopeIn: ["제품 경로"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "core-path",
          statement: "전달 작업이 완료된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-core",
          title: "Core 전달",
          objective: "실제 Delivery Agent를 실행한다",
          criterionKeys: ["core-path"],
          dependencyKeys: [],
          requiredCapabilities: ["quant-analysis"],
          recommendedAgentHandles: [],
          parallelizable: false,
          taskAxis: "code-generation",
          reasoningDifficulty: "medium",
        },
      ],
      evidenceRequests: [],
    };
    const modelServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        modelRequests.push(rawBody);
        const body = JSON.parse(rawBody) as { response_format?: unknown; messages?: unknown; stream?: unknown };
        const fixture = openAiCompatibleFixtureResponse(
          body,
          body.response_format
            ? JSON.stringify(plan)
            : rawBody.includes("execute_work_task")
              ? "DELIVERY_RESULT_calculateTotal_검증완료"
              : rawBody.includes("coordinate_work")
                ? `전략 단계로 전달합니다. ${providerOutputSecret}`
                : "완료",
          "massion-test-model",
        );
        response.setHeader("content-type", fixture.contentType);
        response.end(fixture.body);
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "massion-live-core-")));
    const repositoryRoot = join(workspaceRoot, "repository");
    const sourcePath = join(repositoryRoot, "src", "order.ts");
    await mkdir(repositoryRoot, { recursive: true });
    await chmod(repositoryRoot, 0o700);
    const profileRoot = join(workspaceRoot, "live-core-profile");
    await mkdir(profileRoot, { mode: 0o700 });
    const edgeWorkspaceRoot = join(workspaceRoot, "live-core-edge-workspace");
    await mkdir(edgeWorkspaceRoot, { mode: 0o700 });
    const identityPath = join(workspaceRoot, "live-core-identity.json");
    const pendingIdentity = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-live-core-agent-runtime",
      connectorId: "live-core-agent-runtime",
      commandId: "command-live-core-agent-runtime",
      providerId: "openai-codex",
      accountAlias: "Live Core Agent Runtime",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [edgeWorkspaceRoot],
    });
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(
      sourcePath,
      `const apiKey = "${sourceSecret}";\nexport function calculateTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n`,
    );
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 21).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 22).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database, connectorTransport },
    );
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "live-core-bootstrap-command-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const command = async (operation: string, payload: unknown) =>
        (await client.command({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          payload,
        })) as { data: Record<string, unknown> };
      await command("router.provider.register", {
        providerId: "local-openai",
        displayName: "Local OpenAI",
        adapterKind: "openai-compatible",
      });
      const endpoint = await command("router.endpoint.register", {
        providerId: "local-openai",
        name: "Test API",
        baseUrl: `http://127.0.0.1:${String(modelAddress.port)}/v1`,
        local: true,
      });
      await command("router.credential.add", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        label: "test-account",
        credentialType: "api_key",
        secret: "test-secret",
        priority: 1,
        weight: 1,
      });
      const model = await command("router.model.register", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        modelId: "massion-test-model",
        routeKind: "chat",
        contextWindow: 200000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "core-test",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      });
      let deliveryRouteId = "";
      for (const name of [
        "orchestration-balanced",
        "planning-quality",
        "delivery-quality",
        "assurance-independent",
        "software-engineering-quality",
      ]) {
        const route = await command("router.route.configure", {
          name,
          routeKind: "chat",
          credentialPolicy: "round-robin",
          dataPolicy: "external-allowed",
          equivalenceGroup: "core-test",
          minEvalScore: 0,
          requireTools: false,
          requireStructuredOutput: name === "planning-quality",
          requireVision: false,
          requireStreaming: false,
          maxContextTokens: 200000,
          requestBudgetMicros: 1000000,
          totalBudgetMicros: 10000000,
        });
        if (name === "delivery-quality") deliveryRouteId = String(route.data.routeId);
        await command("router.candidate.add", {
          routeId: route.data.routeId,
          modelProfileId: model.data.modelProfileId,
          priority: 1,
        });
      }
      if (!deliveryRouteId) throw new Error("Delivery route fixture가 없습니다");
      const [organizations, users, memberships] = await database.query<
        [
          Array<{ readonly organization_id: string }>,
          Array<{ readonly user_id: string }>,
          Array<{ readonly membership_id: string; readonly role: "owner" | "admin" | "member" }>,
        ]
      >(
        "SELECT organization_id FROM organization LIMIT 1; SELECT user_id FROM identity_user LIMIT 1; SELECT membership_id, role FROM membership LIMIT 1;",
      );
      const organization = organizations[0];
      const user = users[0];
      const membership = memberships[0];
      if (!organization || !user || !membership) throw new Error("제품 fixture 조직·사용자를 찾을 수 없습니다");
      const edgeIdentity = await new ConnectorIdentityStore(identityPath).activate(pendingIdentity, {
        organizationId: organization.organization_id,
        userId: user.user_id,
        membershipId: membership.membership_id,
        role: membership.role,
      });
      const adapter: SubscriptionAgentAdapter = {
        execute: async (_context, input) => {
          modelRequests.push(JSON.stringify({ prompt: input.prompt }));
          return {
            outcome: "completed",
            executionId: input.executionId,
            sessionId: "live-core-session",
            value: "DELIVERY_RESULT_calculateTotal_검증완료",
            usage: { inputTokens: 8, outputTokens: 2 },
            executionEvidence: deliveryEvidence,
          };
        },
        resume: vi.fn(),
        cancel: vi.fn(),
      };
      edgeExecutor = new EdgeRequestExecutor({
        identity: edgeIdentity,
        factory: { create: () => adapter },
        healthProbe: { verify: async (input) => ({ authKind: input.expectedAuthKind }) },
      });
      await database.query(
        `CREATE subscription_connector CONTENT {
           connector_id: 'live-core-agent-runtime', organization_id: $organization_id, owner_user_id: $owner_user_id,
           location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
           protocol: 'massion.connector.v1', version: '1.0.0', public_key: $public_key,
           capabilities: $capabilities, status: 'ready',
           last_heartbeat_at: time::now(), expires_at: time::now() + 30m,
           created_at: time::now(), updated_at: time::now()
         };`,
        {
          organization_id: organization.organization_id,
          owner_user_id: user.user_id,
          public_key: edgeIdentity.publicKey,
          capabilities: edgeIdentity.capabilities,
        },
      );
      await command("router.provider.register", {
        providerId: "openai-codex",
        displayName: "OpenAI Codex",
        adapterKind: "subscription-agent",
      });
      const codexEndpoint = await command("router.endpoint.register", {
        providerId: "openai-codex",
        name: "Live Core Agent Runtime",
        baseUrl: "http://127.0.0.1/live-core-agent-runtime",
        local: true,
      });
      await command("subscription.account.register", {
        providerId: "openai-codex",
        alias: "Live Core Agent Runtime",
        connectorId: "live-core-agent-runtime",
        profileLocator: "live-core-agent-runtime-profile",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        priority: 1,
        weight: 1,
      });
      const [codexAccounts] = await database.query<[Array<{ readonly account_id: string }>]>(
        "SELECT account_id FROM subscription_account WHERE organization_id = $organization_id AND provider_id = 'openai-codex' LIMIT 1;",
        { organization_id: organization.organization_id },
      );
      const subscriptionAccountId = codexAccounts[0]?.account_id;
      const codexEndpointId = String(codexEndpoint.data.endpointId ?? "");
      if (!subscriptionAccountId || !codexEndpointId) {
        throw new Error(
          `Agent runtime Provider fixture가 불완전합니다 (account=${String(Boolean(subscriptionAccountId))}, endpoint=${String(Boolean(codexEndpointId))})`,
        );
      }
      await database.query(
        `CREATE provider_credential CONTENT {
           credential_id: $credential_id, organization_id: $organization_id, provider_id: 'openai-codex',
           endpoint_id: $endpoint_id, label: 'Live Core Agent Runtime', credential_type: 'subscription_session',
           status: 'active', version: 1, secret_version: 0, priority: 1, weight: 1, request_count: 0,
           input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0,
           material_kind: 'connector_session', subscription_account_id: $account_id,
           subscription_connector_id: 'live-core-agent-runtime', subscription_scope: 'personal',
           created_at: time::now(), updated_at: time::now()
         };`,
        {
          credential_id: crypto.randomUUID(),
          organization_id: organization.organization_id,
          endpoint_id: codexEndpointId,
          account_id: subscriptionAccountId,
        },
      );
      const agentModel = await command("router.model.register", {
        providerId: "openai-codex",
        endpointId: codexEndpointId,
        modelId: "gpt-5.6-sol",
        routeKind: "chat",
        contextWindow: 200000,
        supportsTools: true,
        supportsStructuredOutput: false,
        supportsVision: false,
        supportsStreaming: false,
        equivalenceGroup: "core-test",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: false,
      });
      const verificationEvidence = [
        {
          kind: "runtime-availability",
          source: "codex-app-server:model/list",
          sourceVersion: "0.144.1",
          observedAt: "2026-08-02T00:00:00.000Z",
          accountId: subscriptionAccountId,
          claim: { modelId: "gpt-5.6-sol", hidden: false, actualAvailable: true },
        },
        {
          kind: "provider-capability-contract",
          source: "https://developers.openai.com/codex/models",
          sourceVersion: "retrieved-2026-08-02",
          observedAt: "2026-08-02T00:00:01.000Z",
          claim: { contextWindow: 200000, tools: true, structuredOutput: false, vision: false, streaming: false },
        },
        {
          kind: "runtime-capability-contract",
          source: "massion:fixture-agent-runtime",
          sourceVersion: "1.0.0",
          observedAt: "2026-08-02T00:00:02.000Z",
          accountId: subscriptionAccountId,
          claim: {
            runtimeArtifactDigest: "a".repeat(64),
            agentRuntime: true,
            contextWindow: 200000,
            tools: true,
            structuredOutput: false,
            vision: false,
            streaming: false,
          },
        },
      ];
      for (const evidence of verificationEvidence) {
        const claimJson = JSON.stringify(evidence.claim);
        await database.query(
          `CREATE model_verification_evidence CONTENT {
             evidence_id: $evidence_id, organization_id: $organization_id, model_profile_id: $model_profile_id,
             model_id: 'gpt-5.6-sol', subscription_account_id: $account_id, evidence_kind: $kind,
             source: $source, source_version: $source_version, claim_json: $claim_json,
             claim_digest: $claim_digest, observed_at: type::datetime($observed_at),
             created_by: $created_by, created_at: time::now()
           };`,
          {
            evidence_id: crypto.randomUUID(),
            organization_id: organization.organization_id,
            model_profile_id: agentModel.data.modelProfileId,
            account_id: evidence.accountId,
            kind: evidence.kind,
            source: evidence.source,
            source_version: evidence.sourceVersion,
            claim_json: claimJson,
            claim_digest: createHash("sha256").update(claimJson).digest("hex"),
            observed_at: evidence.observedAt,
            created_by: user.user_id,
          },
        );
      }
      await database.query(
        "UPDATE model_profile SET verified = true, updated_at = time::now() WHERE organization_id = $organization_id AND model_profile_id = $model_profile_id;",
        { organization_id: organization.organization_id, model_profile_id: agentModel.data.modelProfileId },
      );
      await database.query(
        `CREATE model_route_candidate CONTENT {
           candidate_id: $candidate_id, organization_id: $organization_id, route_id: $route_id,
           model_profile_id: $model_profile_id, priority: 2, enabled: true,
           created_at: time::now()
         };`,
        {
          candidate_id: crypto.randomUUID(),
          organization_id: organization.organization_id,
          route_id: deliveryRouteId,
          model_profile_id: agentModel.data.modelProfileId,
        },
      );
      const [agentCredentials] = await database.query<
        [
          Array<{
            readonly credential_id: string;
            readonly subscription_connector_id?: string;
            readonly status: string;
          }>,
        ]
      >(
        "SELECT credential_id, subscription_connector_id, status FROM provider_credential WHERE organization_id = $organization_id AND provider_id = 'openai-codex';",
        { organization_id: organization.organization_id },
      );
      if (!agentCredentials.some((credential) => credential.subscription_connector_id === "live-core-agent-runtime")) {
        throw new Error(`Agent runtime Credential fixture가 없습니다 (${String(agentCredentials.length)})`);
      }
      await expect(client.status()).resolves.toMatchObject({ data: { modelRuntime: "ready" } });
      const registered = (await command("workspace.register", { path: repositoryRoot })) as {
        data: { workspaceId: string; revision: number };
      };
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "workspace.trust",
        expectedRevision: registered.data.revision,
        payload: { workspaceId: registered.data.workspaceId, decision: "trusted" },
      });
      const accepted = (await command("run.start", {
        request: {
          text: "calculateTotal 함수의 동작을 검증해주세요",
          workspaceId: registered.data.workspaceId,
          workspacePaths: ["src/order.ts"],
        },
      })) as { data: { runId: string } };
      let run = (await client.query("run.get", { runId: accepted.data.runId })) as {
        data: { runId: string; workId: string; status: string; approvalId?: string; blockedReason?: string };
      };
      let dynamicStaffingApprovalSeen = false;
      for (let decisionRound = 0; decisionRound < 12; decisionRound += 1) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (["awaiting-approval", "blocked", "completed", "failed", "cancelled"].includes(run.data.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          run = (await client.query("run.get", { runId: accepted.data.runId })) as typeof run;
        }
        if (run.data.status === "completed") break;
        if (run.data.status === "blocked") {
          throw new Error(
            `실제 Core 경로가 차단됐습니다: ${run.data.blockedReason ?? "unknown"} ${JSON.stringify(connectorEvents)}`,
          );
        }
        expect(run.data).toMatchObject({ status: "awaiting-approval", approvalId: expect.any(String) });
        const pending = (await client.query("governance.approval.list", {
          workId: run.data.workId,
          status: "pending",
        })) as {
          data: readonly {
            approvalId: string;
            action: string;
            workId?: string;
            revision?: number;
          }[];
        };
        const approval = pending.data.find((candidate) => candidate.approvalId === run.data.approvalId);
        expect(approval).toMatchObject({ workId: run.data.workId, revision: expect.any(Number) });
        if (!approval?.revision) throw new Error("Work Approval을 찾을 수 없습니다");
        const [staffingProposals] = await database.query<
          [{ readonly organization_id: string; readonly approval_id: string; readonly status: string }[]]
        >(
          "SELECT organization_id, approval_id, status FROM dynamic_staffing_proposal WHERE work_id = $work_id AND approval_id = $approval_id LIMIT 1;",
          {
            work_id: run.data.workId,
            approval_id: approval.approvalId,
          },
        );
        const staffingProposal = staffingProposals[0];
        const isDynamicStaffingApproval = staffingProposal?.status === "awaiting-approval";
        if (isDynamicStaffingApproval) {
          dynamicStaffingApprovalSeen = true;
          const [approvalRecords] = await database.query<[{ readonly decision_id: string }[]]>(
            "SELECT decision_id FROM governance_approval WHERE organization_id = $organization_id AND approval_id = $approval_id LIMIT 1;",
            { organization_id: staffingProposal.organization_id, approval_id: approval.approvalId },
          );
          const decisionId = approvalRecords[0]?.decision_id;
          if (!decisionId) throw new Error("Dynamic Staffing Policy Decision을 찾을 수 없습니다");
          const [decisions] = await database.query<[{ readonly action: string }[]]>(
            "SELECT action FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
            { organization_id: staffingProposal.organization_id, decision_id: decisionId },
          );
          expect(decisions[0]?.action).toBe("organization.change");
          const beforeApprovalGraph = (await client.query("organization.graph.snapshot", {})) as {
            data: { nodes: readonly { scope: string; work_id?: string }[] };
          };
          expect(
            beforeApprovalGraph.data.nodes.filter((node) => node.scope === "work" && node.work_id === run.data.workId),
          ).toEqual([]);
          await expect(client.query("work.assignments", { workId: run.data.workId })).resolves.toMatchObject({
            data: [],
          });
        }
        await command("approval.decide", {
          approvalId: approval.approvalId,
          expectedApprovalRevision: approval.revision,
          vote: "approve",
          reason: isDynamicStaffingApproval
            ? "Work별 quant-analysis Agent 제안을 승인합니다"
            : "실제 Core 경로의 선행 실행을 승인합니다",
        });
        run = (await client.query("run.get", { runId: accepted.data.runId })) as typeof run;
      }
      expect(dynamicStaffingApprovalSeen).toBe(true);
      let snapshot: {
        data?: {
          works?: readonly { status: string }[];
          executions?: readonly { agentHandle: string; status: string }[];
        };
      } = {};
      for (let attempt = 0; attempt < 300; attempt += 1) {
        snapshot = (await productWorkState(client)) as typeof snapshot;
        if (
          (snapshot.data?.executions?.length ?? 0) >= 4 &&
          snapshot.data?.works?.some((work) => work.status === "completed")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "completed" })]);
      for (let attempt = 0; attempt < 300 && run.data.status !== "completed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = (await client.query("run.get", { runId: accepted.data.runId })) as typeof run;
      }
      expect(run.data.status).toBe("completed");
      let organizationGraph = (await client.query("organization.graph.snapshot", {})) as {
        data: {
          nodes: readonly {
            handle: string;
            status: string;
            scope: string;
            work_id?: string;
            capabilities: readonly string[];
          }[];
        };
      };
      let workNodes = organizationGraph.data.nodes.filter(
        (node) => node.scope === "work" && node.work_id === run.data.workId,
      );
      for (let attempt = 0; attempt < 300 && workNodes.length > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        organizationGraph = (await client.query("organization.graph.snapshot", {})) as typeof organizationGraph;
        workNodes = organizationGraph.data.nodes.filter(
          (node) => node.scope === "work" && node.work_id === run.data.workId,
        );
      }
      expect(workNodes).toEqual([]);
      const assignments = (await client.query("work.assignments", { workId: run.data.workId })) as {
        data: readonly { taskId: string; agentHandle: string; status: string }[];
      };
      expect(assignments.data).toEqual([
        expect.objectContaining({ agentHandle: expect.any(String), status: "assigned" }),
      ]);
      const staffHandle = assignments.data[0]?.agentHandle;
      if (!staffHandle) throw new Error("적용된 Dynamic Staffing Work Agent가 없습니다");
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: staffHandle, status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
        ]),
      );
      const executions = (await client.query("work.executions", { workId: run.data.workId })) as {
        data: readonly { executionId: string; taskId?: string; agentHandle: string; status: string }[];
      };
      const staffExecution = executions.data.find(
        (execution) => execution.agentHandle === staffHandle && execution.status === "succeeded",
      );
      expect(staffExecution).toMatchObject({ taskId: assignments.data[0]?.taskId, executionId: expect.any(String) });
      const [runtimeLineages] = await database.query<
        [
          {
            prompt_version_id?: string;
            prompt_checksum?: string;
            memory_version_ids?: readonly string[];
            agent_instruction_checksum?: string;
          }[],
        ]
      >(
        "SELECT prompt_version_id, prompt_checksum, memory_version_ids, agent_instruction_checksum FROM runtime_execution WHERE execution_id = $execution_id LIMIT 1;",
        { execution_id: staffExecution?.executionId },
      );
      const runtimeLineage = runtimeLineages[0];
      if (!runtimeLineage?.prompt_version_id) throw new Error("Dynamic Staffing Runtime Prompt 계보가 없습니다");
      const [promptVersions] = await database.query<
        [
          {
            prompt_version_id: string;
            work_id: string;
            agent_sections_json: string;
            checksum: string;
            memory_version_ids: readonly string[];
          }[],
        ]
      >(
        "SELECT prompt_version_id, work_id, agent_sections_json, checksum, memory_version_ids FROM prompt_version WHERE prompt_version_id = $prompt_version_id LIMIT 1;",
        { prompt_version_id: runtimeLineage.prompt_version_id },
      );
      const promptVersion = promptVersions[0];
      if (!promptVersion) throw new Error("Dynamic Staffing Runtime의 PromptVersion을 찾을 수 없습니다");
      const deliverySection = (
        JSON.parse(promptVersion.agent_sections_json) as readonly {
          agentHandle: string;
          instruction: string;
          capabilityReferences: readonly string[];
        }[]
      ).find((section) => section.agentHandle === "delivery-coordination");
      if (!deliverySection) throw new Error("Dynamic Staffing이 상속할 Delivery Prompt section이 없습니다");
      const [workNodeRecords] = await database.query<
        [
          {
            handle: string;
            status: string;
            responsibility: string;
            capabilities: readonly string[];
            outputs: readonly string[];
          }[],
        ]
      >(
        "SELECT handle, status, responsibility, capabilities, outputs FROM organization_node WHERE work_id = $work_id AND handle = $handle LIMIT 1;",
        { work_id: run.data.workId, handle: staffHandle },
      );
      const workNode = workNodeRecords[0];
      if (!workNode) throw new Error("Dynamic Staffing Work Agent node를 찾을 수 없습니다");
      expect(workNode).toMatchObject({ status: "inactive", capabilities: ["quant-analysis"] });
      const expectedInstruction = [
        deliverySection.instruction,
        "",
        `Work 전용 역할: ${workNode.responsibility}`,
        `필수 역량: ${workNode.capabilities.join(", ")}`,
        `주요 산출물: ${workNode.outputs.join(", ")}`,
      ].join("\n");
      const expectedInstructionChecksum = growthChecksum({
        agentHandle: staffHandle,
        instruction: expectedInstruction,
        capabilityReferences: workNode.capabilities,
      });
      expect(runtimeLineage).toMatchObject({
        prompt_version_id: promptVersion.prompt_version_id,
        prompt_checksum: promptVersion.checksum,
        memory_version_ids: promptVersion.memory_version_ids,
        agent_instruction_checksum: expectedInstructionChecksum,
      });
      expect(promptVersion.work_id).toBe(run.data.workId);
      const artifacts = (await client.query("work.artifacts", { workId: run.data.workId })) as {
        data: readonly {
          artifactVersionId: string;
          creatorAgentHandle?: string;
          creatorExecutionId?: string;
        }[];
      };
      expect(artifacts.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            creatorAgentHandle: staffHandle,
            creatorExecutionId: staffExecution?.executionId,
          }),
        ]),
      );
      const rooms = (await client.query("work.rooms", { workId: run.data.workId })) as {
        data: readonly { roomId: string; coordinatorHandle?: string; participantIds: readonly string[] }[];
      };
      expect(rooms.data).toEqual([
        expect.objectContaining({
          coordinatorHandle: "representative",
          participantIds: expect.arrayContaining([staffHandle]),
        }),
      ]);
      const roomId = rooms.data[0]?.roomId;
      if (!roomId) throw new Error("실제 Core 경로의 Core Office 방을 찾을 수 없습니다");
      const collaboration = (await client.query("work.messages", {
        workId: run.data.workId,
        roomId,
      })) as {
        data: readonly {
          messageId: string;
          sequence: number;
          messageType: string;
          authorKind: string;
          authorId: string;
          content: string;
          replyToMessageId?: string;
          causedByMessageId?: string;
          taskId?: string;
          contextVersionId?: string;
          executionId?: string;
          artifactVersionId?: string;
        }[];
      };
      expect(
        collaboration.data.map(({ sequence, messageType, authorKind, authorId }) => ({
          sequence,
          messageType,
          authorKind,
          authorId,
        })),
      ).toEqual([
        { sequence: 1, messageType: "question", authorKind: "user", authorId: expect.any(String) },
        { sequence: 2, messageType: "handoff", authorKind: "agent", authorId: "representative" },
        { sequence: 3, messageType: "answer", authorKind: "agent", authorId: "context-strategy" },
        { sequence: 4, messageType: "proposal", authorKind: "agent", authorId: "context-strategy" },
        { sequence: 5, messageType: "evidence", authorKind: "agent", authorId: staffHandle },
        { sequence: 6, messageType: "evidence", authorKind: "agent", authorId: "assurance" },
        { sequence: 7, messageType: "answer", authorKind: "agent", authorId: "representative" },
      ]);
      for (const [index, message] of collaboration.data.entries()) {
        expect(message.content.trim(), `collaboration message ${String(index + 1)} content`).not.toBe("");
        expect(message.content, `collaboration message ${String(index + 1)} secret boundary`).not.toContain(
          sourceSecret,
        );
        expect(message.content, `collaboration message ${String(index + 1)} provider secret boundary`).not.toContain(
          providerOutputSecret,
        );
        if (index === 0) continue;
        const previous = collaboration.data[index - 1];
        expect(message.replyToMessageId, `collaboration message ${String(index + 1)} reply lineage`).toBe(
          previous?.messageId,
        );
        expect(message.causedByMessageId, `collaboration message ${String(index + 1)} causal lineage`).toBe(
          previous?.messageId,
        );
      }
      expect(collaboration.data[1]?.executionId).toEqual(expect.any(String));
      expect(collaboration.data[2]).toMatchObject({
        contextVersionId: expect.any(String),
        executionId: expect.any(String),
      });
      expect(collaboration.data[3]).toMatchObject({
        messageType: "proposal",
        content: expect.stringContaining(staffHandle),
      });
      expect(collaboration.data[4]).toMatchObject({
        taskId: expect.any(String),
        executionId: staffExecution?.executionId,
        artifactVersionId: expect.any(String),
      });
      expect(collaboration.data[5]?.executionId).toEqual(expect.any(String));
      expect(collaboration.data[6]).toMatchObject({
        artifactVersionId: collaboration.data[4]?.artifactVersionId,
        content: expect.stringContaining("DELIVERY_RESULT_calculateTotal_검증완료"),
      });
      expect(
        collaboration.data.filter(
          (message) => message.authorId === "representative" && message.messageType === "answer",
        ),
      ).toHaveLength(1);
      const ready = (await client.query("work.knowledge", { workId: run.data.workId })) as {
        data: {
          status: string;
          evidenceBriefId?: string;
          freshnessStatus?: string;
          snapshotChecksum?: string;
          evidenceBriefChecksum?: string;
          references: readonly {
            relativePath?: string;
            startLine?: number;
            endLine?: number;
            provenance?: {
              selection: string;
              snapshotChecksum: string;
              paths: readonly unknown[];
            };
          }[];
        };
      };
      expect(ready.data).toMatchObject({
        status: "ready",
        freshnessStatus: "fresh",
        snapshotChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
        evidenceBriefChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
        references: expect.arrayContaining([
          expect.objectContaining({
            kind: "chunk",
            relativePath: "src/order.ts",
            qualifiedName: "calculateTotal",
            startLine: 2,
            endLine: 4,
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            provenance: {
              selection: "scope",
              snapshotChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
              paths: [expect.objectContaining({ seed: expect.objectContaining({ referenceId: expect.any(String) }) })],
            },
          }),
        ]),
      });
      expect(
        ready.data.references.every((item) => item.provenance?.snapshotChecksum === ready.data.snapshotChecksum),
      ).toBe(true);
      expect(JSON.stringify(ready.data)).not.toContain(sourceSecret);
      const shared = (await client.query("work.shared-contexts", { workId: run.data.workId })) as {
        data: readonly { sourceKind: string; sourceId: string; checksum: string }[];
      };
      const lineage = shared.data.filter((reference) => reference.sourceKind === "evidence-brief");
      expect(lineage).toHaveLength(1);
      const evidenceBriefId = ready.data.evidenceBriefId;
      const briefChecksum = lineage[0]?.checksum;
      const reference = ready.data.references[0];
      if (
        !evidenceBriefId ||
        !briefChecksum ||
        !reference?.relativePath ||
        !reference.startLine ||
        !reference.endLine
      ) {
        throw new Error("실제 Core 경로의 Evidence lineage를 찾을 수 없습니다");
      }
      const citation = `${reference.relativePath}:${String(reference.startLine)}-${String(reference.endLine)}`;
      const stageRequest = (operation: string): string => {
        const matches = modelRequests.filter((modelRequest) => modelRequest.includes(operation));
        expect(matches, `${operation} model request`).toHaveLength(1);
        return matches[0] as string;
      };
      const nestedStrings = (value: unknown): readonly string[] => {
        if (typeof value === "string") return [value];
        if (Array.isArray(value)) return value.flatMap(nestedStrings);
        if (value && typeof value === "object") return Object.values(value).flatMap(nestedStrings);
        return [];
      };
      for (const [stage, operation] of [
        ["Representative", "coordinate_work"],
        ["Strategy", "create_strategy_plan"],
        ["Delivery", "execute_work_task"],
      ] as const) {
        const modelRequest = stageRequest(operation);
        expect(modelRequest, `${stage} EvidenceBrief ID`).toContain(evidenceBriefId);
        expect(modelRequest, `${stage} Brief checksum`).toContain(briefChecksum);
        expect(modelRequest, `${stage} citation`).toContain(citation);
        expect(modelRequest, `${stage} redacted source`).toContain("function calculateTotal");
        expect(modelRequest, `${stage} secret redaction`).not.toContain(sourceSecret);
        if (stage === "Delivery") {
          expect(nestedStrings(JSON.parse(modelRequest)).some((value) => value.includes(expectedInstruction))).toBe(
            true,
          );
        }
      }

      await writeFile(
        sourcePath,
        `const apiKey = "${sourceSecret}";\nexport function calculateTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 1);\n}\n`,
      );
      const changed = (await command("run.start", {
        request: {
          text: "변경된 calculateTotal 함수를 검증해주세요",
          workspaceId: registered.data.workspaceId,
          workspacePaths: ["src/order.ts"],
        },
      })) as { data: { runId: string } };
      let changedRun = (await client.query("run.get", { runId: changed.data.runId })) as {
        data: { workId: string; status: string; approvalId?: string; blockedReason?: string };
      };
      for (let decisionRound = 0; decisionRound < 12; decisionRound += 1) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (["awaiting-approval", "blocked", "completed", "failed", "cancelled"].includes(changedRun.data.status))
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          changedRun = (await client.query("run.get", { runId: changed.data.runId })) as typeof changedRun;
        }
        if (changedRun.data.status === "completed") break;
        if (changedRun.data.status === "blocked") {
          throw new Error(`변경 후 Core 경로가 차단됐습니다: ${changedRun.data.blockedReason ?? "unknown"}`);
        }
        expect(changedRun.data).toMatchObject({ status: "awaiting-approval", approvalId: expect.any(String) });
        const pending = (await client.query("governance.approval.list", {
          workId: changedRun.data.workId,
          status: "pending",
        })) as {
          data: readonly { approvalId: string; revision?: number }[];
        };
        const approval = pending.data.find((candidate) => candidate.approvalId === changedRun.data.approvalId);
        if (!approval?.revision) throw new Error("변경 후 Core 경로의 Work Approval을 찾을 수 없습니다");
        await command("approval.decide", {
          approvalId: approval.approvalId,
          expectedApprovalRevision: approval.revision,
          vote: "approve",
          reason: "변경 후 실제 Core 경로를 승인합니다",
        });
        changedRun = (await client.query("run.get", { runId: changed.data.runId })) as typeof changedRun;
      }
      expect(changedRun.data.status).toBe("completed");

      const deliveryRequestsBeforeToctou = modelRequests.filter((modelRequest) =>
        modelRequest.includes("execute_work_task"),
      ).length;
      const raced = (await command("run.start", {
        request: {
          text: "런타임 지시문 고정 중 변경된 calculateTotal 함수를 검증해주세요",
          workspaceId: registered.data.workspaceId,
          workspacePaths: ["src/order.ts"],
        },
      })) as { data: { runId: string } };
      let racedRun = (await client.query("run.get", { runId: raced.data.runId })) as {
        data: { workId: string; status: string; approvalId?: string; blockedReason?: string };
      };
      let toctouEventInstalled = false;
      let racedStaffHandle: string | undefined;
      for (let decisionRound = 0; decisionRound < 12; decisionRound += 1) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (["awaiting-approval", "blocked", "completed", "failed", "cancelled"].includes(racedRun.data.status))
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          racedRun = (await client.query("run.get", { runId: raced.data.runId })) as typeof racedRun;
        }
        if (["blocked", "completed", "failed", "cancelled"].includes(racedRun.data.status)) break;
        expect(racedRun.data).toMatchObject({ status: "awaiting-approval", approvalId: expect.any(String) });
        const pending = (await client.query("governance.approval.list", {
          workId: racedRun.data.workId,
          status: "pending",
        })) as {
          data: readonly { approvalId: string; revision?: number }[];
        };
        const approval = pending.data.find((candidate) => candidate.approvalId === racedRun.data.approvalId);
        if (!approval?.revision) throw new Error("TOCTOU 경로의 Work Approval을 찾을 수 없습니다");
        const [staffingProposals] = await database.query<[{ readonly status: string; readonly nodes_json: string }[]]>(
          "SELECT status, nodes_json FROM dynamic_staffing_proposal WHERE work_id = $work_id AND approval_id = $approval_id LIMIT 1;",
          { work_id: racedRun.data.workId, approval_id: approval.approvalId },
        );
        const staffingProposal = staffingProposals[0];
        if (staffingProposal?.status === "awaiting-approval" && !toctouEventInstalled) {
          const proposedNodes = JSON.parse(staffingProposal.nodes_json) as readonly { agentHandle?: unknown }[];
          const proposedHandle = proposedNodes[0]?.agentHandle;
          if (typeof proposedHandle !== "string" || !/^[a-z0-9-]+$/u.test(proposedHandle)) {
            throw new Error("TOCTOU 경로의 Dynamic Staffing Agent handle이 유효하지 않습니다");
          }
          racedStaffHandle = proposedHandle;
          await database.query(`
            DEFINE EVENT OVERWRITE runtime_instruction_toctou_test ON TABLE runtime_execution
            WHEN $event = 'UPDATE'
              AND $before.prompt_version_id = NONE
              AND $after.prompt_version_id != NONE
              AND $after.agent_handle = ${JSON.stringify(proposedHandle)}
            THEN {
              UPDATE organization_node
                SET responsibility = '런타임 프롬프트 계보 저장 직후 변경된 역할'
                WHERE organization_id = $after.organization_id
                  AND work_id = $after.work_id
                  AND handle = $after.agent_handle;
            };
          `);
          toctouEventInstalled = true;
        }
        await command("approval.decide", {
          approvalId: approval.approvalId,
          expectedApprovalRevision: approval.revision,
          vote: "approve",
          reason: "런타임 지시문 TOCTOU 경로를 승인합니다",
        });
        racedRun = (await client.query("run.get", { runId: raced.data.runId })) as typeof racedRun;
      }
      expect(toctouEventInstalled).toBe(true);
      expect(racedStaffHandle).toEqual(expect.any(String));
      expect(["blocked", "failed"]).toContain(racedRun.data.status);
      expect(modelRequests.filter((modelRequest) => modelRequest.includes("execute_work_task"))).toHaveLength(
        deliveryRequestsBeforeToctou,
      );
      const [racedNodes] = await database.query<[{ readonly responsibility: string }[]]>(
        "SELECT responsibility FROM organization_node WHERE work_id = $work_id AND handle = $handle LIMIT 1;",
        { work_id: racedRun.data.workId, handle: racedStaffHandle },
      );
      expect(racedNodes[0]?.responsibility).toBe("런타임 프롬프트 계보 저장 직후 변경된 역할");

      await expect(client.query("work.knowledge", { workId: run.data.workId })).resolves.toMatchObject({
        data: { status: "ready", freshnessStatus: "stale_warning" },
      });
      // Assurance가 검증한 Brief는 DB 이벤트가 변조를 차단한다 — 변조가 막히면 work.knowledge는 변하지 않는다
      await expect(
        database.query("UPDATE evidence_brief SET automatic_key = NONE WHERE evidence_brief_id = $evidence_brief_id;", {
          evidence_brief_id: evidenceBriefId,
        }),
      ).rejects.toThrow();
      await expect(client.query("work.knowledge", { workId: run.data.workId })).resolves.toMatchObject({
        data: { status: "ready", freshnessStatus: "stale_warning" },
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 40_000);

  it("clean install에서 MiniMax connect-model 하나로 Core route·ready 상태·실제 run을 완성한다", async () => {
    const plan = {
      objective: "MiniMax 자동 Core 경로 검증",
      summary: "구독 연결 직후 Core 실행 경로를 검증한다",
      scopeIn: ["자동 모델 조립"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "minimax-core-path",
          statement: "자동 조립된 모델로 전달 작업이 실행된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-minimax-core",
          title: "MiniMax Core 전달",
          objective: "자동 조립된 route로 Delivery Agent를 실행한다",
          criterionKeys: ["minimax-core-path"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
          taskAxis: "code-generation",
          reasoningDifficulty: "medium",
        },
      ],
      evidenceRequests: [],
    };
    const realFetch = globalThis.fetch;
    const upstreamRequests: Array<{ readonly url: string; readonly authorization: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://127.0.0.1:")) return await realFetch(input, init);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      upstreamRequests.push({ url, authorization: headers.get("authorization") ?? "" });
      if (url === "https://www.minimax.io/v1/token_plan/remains") {
        return Response.json({
          base_resp: { status_code: 0, status_msg: "success" },
          model_remains: [
            {
              model_name: "MiniMax-M2.7",
              current_interval_total_count: 1_500,
              current_interval_usage_count: 300,
              current_weekly_total_count: 10_000,
              current_weekly_usage_count: 2_500,
              remains_time: 1_000,
              weekly_remains_time: 2_000,
            },
          ],
        });
      }
      if (!url.startsWith("https://api.minimax.io/v1/")) throw new Error("예상하지 않은 외부 요청입니다");
      if (url === "https://api.minimax.io/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "MiniMax-M2.7", object: "model", owned_by: "MiniMax" },
            { id: "MiniMax-M3", object: "model", owned_by: "MiniMax" },
          ],
        });
      }
      const bodyText =
        input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        readonly response_format?: unknown;
        readonly messages?: unknown;
        readonly stream?: unknown;
      };
      const fixture = openAiCompatibleFixtureResponse(
        body,
        body.response_format ? JSON.stringify(plan) : "완료",
        "MiniMax-M2.7",
      );
      return new Response(fixture.body, { headers: { "content-type": fixture.contentType } });
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-minimax-core-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 42).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      {
        modelBuilder: new OpenAICompatibleModelBuilder(() => globalThis.fetch),
        fetchMiniMaxQuota: async () => [
          {
            kind: "session-5h",
            limit: 1_500,
            remaining: 1_200,
            observedAt: new Date().toISOString(),
            source: "minimax-token-plan-endpoint",
            confidence: "reported",
          },
        ],
      },
    );
    const address = await daemon.start();
    const secret = "minimax-product-secret-never-returned";
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "minimax-core-bootstrap-command-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const connected = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "minimax-core-connect-command-0001",
        correlationId: "minimax-core-connect-correlation-0001",
        operation: "subscription.server.connect-model",
        payload: {
          providerId: "minimax-token-plan",
          alias: "MiniMax Token Plan",
          authKind: "subscription-key",
          billingKind: "token-plan",
          secret,
        },
      });
      expect(connected).toMatchObject({
        outcome: "succeeded",
        data: {
          providerId: "minimax-token-plan",
          status: "active",
          connectorStatus: "ready",
        },
      });
      expect(JSON.stringify(connected)).not.toContain(secret);
      await expect(client.status()).resolves.toMatchObject({
        data: { status: "ready", mode: "local", modelRuntime: "ready" },
      });
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "minimax-core-run-command-0001",
        correlationId: "minimax-core-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "자동 MiniMax Core 경로를 검증해주세요" } },
      });
      let snapshot: {
        data?: {
          works?: readonly { status: string }[];
          executions?: readonly { agentHandle: string; status: string }[];
        };
      } = {};
      for (let attempt = 0; attempt < 300; attempt += 1) {
        snapshot = (await productWorkState(client)) as typeof snapshot;
        if (
          (snapshot.data?.executions?.length ?? 0) >= 4 &&
          snapshot.data?.works?.some((work) => work.status === "completed")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "delivery-coordination", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
        ]),
      );
      expect(
        upstreamRequests.filter((request) => request.url.endsWith("/chat/completions")).length,
      ).toBeGreaterThanOrEqual(3);
      expect(upstreamRequests.some((request) => request.url.endsWith("/models"))).toBe(true);
      expect(upstreamRequests.every((request) => request.authorization === `Bearer ${secret}`)).toBe(true);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("설치된 Software Engineering 조직이 실제 Git 변경과 독립 Assurance까지 완성한다", async () => {
    const catalogModelId = "massion-test-model";
    const plan = {
      objective: "값 모듈 변경",
      summary: "백엔드 전문 담당자가 테스트 우선으로 값을 변경한다",
      scopeIn: ["src/value.mjs", "src/value.test.mjs"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "value-is-two",
          statement: "value 모듈은 2를 내보낸다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "implement-value-change",
          title: "value 모듈 변경",
          objective: "src/value.mjs의 value를 1에서 2로 바꾸고 src/value.test.mjs로 검증한다",
          criterionKeys: ["value-is-two"],
          dependencyKeys: [],
          requiredCapabilities: ["backend-engineering"],
          recommendedAgentHandles: ["software-engineering.backend-specialist"],
          parallelizable: false,
          reasoningDifficulty: "medium",
          taskAxis: "code-generation",
        },
      ],
      evidenceRequests: [],
    };
    const proposal = {
      testPatch: [
        "diff --git a/src/value.test.mjs b/src/value.test.mjs",
        "--- a/src/value.test.mjs",
        "+++ b/src/value.test.mjs",
        "@@ -1,3 +1,3 @@",
        ' import assert from "node:assert/strict";',
        ' import { value } from "./value.mjs";',
        '-assert.equal(value, 1, "MASSION_EXPECTED_VALUE");',
        '+assert.equal(value, 2, "MASSION_EXPECTED_VALUE");',
        "",
      ].join("\n"),
      implementationPatch: [
        "diff --git a/src/value.mjs b/src/value.mjs",
        "--- a/src/value.mjs",
        "+++ b/src/value.mjs",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        "",
      ].join("\n"),
      focusedCommand: {
        executable: "node",
        args: ["src/value.test.mjs"],
        cwd: ".",
        timeoutMs: 10_000,
        maxOutputBytes: 8_192,
        environment: {},
      },
      redFailureMarker: "MASSION_EXPECTED_VALUE",
      validationCommands: [],
      commitMessage: "feat: update value",
    };
    const modelRequests: string[] = [];
    const modelServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ object: "list", data: [{ id: catalogModelId, object: "model", owned_by: "Massion" }] }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        modelRequests.push(rawBody);
        const body = JSON.parse(rawBody) as {
          readonly messages?: unknown;
          readonly response_format?: unknown;
          readonly stream?: unknown;
        };
        const structuredPrompt = `${JSON.stringify(body.messages) ?? ""}\n${JSON.stringify(body.response_format) ?? ""}`;
        const fixture = openAiCompatibleFixtureResponse(
          body,
          structuredPrompt.includes("software_patch_proposal") || structuredPrompt.includes("testPatch")
            ? JSON.stringify(proposal)
            : structuredPrompt.includes("massion-strategy-plan") || body.response_format
              ? JSON.stringify(plan)
              : "완료",
          catalogModelId,
        );
        response.setHeader("content-type", fixture.contentType);
        response.end(fixture.body);
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");

    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-software-product-"));
    const repositoryRoot = join(workspaceRoot, "fixture-repository");
    const runFile = promisify(execFile);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "value.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(repositoryRoot, "src", "value.test.mjs"),
      'import assert from "node:assert/strict";\nimport { value } from "./value.mjs";\nassert.equal(value, 1, "MASSION_EXPECTED_VALUE");\n',
      "utf8",
    );
    await runFile("git", ["init", "--initial-branch=main"], { cwd: repositoryRoot });
    await runFile("git", ["config", "user.name", "Massion Product Test"], { cwd: repositoryRoot });
    await runFile("git", ["config", "user.email", "massion-product@example.invalid"], { cwd: repositoryRoot });
    await runFile("git", ["add", "src/value.mjs", "src/value.test.mjs"], { cwd: repositoryRoot });
    await runFile("git", ["commit", "-m", "test: add software fixture"], { cwd: repositoryRoot });

    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 62).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "massion-workspaces"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database },
    );
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "software-product-bootstrap-command-0001",
        capability: bootstrapCapability,
      })) as {
        readonly access: { readonly token: string };
        readonly context: {
          readonly userId: string;
          readonly organizationId: string;
          readonly membershipId: string;
          readonly role: "owner";
        };
      };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const command = async (operation: string, payload: unknown, expectedRevision?: number) =>
        (await client.command({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          payload,
        })) as { readonly data: Record<string, unknown> };

      const organizationCommand = {
        schemaVersion: "massion.application.v1" as const,
        commandId: "software-profile-install-command-0001",
        correlationId: "software-profile-install-correlation-0001",
        operation: "organization.command",
        expectedRevision: 1,
        payload: {
          kind: "install-profile",
          profileId: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileId,
          profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
          nodes: SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes,
        },
      };
      const awaitingOrganization = (await client.command(organizationCommand)) as {
        readonly outcome: string;
        readonly data: { readonly approvalId: string };
      };
      expect(awaitingOrganization).toMatchObject({
        outcome: "awaiting-approval",
        data: { approvalId: expect.any(String) },
      });
      await command("approval.vote", {
        approvalId: awaitingOrganization.data.approvalId,
        vote: "approve",
        reason: "Software Engineering 조직 설치를 승인합니다",
      });
      await expect(
        client.command({
          ...organizationCommand,
          payload: {
            ...organizationCommand.payload,
            governanceApprovalId: awaitingOrganization.data.approvalId,
          },
        }),
      ).resolves.toMatchObject({ outcome: "succeeded", data: { version: 2 } });
      await command("router.provider.register", {
        providerId: "local-openai",
        displayName: "Local OpenAI",
        adapterKind: "openai-compatible",
      });
      const endpoint = await command("router.endpoint.register", {
        providerId: "local-openai",
        name: "Test API",
        baseUrl: `http://127.0.0.1:${String(modelAddress.port)}/v1`,
        local: true,
      });
      await command("router.credential.add", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        label: "test-account",
        credentialType: "api_key",
        secret: "test-secret",
        priority: 1,
        weight: 1,
      });
      const synchronized = await command("router.models.sync", { endpointId: endpoint.data.endpointId });
      expect(synchronized.data).toMatchObject({
        endpointId: endpoint.data.endpointId,
        status: "available",
        activeCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
      });
      const catalog = (await client.query("router.catalog", {})) as {
        readonly data: {
          readonly discoveredModels: readonly {
            readonly endpointId: string;
            readonly providerId: string;
            readonly modelId: string;
            readonly state: string;
          }[];
        };
      };
      const discoveredModel = catalog.data.discoveredModels.find(
        (candidate) =>
          candidate.endpointId === endpoint.data.endpointId &&
          candidate.providerId === "local-openai" &&
          candidate.modelId === catalogModelId &&
          candidate.state === "active",
      );
      if (!discoveredModel) throw new Error("동기화한 Provider 카탈로그 모델을 찾을 수 없습니다");
      const model = await command("router.model.register", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        modelId: discoveredModel.modelId,
        routeKind: "chat",
        contextWindow: 200_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "software-product-test",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      });
      expect(model.data.modelId).toBe(discoveredModel.modelId);
      for (const name of [
        "orchestration-balanced",
        "planning-quality",
        "delivery-quality",
        "assurance-independent",
        "software-engineering-quality",
      ]) {
        const route = await command("router.route.configure", {
          name,
          routeKind: "chat",
          credentialPolicy: "round-robin",
          dataPolicy: "external-allowed",
          equivalenceGroup: "software-product-test",
          minEvalScore: 0,
          requireTools: false,
          requireStructuredOutput: name === "planning-quality",
          requireVision: false,
          requireStreaming: false,
          maxContextTokens: 200_000,
          requestBudgetMicros: 1_000_000,
          totalBudgetMicros: 10_000_000,
        });
        await command("router.candidate.add", {
          routeId: route.data.routeId,
          modelProfileId: model.data.modelProfileId,
          priority: 1,
        });
      }
      const disabled = await command("router.model.enabled.set", {
        modelProfileId: model.data.modelProfileId,
        enabled: false,
      });
      expect(disabled.data).toMatchObject({ modelProfileId: model.data.modelProfileId, enabled: false });
      await expect(client.query("router.catalog", {})).resolves.toMatchObject({
        data: { models: [expect.objectContaining({ modelProfileId: model.data.modelProfileId, enabled: false })] },
      });
      const unavailable = (await command("run.start", {
        request: { text: "꺼진 등록 모델은 실행에서 제외되어야 합니다" },
      })) as { readonly data: { readonly runId: string } };
      let unavailableRun = (await client.query("run.get", { runId: unavailable.data.runId })) as {
        readonly data: { readonly status: string; readonly blockedReason?: string };
      };
      for (let attempt = 0; attempt < 300 && unavailableRun.data.status !== "blocked"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        unavailableRun = (await client.query("run.get", { runId: unavailable.data.runId })) as typeof unavailableRun;
      }
      expect(unavailableRun.data).toMatchObject({ status: "blocked", blockedReason: "model-unavailable" });
      await expect(
        command("router.model.enabled.set", { modelProfileId: model.data.modelProfileId, enabled: true }),
      ).resolves.toMatchObject({ data: { modelProfileId: model.data.modelProfileId, enabled: true } });

      await command("optimization.policy.configure", {
        policy: "quality",
        autoOptimize: true,
        productionLearning: false,
        shadowEnabled: false,
        minimumSampleCount: 3,
        improvementThreshold: 0,
        governanceDecisionId: "software-product-axis-policy-decision-0001",
      });
      const axisBundle = await command("optimization.bundle.create", {
        roleKey: "software-engineering.backend-specialist",
        runtimeVersion: "software-product-axis-runtime-1",
        cases: [
          {
            prompt: "완료라고 답해주세요.",
            promptChecksum: "a".repeat(64),
            toolsChecksum: "b".repeat(64),
            environmentChecksum: "c".repeat(64),
            expectedOutcome: "완료",
            taskAxis: "code-generation",
            reasoningDifficulty: "medium",
          },
          {
            prompt: "완료라고 답해주세요.",
            promptChecksum: "d".repeat(64),
            toolsChecksum: "e".repeat(64),
            environmentChecksum: "f".repeat(64),
            expectedOutcome: "완료",
            taskAxis: "code-generation",
            reasoningDifficulty: "medium",
          },
          {
            prompt: "완료라고 답해주세요.",
            promptChecksum: "1".repeat(64),
            toolsChecksum: "2".repeat(64),
            environmentChecksum: "3".repeat(64),
            expectedOutcome: "완료",
            taskAxis: "code-generation",
            reasoningDifficulty: "medium",
          },
        ],
      });
      const axisBundleId = axisBundle.data.bundleId;
      if (typeof axisBundleId !== "string") throw new Error("작업 축 평가 bundle을 찾을 수 없습니다");
      const axisPreflight = (await client.query("optimization.evaluation.preflight", {
        roleKey: "software-engineering.backend-specialist",
        bundleId: axisBundleId,
        modelProfileId: model.data.modelProfileId,
        runtimeVersion: "software-product-axis-runtime-1",
      })) as { readonly data: readonly [{ readonly checksum: string }] };
      const axisReceipt = await command("optimization.evaluation.execute", {
        roleKey: "software-engineering.backend-specialist",
        bundleId: axisBundleId,
        modelProfileId: model.data.modelProfileId,
        runtimeVersion: "software-product-axis-runtime-1",
        preflightChecksum: axisPreflight.data[0].checksum,
      });
      const axisReceiptId = axisReceipt.data.receiptId;
      if (typeof axisReceiptId !== "string") throw new Error("작업 축 평가 receipt를 찾을 수 없습니다");
      const axisRecommendation = await command("optimization.recommend", {
        roleKey: "software-engineering.backend-specialist",
        requirements: {
          requiresTools: false,
          requiresStructuredOutput: false,
          requiresStreaming: false,
          dataPolicy: "external-allowed",
        },
      });
      expect(axisRecommendation.data).toMatchObject({
        primaryModelProfileId: model.data.modelProfileId,
        status: "approved",
      });
      const axisRecommendationId = axisRecommendation.data.recommendationId;
      if (typeof axisRecommendationId !== "string") throw new Error("작업 축 모델 추천을 찾을 수 없습니다");
      const axisBatch = await command("optimization.batch.create", {
        recommendationId: axisRecommendationId,
        status: "limited",
      });
      const axisBatchId = axisBatch.data.batchId;
      if (typeof axisBatchId !== "string") throw new Error("작업 축 모델 batch를 찾을 수 없습니다");
      await expect(command("optimization.batch.activate", { batchId: axisBatchId })).resolves.toMatchObject({
        data: { batchId: axisBatchId, status: "active" },
      });

      const organizations = await OrganizationService.create(database);
      const repositories = await RepositoryStore.create(database, organizations);
      const indexes = await IndexStore.create(database, organizations);
      const scanner = new RepositoryScanner();
      const collector = new RepositoryRevisionCollector(scanner);
      const scanOptions = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;
      const captured = await collector.capture(repositoryRoot, scanOptions);
      const registered = await repositories.register(initialized.context, {
        commandId: "software-product-repository-register-0001",
        name: "software-product-fixture",
        providerKind: captured.providerKind,
        rootRef: repositoryRoot,
        rootRealPathHash: captured.rootRealPathHash,
        defaultBranch: "main",
      });
      const revision = await repositories.captureRevision(initialized.context, {
        commandId: "software-product-repository-revision-0001",
        repositoryId: registered.repository.repositoryId,
        providerRevision: captured.providerRevision,
        dirty: captured.dirty,
        ...(captured.dirtyFingerprint ? { dirtyFingerprint: captured.dirtyFingerprint } : {}),
        manifestChecksum: captured.manifestChecksum,
        rootRealPathHash: captured.rootRealPathHash,
        collectorVersion: captured.collectorVersion,
      });
      const parser = new EvidenceParser();
      const indexConfiguration = await repositories.createConfiguration(initialized.context, {
        commandId: "software-product-index-configuration-0001",
        repositoryId: registered.repository.repositoryId,
        checksum: createHash("sha256").update(JSON.stringify(scanOptions)).digest("hex"),
        parserBundleVersion: parser.bundleVersion,
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable",
        settings: scanOptions,
      });
      await new EvidenceIndexer(repositories, indexes, scanner, parser).index(initialized.context, {
        commandId: "software-product-index-0001",
        repositoryId: registered.repository.repositoryId,
        repositoryRevisionId: revision.revision.repositoryRevisionId,
        configurationId: indexConfiguration.configuration.configurationId,
        mode: "full",
        root: repositoryRoot,
        scanOptions,
      });

      const accepted = (await command("run.start", {
        request: {
          text: "value 모듈을 테스트 우선으로 2로 변경해주세요",
          softwareDelivery: {
            repositoryRoot,
            repositoryId: registered.repository.repositoryId,
            repositoryRevisionId: revision.revision.repositoryRevisionId,
            baseRevision: captured.providerRevision,
            profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
            allowedPaths: ["src"],
            testPaths: ["src/value.test.mjs"],
          },
        },
      })) as { readonly data: { readonly runId: string } };
      let snapshot: {
        data?: {
          readonly works?: readonly { readonly status: string; readonly artifactIds: readonly string[] }[];
          readonly executions?: readonly { readonly agentHandle: string; readonly status: string }[];
        };
      } = {};
      for (let attempt = 0; attempt < 2400; attempt += 1) {
        snapshot = (await productWorkState(client)) as typeof snapshot;
        const completed = snapshot.data?.works?.some(
          (work) => work.status === "completed" && work.artifactIds.length > 0,
        );
        const specialistCompleted = snapshot.data?.executions?.some(
          (execution) =>
            execution.agentHandle === "software-engineering.backend-specialist" && execution.status === "succeeded",
        );
        const assuranceCompleted = snapshot.data?.executions?.some(
          (execution) => execution.agentHandle === "assurance" && execution.status === "succeeded",
        );
        if (completed && specialistCompleted && assuranceCompleted) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(snapshot.data?.works).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "completed", artifactIds: expect.arrayContaining([expect.any(String)]) }),
        ]),
      );
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "software-engineering.backend-specialist", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
        ]),
      );
      expect(
        modelRequests.filter((request) => request.includes("software_patch_proposal") || request.includes("testPatch")),
      ).toHaveLength(1);
      let completedRun = (await client.query("run.get", { runId: accepted.data.runId })) as {
        readonly data: { readonly workId: string; readonly status: string };
      };
      for (let attempt = 0; attempt < 300 && completedRun.data.status !== "completed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedRun = (await client.query("run.get", { runId: accepted.data.runId })) as typeof completedRun;
      }
      expect(completedRun.data.status).toBe("completed");
      const workExecutions = (await client.query("work.executions", { workId: completedRun.data.workId })) as {
        readonly data: readonly {
          readonly executionId: string;
          readonly taskId?: string;
          readonly agentHandle: string;
          readonly status: string;
        }[];
      };
      const specialistExecution = workExecutions.data.find(
        (execution) =>
          execution.agentHandle === "software-engineering.backend-specialist" && execution.status === "succeeded",
      );
      if (!specialistExecution?.taskId) throw new Error("작업 축 Delivery 실행 계보를 찾을 수 없습니다");
      const specialistEvents = (await client.query("runtime.execution.events", {
        executionId: specialistExecution.executionId,
      })) as {
        readonly data: readonly { readonly type: string }[];
      };
      expect(specialistEvents.data.filter((event) => event.type === "model.route.selected")).toHaveLength(1);
      const [specialistAttempts] = await database.query<
        [
          {
            readonly execution_id?: string;
            readonly optimization_batch_id?: string;
            readonly model_profile_id: string;
            readonly explanation_json: string;
            readonly selection_sequence: number;
            readonly attempt_id: string;
          }[],
        ]
      >(
        "SELECT execution_id, optimization_batch_id, model_profile_id, explanation_json, selection_sequence, attempt_id FROM route_attempt WHERE organization_id = $organization_id AND execution_id = $execution_id ORDER BY selection_sequence ASC, attempt_id ASC;",
        {
          organization_id: initialized.context.organizationId,
          execution_id: specialistExecution.executionId,
        },
      );
      expect(specialistAttempts).toHaveLength(1);
      const specialistAttempt = specialistAttempts[0];
      if (!specialistAttempt) throw new Error("작업 축 Route Attempt를 찾을 수 없습니다");
      expect(specialistAttempt).toMatchObject({
        execution_id: specialistExecution.executionId,
        optimization_batch_id: axisBatchId,
        model_profile_id: model.data.modelProfileId,
      });
      const explanationSnapshot = JSON.parse(specialistAttempt.explanation_json) as { readonly request?: string };
      const routeRequest = explanationSnapshot.request
        ? (JSON.parse(explanationSnapshot.request) as Record<string, unknown>)
        : {};
      const placementReceipt = {
        workId: completedRun.data.workId,
        taskId: specialistExecution.taskId,
        taskAxis: "code-generation",
        reasoningDifficulty: "medium",
        selectionBasis: "task-axis-evidence-available",
        axisEvidence: {
          bundleId: axisBundleId,
          bundleVersion: 1,
          receiptIds: [axisReceiptId],
          rankedModelProfileIds: [model.data.modelProfileId],
        },
      };
      expect(routeRequest.placementReceipt).toEqual(placementReceipt);
      const [routeSelectedEvents] = await database.query<
        [
          {
            readonly event_type: string;
            readonly payload_json: string;
            readonly sequence: number;
          }[],
        ]
      >(
        "SELECT event_type, payload_json, sequence FROM runtime_event WHERE organization_id = $organization_id AND execution_id = $execution_id AND event_type = 'model.route.selected' ORDER BY sequence ASC;",
        {
          organization_id: initialized.context.organizationId,
          execution_id: specialistExecution.executionId,
        },
      );
      expect(routeSelectedEvents).toHaveLength(1);
      const routeSelectedEvent = routeSelectedEvents[0];
      if (!routeSelectedEvent) throw new Error("Model Route 선택 사건을 찾을 수 없습니다");
      expect(JSON.parse(routeSelectedEvent.payload_json)).toMatchObject({
        executionId: specialistExecution.executionId,
        attemptId: specialistAttempt.attempt_id,
        modelProfileId: model.data.modelProfileId,
        batchId: axisBatchId,
        placementReceipt,
      });
      const [artifacts, verifications, records] = (await Promise.all([
        client.query("work.artifacts", { workId: completedRun.data.workId }),
        client.query("work.verifications", { workId: completedRun.data.workId }),
        client.query("work.records", { workId: completedRun.data.workId }),
      ])) as readonly [
        { readonly data: readonly { readonly workId: string; readonly artifactVersionId: string }[] },
        {
          readonly data: readonly {
            readonly verificationId: string;
            readonly workId: string;
            readonly passed: boolean;
            readonly evidenceArtifactVersionIds: readonly string[];
            readonly assuranceRunId?: string;
          }[];
        },
        {
          readonly data: readonly {
            readonly recordId: string;
            readonly artifactIds: readonly string[];
            readonly verificationIds: readonly string[];
          }[];
        },
      ];
      const verification = verifications.data.find(
        (candidate) => candidate.workId === completedRun.data.workId && candidate.passed,
      );
      if (!verification) throw new Error("완료된 Work의 독립 Assurance 검증을 찾을 수 없습니다");
      if (!verification.assuranceRunId) throw new Error("완료된 Work의 Assurance run 계보를 찾을 수 없습니다");
      const assuranceLineage = (await client.query("assurance.lineage.get", {
        workId: completedRun.data.workId,
        assuranceRunId: verification.assuranceRunId,
      })) as {
        readonly data: {
          readonly run: { readonly assuranceRunId: string; readonly workId: string; readonly status: string };
          readonly checks: readonly {
            readonly checkId: string;
            readonly criterionId: string;
            readonly status: string;
            readonly executorHandle?: string;
            readonly systemAdapterId?: string;
            readonly runtime?: { readonly executionId: string; readonly taskId?: string; readonly status: string };
            readonly routeSelections: readonly {
              readonly attemptId: string;
              readonly modelProfileId: string;
              readonly status: string;
              readonly fallbackFromAttemptId?: string;
              readonly placementReceipt?: {
                readonly taskAxis?: string;
                readonly reasoningDifficulty?: string;
                readonly selectionBasis: string;
                readonly axisEvidence?: {
                  readonly bundleId: string;
                  readonly bundleVersion: number;
                  readonly receiptIds: readonly string[];
                  readonly rankedModelProfileIds: readonly string[];
                };
              };
            }[];
          }[];
        };
      };
      expect(assuranceLineage.data.run).toEqual({
        assuranceRunId: verification.assuranceRunId,
        workId: completedRun.data.workId,
        status: "passed",
      });
      expect(assuranceLineage.data.checks.length).toBeGreaterThan(0);
      for (const check of assuranceLineage.data.checks) {
        expect(
          Object.keys(check).every((key) =>
            [
              "checkId",
              "criterionId",
              "status",
              "executorHandle",
              "systemAdapterId",
              "runtime",
              "routeSelections",
            ].includes(key),
          ),
        ).toBe(true);
        expect(typeof check.checkId).toBe("string");
        expect(typeof check.criterionId).toBe("string");
        expect(typeof check.status).toBe("string");
        expect((check.systemAdapterId !== undefined) !== (check.runtime !== undefined)).toBe(true);
        if (check.systemAdapterId !== undefined) {
          expect(check.routeSelections).toEqual([]);
          continue;
        }
        if (!check.runtime) throw new Error("Runtime Assurance check의 실행 계보가 없습니다");
        expect(Object.keys(check.runtime).every((key) => ["executionId", "taskId", "status"].includes(key))).toBe(true);
        expect(check.runtime.executionId).toEqual(expect.any(String));
        expect(check.runtime.status).toEqual(expect.any(String));
        for (const selection of check.routeSelections) {
          expect(
            Object.keys(selection).every((key) =>
              ["attemptId", "modelProfileId", "status", "fallbackFromAttemptId", "placementReceipt"].includes(key),
            ),
          ).toBe(true);
          expect(selection).toMatchObject({
            attemptId: expect.any(String),
            modelProfileId: expect.any(String),
          });
          expect(["reserved", "succeeded", "failed", "interrupted"]).toContain(selection.status);
          if (selection.fallbackFromAttemptId !== undefined)
            expect(selection.fallbackFromAttemptId).toEqual(expect.any(String));
          if (selection.placementReceipt !== undefined) {
            expect(
              Object.keys(selection.placementReceipt).every((key) =>
                ["taskAxis", "reasoningDifficulty", "selectionBasis", "axisEvidence"].includes(key),
              ),
            ).toBe(true);
            expect(selection.placementReceipt.selectionBasis).toEqual(expect.any(String));
            if (selection.placementReceipt.axisEvidence !== undefined) {
              expect(
                Object.keys(selection.placementReceipt.axisEvidence).every((key) =>
                  ["bundleId", "bundleVersion", "receiptIds", "rankedModelProfileIds"].includes(key),
                ),
              ).toBe(true);
            }
          }
        }
      }
      expect(JSON.stringify(assuranceLineage.data)).not.toMatch(
        /"(?:credential|explanation|prompt|inputHash|outputHash|outputSummary|artifact|evidence)/iu,
      );
      expect(JSON.stringify(assuranceLineage.data)).not.toMatch(/secret/iu);
      const evidenceArtifactVersionId = verification.evidenceArtifactVersionIds.find((artifactVersionId) =>
        artifacts.data.some(
          (artifact) =>
            artifact.workId === completedRun.data.workId && artifact.artifactVersionId === artifactVersionId,
        ),
      );
      if (!evidenceArtifactVersionId) throw new Error("Assurance 검증이 가리키는 산출물을 찾을 수 없습니다");
      const record = records.data.find(
        (candidate) =>
          candidate.verificationIds.includes(verification.verificationId) &&
          candidate.artifactIds.includes(evidenceArtifactVersionId),
      );
      if (!record) throw new Error("Records가 Assurance 검증과 산출물을 함께 가리키지 않습니다");
      const desktop = createApplicationDesktopService({
        bootstrap: async () => ({ connection: { status: "connected" } }),
        query: async (operation, payload) => await client.query(operation, payload),
        command: async (input) => await client.command(input),
        loginCodex: async () => ({ status: "ready" }),
        startStream: async () => async () => undefined,
      });
      const desktopWork = await desktop.loadWork(completedRun.data.workId);
      expect(desktopWork).toMatchObject({
        id: completedRun.data.workId,
        status: "complete",
        progress: 100,
        tasks: expect.arrayContaining([expect.objectContaining({ state: "done" })]),
        artifacts: expect.arrayContaining([expect.objectContaining({ artifactVersionId: evidenceArtifactVersionId })]),
        verifications: expect.arrayContaining([
          expect.objectContaining({ id: verification.verificationId, state: "done" }),
        ]),
      });
      const desktopRecord = desktopWork.records.find((candidate) => candidate.id === record.recordId);
      if (!desktopRecord) throw new Error("Desktop이 Records 항목을 투영하지 않았습니다");
      expect(desktopRecord.artifactVersionIds).toContain(evidenceArtifactVersionId);
      expect(desktopRecord.verificationIds).toContain(verification.verificationId);
      const [taskArtifactMessages] = await database.query<
        [{ task_id?: string; execution_id?: string; artifact_version_id?: string }[]]
      >(
        "SELECT task_id, execution_id, artifact_version_id FROM collaboration_message WHERE organization_id = $organization_id AND author_id = 'software-engineering.backend-specialist' AND message_type = 'evidence' AND task_id != NONE AND artifact_version_id != NONE;",
        { organization_id: initialized.context.organizationId },
      );
      expect(taskArtifactMessages).toEqual([
        expect.objectContaining({
          task_id: expect.any(String),
          execution_id: expect.any(String),
          artifact_version_id: expect.any(String),
        }),
      ]);
      const taskArtifactMessage = taskArtifactMessages[0];
      if (!taskArtifactMessage?.artifact_version_id) throw new Error("Task 산출물 계보를 찾을 수 없습니다");
      expect(artifacts.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifactVersionId: taskArtifactMessage.artifact_version_id }),
        ]),
      );
      expect(desktopWork.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifactVersionId: taskArtifactMessage.artifact_version_id }),
        ]),
      );
      expect(await readFile(join(repositoryRoot, "src", "value.mjs"), "utf8")).toBe("export const value = 1;\n");
      await expect(runFile("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot })).resolves.toMatchObject({
        stdout: "",
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 90_000);

  it("clean install에서 Z.AI Core 실행의 RuntimeExecution에 개인 기억 계보를 고정한다", async () => {
    const plan = {
      objective: "Z.AI 자동 Core 경로 검증",
      summary: "구독 연결 직후 Core 실행 경로를 검증한다",
      scopeIn: ["자동 모델 조립"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "zai-core-path",
          statement: "자동 조립된 모델로 전달 작업이 실행된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-zai-core",
          title: "Z.AI Core 전달",
          objective: "자동 조립된 route로 Delivery Agent를 실행한다",
          criterionKeys: ["zai-core-path"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
          taskAxis: "code-generation",
          reasoningDifficulty: "medium",
        },
      ],
      evidenceRequests: [],
    };
    const realFetch = globalThis.fetch;
    const upstreamRequests: Array<{
      readonly url: string;
      readonly authorization: string;
      readonly responseFormatType?: string;
      readonly includesOutputSchema: boolean;
    }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://127.0.0.1:")) return await realFetch(input, init);
      if (!url.startsWith("https://api.z.ai/api/coding/paas/v4/")) throw new Error("예상하지 않은 외부 요청입니다");
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const bodyText =
        input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        readonly model?: unknown;
        readonly response_format?: { readonly type?: unknown };
        readonly messages?: unknown;
        readonly stream?: unknown;
      };
      upstreamRequests.push({
        url,
        authorization: headers.get("authorization") ?? "",
        ...(typeof body.response_format?.type === "string" ? { responseFormatType: body.response_format.type } : {}),
        includesOutputSchema: JSON.stringify(body.messages).includes("Massion JSON output schema"),
      });
      if (body.model !== "glm-5.2") return new Response("invalid model", { status: 400 });
      if (body.response_format?.type === "json_schema")
        return new Response("JSON Schema response format is unsupported", { status: 400 });
      const fixture = openAiCompatibleFixtureResponse(
        body,
        body.response_format?.type === "json_object"
          ? JSON.stringify(
              JSON.stringify(body.messages).includes("Massion JSON output schema")
                ? plan
                : { objective: "불완전한 계획" },
            )
          : "완료",
        "glm-5.2",
      );
      return new Response(fixture.body, { headers: { "content-type": fixture.contentType } });
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-zai-core-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 51).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 52).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database, modelBuilder: new OpenAICompatibleModelBuilder(() => globalThis.fetch) },
    );
    const secret = "zai-product-secret-never-returned";
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "zai-core-bootstrap-command-0001",
        capability: bootstrapCapability,
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const memory = (await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "zai-core-memory-command-0001",
        correlationId: "zai-core-memory-correlation-0001",
        operation: "growth.memory.put",
        expectedRevision: 0,
        payload: { key: "answer-style", kind: "preference", value: "첫 문장에 결론을 먼저 쓴다" },
      })) as { data: { memoryVersionId: string; revision: number } };
      expect(memory.data).toMatchObject({ memoryVersionId: expect.any(String), revision: 1 });
      const connected = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "zai-core-connect-command-0001",
        correlationId: "zai-core-connect-correlation-0001",
        operation: "subscription.server.connect-model",
        payload: {
          providerId: "zai-coding-plan",
          alias: "Z.AI GLM Coding Plan",
          authKind: "api-key",
          billingKind: "coding-plan",
          secret,
        },
      });
      expect(connected).toMatchObject({
        outcome: "succeeded",
        data: {
          providerId: "zai-coding-plan",
          status: "active",
          connectorStatus: "ready",
        },
      });
      expect(JSON.stringify(connected)).not.toContain(secret);
      await expect(client.status()).resolves.toMatchObject({
        data: { status: "ready", mode: "local", modelRuntime: "ready" },
      });
      const accepted = (await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "zai-core-run-command-0001",
        correlationId: "zai-core-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "자동 Z.AI Core 경로를 검증해주세요" } },
      })) as { data: { runId: string } };
      let run = (await client.query("run.get", { runId: accepted.data.runId })) as {
        data?: { status?: string; workId?: string };
      };
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (run.data?.status === "completed" && typeof run.data.workId === "string") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
        run = (await client.query("run.get", { runId: accepted.data.runId })) as typeof run;
      }
      expect(run.data).toMatchObject({ status: "completed", workId: expect.any(String) });
      const workId = run.data?.workId;
      if (!workId) throw new Error("완료된 Z.AI Core Work ID가 없습니다");
      expect(
        upstreamRequests.filter((request) => request.url.endsWith("/chat/completions")).length,
      ).toBeGreaterThanOrEqual(4);
      expect(upstreamRequests.some((request) => request.responseFormatType === "json_schema")).toBe(false);
      expect(upstreamRequests.some((request) => request.responseFormatType === "json_object")).toBe(true);
      expect(upstreamRequests.some((request) => request.includesOutputSchema)).toBe(true);
      expect(upstreamRequests.every((request) => request.authorization === `Bearer ${secret}`)).toBe(true);
      const [executions] = await database.query<
        [{ agent_handle: string; status: string; memory_version_ids?: readonly string[] }[]]
      >("SELECT agent_handle, status, memory_version_ids FROM runtime_execution WHERE work_id = $work_id;", {
        work_id: workId,
      });
      expect(executions).toHaveLength(4);
      expect(executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent_handle: "representative", status: "succeeded" }),
          expect.objectContaining({ agent_handle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agent_handle: "delivery-coordination", status: "succeeded" }),
          expect.objectContaining({ agent_handle: "assurance", status: "succeeded" }),
        ]),
      );
      expect(executions.every((execution) => execution.memory_version_ids?.includes(memory.data.memoryVersionId))).toBe(
        true,
      );
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  }, 20_000);
});
