import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateText, type LanguageModel } from "ai";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import {
  CredentialVault,
  ModelRouter,
  ProviderService,
  type ModelProvider,
  type ProviderEndpoint,
} from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { MassionModelFactory, OpenAICompatibleModelBuilder, type ProviderModelSelection } from "./model-factory.js";

function buildOpenAiModelFixture({
  adapterKind = "ai-sdk",
  baseUrl,
  modelId,
  providerId = "openai",
  supportsStructuredOutputs,
}: {
  readonly adapterKind?: ModelProvider["adapter_kind"];
  readonly baseUrl: string;
  readonly modelId: string;
  readonly providerId?: string;
  readonly supportsStructuredOutputs?: boolean;
}): LanguageModel {
  const builder = new OpenAICompatibleModelBuilder();
  const provider: ModelProvider = {
    provider_id: providerId,
    organization_id: "organization-a",
    display_name: providerId === "openai" ? "OpenAI" : "Configured Provider",
    adapter_kind: adapterKind,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const endpoint: ProviderEndpoint = {
    endpoint_id: "endpoint-openai",
    organization_id: "organization-a",
    provider_id: providerId,
    name: "OpenAI API",
    base_url: baseUrl,
    local: false,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
  return builder.build({
    provider,
    endpoint,
    modelId,
    credentialId: "openai-api-key",
    secret: "openai-secret",
    supportsStructuredOutputs: supportsStructuredOutputs ?? true,
  });
}

describe("Massion routed model factory", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let providers: ProviderService;
  let router: ModelRouter;
  let routeName: string;

  it("upgrade DB에 남은 private·loopback 외부 endpoint를 모델 생성 직전에 거부한다", () => {
    expect(() =>
      buildOpenAiModelFixture({
        adapterKind: "openai-compatible",
        baseUrl: "https://169.254.169.254/latest",
        modelId: "unsafe-model",
        providerId: "legacy-unsafe",
      }),
    ).toThrow("public HTTPS");
  });

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
    router = await ModelRouter.create(database, organizations, providers);
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      displayName: "OpenAI Compatible",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      name: "API",
      baseUrl: "https://models.example/v1",
      local: false,
    });
    for (const label of ["account-a", "account-b"]) {
      await providers.addCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai-compatible",
        endpointId: endpoint.endpoint.endpoint_id,
        label,
        credentialType: "api_key",
        secret: `secret-${label}`,
        priority: 1,
        weight: 1,
      });
    }
    const profile = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "coding-model",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "coding",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1_000_000,
      outputCostMicrosPerMillion: 1_000_000,
      verified: true,
    });
    const route = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: `coding-${crypto.randomUUID()}`,
      routeKind: "chat",
      credentialPolicy: "round-robin",
      dataPolicy: "external-allowed",
      equivalenceGroup: "coding",
      minEvalScore: 0.8,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 16_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
    });
    routeName = route.route.name;
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: route.route.route_id,
      modelProfileId: profile.profile.model_profile_id,
      priority: 1,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await database.close();
  });

  it("구성되지 않은 경로는 실행 실패가 아니라 명시적인 모델 제한 상태로 분류한다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: () => ({ modelId: "사용되지-않음" }) as LanguageModel,
    });

    await expect(
      factory.acquire(context, {
        commandId: crypto.randomUUID(),
        routeName: "구성되지-않은-경로",
        estimatedTokens: 100,
        estimatedCostMicros: 100,
      }),
    ).rejects.toThrow("blocked_model_unavailable: 구성되지-않은-경로 Route가 구성되지 않았습니다");
  });

  it("reservation secret을 lease에 노출하지 않고 model 생성과 실제 usage를 정산한다", async () => {
    const build = vi.fn((selection: ProviderModelSelection) => ({ modelId: selection.modelId }) as LanguageModel);
    const factory = new MassionModelFactory(router, providers, { build });
    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });

    expect(build.mock.calls[0]?.[0].secret).toMatch(/^secret-account-/u);
    expect(
      (build.mock.calls[0]?.[0] as ProviderModelSelection & { readonly supportsStructuredOutputs?: boolean })
        .supportsStructuredOutputs,
    ).toBe(true);
    expect(JSON.stringify(lease)).not.toContain("secret-account");
    expect(lease.model.modelId).toBe("coding-model");
    const completed = await lease.complete({
      commandId: crypto.randomUUID(),
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.actual_cost_micros).toBe(60);
  });

  it("MassionModelFactory가 레거시 unsafe endpoint를 예약·비용·builder 호출 전에 차단한다", async () => {
    const build = vi.fn(() => ({ modelId: "unsafe-model" }) as LanguageModel);
    const factory = new MassionModelFactory(router, providers, { build });
    const route = (await router.listRoutes(context)).find((item) => item.name === routeName);
    const model = (await router.listModels(context))[0];
    if (!route || !model) throw new Error("Router fixture가 없습니다");
    await database.query(
      "UPDATE provider_endpoint SET base_url = 'https://169.254.169.254/latest' WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;",
      { organization_id: context.organizationId, endpoint_id: model.endpoint_id },
    );

    await expect(
      factory.acquire(context, {
        commandId: crypto.randomUUID(),
        routeName,
        estimatedTokens: 100,
        estimatedCostMicros: 1_000,
      }),
    ).rejects.toThrow("안전하지 않은 endpoint");
    const [routes] = await database.query<
      [Array<{ readonly spent_micros: number; readonly selection_sequence: number }>]
    >(
      "SELECT spent_micros, selection_sequence FROM model_route WHERE organization_id = $organization_id AND route_id = $route_id;",
      { organization_id: context.organizationId, route_id: route.route_id },
    );
    const [credentials] = await database.query<
      [Array<{ readonly request_count: number; readonly cost_micros: number }>]
    >(
      "SELECT request_count, cost_micros FROM provider_credential WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;",
      { organization_id: context.organizationId, endpoint_id: model.endpoint_id },
    );
    const [attempts] = await database.query<[unknown[]]>(
      "SELECT attempt_id FROM route_attempt WHERE organization_id = $organization_id AND route_id = $route_id;",
      { organization_id: context.organizationId, route_id: route.route_id },
    );

    expect(build).not.toHaveBeenCalled();
    expect(routes[0]).toMatchObject({ spent_micros: 0, selection_sequence: 0 });
    expect(credentials.every((credential) => credential.request_count === 0 && credential.cost_micros === 0)).toBe(
      true,
    );
    expect(attempts).toEqual([]);
  });

  it("활성 역할별 model batch의 선호 순서를 Router reserve에 전달한다", async () => {
    const models = await router.listModels(context);
    const source = models[0];
    if (!source) throw new Error("model fixture가 없습니다");
    const preferred = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      providerId: source.provider_id,
      endpointId: source.endpoint_id,
      modelId: "preferred-coding-model",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "coding",
      evalScore: 0.95,
      inputCostMicrosPerMillion: 1_000_000,
      outputCostMicrosPerMillion: 1_000_000,
      verified: true,
    });
    const routes = await router.listRoutes(context);
    const route = routes.find((candidate) => candidate.name === routeName);
    if (!route) throw new Error("route fixture가 없습니다");
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: route.route_id,
      modelProfileId: preferred.profile.model_profile_id,
      priority: 99,
    });
    await database.query(
      "CREATE optimization_batch CONTENT { batch_id: 'optimization-batch-1', organization_id: $organization_id, role_key: 'assurance', version: 1, status: 'active', primary_model_profile_id: $profile_id, fallback_model_profile_ids: [], checksum: $checksum }; CREATE optimization_active_pointer CONTENT { pointer_id: 'optimization-pointer-runtime', organization_id: $organization_id, role_key: 'assurance', batch_id: 'optimization-batch-1', batch_version: 1, checksum: $checksum };",
      {
        organization_id: context.organizationId,
        profile_id: preferred.profile.model_profile_id,
        checksum: "e".repeat(64),
      },
    );
    const simulation = await router.simulate(context, {
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
      preferredModelProfileIds: [preferred.profile.model_profile_id],
    });
    expect((await router.listCandidates(context, route.route_id)).map((item) => item.model_profile_id)).toContain(
      preferred.profile.model_profile_id,
    );
    expect(simulation.profile?.model_profile_id).toBe(preferred.profile.model_profile_id);
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: (selection) => ({ modelId: selection.modelId }) as LanguageModel },
      undefined,
      {
        resolve: async () => ({
          profileIds: [preferred.profile.model_profile_id],
          batchId: "optimization-batch-1",
        }),
      },
    );
    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      executionId: "execution-lineage-1",
      agentHandle: "assurance",
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });
    expect(lease.model.modelId).toBe("preferred-coding-model");
    expect(lease).toMatchObject({
      modelProfileId: preferred.profile.model_profile_id,
      optimizationBatchId: "optimization-batch-1",
      preferenceApplied: true,
    });
    const [attempts] = await database.query<[Array<{ execution_id?: string; optimization_batch_id?: string }>]>(
      "SELECT execution_id, optimization_batch_id FROM route_attempt WHERE organization_id = $organization_id AND attempt_id = $attempt_id LIMIT 1;",
      { organization_id: context.organizationId, attempt_id: lease.attemptId },
    );
    expect(attempts[0]).toEqual({
      execution_id: "execution-lineage-1",
      optimization_batch_id: "optimization-batch-1",
    });
    Object.assign(router, {
      readReservedAttemptByExecution: async (tenant: TenantContext, executionId: string) => {
        const attempt = await router.readAttempt(tenant, lease.attemptId);
        return attempt.execution_id === executionId && attempt.status === "reserved" ? attempt : undefined;
      },
    });
    const originalAttempt = await router.readAttempt(context, lease.attemptId);
    const mismatchedExplanation = JSON.parse(originalAttempt.explanation_json) as {
      request: string;
      explanation: unknown;
    };
    mismatchedExplanation.request = JSON.stringify({
      ...(JSON.parse(mismatchedExplanation.request) as Record<string, unknown>),
      optimizationBatchId: "different-batch",
    });
    await database.query(
      "UPDATE route_attempt SET explanation_json = $explanation_json WHERE organization_id = $organization_id AND attempt_id = $attempt_id;",
      {
        organization_id: context.organizationId,
        attempt_id: lease.attemptId,
        explanation_json: JSON.stringify(mismatchedExplanation),
      },
    );
    await expect(factory.recoverReservedSelection(context, "execution-lineage-1")).rejects.toThrow("batch 계보");
    await database.query(
      "UPDATE route_attempt SET explanation_json = $explanation_json WHERE organization_id = $organization_id AND attempt_id = $attempt_id;",
      {
        organization_id: context.organizationId,
        attempt_id: lease.attemptId,
        explanation_json: originalAttempt.explanation_json,
      },
    );
    const recovered = await factory.recoverReservedSelection(context, "execution-lineage-1");
    expect(recovered).toMatchObject({
      attemptId: lease.attemptId,
      modelProfileId: preferred.profile.model_profile_id,
      optimizationBatchId: "optimization-batch-1",
      preferenceApplied: true,
    });
    await recovered?.fail({
      commandId: "execution-lineage-1:model:recovery:release",
      signal: { kind: "cancelled" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(factory.recoverReservedSelection(context, "execution-lineage-1")).resolves.toBeUndefined();
  });

  it("명시적 선호는 활성 batch resolver보다 우선하고 batch 계보를 가져오지 않는다", async () => {
    const profile = (await router.listModels(context))[0];
    if (!profile) throw new Error("model fixture가 없습니다");
    const resolve = vi.fn().mockResolvedValue({
      profileIds: ["resolver-profile"],
      batchId: "resolver-batch",
    });
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: (selection) => ({ modelId: selection.modelId }) as LanguageModel },
      undefined,
      { resolve },
    );

    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
      preferredModelProfileIds: [profile.model_profile_id],
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(lease).toMatchObject({ modelProfileId: profile.model_profile_id, preferenceApplied: true });
    expect(lease).not.toHaveProperty("optimizationBatchId");
  });

  it("활성 batch의 선호 목록이 비었으면 기존 Router 기준을 쓰고 batch 계보를 연결하지 않는다", async () => {
    const profile = (await router.listModels(context))[0];
    if (!profile) throw new Error("model fixture가 없습니다");
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: (selection) => ({ modelId: selection.modelId }) as LanguageModel },
      undefined,
      { resolve: async () => ({ profileIds: [], batchId: "empty-batch" }) },
    );

    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      executionId: "execution-empty-preference",
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });
    const [attempts] = await database.query<[Array<{ optimization_batch_id?: string }>]>(
      "SELECT optimization_batch_id FROM route_attempt WHERE organization_id = $organization_id AND attempt_id = $attempt_id LIMIT 1;",
      { organization_id: context.organizationId, attempt_id: lease.attemptId },
    );

    expect(lease).toMatchObject({ modelProfileId: profile.model_profile_id, preferenceApplied: false });
    expect(lease).not.toHaveProperty("optimizationBatchId");
    expect(attempts[0]).toEqual({});
  });

  it("cold recovery는 Session Lease를 먼저 닫아 Router 정산 재시도에도 고아를 남기지 않는다", async () => {
    let attemptId = "";
    let sessionActive = true;
    const sessionFail = vi.fn(async () => {
      sessionActive = false;
      return { status: "failed" as const, fallbackAllowed: false, failureKind: "cancelled" as const };
    });
    const broker = {
      acquire: vi.fn(),
      bindRuntime: vi.fn(),
      recoverActive: vi.fn(async () => []),
      getLease: vi.fn(),
      findExecutionLeases: vi.fn(async () =>
        sessionActive && attemptId
          ? [
              {
                leaseId: "recovery-session-1",
                executionId: "execution-session-recovery",
                accountId: "account-1",
                connectorId: "connector-1",
                workId: "work-1",
                agentHandle: "assurance",
                routeAttemptId: attemptId,
                status: "active" as const,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                complete: vi.fn(),
                fail: sessionFail,
                renew: vi.fn(),
              },
            ]
          : [],
      ),
    };
    const factory = new MassionModelFactory(
      router,
      providers,
      { build: (selection) => ({ modelId: selection.modelId }) as LanguageModel },
      { broker, resolver: { resolve: vi.fn() } } as never,
    );
    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      executionId: "execution-session-recovery",
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });
    attemptId = lease.attemptId;
    Object.assign(router, {
      readReservedAttemptByExecution: async (tenant: TenantContext, executionId: string) => {
        const attempt = await router.readAttempt(tenant, attemptId);
        return attempt.execution_id === executionId && attempt.status === "reserved" ? attempt : undefined;
      },
    });
    const reportFailure = router.reportFailure.bind(router);
    vi.spyOn(router, "reportFailure")
      .mockRejectedValueOnce(new Error("router recovery unavailable"))
      .mockImplementation(reportFailure);
    const usage = {
      commandId: "execution-session-recovery:model:recovery-release",
      signal: { kind: "cancelled" as const },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    };

    const first = await factory.recoverReservedSelection(context, "execution-session-recovery");
    await expect(first?.fail(usage)).rejects.toThrow("Router 실패 정산");
    expect(sessionFail).toHaveBeenCalledOnce();
    const retried = await factory.recoverReservedSelection(context, "execution-session-recovery");
    await retried?.fail(usage);

    await expect(factory.recoverReservedSelection(context, "execution-session-recovery")).resolves.toBeUndefined();
    expect(sessionFail).toHaveBeenCalledOnce();
  });

  it("공통 Connector 정산은 Session 실패 시 Router attempt를 reserved로 보존해 재시도한다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: (selection) => ({ modelId: selection.modelId }) as LanguageModel,
    });
    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      executionId: "execution-shared-connector-settlement",
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });
    const sessionFail = vi
      .fn()
      .mockRejectedValueOnce(new Error("session settlement unavailable"))
      .mockResolvedValue({ status: "failed", fallbackAllowed: false, failureKind: "cancelled" });
    const session = {
      leaseId: "shared-settlement-session",
      executionId: "execution-shared-connector-settlement",
      accountId: "account-1",
      connectorId: "connector-1",
      workId: "work-1",
      agentHandle: "assurance",
      routeAttemptId: lease.attemptId,
      status: "active",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      complete: vi.fn(),
      fail: sessionFail,
      renew: vi.fn(),
    };
    const reportFailure = vi.spyOn(router, "reportFailure");
    const failConnectorAttempt = (
      factory as unknown as {
        failConnectorAttempt(
          tenant: TenantContext,
          attemptId: string,
          connectorSession: typeof session,
          usage: {
            commandId: string;
            signal: { kind: "cancelled" };
            emittedTokens: number;
            sideEffectsStarted: boolean;
            inputTokens: number;
            outputTokens: number;
          },
        ): Promise<unknown>;
      }
    ).failConnectorAttempt.bind(factory);
    const usage = {
      commandId: "execution-shared-connector-settlement:fail",
      signal: { kind: "cancelled" as const },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    };

    await expect(failConnectorAttempt(context, lease.attemptId, session, usage)).rejects.toThrow(
      "session settlement unavailable",
    );
    expect(reportFailure).not.toHaveBeenCalled();
    await expect(router.readAttempt(context, lease.attemptId)).resolves.toMatchObject({ status: "reserved" });

    await failConnectorAttempt(context, lease.attemptId, session, usage);
    expect(sessionFail).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledOnce();
    await expect(router.readAttempt(context, lease.attemptId)).resolves.toMatchObject({ status: "failed" });
  });

  it("first-token 전 401 실패 후 다른 credential lease로 fallback한다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: (selection) => ({ modelId: `${selection.modelId}:${selection.credentialId}` }) as LanguageModel,
    });
    const first = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
    });
    const failed = await first.fail({
      commandId: crypto.randomUUID(),
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
    const fallback = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      fallbackFromAttemptId: first.attemptId,
    });

    expect(failed.fallbackAllowed).toBe(true);
    expect(fallback.credentialId).not.toBe(first.credentialId);
    expect(fallback.modelProfileId).toBe(first.modelProfileId);
    expect(fallback.preferenceApplied).toBe(false);
  });

  it.each(["https://api.openai.com/v1?", "https://api.openai.com/v1#"])(
    "빈 query/hash가 포함된 OpenAI API URL %s는 chat provider를 사용한다",
    (baseUrl) => {
      const model = buildOpenAiModelFixture({
        baseUrl,
        modelId: "gpt-5.6-sol",
      });

      expect(model.provider).toBe("openai.chat");
    },
  );

  it.each(["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "공식 OpenAI의 %s는 Responses provider를 사용한다",
    (modelId) => {
      const model = buildOpenAiModelFixture({
        baseUrl: "https://api.openai.com/v1",
        modelId,
      });

      expect(model.provider).toBe("openai.responses");
    },
  );

  it.each([
    {
      name: "공식 OpenAI의 allowlist 외 gpt-5.5는 chat provider를 사용한다",
      adapterKind: "ai-sdk",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.5",
      expectedProvider: "openai.chat",
    },
    {
      name: "사용자 지정 proxy의 gpt-5.6-sol은 chat provider를 사용한다",
      adapterKind: "ai-sdk",
      baseUrl: "https://proxy.example/v1",
      modelId: "gpt-5.6-sol",
      providerId: "configured-provider",
      expectedProvider: "configured-provider.chat",
    },
    {
      name: "openai-compatible adapter의 gpt-5.6-sol은 chat provider를 사용한다",
      adapterKind: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      modelId: "gpt-5.6-sol",
      providerId: "configured-provider",
      expectedProvider: "configured-provider.chat",
    },
    {
      name: "이중 trailing slash가 포함된 공식 OpenAI URL은 chat provider를 사용한다",
      adapterKind: "ai-sdk",
      baseUrl: "https://api.openai.com/v1//",
      modelId: "gpt-5.6-sol",
      expectedProvider: "openai.chat",
    },
    {
      name: "단일 trailing slash가 포함된 공식 OpenAI URL은 Responses provider를 사용한다",
      adapterKind: "ai-sdk",
      baseUrl: "https://api.openai.com/v1/",
      modelId: "gpt-5.6-sol",
      expectedProvider: "openai.responses",
    },
  ] as const)("$name", (testCase) => {
    const model = buildOpenAiModelFixture({
      adapterKind: testCase.adapterKind,
      baseUrl: testCase.baseUrl,
      modelId: testCase.modelId,
      ...("providerId" in testCase ? { providerId: testCase.providerId } : {}),
    });

    expect(model.provider).toBe(testCase.expectedProvider);
  });

  it.each([
    { adapterKind: "ollama" as const, providerId: "ollama", basePath: "" },
    { adapterKind: "openai-compatible" as const, providerId: "gateway", basePath: "/v1" },
  ])("$adapterKind builder가 secure /v1 endpoint와 Bearer secret으로 호출한다", async (fixture) => {
    let requestUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "completion-1",
          object: "chat.completion",
          created: 1,
          model: "qwen3:8b",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소를 찾을 수 없습니다");
    const builder = new OpenAICompatibleModelBuilder();
    const provider: ModelProvider = {
      provider_id: fixture.providerId,
      organization_id: "organization-a",
      display_name: "Configured Provider",
      adapter_kind: fixture.adapterKind,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const endpoint: ProviderEndpoint = {
      endpoint_id: "endpoint-1",
      organization_id: "organization-a",
      provider_id: fixture.providerId,
      name: "Local",
      base_url: `http://127.0.0.1:${String(address.port)}${fixture.basePath}`,
      local: true,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const model = builder.build({
      provider,
      endpoint,
      modelId: "qwen3:8b",
      credentialId: "local",
      secret: "ollama-secret",
      supportsStructuredOutputs: false,
    });
    try {
      const result = await generateText({ model, prompt: "hello" });
      expect(result.text).toBe("ok");
      expect(requestUrl).toBe("/v1/chat/completions");
      expect(authorization).toBe("Bearer ollama-secret");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("Anthropic 호환 구독 endpoint를 /v1/messages와 Bearer 구독 키로 호출한다", async () => {
    let requestUrl = "";
    let authorization = "";
    let apiKey = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      apiKey = String(request.headers["x-api-key"] ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "message-1",
          type: "message",
          role: "assistant",
          model: "MiniMax-M2.7",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소를 찾을 수 없습니다");
    const builder = new OpenAICompatibleModelBuilder();
    const provider: ModelProvider = {
      provider_id: "minimax-token-plan",
      organization_id: "organization-a",
      display_name: "MiniMax Token Plan",
      adapter_kind: "subscription-connector",
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const endpoint: ProviderEndpoint = {
      endpoint_id: "endpoint-minimax",
      organization_id: "organization-a",
      provider_id: provider.provider_id,
      name: "MiniMax Anthropic",
      base_url: `http://127.0.0.1:${String(address.port)}/anthropic`,
      local: true,
      subscription_protocol: "anthropic",
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const model = builder.build({
      provider,
      endpoint,
      modelId: "MiniMax-M2.7",
      credentialId: "minimax-subscription-key",
      secret: "subscription-key-value",
      supportsStructuredOutputs: false,
    });
    try {
      const result = await generateText({ model, prompt: "hello", maxRetries: 0 });
      expect(result.text).toBe("ok");
      expect(requestUrl).toBe("/anthropic/v1/messages");
      expect(authorization).toBe("Bearer subscription-key-value");
      expect(apiKey).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
