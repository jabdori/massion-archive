import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LanguageModel } from "ai";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import {
  SUBSCRIPTION_EDGE_READY_MIGRATION,
  SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION,
  SubscriptionAccountService,
  type ConnectorSessionLease,
  SubscriptionQuotaService,
} from "@massion/subscriptions";

import {
  MassionModelFactory,
  type ConnectorRouteAttemptReader,
  type ConnectorRuntimeResolver,
  type ConnectorSessionBroker,
} from "./model-factory.js";

describe("구독 실행 Runtime–Broker 브리지", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let providers: ProviderService;
  let router: ModelRouter;
  let routeName: string;
  let quotaSnapshotIds: Readonly<Record<string, string>>;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const registered = await identities.registerPersonalUser({
      email: "runtime-broker-owner@example.com",
      displayName: "Runtime Broker Owner",
    });
    context = await organizations.resolveTenantContext(
      registered.user.user_id,
      registered.organization.organization_id,
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    const quota = await SubscriptionQuotaService.create(database, organizations);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    await applyMigrations(database, [SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION, SUBSCRIPTION_EDGE_READY_MIGRATION]);

    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'connector-a', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', trust_origin: 'server-managed', provider_id: 'subscription-provider',
        execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        runtime_id: 'fixture-runtime-a', runtime_artifact_digest: $runtime_digest_a,
        process_generation: 1, last_health_at: time::now(), capabilities: ['subscription-provider'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'connector-b', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', trust_origin: 'server-managed', provider_id: 'subscription-provider',
        execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        runtime_id: 'fixture-runtime-b', runtime_artifact_digest: $runtime_digest_b,
        process_generation: 1, last_health_at: time::now(), capabilities: ['subscription-provider'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'account-a', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'subscription-provider', alias: 'Account A', scope: 'personal', connector_id: 'connector-a',
        profile_fingerprint: $fingerprint_a, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'account-b', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'subscription-provider', alias: 'Account B', scope: 'personal', connector_id: 'connector-b',
        profile_fingerprint: $fingerprint_b, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        fingerprint_a: "a".repeat(64),
        fingerprint_b: "b".repeat(64),
        runtime_digest_a: "c".repeat(64),
        runtime_digest_b: "d".repeat(64),
      },
    );

    await providers.registerProvider(context, {
      commandId: randomUUID(),
      providerId: "subscription-provider",
      displayName: "Subscription Provider",
      adapterKind: "ai-sdk",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: randomUUID(),
      providerId: "subscription-provider",
      name: "Subscription Runtime",
      baseUrl: "https://subscriptions.example/v1",
      local: false,
    });
    for (const suffix of ["a", "b"] as const) {
      await providers.addConnectorCredential(context, {
        commandId: randomUUID(),
        providerId: "subscription-provider",
        endpointId: endpoint.endpoint.endpoint_id,
        label: `Account ${suffix.toUpperCase()}`,
        accountId: `account-${suffix}`,
        connectorId: `connector-${suffix}`,
        scope: "personal",
        priority: 1,
        weight: 1,
      });
    }
    const profile = await router.registerModel(context, {
      commandId: randomUUID(),
      providerId: "subscription-provider",
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "subscription-agent",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: false,
      equivalenceGroup: "subscription-agent",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
    });
    const route = await router.createRoute(context, {
      commandId: randomUUID(),
      name: `subscription-${randomUUID()}`,
      routeKind: "chat",
      credentialPolicy: "round-robin",
      dataPolicy: "external-allowed",
      equivalenceGroup: "subscription-agent",
      minEvalScore: 0.8,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: false,
      maxContextTokens: 16_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
    });
    routeName = route.route.name;
    await router.addCandidate(context, {
      commandId: randomUUID(),
      routeId: route.route.route_id,
      modelProfileId: profile.profile.model_profile_id,
      priority: 1,
    });
    const observedAt = new Date().toISOString();
    const snapshots = await Promise.all(
      ["a", "b"].map(
        async (suffix) =>
          await quota.record(context, {
            commandId: randomUUID(),
            accountId: `account-${suffix}`,
            windows: [
              {
                kind: "weekly",
                limit: 100,
                remaining: 80,
                observedAt,
                source: "contract-test",
                confidence: "reported",
              },
            ],
          }),
      ),
    );
    quotaSnapshotIds = Object.fromEntries(snapshots.map((snapshot) => [snapshot.accountId, snapshot.snapshotId]));
  });

  afterEach(async () => database.close());

  function session(input: {
    readonly accountId: string;
    readonly connectorId: string;
    readonly routeAttemptId: string;
    readonly quotaSnapshotId?: string;
  }): ConnectorSessionLease {
    return {
      leaseId: `lease-${input.routeAttemptId}`,
      executionId: "execution-1",
      accountId: input.accountId,
      connectorId: input.connectorId,
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      routeAttemptId: input.routeAttemptId,
      ...(input.quotaSnapshotId ? { quotaSnapshotId: input.quotaSnapshotId } : {}),
      status: "active",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      complete: vi.fn().mockResolvedValue({ status: "completed" }),
      fail: vi.fn().mockResolvedValue({ status: "failed", fallbackAllowed: true, failureKind: "timeout" }),
      renew: vi.fn(),
    } as ConnectorSessionLease;
  }

  function dependencies() {
    const sessions = new Map<string, ConnectorSessionLease>();
    const acquire = vi.fn(async (_context: TenantContext, input: Parameters<ConnectorSessionBroker["acquire"]>[1]) => {
      const created = session(input);
      sessions.set(created.leaseId, created);
      return created;
    });
    const broker: ConnectorSessionBroker = {
      acquire,
      bindRuntime: vi.fn(async (_context, input) => {
        const lease = [...sessions.values()].find((candidate) => candidate.leaseId === input.leaseId);
        if (!lease) throw new Error("Session Lease가 없습니다");
        const bound = { ...lease, adapterId: input.adapterId };
        sessions.set(bound.leaseId, bound);
        return bound;
      }),
      recoverActive: vi.fn(async () => [...sessions.values()]),
      getLease: vi.fn(async (_context, leaseId) => {
        const lease = sessions.get(leaseId);
        if (!lease) throw new Error("Session Lease가 없습니다");
        return lease;
      }),
      findExecutionLeases: vi.fn(async () => [...sessions.values()]),
    };
    const execute = vi.fn().mockResolvedValue({
      outcome: "completed",
      executionId: "provider-execution-1",
      sessionId: "provider-session-1",
      value: "agent result",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const resolver: ConnectorRuntimeResolver = {
      resolve: vi.fn(async () => ({ kind: "agent-runtime" as const, adapterId: "codex", executor: { execute } })),
    };
    return { acquire, broker, execute, resolver, sessions };
  }

  function acquireInput(fallback?: { readonly attemptId: string; readonly leaseId: string }) {
    return {
      commandId: randomUUID(),
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-engineering.backend-specialist",
      workspaceAccess: "workspace-write" as const,
      workspaceCapability: "workspace-capability-1",
      workspaceRoot: "/tmp/massion-work-1",
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      ...(fallback ? { fallbackFromAttemptId: fallback.attemptId, fallbackFromLeaseId: fallback.leaseId } : {}),
    };
  }

  it("Router reservation의 계정·Connector·Quota 계보와 실행 맥락을 Session Lease에 그대로 전달한다", async () => {
    const { acquire, broker, resolver } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver },
    );

    const lease = await factory.acquire(context, acquireInput());
    const request = acquire.mock.calls[0]?.[1];
    if (!request) throw new Error("Session Lease 요청이 없습니다");
    const [attempts] = await database.query<
      [Array<{ attempt_id: string; quota_snapshot_id?: string; fallback_from_attempt_id?: string }>]
    >(
      "SELECT attempt_id, quota_snapshot_id, fallback_from_attempt_id FROM route_attempt WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );

    expect(lease.kind).toBe("agent-runtime");
    expect(request).toEqual({
      commandId: expect.stringContaining(":session:acquire"),
      executionId: "execution-1",
      accountId: request.accountId,
      connectorId: request.connectorId,
      scope: "personal",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      routeAttemptId: attempts[0]?.attempt_id,
      quotaSnapshotId: quotaSnapshotIds[request.accountId],
    });
    expect(request.quotaSnapshotId).toBe(attempts[0]?.quota_snapshot_id);
    expect(resolver.resolve).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        executionId: "execution-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "software-engineering.backend-specialist",
        workspaceAccess: "workspace-write",
        workspaceCapability: "workspace-capability-1",
        workspaceRoot: "/tmp/massion-work-1",
        accountId: request.accountId,
        connectorId: request.connectorId,
        routeAttemptId: request.routeAttemptId,
        quotaSnapshotId: request.quotaSnapshotId,
        sessionLeaseId: `lease-${request.routeAttemptId}`,
      }),
    );
  });

  it("Connector 실패를 Router와 Session Lease에 모두 기록하고 두 fallback 계보를 다음 획득에 보존한다", async () => {
    const { acquire, broker, resolver, sessions } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver },
    );
    const first = await factory.acquire(context, acquireInput());
    if (first.kind !== "agent-runtime") throw new Error("Agent runtime lease가 필요합니다");

    const failed = await first.fail({
      commandId: randomUUID(),
      signal: { kind: "timeout" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    const firstSession = sessions.get(first.sessionLeaseId);
    const second = await factory.acquire(
      context,
      acquireInput({ attemptId: first.attemptId, leaseId: first.sessionLeaseId }),
    );
    const secondRequest = acquire.mock.calls[1]?.[1];
    const [attempts] = await database.query<
      [Array<{ attempt_id: string; fallback_from_attempt_id?: string; status: string }>]
    >(
      "SELECT attempt_id, fallback_from_attempt_id, status, created_at FROM route_attempt WHERE organization_id = $organization_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId },
    );

    expect(failed.fallbackAllowed).toBe(true);
    expect(firstSession?.fail).toHaveBeenCalledWith({
      commandId: expect.stringContaining(":session"),
      emittedTokens: 0,
      sideEffectsStarted: false,
      signal: { kind: "timeout" },
    });
    expect(attempts.find((attempt) => attempt.attempt_id === first.attemptId)?.status).toBe("failed");
    expect(secondRequest?.fallbackFromLeaseId).toBe(first.sessionLeaseId);
    expect(attempts.find((attempt) => attempt.attempt_id === second.attemptId)?.fallback_from_attempt_id).toBe(
      first.attemptId,
    );
  });

  it("일반 모델 실패 뒤 Connector 후보로 fallback할 때 이전 Session Lease를 요구하지 않는다", async () => {
    await providers.registerProvider(context, {
      commandId: randomUUID(),
      providerId: "normal-provider",
      displayName: "Normal Provider",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: randomUUID(),
      providerId: "normal-provider",
      name: "Normal Endpoint",
      baseUrl: "https://models.example/v1",
      local: false,
    });
    await providers.addCredential(context, {
      commandId: randomUUID(),
      providerId: "normal-provider",
      endpointId: endpoint.endpoint.endpoint_id,
      label: "Normal Credential",
      credentialType: "api_key",
      secret: "normal-fallback-secret",
      priority: 1,
      weight: 1,
    });
    const normal = await router.registerModel(context, {
      commandId: randomUUID(),
      providerId: "normal-provider",
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "normal-model",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: false,
      equivalenceGroup: "subscription-agent",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
    });
    const route = (await router.listRoutes(context)).find((candidate) => candidate.name === routeName);
    if (!route) throw new Error("Subscription Route가 필요합니다");
    await router.addCandidate(context, {
      commandId: randomUUID(),
      routeId: route.route_id,
      modelProfileId: normal.profile.model_profile_id,
      priority: 0,
    });
    const { acquire, broker, resolver } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: () => ({ modelId: "normal-model" }) as LanguageModel },
      { broker, resolver },
    );

    const first = await factory.acquire(context, acquireInput());
    if (first.kind !== "model") throw new Error("일반 model lease가 필요합니다");
    const failed = await first.fail({
      commandId: randomUUID(),
      signal: { kind: "timeout" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    const second = await factory.acquire(context, {
      ...acquireInput(),
      commandId: randomUUID(),
      fallbackFromAttemptId: first.attemptId,
    });
    if (second.kind !== "agent-runtime") throw new Error("Connector Agent runtime lease가 필요합니다");

    expect(failed.fallbackAllowed).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire.mock.calls[0]?.[1]).not.toHaveProperty("fallbackFromLeaseId");
    await expect(router.readAttempt(context, second.attemptId)).resolves.toMatchObject({
      fallback_from_attempt_id: first.attemptId,
      status: "reserved",
    });
  });

  it("이전 Session Lease만 있는 Connector fallback은 거부한다", async () => {
    const { acquire, broker, resolver } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: () => ({ modelId: "unused" }) as LanguageModel },
      { broker, resolver },
    );

    await expect(
      factory.acquire(context, { ...acquireInput(), fallbackFromLeaseId: "lease-without-route-attempt" }),
    ).rejects.toThrow("Route Attempt ID");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("Connector 성공을 Router attempt와 Session Lease에 모두 종결한다", async () => {
    const { broker, resolver, sessions } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver },
    );
    const lease = await factory.acquire(context, acquireInput());
    if (lease.kind !== "agent-runtime") throw new Error("Agent runtime lease가 필요합니다");

    const completed = await lease.complete({
      commandId: randomUUID(),
      inputTokens: 7,
      outputTokens: 3,
    });

    expect(completed.status).toBe("succeeded");
    expect(sessions.get(lease.sessionLeaseId)?.complete).toHaveBeenCalledOnce();
  });

  it("model 종류 Connector는 Agent executor가 아니라 명시적 LanguageModel lease로 분기한다", async () => {
    const { broker, resolver } = dependencies();
    const model = { modelId: "connector-language-model" } as LanguageModel;
    vi.mocked(resolver.resolve).mockResolvedValue({ kind: "model", model });
    const build = vi.fn(() => ({ modelId: "secret-model" }) as LanguageModel);
    const factory = new MassionModelFactory(router, providers, { build }, { broker, resolver });

    const lease = await factory.acquire(context, acquireInput());

    expect(lease).toMatchObject({ kind: "model", model, sessionLeaseId: expect.any(String) });
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    ["executionId", "다른-execution"],
    ["workId", "다른-work"],
    ["agentHandle", "다른-agent"],
    ["routeAttemptId", "다른-attempt"],
    ["quotaSnapshotId", "다른-quota"],
    ["status", "completed"],
  ] as const)("반환된 Session Lease의 %s 계보가 다르면 실행 전에 양쪽을 실패 처리한다", async (field, value) => {
    let returned: ConnectorSessionLease | undefined;
    const acquire = vi.fn(async (_context: TenantContext, input: Parameters<ConnectorSessionBroker["acquire"]>[1]) => {
      returned = { ...session(input), [field]: value } as ConnectorSessionLease;
      return returned;
    });
    const resolver: ConnectorRuntimeResolver = {
      resolve: vi.fn(async () => ({
        kind: "agent-runtime" as const,
        adapterId: "codex",
        executor: {
          execute: vi.fn().mockResolvedValue({
            outcome: "completed",
            executionId: "unused",
            sessionId: "unused",
            value: "unused",
          }),
        },
      })),
    };
    const factory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      {
        broker: {
          acquire,
          bindRuntime: vi.fn(async (_context, input) => ({ adapterId: input.adapterId })),
          recoverActive: vi.fn(async () => []),
          getLease: vi.fn(async () => {
            if (!returned) throw new Error("Session Lease가 없습니다");
            return returned;
          }),
          findExecutionLeases: vi.fn(async () => (returned ? [returned] : [])),
        },
        resolver,
      },
    );

    await expect(factory.acquire(context, acquireInput())).rejects.toThrow("Session Lease 계보");
    const [attempts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM route_attempt WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );

    expect(attempts[0]?.status).toBe("failed");
    expect(returned?.fail).toHaveBeenCalledWith(
      expect.objectContaining({ emittedTokens: 0, sideEffectsStarted: false }),
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("Connector Runtime 의존성이 없으면 선택된 Router attempt를 reserved로 방치하지 않는다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: () => ({ modelId: "unused" }) as LanguageModel,
    });

    await expect(factory.acquire(context, acquireInput())).rejects.toThrow("Connector Runtime Broker");
    const [attempts] = await database.query<[Array<{ status: string; fallback_allowed: boolean }>]>(
      "SELECT status, fallback_allowed FROM route_attempt WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );

    expect(attempts).toEqual([expect.objectContaining({ status: "interrupted", fallback_allowed: false })]);
  });

  it("내부 실행 맥락이 없으면 Connector를 호출하지 않고 Router attempt를 실패로 종결한다", async () => {
    const { broker, resolver, acquire } = dependencies();
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: () => ({ modelId: "unused" }) as LanguageModel },
      { broker, resolver },
    );
    const { workId, ...missingWork } = acquireInput();
    if (!workId) throw new Error("테스트 Work ID가 없습니다");

    await expect(factory.acquire(context, missingWork)).rejects.toThrow("Work ID");
    const [attempts] = await database.query<[Array<{ status: string; fallback_allowed: boolean }>]>(
      "SELECT status, fallback_allowed FROM route_attempt WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );

    expect(attempts).toEqual([expect.objectContaining({ status: "interrupted", fallback_allowed: false })]);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("재시작 시 Router만 성공하고 남은 활성 Session Lease를 완료 상태로 조정한다", async () => {
    const { broker, resolver, sessions } = dependencies();
    const firstFactory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver },
    );
    const lease = await firstFactory.acquire(context, acquireInput());
    if (lease.kind !== "agent-runtime") throw new Error("Agent runtime lease가 필요합니다");
    const routeOutcome = await router.reportSuccess(context, {
      commandId: randomUUID(),
      attemptId: lease.attemptId,
      actualInputTokens: 4,
      actualOutputTokens: 2,
      actualCostMicros: 0,
    });
    const reader: ConnectorRouteAttemptReader = {
      read: vi.fn().mockResolvedValue(routeOutcome.attempt),
    };
    const restarted = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver, routeAttempts: reader },
    );

    const reconciled = await restarted.reconcileConnectorLeases(context);

    expect(reconciled).toEqual([
      { leaseId: lease.sessionLeaseId, routeAttemptId: lease.attemptId, action: "completed" },
    ]);
    expect(sessions.get(lease.sessionLeaseId)?.complete).toHaveBeenCalledOnce();
  });

  it("재시작 대조 결과가 interrupted이면 활성 Session Lease를 fallback 불가 실패로 조정한다", async () => {
    const { broker, resolver, sessions } = dependencies();
    const firstFactory = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver },
    );
    const lease = await firstFactory.acquire(context, acquireInput());
    if (lease.kind !== "agent-runtime") throw new Error("Agent runtime lease가 필요합니다");
    const routeOutcome = await router.reportFailure(context, {
      commandId: randomUUID(),
      attemptId: lease.attemptId,
      signal: { kind: "network" },
      emittedTokens: 1,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 1,
      actualCostMicros: 0,
    });
    const reader: ConnectorRouteAttemptReader = {
      read: vi.fn().mockResolvedValue({ ...routeOutcome.attempt, status: "interrupted" }),
    };
    const restarted = new MassionModelFactory(
      router,
      providers,
      {
        build: () => ({ modelId: "unused" }) as LanguageModel,
      },
      { broker, resolver, routeAttempts: reader },
    );

    const reconciled = await restarted.reconcileConnectorLeases(context);

    expect(reconciled).toEqual([{ leaseId: lease.sessionLeaseId, routeAttemptId: lease.attemptId, action: "failed" }]);
    expect(sessions.get(lease.sessionLeaseId)?.fail).toHaveBeenCalledWith({
      commandId: expect.stringContaining(":reconcile:session:fail"),
      emittedTokens: 1,
      sideEffectsStarted: true,
      signal: { kind: "provider-unavailable" },
    });
  });
});
