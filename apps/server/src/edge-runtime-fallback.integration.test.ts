import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import {
  DirectExecutionLifecycle,
  MassionModelFactory,
  RoutedModelRegistry,
  RuntimeExecutionStore,
  RuntimeRecovery,
  VoltAgentRunner,
  runtimeAgentName,
  type SubscriptionAgentAdapter,
} from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import {
  ConnectorEnrollmentService,
  ConnectorRegistry,
  SubscriptionAccountService,
  SubscriptionConnectorBroker,
  SubscriptionQuotaService,
  type ConnectorEvent,
  type ConnectorTransportDirectory,
} from "@massion/subscriptions";

import { EdgeRequestExecutor } from "../../connector/src/executor.js";
import { ConnectorIdentityStore, type ActiveConnectorIdentity } from "../../connector/src/identity-store.js";
import type { ConnectorRequestFrame } from "../../connector/src/protocol.js";
import { CodexAppServerSubscriptionConnector, type CodexAppServerOpen } from "./codex-app-server-agent.js";
import type { CodexAppServerConnection, CodexAppServerOptions } from "./codex-app-server.js";
import {
  MassionSubscriptionRuntimeResolver,
  type SubscriptionAgentExecutionPolicy,
} from "./subscription-runtime-resolver.js";

describe("실제 Edge 구독 fallback 통합", () => {
  const roots: string[] = [];
  let database: MassionDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  async function edgeIdentity(
    root: string,
    connectorId: string,
    context: {
      readonly organizationId: string;
      readonly userId: string;
      readonly membershipId: string;
      readonly role: "owner" | "admin" | "member";
    },
    workspaceRoot: string,
  ): Promise<ActiveConnectorIdentity> {
    const profileRoot = join(root, `${connectorId}-profile`);
    await mkdir(profileRoot, { mode: 0o700 });
    await writeFile(join(profileRoot, "auth.json"), "integration-login-fixture", { mode: 0o600 });
    const identityPath = join(root, `${connectorId}-identity.json`);
    const pending = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://massion.example",
      enrollmentId: `enrollment-${connectorId}`,
      connectorId,
      commandId: `command-${connectorId}`,
      providerId: "openai-codex",
      accountAlias: connectorId,
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
    });
    return await new ConnectorIdentityStore(identityPath).activate(pending, context);
  }

  it("실제 Edge 구독의 성공·fallback·실패·재시작이 Work 실행과 모델 계보를 보존한다", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "massion-edge-runtime-fallback-")));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { mode: 0o700 });
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const registered = await identities.registerPersonalUser({
      email: "edge-fallback-owner@example.com",
      displayName: "Edge Fallback Owner",
    });
    const context = await organizations.resolveTenantContext(
      registered.user.user_id,
      registered.organization.organization_id,
    );
    const identityContext = {
      organizationId: context.organizationId,
      userId: context.userId,
      membershipId: context.membershipId,
      role: context.role,
    };
    const identityA = await edgeIdentity(root, "edge-account-a", identityContext, workspaceRoot);
    const identityB = await edgeIdentity(root, "edge-account-b", identityContext, workspaceRoot);

    const enrollment = await ConnectorEnrollmentService.create(database, organizations);
    const connectorRegistry = await ConnectorRegistry.create(database, organizations, enrollment);
    await database.query(
      `CREATE subscription_connector CONTENT {
         connector_id: $connector_a, organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
         protocol: 'massion.connector.v1', version: '1.0.0', public_key: $public_key_a,
         capabilities: $capabilities_a, status: 'ready', last_heartbeat_at: time::now(),
         expires_at: time::now() + 1h, created_at: time::now(), updated_at: time::now()
       };
       CREATE subscription_connector CONTENT {
         connector_id: $connector_b, organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
         protocol: 'massion.connector.v1', version: '1.0.0', public_key: $public_key_b,
         capabilities: $capabilities_b, status: 'ready', last_heartbeat_at: time::now(),
         expires_at: time::now() + 1h, created_at: time::now(), updated_at: time::now()
       };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        connector_a: identityA.connectorId,
        connector_b: identityB.connectorId,
        public_key_a: identityA.publicKey,
        public_key_b: identityB.publicKey,
        capabilities_a: identityA.capabilities,
        capabilities_b: identityB.capabilities,
      },
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    const accountA = await accounts.register(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      alias: "Codex A",
      connectorId: identityA.connectorId,
      profileLocator: "profile-a",
      billingKind: "consumer-subscription",
      requiredExecutionKind: "agent-runtime",
      requiredCapability: "openai-codex",
    });
    const accountB = await accounts.register(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      alias: "Codex B",
      connectorId: identityB.connectorId,
      profileLocator: "profile-b",
      billingKind: "consumer-subscription",
      requiredExecutionKind: "agent-runtime",
      requiredCapability: "openai-codex",
    });
    const quota = await SubscriptionQuotaService.create(database, organizations);
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    const ensured = await providers.ensureSubscriptionProvider(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
    });
    const credentialA = (
      await providers.addConnectorCredential(context, {
        commandId: randomUUID(),
        providerId: "openai-codex",
        endpointId: ensured.endpoint.endpoint_id,
        label: "Codex A",
        accountId: accountA.account_id,
        connectorId: identityA.connectorId,
        scope: "personal",
        priority: 0,
        weight: 1,
      })
    ).credential;
    const credentialB = (
      await providers.addConnectorCredential(context, {
        commandId: randomUUID(),
        providerId: "openai-codex",
        endpointId: ensured.endpoint.endpoint_id,
        label: "Codex B",
        accountId: accountB.account_id,
        connectorId: identityB.connectorId,
        scope: "personal",
        priority: 1,
        weight: 1,
      })
    ).credential;
    const router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    const profile = await router.registerModel(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      endpointId: ensured.endpoint.endpoint_id,
      modelId: "gpt-5.6",
      routeKind: "chat",
      contextWindow: 128_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: false,
      equivalenceGroup: "edge-coding",
      evalScore: 1,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
      verificationEvidence: [
        {
          kind: "runtime-availability",
          source: "codex-app-server:model/list",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:00.000Z",
          subscriptionAccountId: accountA.account_id,
          claim: { modelId: "gpt-5.6", hidden: false, actualAvailable: true },
        },
        {
          kind: "provider-capability-contract",
          source: "https://developers.openai.com/api/docs/guides/latest-model",
          sourceVersion: "retrieved-2026-07-12",
          observedAt: "2026-07-12T00:00:01.000Z",
          claim: {
            contextWindow: 1_050_000,
            tools: true,
            structuredOutput: true,
            vision: true,
            streaming: true,
          },
        },
        {
          kind: "runtime-capability-contract",
          source: "massion:bundled-codex-runtime-attestation",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:02.000Z",
          subscriptionAccountId: accountA.account_id,
          claim: {
            runtimeArtifactDigest: "a".repeat(64),
            agentRuntime: true,
            contextWindow: 128_000,
            tools: true,
            structuredOutput: true,
            vision: false,
            streaming: false,
          },
        },
      ],
    });
    await router.recordModelEvidence(context, {
      commandId: randomUUID(),
      modelProfileId: profile.profile.model_profile_id,
      verificationEvidence: [
        {
          kind: "runtime-availability",
          source: "codex-app-server:model/list",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:03.000Z",
          subscriptionAccountId: accountB.account_id,
          claim: { modelId: "gpt-5.6", hidden: false, actualAvailable: true },
        },
        {
          kind: "provider-capability-contract",
          source: "https://developers.openai.com/api/docs/guides/latest-model",
          sourceVersion: "retrieved-2026-07-12",
          observedAt: "2026-07-12T00:00:04.000Z",
          claim: {
            contextWindow: 1_050_000,
            tools: true,
            structuredOutput: true,
            vision: true,
            streaming: true,
          },
        },
        {
          kind: "runtime-capability-contract",
          source: "massion:bundled-codex-runtime-attestation",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:05.000Z",
          subscriptionAccountId: accountB.account_id,
          claim: {
            runtimeArtifactDigest: "b".repeat(64),
            agentRuntime: true,
            contextWindow: 128_000,
            tools: true,
            structuredOutput: true,
            vision: false,
            streaming: false,
          },
        },
      ],
    });
    const route = await router.createRoute(context, {
      commandId: randomUUID(),
      name: "edge-coding",
      routeKind: "chat",
      credentialPolicy: "fill-first",
      dataPolicy: "external-allowed",
      equivalenceGroup: "edge-coding",
      minEvalScore: 0.9,
      requireTools: true,
      requireStructuredOutput: false,
      requireVision: false,
      requireStreaming: false,
      maxContextTokens: 64_000,
      requestBudgetMicros: 0,
      totalBudgetMicros: 0,
    });
    await router.addCandidate(context, {
      commandId: randomUUID(),
      routeId: route.route.route_id,
      modelProfileId: profile.profile.model_profile_id,
      priority: 1,
    });

    const authenticationError = {
      message: "인증이 필요합니다",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    };
    let appServerOptions: CodexAppServerOptions | undefined;
    let appServerClosed = false;
    const appServerConnection: CodexAppServerConnection = {
      get closed() {
        return appServerClosed;
      },
      close: vi.fn(async () => {
        appServerClosed = true;
      }),
      notify: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "provider-session-a" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            void (async () => {
              await appServerOptions?.onNotification?.({
                method: "turn/started",
                params: {
                  threadId: "provider-session-a",
                  turn: { id: "provider-turn-a", status: "inProgress", error: null },
                },
              });
              await appServerOptions?.onNotification?.({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "provider-session-a",
                  turnId: "provider-turn-a",
                  tokenUsage: {
                    last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
                  },
                },
              });
              await appServerOptions?.onNotification?.({
                method: "error",
                params: {
                  threadId: "provider-session-a",
                  turnId: "provider-turn-a",
                  error: authenticationError,
                  willRetry: false,
                },
              });
              await appServerOptions?.onNotification?.({
                method: "turn/completed",
                params: {
                  threadId: "provider-session-a",
                  turn: {
                    id: "provider-turn-a",
                    status: "failed",
                    error: authenticationError,
                    items: [],
                  },
                },
              });
            })();
          });
          return { turn: { id: "provider-turn-a" } };
        }
        throw new Error(`예상하지 않은 app-server method: ${method}`);
      }),
    };
    const appServerOpen = vi.fn(async (_command, _arguments, _environment, options) => {
      appServerOptions = options;
      return appServerConnection;
    }) satisfies CodexAppServerOpen;
    const adapterAFactory = vi.fn(
      () =>
        new CodexAppServerSubscriptionConnector(
          { request: async () => ({ outcome: "deny", reason: "호출되지 않아야 합니다" }) },
          {
            model: "gpt-5.6-codex",
            policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
            runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
          },
          appServerOpen,
        ),
    );
    const adapterB: SubscriptionAgentAdapter = {
      execute: vi.fn().mockImplementation((_context, input) =>
        Promise.resolve({
          outcome: "completed" as const,
          executionId: input.executionId,
          sessionId: "provider-session-b",
          value: "두 번째 계정 성공",
          usage: { inputTokens: 4, outputTokens: 1 },
        }),
      ),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const executors = new Map([
      [
        identityA.connectorId,
        new EdgeRequestExecutor({
          identity: identityA,
          factory: { create: adapterAFactory },
          healthProbe: { verify: async (input) => ({ authKind: input.expectedAuthKind }) },
        }),
      ],
      [
        identityB.connectorId,
        new EdgeRequestExecutor({
          identity: identityB,
          factory: { create: () => adapterB },
          healthProbe: {
            verify: async (input) => ({ authKind: input.expectedAuthKind }),
          },
        }),
      ],
    ]);
    const transport: ConnectorTransportDirectory = {
      async *invoke(organizationId, connectorId, request, signal): AsyncIterable<ConnectorEvent> {
        expect(organizationId).toBe(context.organizationId);
        if (signal?.aborted) throw new Error("테스트 요청이 취소되었습니다");
        const executor = executors.get(connectorId);
        if (!executor) throw new Error("테스트 Edge executor가 없습니다");
        const events: ConnectorEvent[] = [];
        await executor.execute({ ...request, type: "request" } as ConnectorRequestFrame, async (event) => {
          events.push({ kind: event.kind, sequence: event.sequence, payload: event.payload });
        });
        for (const event of events) yield event;
      },
    };
    const broker = await SubscriptionConnectorBroker.create(database, organizations, accounts, { transport });
    const edgePolicy = Object.defineProperties(
      {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
      },
      {
        permissionMode: { value: "governed" },
        autonomyRevision: { value: 0 },
      },
    ) as SubscriptionAgentExecutionPolicy;
    const resolver = new MassionSubscriptionRuntimeResolver({
      accounts,
      connectors: connectorRegistry,
      broker,
      workspaceCapabilities: {
        verify: async () => ({
          workspaceRoot,
          workspaceAccess: "workspace-write",
          allowedTools: [],
          disallowedTools: [],
        }),
      },
      policies: {
        resolve: async () => edgePolicy,
      },
      profileRoot: join(root, "server-profiles"),
      executableAllowlist: {},
    });
    const modelBuilder = { build: () => ({ modelId: "unused" }) as LanguageModel };
    const connectorRuntime = {
      broker,
      resolver,
      routeAttempts: {
        read: async (tenant: typeof context, attemptId: string) => await router.readAttempt(tenant, attemptId),
      },
    };
    const modelFactory = new MassionModelFactory(router, providers, modelBuilder, connectorRuntime);
    const store = await RuntimeExecutionStore.create(database, organizations);
    const runner = new VoltAgentRunner(
      {
        // Agent runtime도 요청된 조직 Agent가 실제 활성 상태인지 먼저 검증합니다.
        getAgents: () => [{ name: runtimeAgentName(context.organizationId, "representative") } as never],
      },
      store,
      modelFactory,
      new RoutedModelRegistry(),
      undefined,
      {
        resolve: async () => ({
          workspaceRoot,
          workspaceAccess: "workspace-write",
          workspaceCapability: "workspace-capability-edge-fallback",
        }),
      },
    );

    const result = await runner.execute(context, {
      commandId: randomUUID(),
      workId: "work-edge-fallback",
      agentHandle: "representative",
      modelRoute: route.route.name,
      correlationId: randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: "fallback을 검증해주세요",
    });
    const [accountRows, attemptRows, leaseRows] = await database.query<
      [
        Array<{ account_id: string; status: string }>,
        Array<{
          attempt_id: string;
          execution_id: string;
          model_profile_id: string;
          credential_id: string;
          status: string;
          failure_class?: string;
          fallback_from_attempt_id?: string;
          emitted_tokens: number;
          side_effects_started: boolean;
          selection_sequence: number;
        }>,
        Array<{ lease_id: string; account_id: string; status: string; route_attempt_id: string; created_at: unknown }>,
      ]
    >(
      `SELECT account_id, status FROM subscription_account
       WHERE organization_id = $organization_id ORDER BY account_id ASC;
       SELECT attempt_id, execution_id, model_profile_id, credential_id, status, failure_class,
              fallback_from_attempt_id, emitted_tokens,
              side_effects_started,
              selection_sequence
       FROM route_attempt WHERE organization_id = $organization_id ORDER BY selection_sequence ASC;
       SELECT lease_id, account_id, status, route_attempt_id, created_at FROM subscription_session_lease
       WHERE organization_id = $organization_id ORDER BY created_at ASC;`,
      { organization_id: context.organizationId },
    );
    const fallbackRecovery = await store.getRecovery(context, result.executionId);
    const fallbackLineages = await router.listAttemptLineagesByExecution(context, result.executionId);

    expect(result, JSON.stringify({ result, accountRows, attemptRows, leaseRows })).toMatchObject({
      status: "succeeded",
      output: "두 번째 계정 성공",
    });
    expect(adapterAFactory).toHaveBeenCalledOnce();
    expect(adapterB.execute).toHaveBeenCalledOnce();
    expect(accountRows.find((account) => account.account_id === accountA.account_id)?.status).toBe("needs-reauth");
    expect(accountRows.find((account) => account.account_id === accountB.account_id)?.status).toBe("active");
    expect(attemptRows).toEqual([
      expect.objectContaining({
        execution_id: result.executionId,
        model_profile_id: profile.profile.model_profile_id,
        credential_id: credentialA.credential_id,
        status: "failed",
        failure_class: "authentication",
        emitted_tokens: 0,
        side_effects_started: false,
      }),
      expect.objectContaining({
        execution_id: result.executionId,
        model_profile_id: profile.profile.model_profile_id,
        credential_id: credentialB.credential_id,
        status: "succeeded",
        fallback_from_attempt_id: expect.any(String),
      }),
    ]);
    expect(attemptRows[1]?.fallback_from_attempt_id).toBe(attemptRows[0]?.attempt_id);
    expect(fallbackRecovery.execution).toMatchObject({
      execution_id: result.executionId,
      work_id: "work-edge-fallback",
      status: "succeeded",
    });
    expect(fallbackLineages).toEqual([
      {
        attemptId: attemptRows[0]?.attempt_id,
        executionId: result.executionId,
        modelProfileId: profile.profile.model_profile_id,
        status: "failed",
      },
      {
        attemptId: attemptRows[1]?.attempt_id,
        executionId: result.executionId,
        modelProfileId: profile.profile.model_profile_id,
        fallbackFromAttemptId: attemptRows[0]?.attempt_id,
        status: "succeeded",
      },
    ]);
    expect(
      fallbackRecovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual(
      attemptRows.map((attempt) => ({
        executionId: result.executionId,
        attemptId: attempt.attempt_id,
        modelProfileId: profile.profile.model_profile_id,
        routeName: route.route.name,
        preferenceApplied: false,
      })),
    );
    expect(leaseRows).toEqual([
      expect.objectContaining({
        account_id: accountA.account_id,
        status: "failed",
        route_attempt_id: attemptRows[0]?.attempt_id,
      }),
      expect.objectContaining({
        account_id: accountB.account_id,
        status: "completed",
        route_attempt_id: attemptRows[1]?.attempt_id,
      }),
    ]);
    expect(new Set(leaseRows.map((lease) => lease.lease_id)).size).toBe(2);
    expect(JSON.stringify({ result, accountRows, attemptRows, leaseRows })).not.toMatch(
      /profile-a|profile-b|edge-fallback-owner@example\.com/iu,
    );

    vi.mocked(adapterB.execute).mockImplementationOnce(async (_tenant, input) => ({
      outcome: "failed",
      executionId: input.executionId,
      sessionId: "provider-session-b-failed",
      category: "input",
      retryable: false,
      signal: { kind: "input" },
      emittedTokens: 0,
      sideEffectsStarted: false,
    }));
    const failedResult = await runner.execute(context, {
      commandId: randomUUID(),
      workId: "work-edge-failed",
      agentHandle: "representative",
      modelRoute: route.route.name,
      correlationId: randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: "실패 계보를 검증해주세요",
    });
    const failedRecovery = await store.getRecovery(context, failedResult.executionId);
    const failedLineages = await router.listAttemptLineagesByExecution(context, failedResult.executionId);

    expect(failedResult).toMatchObject({ status: "failed", error: { category: "input", retryable: false } });
    expect(failedRecovery.execution).toMatchObject({
      execution_id: failedResult.executionId,
      work_id: "work-edge-failed",
      status: "failed",
    });
    expect(failedLineages).toEqual([
      {
        attemptId: expect.any(String),
        executionId: failedResult.executionId,
        modelProfileId: profile.profile.model_profile_id,
        status: "failed",
      },
    ]);
    const failedAttempt = await router.readAttempt(context, failedLineages[0]?.attemptId ?? "");
    expect(failedAttempt).toMatchObject({
      execution_id: failedResult.executionId,
      model_profile_id: profile.profile.model_profile_id,
      credential_id: credentialB.credential_id,
      failure_class: "input",
      status: "failed",
    });
    expect(
      failedRecovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual([
      {
        executionId: failedResult.executionId,
        attemptId: failedAttempt.attempt_id,
        modelProfileId: profile.profile.model_profile_id,
        routeName: route.route.name,
        preferenceApplied: false,
      },
    ]);

    const restartExecution = await store.createExecution(context, {
      commandId: randomUUID(),
      workId: "work-edge-restart",
      agentHandle: "representative",
      modelRoute: route.route.name,
      correlationId: randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: "재시작 계보를 검증해주세요",
    });
    await store.transition(context, {
      commandId: `${restartExecution.execution.execution_id}:running`,
      executionId: restartExecution.execution.execution_id,
      expectedVersion: restartExecution.execution.version,
      target: "running",
      payload: { agentHandle: "representative" },
    });
    const reserved = await modelFactory.acquire(context, {
      commandId: randomUUID(),
      executionId: restartExecution.execution.execution_id,
      workId: "work-edge-restart",
      agentHandle: "representative",
      workspaceRoot,
      workspaceAccess: "workspace-write",
      workspaceCapability: "workspace-capability-edge-fallback",
      routeName: route.route.name,
      estimatedTokens: 100,
      estimatedCostMicros: 0,
    });
    const restartedStore = await RuntimeExecutionStore.create(database, organizations);
    const restartedRunner = new VoltAgentRunner(
      {
        getAgents: () => [{ name: runtimeAgentName(context.organizationId, "representative") } as never],
      },
      restartedStore,
      new MassionModelFactory(router, providers, modelBuilder, connectorRuntime),
      new RoutedModelRegistry(),
      new DirectExecutionLifecycle(
        new RuntimeRecovery(restartedStore, { getWorkflowState: () => Promise.resolve(null) }),
      ),
    );

    await expect(restartedRunner.recover(context, restartExecution.execution.execution_id)).resolves.toMatchObject({
      executionId: restartExecution.execution.execution_id,
      status: "interrupted",
    });
    const restartedRecovery = await restartedStore.getRecovery(context, restartExecution.execution.execution_id);
    expect(restartedRecovery.execution).toMatchObject({
      execution_id: restartExecution.execution.execution_id,
      work_id: "work-edge-restart",
      status: "interrupted",
    });
    await expect(
      router.listAttemptLineagesByExecution(context, restartExecution.execution.execution_id),
    ).resolves.toEqual([
      {
        attemptId: reserved.attemptId,
        executionId: restartExecution.execution.execution_id,
        modelProfileId: profile.profile.model_profile_id,
        status: "failed",
      },
    ]);
    expect(
      restartedRecovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual([
      {
        executionId: restartExecution.execution.execution_id,
        attemptId: reserved.attemptId,
        modelProfileId: profile.profile.model_profile_id,
        routeName: route.route.name,
        preferenceApplied: false,
      },
    ]);
  });
});
