import { agentIdentityToken } from "@massion/application/client";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicationDesktopService,
  createFixtureDesktopService,
  projectRoomActivities,
  projectRoom,
  projectRouteAttempts,
  type DesktopService,
} from "./desktop-service";
import type { NativeTransport } from "./native-transport";

const detail = {
  workId: "work-0001",
  title: "고객 이탈 원인 분석",
  status: "running",
  revision: 7,
  artifactVersionIds: [],
  artifactIds: [],
  updatedAt: "2026-07-22T00:24:00.000Z",
};
const run = {
  runId: "run-00001",
  workId: detail.workId,
  stage: "delivery",
  status: "running",
  leaseGeneration: 4,
};

function result(operation: string, data: unknown) {
  return { schemaVersion: "massion.application.v1", operation, data };
}

async function flushFixtureEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function transport(overrides: Record<string, unknown> = {}): NativeTransport & {
  query: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  loginCodex: ReturnType<typeof vi.fn>;
} {
  const data: Record<string, unknown> = {
    "work.index": { items: [detail] },
    "work.detail": detail,
    "run.list": [run],
    "work.activity.list": {
      items: [
        {
          activityId: "activity-1",
          workId: detail.workId,
          kind: "message",
          title: "요청을 분석합니다",
          detail: "최근 90일 범위를 확인합니다.",
          createdAt: "2026-07-22T00:21:00.000Z",
        },
      ],
    },
    "work.tasks": [{ workId: detail.workId, taskId: "task-0001", title: "범위 확인", status: "running", revision: 2 }],
    "work.assignments": [
      {
        workId: detail.workId,
        taskId: "task-0001",
        agentHandle: "evidence",
        status: "active",
        revision: 1,
      },
    ],
    "work.executions": [
      {
        executionId: "execution-0001",
        workId: detail.workId,
        agentHandle: "evidence",
        modelRoute: "local/default",
        status: "running",
        inputTokens: 120,
        outputTokens: 48,
        costMicros: 810,
      },
    ],
    "work.artifacts": [],
    "work.verifications": [],
    "work.records": [
      {
        recordId: "record-0001",
        version: 1,
        summary: "Records run records-run-0001 finalized 0 document(s)",
        artifactIds: ["artifact-version-0001"],
        verificationIds: ["verification-0001"],
        finalizedAt: "2026-07-22T00:25:00.000Z",
      },
    ],
    "governance.approval.list": [
      {
        approvalId: "approval-0001",
        action: "crm.read",
        status: "pending",
        requestedBy: "agent:evidence",
        expiresAt: "2026-07-23T00:00:00.000Z",
        workId: detail.workId,
        revision: 3,
      },
    ],
    "work.directive.list": [],
    "inbox.list": [
      {
        kind: "blocked",
        id: "blocked:run-inbox-0001",
        runId: "run-inbox-0001",
        workId: detail.workId,
        title: detail.title,
        blockedReason: "model-unavailable",
      },
      {
        kind: "approval",
        id: "approval-0001",
        workTitle: detail.title,
        approval: {
          approvalId: "approval-0001",
          action: "crm.read",
          status: "pending",
          requestedBy: "agent:evidence",
          expiresAt: "2026-07-23T00:00:00.000Z",
          workId: detail.workId,
          revision: 3,
        },
      },
      {
        kind: "growth",
        id: "growth:suggestion-0001",
        suggestionId: "suggestion-0001",
        workId: detail.workId,
        workTitle: detail.title,
        title: "검증 근거 보강",
        reason: "기록된 검증 누락을 줄이기 위해",
      },
    ],
    "organization.graph.snapshot": { version: { version: 1 }, nodes: [] },
    "router.catalog": { providers: [{ providerId: "openai", apiKey: "never-return-this" }] },
    "router.credentials": [{ credentialId: "credential-1", token: "never-return-this" }],
    "router.routes": [],
    "router.attempts": [],
    "subscription.providers": [],
    "subscription.accounts": [],
    "subscription.quota": [],
    "subscription.policy": [],
    "registry.search": [{ versionId: "version-1" }],
    "registry.info": { versionId: "version-1", secret: "never-return-this" },
    "registry.inventory": [{ packageName: "calendar" }],
    "extension.list": [],
    "growth.configuration.get": {
      reflectionEnabled: true,
      adoptionMode: "review",
      governanceDecisionId: "decision-growth-0001",
      activatedAt: "2026-07-22T00:00:00.000Z",
    },
    "growth.memories": [
      {
        memoryVersionId: "memory-0001",
        revision: 3,
        entries: [
          {
            key: "verification-required",
            kind: "procedure",
            value: "검증 근거를 남긴다",
            authority: "explicit",
          },
        ],
      },
    ],
    "growth.suggestions": [
      {
        suggestionId: "suggestion-0001",
        workId: "work-0001",
        targetKind: "memory",
        operation: "add-entry",
        summary: "검증 근거 보강",
        rationale: "기록된 검증 누락을 줄이기 위해",
        expectedEffect: "검증 계보 보강",
        riskSummary: "검토 필요",
        status: "awaiting-review",
      },
    ],
    "growth.effects": [{ effectEvaluationId: "effect-0001", adoptionId: "adoption-0001", result: "improved" }],
  };
  Object.assign(data, overrides);
  const query = vi.fn(async (operation: string) => result(operation, data[operation]));
  const command = vi.fn(async (input: unknown) => {
    const value = input as { commandId: string; correlationId: string; operation: string };
    return {
      schemaVersion: "massion.application.v1",
      commandId: value.commandId,
      correlationId: value.correlationId,
      operation: value.operation,
      outcome: "succeeded",
      ...(value.operation === "run.start" ? { data: { runId: "run-new-0001", status: "ready" } } : {}),
      ...(value.operation === "approval.decide"
        ? { data: { approvalId: "approval-0001", status: "approved", revision: 4 } }
        : {}),
      ...(value.operation === "registry.install"
        ? { outcome: "awaiting-approval", data: { approvalId: "approval-install-1" } }
        : {}),
    };
  });
  const loginCodex = vi.fn(async () => ({ status: "ready" }));
  return {
    bootstrap: async () => ({ connection: { status: "connected" } }),
    query,
    command,
    loginCodex,
    startStream: async () => async () => undefined,
  };
}

describe("Application desktop service", () => {
  it("개발 화면은 번들 공식 확장을 마켓플레이스 목록으로 제공한다", async () => {
    const capabilities = await createFixtureDesktopService().loadCapabilities();

    expect(capabilities.extensions).toEqual([]);
    expect(capabilities.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: "@massion-ext/slack", packageVersion: "1.0.0" }),
        expect.objectContaining({ packageName: "@massion-ext/github", packageVersion: "1.0.0" }),
        expect.objectContaining({ packageName: "@massion-ext/discord", packageVersion: "1.0.0" }),
      ]),
    );
  });

  it("없는 fixture Work 조회는 동기 throw 없이 rejected Promise를 반환한다", async () => {
    const promise = createFixtureDesktopService().loadWork("없는-id");
    await expect(promise).rejects.toThrow("Fixture Work를 찾을 수 없습니다");
  });

  it("fixture 재개는 차단을 풀고 다음 단계로 옮긴다", async () => {
    const service = createFixtureDesktopService();
    const blocked = await service.loadWork("partner-contract");
    expect(blocked.run).toMatchObject({ status: "blocked", stage: "evidence", leaseGeneration: 1 });

    await service.resumeRun(blocked);

    const resumed = await service.loadWork("partner-contract");
    expect(resumed.run).toEqual({
      runId: "run-partner",
      status: "ready",
      stage: "delivery",
      leaseGeneration: 2,
    });
  });

  it("fixture 취소는 실행을 terminal로 보낸다", async () => {
    const service = createFixtureDesktopService();
    const work = await service.loadWork("partner-contract");

    await service.cancelRun(work);

    const cancelled = await service.loadWork("partner-contract");
    expect(cancelled.run).toMatchObject({ status: "cancelled", stage: "terminal" });
  });

  it("fixture 지시는 활동 흐름에 남는다", async () => {
    const service = createFixtureDesktopService();
    const work = await service.loadWork("churn-q3");

    await service.submitDirective(work, "코호트를 계약 규모별로도 나눠줘", "next-stage");

    const updated = await service.loadWork("churn-q3");
    expect(updated.activities).toHaveLength(work.activities.length + 1);
    expect(updated.activities.at(-1)).toMatchObject({
      kind: "message",
      author: "사용자",
      human: true,
      content: "코호트를 계약 규모별로도 나눠줘",
    });
  });

  it("fixture 상태 변경은 서비스 인스턴스 밖으로 새지 않는다", async () => {
    const changed = createFixtureDesktopService();
    await changed.cancelRun(await changed.loadWork("partner-contract"));

    const fresh = await createFixtureDesktopService().loadWork("partner-contract");
    expect(fresh.run).toMatchObject({ status: "blocked" });
  });

  it("fixture 설정과 새 Work 상태는 서비스 인스턴스마다 독립적이다", async () => {
    const changed = createFixtureDesktopService();
    await changed.registerProvider({
      providerId: "isolated-provider",
      displayName: "격리 제공자",
      adapterKind: "test",
    });
    await changed.startWork({ text: "격리된 Work", workspaceId: "workspace-analytics" });

    const fresh = createFixtureDesktopService();
    expect(JSON.stringify(await changed.loadSettings())).toContain("isolated-provider");
    expect(JSON.stringify(await fresh.loadSettings())).not.toContain("isolated-provider");
    await expect(fresh.loadWork("work-fixture-0001")).rejects.toThrow("Fixture Work를 찾을 수 없습니다");
  });

  it("fixture Provider·route 설정 명령은 재조회에 반영하고 secret을 보존하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const before = await service.loadSettings();
    const credential = (before.credentials as Array<{ credentialId: string }>).find(
      (item) => item.credentialId === "credential-zai",
    );
    if (!credential) throw new Error("fixture credential이 필요합니다");

    await service.registerProvider({
      providerId: "fixture-provider",
      displayName: "Fixture Provider",
      adapterKind: "openai-compatible",
    });
    await service.registerEndpoint({
      providerId: "fixture-provider",
      name: "api",
      baseUrl: "https://fixture.example/v1",
      local: false,
    });
    await service.addCredential({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider",
      label: "기본 키",
      credentialType: "api_key",
      secret: "fixture-api-secret",
      priority: 0,
      weight: 100,
    });
    await service.registerEndpoint({
      providerId: "fixture-provider",
      name: "backup",
      baseUrl: "https://fixture.example/backup",
      local: false,
    });
    await service.addCredential({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider-backup",
      label: "기본 키",
      credentialType: "api_key",
      secret: "fixture-backup-secret",
      priority: 1,
      weight: 50,
    });
    await service.connectZaiCodingPlan({ alias: "개인 Coding Plan", secret: "fixture-secret" });
    await service.disableCredential(credential.credentialId, 1);
    await service.registerModel({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider",
      modelId: "glm-fixture",
      routeKind: "reasoning",
      contextWindow: 128_000,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "reasoning",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1,
      outputCostMicrosPerMillion: 2,
      verified: true,
      token: "model-token",
    });
    await service.configureRoute({
      name: "Fixture 추론",
      routeKind: "reasoning",
      credentialPolicy: "required",
      dataPolicy: "cloud",
      equivalenceGroup: "reasoning",
      minEvalScore: 0.9,
      requireTools: true,
      requireStructuredOutput: false,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 128_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
      secret: "route-secret",
    });
    await service.addRouteCandidate({
      routeId: "route-fixture-",
      modelProfileId: "mp-glm-fixture",
      priority: 0,
      token: "candidate-token",
    });
    await service.configureSubscriptionPolicy({
      providerId: "zai-coding-plan",
      credentialPolicy: "round-robin",
      approvalMode: "automatic",
      secret: "policy-secret",
    });

    const changed = await service.loadSettings();
    expect(JSON.stringify(changed)).toContain("glm-fixture");
    expect(JSON.stringify(changed)).toContain("Fixture Provider");
    expect(JSON.stringify(changed)).toContain("Fixture 추론");
    expect(JSON.stringify(changed)).toContain("round-robin");
    expect(JSON.stringify(changed)).toContain("개인 Coding Plan");
    expect(JSON.stringify(changed)).not.toContain("fixture-secret");
    expect(JSON.stringify(changed)).not.toContain("fixture-api-secret");
    expect(JSON.stringify(changed)).not.toContain("model-token");
    expect(JSON.stringify(changed)).not.toContain("route-secret");
    expect(JSON.stringify(changed)).not.toContain("candidate-token");
    expect(JSON.stringify(changed)).not.toContain("policy-secret");
    expect(changed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: credential.credentialId, status: "revoked" }),
        expect.objectContaining({ providerId: "fixture-provider", label: "기본 키", status: "active" }),
        expect.objectContaining({
          providerId: "fixture-provider",
          endpointId: "ep-fixture-provider-backup",
          label: "기본 키",
          status: "active",
        }),
      ]),
    );
    const fixtureCredentials = (
      changed.credentials as Array<{ credentialId: string; endpointId: string; status: string }>
    ).filter((item) => item.endpointId.startsWith("ep-fixture-provider"));
    const primaryCredential = fixtureCredentials.find((item) => item.endpointId === "ep-fixture-provider");
    const backupCredential = fixtureCredentials.find((item) => item.endpointId === "ep-fixture-provider-backup");
    if (!primaryCredential || !backupCredential) throw new Error("endpoint별 fixture credential이 필요합니다");
    expect(primaryCredential.credentialId).not.toBe(backupCredential.credentialId);
    await service.disableCredential(primaryCredential.credentialId, 1);
    expect(await service.loadSettings()).toMatchObject({
      credentials: expect.arrayContaining([
        expect.objectContaining({ credentialId: primaryCredential.credentialId, status: "revoked" }),
        expect.objectContaining({ credentialId: backupCredential.credentialId, status: "active" }),
      ]),
    });
    expect(changed.catalog).toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ providerId: "zai-coding-plan" })]),
      endpoints: expect.arrayContaining([expect.objectContaining({ providerId: "zai-coding-plan" })]),
    });
    expect(changed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: "credential-account-zai", label: "개인 Coding Plan" }),
      ]),
    );
    expect(changed.policy).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "configured", updatedAt: expect.any(String) })]),
    );
    const returnedModel = (changed.catalog as { models: Array<{ modelId: string }> }).models.find(
      (model) => model.modelId === "glm-fixture",
    );
    if (!returnedModel) throw new Error("반환된 fixture model이 필요합니다");
    returnedModel.modelId = "외부 mutation";
    expect(JSON.stringify(await service.loadSettings())).not.toContain("외부 mutation");
    await expect(service.disableCredential(credential.credentialId, 1)).rejects.toThrow("version");
    expect(JSON.stringify(await createFixtureDesktopService().loadSettings())).not.toContain("glm-fixture");
  });

  it("fixture router 저장은 참조와 중복을 거부한다", async () => {
    const service = createFixtureDesktopService();
    const model = {
      providerId: "zai",
      endpointId: "ep-zai",
      modelId: "glm-conflict",
      routeKind: "reasoning",
      contextWindow: 128_000,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "reasoning",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1,
      outputCostMicrosPerMillion: 2,
      verified: true,
    };
    await expect(service.registerModel({ ...model, endpointId: "없는-endpoint" })).rejects.toThrow("Endpoint");
    await service.registerModel(model);
    await expect(service.registerModel(model)).rejects.toThrow("중복");
    await expect(service.configureRoute({ name: "추론", routeKind: "reasoning" })).rejects.toThrow("중복");
    await expect(
      service.addRouteCandidate({ routeId: "없는-route", modelProfileId: "mp-glm-conflict", priority: 0 }),
    ).rejects.toThrow("Route");
    await expect(
      service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "없는-policy" }),
    ).rejects.toThrow("정책");
    await expect(
      service.configureSubscriptionPolicy({
        providerId: "zai-coding-plan",
        credentialPolicy: "adaptive",
        approvalMode: "없는-mode",
      }),
    ).rejects.toThrow("승인");
  });

  it("fixture subscription policy는 기존 mode와 provider 기본 mode를 따른다", async () => {
    const service = createFixtureDesktopService();

    await service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: [expect.objectContaining({ providerId: "zai-coding-plan", approvalMode: "deny" })],
    });
    await service.configureSubscriptionPolicy({
      providerId: "zai-coding-plan",
      credentialPolicy: "priority",
      approvalMode: "review",
    });
    await service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "weighted" });
    expect(await service.loadSettings()).toMatchObject({
      policy: [expect.objectContaining({ providerId: "zai-coding-plan", approvalMode: "review" })],
    });

    await service.configureSubscriptionPolicy({ providerId: "openai-codex", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: expect.arrayContaining([
        expect.objectContaining({ providerId: "openai-codex", approvalMode: "automatic" }),
      ]),
    });
    await service.configureSubscriptionPolicy({ providerId: "xai-grok-build", credentialPolicy: "adaptive" });
    await service.configureSubscriptionPolicy({ providerId: "manifest-없는-provider", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: expect.arrayContaining([
        expect.objectContaining({ providerId: "xai-grok-build", approvalMode: "deny" }),
        expect.objectContaining({ providerId: "manifest-없는-provider", approvalMode: "deny" }),
      ]),
    });
  });

  it("fixture explicit memory는 revision CAS로 재조회되고 반환 mutation이 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const memory = initial.memories[0];
    if (!memory) throw new Error("fixture explicit memory가 필요합니다");

    await service.putExplicitMemory({
      key: "fixture-rule",
      kind: "procedure",
      value: "재조회로 확인합니다",
      revision: memory.revision,
    });
    const updated = (await service.loadGrowth()).memories[0];
    expect(updated?.memoryVersionId).not.toBe(memory.memoryVersionId);
    expect(updated?.revision).toBe(memory.revision + 1);
    expect(updated?.entries).toContainEqual(expect.objectContaining({ key: "fixture-rule" }));
    await expect(
      service.putExplicitMemory({ key: "stale", kind: "fact", value: "거부", revision: memory.revision }),
    ).rejects.toThrow("precondition");
    await service.forgetExplicitMemory({ key: "fixture-rule", revision: updated?.revision ?? 0 });
    expect((await service.loadGrowth()).memories[0]).toMatchObject({ revision: memory.revision + 2 });

    const returnedEntry = updated?.entries[0];
    if (!returnedEntry) throw new Error("반환된 explicit memory entry가 필요합니다");
    (returnedEntry as { value: string }).value = "외부 mutation";
    expect((await service.loadGrowth()).memories[0]?.entries[0]?.value).not.toBe("외부 mutation");
    expect(JSON.stringify(await createFixtureDesktopService().loadGrowth())).not.toContain("fixture-rule");
  });

  it("fixture Growth 설정은 CAS 갱신 뒤 재조회되고 새 서비스에는 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const configuration = initial.configuration;
    if (!configuration?.version || !configuration.checksum)
      throw new Error("초기 Growth 설정 version과 checksum이 필요합니다");

    await service.configureGrowth({
      reflectionEnabled: false,
      adoptionMode: "auto",
      expectedVersion: configuration.version,
    });

    await expect(service.loadGrowth()).resolves.toMatchObject({
      configuration: {
        reflectionEnabled: false,
        adoptionMode: "auto",
        version: configuration.version + 1,
        governanceDecisionId: "decision-growth-fixture-2",
        activatedAt: expect.any(String),
      },
    });
    expect((await service.loadGrowth()).configuration?.checksum).not.toBe(configuration.checksum);
    await expect(
      service.configureGrowth({ reflectionEnabled: false, adoptionMode: "auto", expectedVersion: 0 }),
    ).rejects.toThrow("version");
    await expect(
      service.configureGrowth({
        reflectionEnabled: true,
        adoptionMode: "review",
        expectedVersion: configuration.version,
      }),
    ).rejects.toThrow("version");
    await service.configureGrowth({ reflectionEnabled: false, adoptionMode: "auto" });
    await expect(service.loadGrowth()).resolves.toMatchObject({
      configuration: { version: configuration.version + 2, governanceDecisionId: "decision-growth-fixture-3" },
    });

    await expect(createFixtureDesktopService().loadGrowth()).resolves.toMatchObject({
      configuration: { reflectionEnabled: true, adoptionMode: "review", version: configuration.version },
    });
  });

  it("fixture Growth 승인는 eligible 대기 제안을 observing으로 옮기고 stale 재요청을 막는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const suggestion = initial.suggestions.find((item) => item.suggestionId === "suggestion-cohort-guard");
    if (!suggestion?.revision) throw new Error("승인 대기 Growth 제안 revision이 필요합니다");
    expect(suggestion).toMatchObject({
      evaluation: { outcome: "eligible", inputHash: expect.any(String) },
      adoption: {
        status: "awaiting-review",
        approvalId: expect.any(String),
        evaluationRunId: suggestion.evaluation?.evaluationRunId,
        beforeChecksum: expect.any(String),
      },
    });
    await expect(
      service.approveGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision + 1,
        reason: "오래된 revision입니다",
      }),
    ).rejects.toThrow("revision");

    await service.approveGrowthSuggestion({
      suggestionId: suggestion.suggestionId,
      expectedRevision: suggestion.revision,
      reason: "평가와 대상 checksum을 확인했습니다",
    });

    const approved = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === suggestion.suggestionId,
    );
    expect(approved).toMatchObject({
      status: "adopted",
      revision: suggestion.revision,
      adoption: { status: "observing" },
    });
    expect(approved).not.toHaveProperty("decisionReason");
    expect(approved).not.toHaveProperty("decidedAt");
    expect(
      (await service.loadGrowth()).suggestions.filter((item) => item.status === "awaiting-review"),
    ).not.toContainEqual(expect.objectContaining({ suggestionId: suggestion.suggestionId }));
    await expect(
      service.approveGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision,
        reason: "같은 승인 재시도",
      }),
    ).rejects.toThrow("승인 대기");
  });

  it("fixture Growth 거절은 CAS 사유를 보존하고 새 서비스와 다른 제안에 영향을 주지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const suggestion = initial.suggestions.find((item) => item.suggestionId === "suggestion-quant-persist");
    if (!suggestion?.revision) throw new Error("거절할 Growth 제안 revision이 필요합니다");
    expect(suggestion).toMatchObject({ status: "evaluated" });
    expect(suggestion).not.toHaveProperty("adoption");

    await service.rejectGrowthSuggestion({
      suggestionId: suggestion.suggestionId,
      expectedRevision: suggestion.revision,
      reason: "관측 표본이 아직 부족합니다",
    });
    await expect(
      service.rejectGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision + 1,
        reason: "오래된 revision입니다",
      }),
    ).rejects.toThrow("revision");

    const rejected = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === suggestion.suggestionId,
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      revision: suggestion.revision,
      decisionReason: "관측 표본이 아직 부족합니다",
      decidedAt: expect.any(String),
    });
    expect(
      (await service.loadGrowth()).suggestions.find((item) => item.suggestionId === "suggestion-cohort-guard"),
    ).toMatchObject({
      status: "awaiting-review",
    });
    await expect(
      service.rejectGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision,
        reason: "다시 거절",
      }),
    ).rejects.toThrow("거절");
    expect(
      (await createFixtureDesktopService().loadGrowth()).suggestions.find(
        (item) => item.suggestionId === suggestion.suggestionId,
      ),
    ).toMatchObject({ status: "evaluated" });
  });

  it("fixture Growth 대기 제안 거절은 adoption도 rejected로 전이하고 계보를 보존한다", async () => {
    const service = createFixtureDesktopService();
    const initial = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === "suggestion-cohort-guard",
    );
    if (!initial?.revision || !initial.adoption || !initial.evaluation)
      throw new Error("대기 Growth 제안 계보가 필요합니다");

    await service.rejectGrowthSuggestion({
      suggestionId: initial.suggestionId,
      expectedRevision: initial.revision,
      reason: "현재 변경은 보류합니다",
    });

    const rejected = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === initial.suggestionId,
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      decisionReason: "현재 변경은 보류합니다",
      adoption: {
        status: "rejected",
        adoptionId: initial.adoption.adoptionId,
        evaluationRunId: initial.evaluation.evaluationRunId,
        evaluationInputHash: initial.adoption.evaluationInputHash,
      },
    });
  });

  it("fixture Growth 반환의 nested 계보 mutation은 같은 서비스와 새 서비스에 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const returned = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === "suggestion-cohort-guard",
    );
    if (!returned?.adoption || !returned.evaluation?.signals[0]) throw new Error("Growth nested 계보가 필요합니다");

    (returned.adoption as { status: string }).status = "observing";
    (returned.evaluation.signals[0] as { score: number }).score = 0;

    const reread = (await service.loadGrowth()).suggestions.find((item) => item.suggestionId === returned.suggestionId);
    const fresh = (await createFixtureDesktopService().loadGrowth()).suggestions.find(
      (item) => item.suggestionId === returned.suggestionId,
    );
    expect(reread?.adoption?.status).toBe("awaiting-review");
    expect(reread?.evaluation?.signals[0]?.score).toBe(0.75);
    expect(fresh?.adoption?.status).toBe("awaiting-review");
    expect(fresh?.evaluation?.signals[0]?.score).toBe(0.75);
  });

  it("fixture Growth 거절은 proposed와 evaluated 제안도 terminal 상태로 옮긴다", async () => {
    const service = createFixtureDesktopService();

    for (const suggestionId of ["suggestion-proposed-fixture", "suggestion-evaluated-fixture"]) {
      await service.rejectGrowthSuggestion({
        suggestionId,
        expectedRevision: 1,
        reason: "현재 범위에는 맞지 않습니다",
      });
    }

    const suggestions = await service.loadGrowth();
    expect(suggestions.suggestions.find((item) => item.suggestionId === "suggestion-proposed-fixture")).toMatchObject({
      status: "rejected",
      decisionReason: "현재 범위에는 맞지 않습니다",
    });
    expect(suggestions.suggestions.find((item) => item.suggestionId === "suggestion-evaluated-fixture")).toMatchObject({
      status: "rejected",
      decisionReason: "현재 범위에는 맞지 않습니다",
    });
  });

  it("fixture Growth 승인은 ineligible·종료·알 수 없는 제안을 거부한다", async () => {
    const service = createFixtureDesktopService();
    const reason = "승인 근거";

    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-quant-persist", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-target-drift-fixture", expectedRevision: 1, reason }),
    ).rejects.toThrow("checksum");
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-handoff-note", expectedRevision: 2, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-tone-brief", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "없는-suggestion", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.rejectGrowthSuggestion({ suggestionId: "없는-suggestion", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-cohort-guard", expectedRevision: 3, reason: " " }),
    ).rejects.toThrow("사유");
  });

  it("fixture startWork는 입력별 Work·실행 계보를 만들고 목록과 상세에서 다시 읽는다", async () => {
    const service = createFixtureDesktopService();
    const first = await service.startWork({ text: "ABC 첫 번째 계약 검토", workspaceId: "workspace-analytics" });
    const second = await service.startWork({ text: "두 번째 계약 검토", workspaceId: "workspace-ops" });

    expect(first.runId).not.toBe(second.runId);
    const works = await service.loadIndex({ filter: "active", search: "계약 검토" });
    expect(works.map((work) => work.id)).toEqual(["work-fixture-0001", "work-fixture-0002"]);
    await expect(service.loadIndex({ filter: "active", locale: "en", search: "ＡＢＣ" })).resolves.toHaveLength(1);
    await expect(service.loadWork("work-fixture-0001")).resolves.toMatchObject({
      title: "ABC 첫 번째 계약 검토",
      workspace: { name: "workspace-analytics", trusted: true },
      run: { runId: first.runId, status: "ready", stage: "intake", leaseGeneration: 0 },
      activeExecutionId: "execution-fixture-0001",
    });
    await expect(service.loadWork("work-fixture-0002")).resolves.toMatchObject({
      title: "두 번째 계약 검토",
      workspace: { name: "workspace-ops", trusted: true },
      run: { runId: second.runId, status: "ready", stage: "intake", leaseGeneration: 0 },
      activeExecutionId: "execution-fixture-0002",
    });
  });

  it("fixture 구독은 실행별 lifecycle을 비동기로 전달하고 중지·서비스 경계를 지킨다", async () => {
    const service = createFixtureDesktopService();
    const otherService = createFixtureDesktopService();
    const durable = vi.fn();
    const foreignDurable = vi.fn();
    const execution = vi.fn();
    const otherExecution = vi.fn();
    const stopDurable = await service.subscribeDurable(durable);
    const stopForeignDurable = await otherService.subscribeDurable(foreignDurable);
    const stopOtherExecution = await service.subscribeExecution("execution-fixture-0002", otherExecution);

    const first = await service.startWork({ text: "구독 Work" });
    await flushFixtureEvents();

    expect(durable).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "massion.application.event.v1",
        type: "work.created",
        resource: { type: "Work", id: "work-fixture-0001", revision: 1 },
      }),
    );
    const stopExecution = await service.subscribeExecution("execution-fixture-0001", execution);
    await flushFixtureEvents();

    expect(execution).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        executionId: "execution-fixture-0001",
        sequence: 1,
        kind: "lifecycle",
        summary: "started",
      }),
    );
    expect(execution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionId: "execution-fixture-0001",
        sequence: 2,
        kind: "lifecycle",
        summary: "finish",
      }),
    );
    expect(otherExecution).not.toHaveBeenCalled();
    expect(foreignDurable).not.toHaveBeenCalled();
    await expect(service.loadWork("work-fixture-0001")).resolves.toMatchObject({
      run: { runId: first.runId, status: "completed", stage: "terminal", leaseGeneration: 0 },
    });

    const durableCalls = durable.mock.calls.length;
    const executionCalls = execution.mock.calls.length;
    await stopDurable();
    await stopExecution();
    await service.startWork({ text: "중지 뒤 Work" });
    await flushFixtureEvents();

    expect(durable).toHaveBeenCalledTimes(durableCalls);
    expect(execution).toHaveBeenCalledTimes(executionCalls);
    await stopForeignDurable();
    await stopOtherExecution();
  });

  it("fixture 취소는 예약된 완료 lifecycle과 durable 완료 사건을 발행하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const durable = vi.fn();
    const execution = vi.fn();
    await service.subscribeDurable(durable);
    await service.startWork({ text: "취소 Work" });
    await flushFixtureEvents();
    const work = await service.loadWork("work-fixture-0001");

    await service.subscribeExecution("execution-fixture-0001", execution);
    await service.cancelRun(work);
    await flushFixtureEvents();

    await expect(service.loadWork(work.id)).resolves.toMatchObject({
      status: "cancelled",
      run: { status: "cancelled", stage: "terminal" },
    });
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ summary: "started" }));
    expect(execution).not.toHaveBeenCalledWith(expect.objectContaining({ summary: "finish" }));
    expect(durable).not.toHaveBeenCalledWith(expect.objectContaining({ type: "run.completed" }));
  });

  it("startWork 중 실행 구독도 lifecycle sequence를 한 번씩만 받는다", async () => {
    const service = createFixtureDesktopService();
    const received: unknown[] = [];

    const starting = service.startWork({ text: "경합 Work" });
    await service.subscribeExecution("execution-fixture-0001", (delta) => received.push(delta));
    await starting;
    await flushFixtureEvents();

    expect(received.map((delta) => (delta as { sequence: number }).sequence)).toEqual([1, 2]);
  });

  it("오래된 실행 중지는 새 구독자의 handler를 제거하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const staleStop = await service.subscribeExecution("execution-fixture-0001", vi.fn());
    await staleStop();
    const received: unknown[] = [];
    await service.subscribeExecution("execution-fixture-0001", (delta) => received.push(delta));
    await staleStop();

    await service.startWork({ text: "수명 격리 Work" });
    await flushFixtureEvents();

    expect(received.map((delta) => (delta as { sequence: number }).sequence)).toEqual([1, 2]);
  });

  it("fixture index 입력 평가 오류도 rejected Promise로 전달한다", async () => {
    const input = {
      get filter(): "active" {
        throw new Error("fixture input error");
      },
      search: "",
    };
    const promise = createFixtureDesktopService().loadIndex(input);
    await expect(promise).rejects.toThrow("fixture input error");
  });

  it("bootstrap이 연결되지 않은 상태를 오류로 처리하고 Native stream 이름을 UI 계약으로 변환한다", async () => {
    const native = transport();
    native.bootstrap = async () => ({ connection: { status: "initialization-required" } });
    native.startStream = vi.fn(async () => async () => undefined);
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });
    const durableHandler = vi.fn();
    const executionHandler = vi.fn();

    expect(service.initialSnapshot).toBeUndefined();
    await expect(service.bootstrap()).rejects.toThrow("Desktop bootstrap 연결 상태가 유효하지 않습니다");
    await service.subscribeDurable(durableHandler, 12);
    await service.subscribeExecution("execution-0001", executionHandler);

    expect(native.startStream).toHaveBeenNthCalledWith(1, "events", { after: 12 }, durableHandler);
    expect(native.startStream).toHaveBeenNthCalledWith(
      2,
      "executions",
      { executionId: "execution-0001" },
      executionHandler,
    );
  });

  it("bootstrap 뒤 정규화한 search를 work.index payload에 전달하고 종료 Work를 완료 목록으로 분류한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.bootstrap()).resolves.toBe("ready");
    const [work] = await service.loadIndex({ filter: "active", locale: "en", search: "ＡＧＥＮＴ" });

    expect(native.query).toHaveBeenCalledWith("work.index", { search: "agent", limit: 50 });
    expect(work).toMatchObject({ updatedAt: "09:24", updatedAtIso: detail.updatedAt });
  });

  it("전역 Inbox를 하나의 typed Application 조회에서 투영한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const items = await (
      service as DesktopService & { loadInbox(): Promise<readonly { readonly kind: string; readonly id: string }[]> }
    ).loadInbox();

    expect(items).toMatchObject([
      {
        kind: "blocked",
        id: "blocked:run-inbox-0001",
        workId: detail.workId,
        title: detail.title,
      },
      {
        kind: "approval",
        id: "approval-0001",
        workTitle: detail.title,
        approval: { id: "approval-0001", revision: 3 },
      },
      {
        kind: "growth",
        id: "growth:suggestion-0001",
        suggestionId: "suggestion-0001",
        workTitle: detail.title,
      },
    ]);
    expect(native.query).toHaveBeenCalledWith("inbox.list", {});
    expect(native.query).not.toHaveBeenCalledWith("work.index", expect.anything());
    expect(native.query).not.toHaveBeenCalledWith("governance.approval.list", expect.anything());
    expect(native.query).not.toHaveBeenCalledWith("growth.suggestions", expect.anything());
  });

  it("개선 정책 변경은 조직 대상과 현재 version을 command에 전달한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await (
      service as DesktopService & {
        configureGrowth(input: {
          readonly reflectionEnabled: boolean;
          readonly adoptionMode: "review" | "auto";
          readonly expectedVersion?: number;
        }): Promise<void>;
      }
    ).configureGrowth({ reflectionEnabled: true, adoptionMode: "auto", expectedVersion: 1 });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.configure",
        payload: {
          subject: { type: "organization" },
          reflectionEnabled: true,
          adoptionMode: "auto",
          expectedVersion: 1,
        },
      }),
    );
  });

  it("개선 목록의 최근 50개 밖 대상은 suggestion ID exact 조회로 불러온다", async () => {
    const target = {
      suggestionId: "suggestion-exact-0051",
      workId: "work-0051",
      targetKind: "memory",
      operation: "add-entry",
      summary: "51번째 정확한 개선",
      rationale: "목록 밖 대상도 정확히 열어야 합니다",
      expectedEffect: "오선택 방지",
      riskSummary: "검토 필요",
      status: "awaiting-review",
    };
    const native = transport({ "growth.suggestion.get": target });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(
      (
        service as DesktopService & {
          loadGrowthSuggestion(suggestionId: string): Promise<typeof target>;
        }
      ).loadGrowthSuggestion(target.suggestionId),
    ).resolves.toEqual(target);
    expect(native.query).toHaveBeenCalledWith("growth.suggestion.get", { suggestionId: target.suggestionId });
  });

  it("조직 스냅샷에 노드나 버전이 없으면 빈 조직 화면용 데이터를 반환한다", async () => {
    const native = transport();
    native.query.mockImplementation(async (operation: string) =>
      result(operation, operation === "organization.graph.snapshot" ? {} : undefined),
    );
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadOrganization()).resolves.toEqual({ nodes: [] });
  });

  it("공개 조직 DTO의 ID·부모·범위·업무 소속을 화면 투영에 보존한다", async () => {
    const native = transport({
      "organization.graph.snapshot": {
        version: { version: 3 },
        nodes: [
          {
            node_id: "node-representative",
            handle: "representative",
            name: "Iris",
            responsibility: "사용자 요청 조정",
            status: "active",
            role: "orchestrator",
            capabilities: ["request-coordination"],
            scope: "persistent",
          },
          {
            node_id: "node-analysis",
            handle: "analysis",
            name: "Lyra",
            responsibility: "맥락 구성",
            parent_handle: "representative",
            status: "active",
            role: "coordinator",
            capabilities: ["analysis"],
            scope: "work",
            work_id: "work-0001",
          },
        ],
      },
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadOrganization()).resolves.toMatchObject({
      version: 3,
      nodes: [
        { id: "node-representative", scope: "persistent" },
        {
          id: "node-analysis",
          parentHandle: "representative",
          scope: "work",
          workId: "work-0001",
        },
      ],
    });
  });

  it("Work 선택 시 상세 투영을 독립 query로 병렬 조회한다", async () => {
    const native = transport({
      "organization.graph.snapshot": {
        version: { version: 1 },
        nodes: [
          {
            node_id: "node-evidence",
            handle: "evidence",
            name: "Evidence & Research",
            responsibility: "근거 조사, 출처 검증",
            status: "active",
            role: "operator",
            capabilities: ["evidence-research"],
            scope: "persistent",
          },
        ],
      },
      "work.executions": [
        {
          ...run,
          executionId: "execution-0001",
          agentHandle: "evidence",
          modelRoute: "coding/high",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          inputTokens: 120,
          outputTokens: 48,
          costMicros: 810,
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const work = await service.loadWork(detail.workId);

    expect(new Set(native.query.mock.calls.map(([operation]) => operation))).toEqual(
      new Set([
        "work.detail",
        "run.list",
        "work.activity.list",
        "work.tasks",
        "work.assignments",
        "work.executions",
        "work.artifacts",
        "work.verifications",
        "work.records",
        "governance.approval.list",
        "work.directive.list",
        "organization.graph.snapshot",
      ]),
    );
    expect(work).toMatchObject({
      id: detail.workId,
      revision: 7,
      run: { runId: run.runId },
      activeExecutionId: "execution-0001",
      updatedAt: "09:24",
      updatedAtIso: detail.updatedAt,
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      agents: [{ name: "Quill", initials: "Q", role: "근거 조사" }],
      records: [
        {
          id: "record-0001",
          version: 1,
          summary: "업무 결과와 검증 기록을 확정했습니다.",
          artifactVersionIds: ["artifact-version-0001"],
          verificationIds: ["verification-0001"],
          finalizedAt: "09:25",
        },
      ],
    });
    expect(work.activities.find((activity) => activity.kind === "approval")).toMatchObject({
      description: "승인 요청 · 09:00까지",
    });
  });

  it("실제 ISO 시각과 활동 종류를 사람이 읽는 Work 표시 모델로 투영한다", async () => {
    const native = transport({
      "work.tasks": [
        {
          workId: detail.workId,
          taskId: "task-actual",
          title: "실제 작업",
          status: "completed",
          revision: 2,
          updatedAt: "2026-07-31T02:25:41.005Z",
        },
        {
          workId: detail.workId,
          taskId: "task-fixture",
          title: "표시 시각 작업",
          status: "completed",
          revision: 2,
          updatedAt: "07.24",
        },
        {
          workId: detail.workId,
          taskId: "task-waiting",
          title: "선행 작업 대기",
          status: "blocked",
          revision: 1,
          updatedAt: "2026-07-31T02:25:42.000Z",
        },
        {
          workId: detail.workId,
          taskId: "task-failed",
          title: "실패한 작업",
          status: "failed",
          revision: 2,
          updatedAt: "2026-07-31T02:25:43.000Z",
        },
      ],
      "work.artifacts": [
        {
          artifactId: "artifact-actual",
          artifactVersionId: "artifact-version-actual",
          workId: detail.workId,
          name: "실제 산출물",
          kind: "task-output",
          version: 1,
          mediaType: "text/plain",
          checksum: "a".repeat(64),
          createdBy: "staff-actual",
          createdAt: "2026-07-31T02:25:40.977Z",
        },
      ],
      "work.records": [
        {
          recordId: "record-actual",
          version: 1,
          summary: "실제 기록",
          artifactIds: ["artifact-version-actual"],
          verificationIds: [],
          finalizedAt: "2026-07-31T02:26:18.579Z",
        },
      ],
      "work.activity.list": {
        items: [
          ["stage", "work", "업무가 접수되었습니다"],
          ["task", "task", "작업이 배정되었습니다"],
          ["artifact", "artifact", "산출물이 생성되었습니다"],
          ["verification", "verification", "독립 검증을 완료했습니다"],
          ["record", "record", "결과 기록을 확정했습니다"],
        ].map(([activityId, kind, title], index) => ({
          activityId,
          workId: detail.workId,
          kind,
          title,
          createdAt: `2026-07-31T02:2${String(index)}:00.000Z`,
        })),
      },
      "work.assignments": [],
    });

    const work = await createApplicationDesktopService(native).loadWork(detail.workId);

    expect(work.tasks).toMatchObject([
      { time: "11:25", createdAtIso: "2026-07-31T02:25:41.005Z" },
      { time: "07.24", createdAtIso: "07.24" },
      { state: "pending", time: "11:25" },
      { state: "failed", time: "11:25" },
    ]);
    expect(work.artifacts[0]).toMatchObject({
      createdAt: "11:25",
      createdAtIso: "2026-07-31T02:25:40.977Z",
    });
    expect(work.records[0]).toMatchObject({ finalizedAt: "11:26" });
    expect(work.activities.flatMap((activity) => (activity.kind === "event" ? [activity.semantic] : []))).toEqual([
      "stage",
      "task",
      "artifact",
      "verification",
      "record",
    ]);
    expect(work.activities.find((activity) => activity.kind === "plan")).toMatchObject({
      kind: "plan",
      title: "실행 계획",
      time: "11:25",
      steps: [
        { id: "task-actual", title: "실제 작업" },
        { id: "task-fixture", title: "표시 시각 작업" },
        { id: "task-waiting", title: "선행 작업 대기", state: "pending" },
        { id: "task-failed", title: "실패한 작업", state: "failed" },
      ],
    });
  });

  it("완료된 Work의 열린 협업방에서도 마지막 대표 답변을 최종 응답으로 표시한다", async () => {
    const native = transport({
      "work.detail": { ...detail, status: "completed" },
      "work.rooms": [
        {
          roomId: "room-core",
          workId: detail.workId,
          name: "Core Office",
          kind: "core-office",
          status: "active",
          coordinatorHandle: "representative",
          participantIds: ["representative"],
          lastMessageSequence: 1,
        },
      ],
      "work.shared-contexts": [],
      "work.messages": [
        {
          messageId: "message-final",
          sequence: 1,
          messageType: "answer",
          authorKind: "agent",
          authorId: "representative",
          content: "완료된 작업 결과입니다.",
          createdAt: "2026-07-31T02:26:18.602Z",
        },
      ],
    });

    const [room] = await createApplicationDesktopService(native).loadRooms(detail.workId);

    expect(room?.activities[0]).toMatchObject({ kind: "room", final: true });
    expect(native.query).toHaveBeenCalledWith("work.detail", { workId: detail.workId });
  });

  it("적용된 Staffing 제안의 모든 노드를 처리된 카드로 투영하고 일반 제안은 decision으로 유지한다", () => {
    const activities = projectRoomActivities(
      [
        {
          messageId: "message-applied-staffing",
          sequence: 1,
          messageType: "proposal",
          authorKind: "agent",
          authorId: "representative",
          content: "두 개의 Work 전용 Agent를 적용했습니다.",
          createdAt: "2026-07-31T02:20:00.000Z",
          staffingProposal: {
            proposalId: "proposal-applied",
            status: "applied",
            nodes: [
              {
                handle: "staff-analysis",
                name: "분석 담당",
                scope: "work",
                workId: detail.workId,
                parentHandle: "delivery-coordination",
                role: "operator",
                capabilities: ["analysis", "statistics"],
              },
              {
                handle: "staff-review",
                name: "검토 담당",
                scope: "work",
                workId: detail.workId,
                parentHandle: "assurance",
                role: "coordinator",
                capabilities: ["review"],
              },
            ],
            impactNodeHandles: ["delivery-coordination", "assurance"],
            impactReferenceCount: 3,
            fromOrganizationVersion: 12,
            toOrganizationVersion: 13,
          },
        },
        {
          messageId: "message-legacy-proposal",
          sequence: 2,
          messageType: "proposal",
          authorKind: "agent",
          authorId: "representative",
          content: "구조화 계보가 없는 기존 제안입니다.",
          createdAt: "2026-07-31T02:21:00.000Z",
        },
      ],
      [],
    );

    expect(activities[0]).toMatchObject({
      kind: "proposal",
      decided: true,
      content: "Work에 필요한 전문 Agent 2명을 구성하고 배치를 완료했습니다.",
      change: {
        nodes: [
          {
            handle: "staff-analysis",
            name: agentIdentityToken("staff-analysis").name,
            capabilities: ["analysis", "statistics"],
          },
          {
            handle: "staff-review",
            name: agentIdentityToken("staff-review").name,
            capabilities: ["review"],
          },
        ],
        impactNodes: 2,
        impactReferences: 3,
        impactHandles: ["delivery-coordination", "assurance"],
        fromVersion: 12,
        toVersion: 13,
      },
    });
    expect(activities[1]).toMatchObject({ kind: "room", messageType: "decision" });
  });

  it("완료된 Work에서도 canonical Core Office의 대표 답변만 최종 응답으로 표시한다", () => {
    const answer = {
      messageId: "message-final",
      sequence: 1,
      messageType: "answer" as const,
      authorKind: "agent" as const,
      authorId: "representative",
      content: "최종 결과입니다.",
      createdAt: "2026-07-31T02:26:18.602Z",
    };
    const room = {
      workId: detail.workId,
      roomId: "room-core",
      name: "Core Office",
      kind: "core-office",
      status: "active",
      participantIds: ["representative"],
      lastMessageSequence: 1,
      coordinatorHandle: "representative",
    };

    const core = projectRoom(room, [answer], [], [], "completed");
    const auxiliary = projectRoom(
      { ...room, roomId: "room-review", name: "검증 협업방", coordinatorHandle: "assurance" },
      [answer],
      [],
      [],
      "completed",
    );

    expect(core.activities[0]).toMatchObject({ kind: "room", final: true });
    expect(auxiliary.activities[0]).toMatchObject({ kind: "room" });
    expect(auxiliary.activities[0]).not.toHaveProperty("final");
  });

  it("UUID 사용자는 사람으로, 종료된 동적 Agent는 저장된 Agent 이름으로 표시한다", () => {
    const userId = "00000000-0000-4000-8000-000000000000";
    const dynamicAgentId = "dynamic-staff-8";
    const room = projectRoom(
      {
        workId: detail.workId,
        roomId: "room-participant-kinds",
        name: "Core Office",
        kind: "core-office",
        status: "closed",
        participantIds: [userId, dynamicAgentId],
        participants: [
          { subjectId: userId, kind: "user" },
          { subjectId: dynamicAgentId, kind: "agent" },
        ],
        lastMessageSequence: 0,
      },
      [],
      [],
    );

    expect(room.participants[0]).toMatchObject({ handle: userId, name: "나", role: "사람", human: true });
    expect(room.participants[0]?.name).not.toBe("Haven");
    expect(room.participants[1]).toMatchObject({ handle: dynamicAgentId, name: "Brook" });
    expect(room.participants[1]).not.toHaveProperty("human");
  });

  it("같은 UUID의 손상된 user·agent 중복도 각각 저장된 종류대로 표시한다", () => {
    const subjectId = "00000000-0000-4000-8000-000000000000";
    const room = projectRoom(
      {
        workId: detail.workId,
        roomId: "room-duplicate-participant-kinds",
        name: "Core Office",
        kind: "core-office",
        status: "closed",
        participantIds: [subjectId, subjectId],
        participants: [
          { subjectId, kind: "agent" },
          { subjectId, kind: "user" },
        ],
        lastMessageSequence: 0,
      },
      [],
      [],
    );

    expect(room.participants[0]).toMatchObject({ handle: subjectId, name: "Haven" });
    expect(room.participants[0]).not.toHaveProperty("human");
    expect(room.participants[1]).toMatchObject({ handle: subjectId, name: "나", human: true });
  });

  it("여러 실행의 실제 모델이 다르면 Work 모델을 단정하지 않는다", async () => {
    const native = transport({
      "work.executions": [
        {
          executionId: "execution-openai",
          workId: detail.workId,
          agentHandle: "staff-research",
          modelRoute: "coding/high",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          status: "completed",
          inputTokens: 120,
          outputTokens: 48,
          costMicros: 810,
        },
        {
          executionId: "execution-zai",
          workId: detail.workId,
          agentHandle: "staff-review",
          modelRoute: "coding/high",
          providerId: "zai",
          modelId: "glm-5.2",
          status: "completed",
          inputTokens: 120,
          outputTokens: 48,
          costMicros: 810,
        },
      ],
      "work.assignments": [],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const work = await service.loadWork(detail.workId);

    expect(work.providerId).toBeUndefined();
    expect(work.modelId).toBeUndefined();
    expect(work.agents.map((agent) => agent.name)).not.toContain("staff-research");
    expect(work.agents.map((agent) => agent.name)).not.toContain("staff-review");
  });

  it("모델 계보가 없는 실행이 하나라도 있으면 Work 전체 모델을 단정하지 않는다", async () => {
    const native = transport({
      "work.executions": [
        {
          executionId: "execution-attributed",
          workId: detail.workId,
          agentHandle: "representative",
          modelRoute: "coding/high",
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          status: "completed",
          inputTokens: 120,
          outputTokens: 48,
          costMicros: 810,
        },
        {
          executionId: "execution-unattributed",
          workId: detail.workId,
          agentHandle: "assurance",
          modelRoute: "coding/high",
          status: "completed",
          inputTokens: 20,
          outputTokens: 8,
          costMicros: 100,
        },
      ],
      "work.assignments": [],
    });

    const work = await createApplicationDesktopService(native).loadWork(detail.workId);

    expect(work.providerId).toBeUndefined();
    expect(work.modelId).toBeUndefined();
  });

  it("실제 Work 산출물과 검증의 내부 식별자를 사람용 이름으로 투영한다", async () => {
    const taskId = "0b75e4fe-e3f1-4911-ba05-ea1eccea5a91";
    const native = transport({
      "work.tasks": [{ workId: detail.workId, taskId, title: "결과 생성", status: "completed", revision: 2 }],
      "work.artifacts": [
        {
          artifactId: "artifact-task-1",
          artifactVersionId: "artifact-version-task-1",
          workId: detail.workId,
          name: `task-${taskId}`,
          kind: "task-output",
          version: 1,
          mediaType: "application/json",
          checksum: "a".repeat(64),
          createdBy: "agent-1",
          createdAt: "2026-07-22T00:24:00.000Z",
        },
        {
          artifactId: "artifact-assurance-1",
          artifactVersionId: "artifact-version-assurance-1",
          workId: detail.workId,
          name: "assurance-dcc7fd56-8e0b-4677-8baa-247ef0cdcef7.json",
          kind: "verification-evidence",
          version: 1,
          mediaType: "application/vnd.massion.assurance-evidence+json",
          checksum: "b".repeat(64),
          createdBy: "assurance",
          createdAt: "2026-07-22T00:25:00.000Z",
        },
      ],
      "work.verifications": [
        {
          verificationId: "verification-1",
          workId: detail.workId,
          verifierId: "assurance",
          passed: true,
          criteria: [{ criterionKey: "exact-result", status: "passed" }],
          evidenceArtifactVersionIds: ["artifact-version-assurance-1", "opaque-missing-evidence"],
          createdAt: "2026-07-22T00:25:00.000Z",
        },
      ],
    });

    const work = await createApplicationDesktopService(native).loadWork(detail.workId);

    expect(work.artifacts.map((artifact) => artifact.name)).toEqual(["결과 생성 결과", "독립 검증 근거"]);
    expect(work.verifications).toEqual([
      expect.objectContaining({
        verifier: "독립 검증",
        criteria: [{ key: "exact-result", status: "passed" }],
        evidence: "독립 검증 근거 외 1개",
      }),
    ]);
  });

  it("Work의 사용한 지식에 실제 evidence 1-hop 관계와 ID·checksum 계보를 연결한다", async () => {
    const native = transport({
      "work.detail": { ...detail, workspaceId: "workspace-knowledge" },
      "work.knowledge": {
        workId: detail.workId,
        status: "ready",
        indexVersionId: "index-knowledge",
        snapshotChecksum: "b".repeat(64),
        evidenceBriefChecksum: "c".repeat(64),
        freshnessStatus: "fresh",
        evidenceBriefId: "brief-0001",
        references: [
          {
            referenceId: "symbol-order-total",
            kind: "symbol",
            relativePath: "src/order.ts",
            qualifiedName: "calculateTotal",
            startLine: 3,
            endLine: 6,
            contentHash: "a".repeat(64),
            nodeId: "symbol:symbol-order-total",
            provenance: {
              selection: "graph-neighbor",
              snapshotChecksum: "b".repeat(64),
              paths: [
                {
                  seed: {
                    referenceId: "symbol-tax-rate",
                    kind: "symbol",
                    symbolKey: "symbol-key-tax-rate",
                  },
                  relation: {
                    relationId: "relation-order-tax",
                    relationKey: "relation-key-order-tax",
                    kind: "calls",
                    sourceSymbolKey: "symbol-key-order-total",
                    targetSymbolKey: "symbol-key-tax-rate",
                    targetText: "resolveTaxRate",
                    resolved: true,
                    relativePath: "src/order.ts",
                    startLine: 5,
                  },
                },
              ],
            },
          },
        ],
      },
      "knowledge.links": [
        {
          node: {
            nodeId: "symbol:symbol-order-total",
            kind: "symbol",
            label: "calculateTotal",
            detail: "src/order.ts:3",
          },
          kind: "documents",
          direction: "outgoing",
        },
        {
          node: {
            nodeId: "symbol:symbol-tax-rate",
            kind: "symbol",
            label: "resolveTaxRate",
            detail: "src/tax.ts:8",
          },
          kind: "calls",
          direction: "outgoing",
          relationId: "relation-order-tax",
          relationKey: "relation-key-order-tax",
          sourceSymbolKey: "symbol-key-order-total",
          targetSymbolKey: "symbol-key-tax-rate",
          snapshotChecksum: "b".repeat(64),
          sourcePath: "src/order.ts",
          sourceLine: 5,
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadWorkKnowledge(detail.workId)).resolves.toMatchObject({
      status: "ready",
      workspaceId: "workspace-knowledge",
      references: [
        expect.objectContaining({
          relativePath: "src/order.ts",
          qualifiedName: "calculateTotal",
          nodeId: "symbol:symbol-order-total",
          relations: [
            expect.objectContaining({
              kind: "calls",
              direction: "outgoing",
              node: expect.objectContaining({ nodeId: "symbol:symbol-tax-rate", label: "resolveTaxRate" }),
              relationId: "relation-order-tax",
              snapshotChecksum: "b".repeat(64),
              sourcePath: "src/order.ts",
              sourceLine: 5,
            }),
          ],
        }),
      ],
    });
    expect(native.query).toHaveBeenCalledWith("work.detail", { workId: detail.workId });
    expect(native.query).toHaveBeenCalledWith("work.knowledge", { workId: detail.workId });
    expect(native.query).toHaveBeenCalledWith("knowledge.links", {
      workspaceId: "workspace-knowledge",
      nodeId: "symbol:symbol-order-total",
      indexVersionId: "index-knowledge",
      snapshotChecksum: "b".repeat(64),
      relationIds: ["relation-order-tax"],
    });
  });

  it("실제 지식 표면은 typed index·graph·links query를 호출하고 canonical DTO를 보존한다", async () => {
    const native = transport({
      "knowledge.index": {
        workspaceId: "workspace-knowledge",
        status: "ready",
        indexVersionId: "index-knowledge",
        fileCount: 2,
        symbolCount: 1,
        relationCount: 1,
        indexedAt: "2026-07-29T01:00:00.000Z",
        excluded: ["dist", "node_modules"],
      },
      "knowledge.graph": {
        lens: "work",
        nodes: [
          { nodeId: "work:work-alpha", kind: "work", label: "Alpha 점검", detail: "completed" },
          { nodeId: "work:work-zeta", kind: "work", label: "Zeta 점검", detail: "running" },
        ],
        edges: [
          {
            kind: "documents",
            sourceId: "work:work-alpha",
            targetId: "work:work-zeta",
            derivedVia: "src/payment.ts",
          },
        ],
      },
      "knowledge.links": [
        {
          node: {
            nodeId: "file:file-payment",
            kind: "file",
            label: "payment.ts",
            detail: "src/payment.ts",
            group: "src",
          },
          kind: "documents",
          direction: "outgoing",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadKnowledgeIndex("workspace-knowledge")).resolves.toMatchObject({
      status: "ready",
      indexVersionId: "index-knowledge",
      excluded: ["dist", "node_modules"],
    });
    await expect(service.loadKnowledgeGraph("workspace-knowledge", "work")).resolves.toMatchObject({
      lens: "work",
      nodes: [{ nodeId: "work:work-alpha" }, { nodeId: "work:work-zeta" }],
      edges: [{ kind: "documents", derivedVia: "src/payment.ts" }],
    });
    await expect(service.loadKnowledgeLinks("workspace-knowledge", "work:work-alpha")).resolves.toMatchObject([
      { node: { nodeId: "file:file-payment" }, kind: "documents", direction: "outgoing" },
    ]);
    expect(native.query).toHaveBeenCalledWith("knowledge.index", { workspaceId: "workspace-knowledge" });
    expect(native.query).toHaveBeenCalledWith("knowledge.graph", {
      workspaceId: "workspace-knowledge",
      lens: "work",
    });
    expect(native.query).toHaveBeenCalledWith("knowledge.links", {
      workspaceId: "workspace-knowledge",
      nodeId: "work:work-alpha",
    });
  });

  it("실제 지식 투영은 6개 렌즈의 정상 empty state를 validation 오류로 바꾸지 않는다", async () => {
    for (const lens of ["work", "document", "file", "symbol", "artifact", "agent"] as const) {
      const native = transport({ "knowledge.graph": { lens, nodes: [], edges: [] } });
      const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

      await expect(service.loadKnowledgeGraph("workspace-knowledge", lens)).resolves.toEqual({
        lens,
        nodes: [],
        edges: [],
      });
      expect(native.query).toHaveBeenCalledWith("knowledge.graph", { workspaceId: "workspace-knowledge", lens });
    }
  });

  it("실제 지식 투영은 손상된 상태·렌즈·노드·dangling edge를 빈 그래프로 숨기지 않는다", async () => {
    const invalidIndex = createApplicationDesktopService(
      transport({
        "knowledge.index": {
          workspaceId: "workspace-knowledge",
          status: "complete",
          fileCount: 0,
          symbolCount: 0,
          relationCount: 0,
          excluded: [],
        },
      }),
    );
    const mismatchedGraph = createApplicationDesktopService(
      transport({
        "knowledge.graph": {
          lens: "file",
          nodes: [{ nodeId: "work:work-alpha", kind: "work", label: "Alpha", secret: "must-not-pass" }],
          edges: [],
        },
      }),
    );
    const danglingGraph = createApplicationDesktopService(
      transport({
        "knowledge.graph": {
          lens: "work",
          nodes: [{ nodeId: "work:work-alpha", kind: "work", label: "Alpha" }],
          edges: [{ kind: "documents", sourceId: "work:work-alpha", targetId: "work:missing" }],
        },
      }),
    );
    const invalidLinks = createApplicationDesktopService(
      transport({
        "knowledge.links": [
          {
            node: { nodeId: "file:file-payment", kind: "file", label: "payment.ts" },
            kind: "documents",
            direction: "sideways",
          },
        ],
      }),
    );

    await expect(invalidIndex.loadKnowledgeIndex("workspace-knowledge")).rejects.toThrow();
    await expect(mismatchedGraph.loadKnowledgeGraph("workspace-knowledge", "work")).rejects.toThrow();
    await expect(danglingGraph.loadKnowledgeGraph("workspace-knowledge", "work")).rejects.toThrow();
    await expect(invalidLinks.loadKnowledgeLinks("workspace-knowledge", "file:file-payment")).rejects.toThrow();
  });

  it("영속 Work 지시의 대기·반영 시점·revision을 pending control과 상태 기록에 정직하게 투영한다", async () => {
    const directive = (
      directiveId: string,
      status: "queued" | "applying" | "applied" | "failed" | "unapplied",
      mode: "now" | "next-stage",
      submittedStage: string,
      revision: number,
    ) => ({
      directiveId,
      workId: detail.workId,
      runId: run.runId,
      sequence: Number(directiveId.at(-1)),
      content: `${directiveId} 지시`,
      mode,
      submittedStage,
      status,
      revision,
      createdAt: `2026-07-22T00:2${directiveId.at(-1)}:00.000Z`,
      updatedAt: `2026-07-22T00:3${directiveId.at(-1)}:00.000Z`,
    });
    const native = transport({
      "run.list": [{ ...run, stage: "delivery" }],
      "work.directive.list": [
        directive("directive-1", "queued", "now", "delivery", 0),
        directive("directive-2", "queued", "next-stage", "delivery", 0),
        directive("directive-3", "queued", "next-stage", "evidence", 0),
        directive("directive-4", "applying", "now", "delivery", 2),
        directive("directive-5", "applied", "now", "delivery", 1),
        directive("directive-6", "unapplied", "next-stage", "delivery", 0),
        directive("directive-7", "failed", "now", "delivery", 1),
      ],
    });

    const work = await createApplicationDesktopService(native).loadWork(detail.workId);

    expect(work.queuedDirectives).toEqual([
      {
        id: "directive-1",
        content: "directive-1 지시",
        status: "queued",
        mode: "now",
        submittedStage: "delivery",
        applyAt: "current-stage",
        revision: 0,
      },
      {
        id: "directive-2",
        content: "directive-2 지시",
        status: "queued",
        mode: "next-stage",
        submittedStage: "delivery",
        applyAt: "next-stage",
        revision: 0,
      },
      {
        id: "directive-3",
        content: "directive-3 지시",
        status: "queued",
        mode: "next-stage",
        submittedStage: "evidence",
        applyAt: "current-stage",
        revision: 0,
      },
      {
        id: "directive-4",
        content: "directive-4 지시",
        status: "applying",
        mode: "now",
        submittedStage: "delivery",
        applyAt: "current-stage",
        revision: 2,
      },
    ]);
    expect(
      work.activities
        .filter((activity) => activity.id.startsWith("directive:"))
        .map((activity) => ({ kind: activity.kind, status: activity.kind === "event" ? activity.status : undefined })),
    ).toEqual([
      { kind: "event", status: "대기" },
      { kind: "event", status: "대기" },
      { kind: "event", status: "대기" },
      { kind: "event", status: "반영 중" },
      { kind: "event", status: "반영됨" },
      { kind: "event", status: "미반영 종료" },
      { kind: "event", status: "반영 실패" },
    ]);
  });

  it("현재 run과 종료 Work 상태 및 병합 활동의 시간순을 보존한다", async () => {
    const native = transport({
      "work.detail": { ...detail, status: "failed" },
      "run.list": [
        { ...run, runId: "run-finished", status: "completed", updatedAt: "2026-07-22T00:30:00.000Z" },
        { ...run, runId: "run-current", status: "running", updatedAt: "2026-07-22T00:20:00.000Z" },
      ],
      "work.activity.list": {
        items: [
          {
            activityId: "activity-new",
            workId: detail.workId,
            kind: "message",
            title: "새 활동",
            authorKind: "user",
            authorId: "db06753b-4495-44e0-b16b-c17b9081aa0d",
            createdAt: "2026-07-22T00:30:00.000Z",
          },
          {
            activityId: "activity-old",
            workId: detail.workId,
            kind: "message",
            title: "이전 활동",
            authorKind: "agent",
            authorId: "db06753b-4495-44e0-b16b-c17b9081aa0d",
            createdAt: "2026-07-22T00:10:00.000Z",
          },
        ],
      },
      "work.directive.list": [
        {
          directiveId: "directive-1",
          workId: detail.workId,
          runId: run.runId,
          content: "중간 지시",
          createdAt: "2026-07-22T00:20:00.000Z",
        },
      ],
      "work.artifacts": [
        {
          artifactVersionId: "artifact-version-1",
          artifactId: "artifact-1",
          workId: detail.workId,
          name: "결과.txt",
          kind: "text",
          mediaType: "text/plain",
          checksum: "a".repeat(64),
          version: 1,
          createdAt: "2026-07-22T00:40:00.000Z",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const work = await service.loadWork(detail.workId);

    expect(work).toMatchObject({ status: "failed", run: { runId: "run-current", status: "running" } });
    expect(work.activities.map((activity) => activity.id)).toEqual([
      "plan:current",
      "activity-old",
      "directive:directive-1",
      "activity-new",
      "artifacts:current",
      "approval:approval-0001",
    ]);
    expect(work.activities.map((activity) => activity.time)).toEqual(["", "09:10", "09:20", "09:30", "09:40", "09:00"]);
    expect(work.activities.map((activity) => activity.occurredAt)).toEqual([
      undefined,
      "2026-07-22T00:10:00.000Z",
      "2026-07-22T00:20:00.000Z",
      "2026-07-22T00:30:00.000Z",
      "2026-07-22T00:40:00.000Z",
      "2026-07-23T00:00:00.000Z",
    ]);
    expect(work.activities.find((activity) => activity.id === "activity-old")).toMatchObject({
      kind: "message",
      author: expect.not.stringContaining("db06753b"),
      human: false,
    });
    expect(work.activities.find((activity) => activity.id === "activity-new")).toMatchObject({
      kind: "message",
      author: "나",
      human: true,
    });
  });

  it("Application API의 blockedDetail을 Desktop run model까지 그대로 투영한다", async () => {
    const native = transport({
      "run.list": [
        {
          ...run,
          status: "blocked",
          stage: "assurance",
          blockedReason: "assurance-verifier-rejected",
          blockedDetail: "산출물의 모순을 보완해야 합니다.",
        },
      ],
    });
    const service = createApplicationDesktopService(native);

    await expect(service.loadWork(detail.workId)).resolves.toMatchObject({
      run: {
        status: "blocked",
        stage: "assurance",
        blockedReason: "assurance-verifier-rejected",
        blockedDetail: "산출물의 모순을 보완해야 합니다.",
      },
    });
  });

  it("지시·승인·run 제어에 실제 식별자와 revision을 보낸다", async () => {
    const native = transport();
    let id = 0;
    const service = createApplicationDesktopService(native, {
      createId: () => `request-${String(++id).padStart(4, "0")}`,
    });
    const work = await service.loadWork(detail.workId);
    const approval = work.approvals[0];
    if (!approval) throw new Error("승인 fixture가 없습니다");

    await service.submitDirective(work, "산업군별 이탈률도 분리해줘", "next-stage");
    await service.decideApproval(approval, "approve", "데스크톱에서 검토 완료");
    await service.cancelRun(work);
    await service.resumeRun({ ...work, run: { ...run, status: "blocked" } });

    const commands = native.command.mock.calls.map(([input]) => input);
    expect(commands).toEqual([
      expect.objectContaining({
        operation: "work.directive.submit",
        expectedRevision: 7,
        payload: {
          workId: detail.workId,
          runId: run.runId,
          content: "산업군별 이탈률도 분리해줘",
          mode: "next-stage",
        },
      }),
      expect.objectContaining({
        operation: "approval.decide",
        payload: {
          approvalId: "approval-0001",
          expectedApprovalRevision: 3,
          vote: "approve",
          reason: "데스크톱에서 검토 완료",
        },
      }),
      expect.objectContaining({ operation: "run.cancel", payload: { runId: run.runId } }),
      expect.objectContaining({
        operation: "run.resume",
        payload: { runId: run.runId, retryBlocked: true },
      }),
    ]);
  });

  it("Approval 결정의 최종 status·revision을 반환하고 긴급 정지는 terminal approved 뒤에만 해제한다", async () => {
    const native = transport();
    let approvalStatus: "pending" | "approved" = "pending";
    native.command.mockImplementation(async (input: unknown) => {
      const value = input as { commandId: string; correlationId: string; operation: string };
      return {
        schemaVersion: "massion.application.v1",
        commandId: value.commandId,
        correlationId: value.correlationId,
        operation: value.operation,
        outcome: "succeeded",
        ...(value.operation === "approval.decide"
          ? {
              data: {
                approvalId: "approval-emergency",
                status: approvalStatus,
                revision: approvalStatus === "pending" ? 4 : 5,
              },
            }
          : {}),
      } as never;
    });
    const service = createApplicationDesktopService(native, { createId: () => crypto.randomUUID() });
    const approval = {
      id: "approval-emergency",
      title: "긴급 정지 해제",
      description: "두 명의 승인이 필요합니다.",
      action: "emergency.stop.disable",
      status: "pending",
      revision: 3,
    };

    await expect(service.decideApproval(approval, "approve", "첫 번째 투표")).resolves.toEqual({
      approvalId: "approval-emergency",
      status: "pending",
      revision: 4,
    });
    expect(
      native.command.mock.calls.some(
        ([input]) => (input as { operation?: string }).operation === "governance.emergency.release",
      ),
    ).toBe(false);

    approvalStatus = "approved";
    await expect(service.decideApproval({ ...approval, revision: 4 }, "approve", "두 번째 투표")).resolves.toEqual({
      approvalId: "approval-emergency",
      status: "approved",
      revision: 5,
    });
    expect(
      native.command.mock.calls.filter(
        ([input]) => (input as { operation?: string }).operation === "governance.emergency.release",
      ),
    ).toHaveLength(1);
  });

  it("새 Work 요청을 desktop surface의 run.start로 시작한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(
      service.startWork({ text: "파트너 계약 위험을 검토해줘", workspaceId: "workspace-0001" }),
    ).resolves.toEqual({
      runId: "run-new-0001",
    });
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "run.start",
        payload: {
          request: {
            outputLocale: "en",
            text: "파트너 계약 위험을 검토해줘",
            surface: "desktop",
            workspaceId: "workspace-0001",
          },
        },
      }),
    );
  });

  it("Workspace 유무별 Work team 표시값은 내부 ID를 노출하지 않는다", async () => {
    const native = transport({
      "work.index": {
        items: [{ ...detail }, { ...detail, workId: "work-0002", workspaceId: "workspace-secret-0001" }],
      },
    });
    const service = createApplicationDesktopService(native);

    await expect(service.loadIndex({ filter: "active", search: "" })).resolves.toEqual([
      expect.objectContaining({ team: "Massion" }),
      expect.objectContaining({ team: "워크스페이스" }),
    ]);
  });

  it("잘못된 workspace 목록 항목을 runtime 경계에서 거부한다", async () => {
    const service = createApplicationDesktopService(
      transport({ "workspace.list": [{ workspaceId: "workspace-invalid" }] }),
    );

    await expect(service.loadWorkspaces()).rejects.toThrow("Workspace 응답이 유효하지 않습니다");
  });

  it("Settings 읽기와 변경 command가 실제 operation을 사용하며 secret을 view에 노출하지 않는다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const settings = await service.loadSettings();
    await service.addCredential({
      providerId: "openai",
      endpointId: "endpoint-1",
      label: "기본",
      credentialType: "api-key",
      secret: "input-only",
      priority: 1,
      weight: 1,
    });
    await service.configureRoute({ name: "default", routeKind: "chat" });

    expect(JSON.stringify(settings)).not.toContain("never-return-this");
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining([
        "router.catalog",
        "router.credentials",
        "router.routes",
        "subscription.providers",
        "subscription.accounts",
        "subscription.quota",
        "subscription.policy",
      ]),
    );
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "router.credential.add",
        payload: expect.objectContaining({ secret: "input-only" }),
      }),
    );
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "router.route.configure", payload: { name: "default", routeKind: "chat" } }),
    );
  });

  it("Codex 로그인 뒤 native 연결을 다시 열어 갱신된 local access를 사용한다", async () => {
    const native = transport();
    const bootstrap = vi.spyOn(native, "bootstrap");
    const service = createApplicationDesktopService(native);

    await service.loginSubscription({ providerId: "openai-codex", alias: "OpenAI Codex", newAccount: true });

    expect(native.loginCodex).toHaveBeenCalledWith({ alias: "OpenAI Codex", newAccount: true });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("권한 조회에 실제 자가개선 설정과 동시성 version을 함께 투영한다", async () => {
    const native = transport({
      "governance.autonomy": {
        mode: "automatic",
        revision: 3,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
      },
      "growth.configuration.get": {
        reflectionEnabled: true,
        adoptionMode: "review",
        version: 4,
        governanceDecisionId: "decision-growth-0004",
        activatedAt: "2026-07-22T00:00:00.000Z",
      },
    });

    await expect(createApplicationDesktopService(native).loadAutonomy()).resolves.toMatchObject({
      mode: "automatic",
      revision: 3,
      growthMode: "review",
      growthReflectionEnabled: true,
      growthConfigurationVersion: 4,
    });
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining(["governance.autonomy", "growth.configuration.get"]),
    );
  });

  it("실제 Desktop service가 최근 모델 호출 기록을 조회하고 사람용 view로 투영한다", async () => {
    const native = transport({
      "router.attempts": [
        {
          attemptId: "attempt-live-1",
          at: "2026-07-30T01:00:00.000Z",
          routeId: "route-reasoning",
          modelProfileId: "mp-gpt-coding",
          modelId: "gpt-coding",
          providerId: "openai",
          optimizationRunId: "optimization-run-live-1",
          optimizationBatchId: "batch-live-1",
          status: "interrupted",
          failureClass: "network",
          inputTokens: 13,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          costMicros: 21,
          fallbackFrom: "attempt-live-0",
          workId: "work-0001",
          workTitle: "고객 이탈 원인 분석",
          credentialSecretVersion: 9,
          explanation: "never-return-this",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const attempts = await service.loadRouteAttempts();

    expect(native.query).toHaveBeenCalledWith("router.attempts", { limit: 50 });
    expect(attempts).toEqual([
      {
        attemptId: "attempt-live-1",
        at: "2026-07-30T01:00:00.000Z",
        routeId: "route-reasoning",
        modelProfileId: "mp-gpt-coding",
        modelId: "gpt-coding",
        providerId: "openai",
        optimizationRunId: "optimization-run-live-1",
        optimizationBatchId: "batch-live-1",
        status: "interrupted",
        failureClass: "network",
        inputTokens: 13,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costMicros: 21,
        fallbackFrom: "attempt-live-0",
        workId: "work-0001",
        workTitle: "고객 이탈 원인 분석",
      },
    ]);
    expect(JSON.stringify(attempts)).not.toContain("never-return-this");
  });

  it("모델 호출 기록 응답이 손상되면 호출 없음으로 숨기지 않는다", async () => {
    const service = createApplicationDesktopService(
      transport({ "router.attempts": [{ attemptId: "attempt-malformed" }] }),
    );

    await expect(service.loadRouteAttempts()).rejects.toThrow("Route Attempt");
  });

  it("모델 호출 기록 시각은 canonical ISO instant만 허용한다", () => {
    const attempt = (at: unknown) => ({
      attemptId: "attempt-time",
      at,
      routeId: "route-1",
      modelProfileId: "mp-gpt",
      modelId: "gpt",
      providerId: "openai",
      status: "succeeded",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costMicros: 1,
    });

    expect(() => projectRouteAttempts([attempt(0)])).toThrow("at");
    expect(() => projectRouteAttempts([attempt("2026-02-30T00:00:00.000Z")])).toThrow("at");
    expect(() => projectRouteAttempts([attempt(new Date(Number.NaN))])).toThrow("at");
    expect(projectRouteAttempts([attempt("2026-07-30T01:02:03.004Z")])).toMatchObject([
      { at: "2026-07-30T01:02:03.004Z" },
    ]);
  });

  it("등록이 제거된 모델의 호출 기록은 이름 없이 남기고 목록 전체를 죽이지 않는다", () => {
    // Provider를 두 번 제거하면 route_attempt는 남고 model_profile은 지워집니다(2026-08-09 이전 동작).
    // 그 한 행 때문에 던지면 예산 표면이 통째로 오류가 되고, 조용히 빼면 지출 합계가 틀려집니다.
    const removed = {
      attemptId: "attempt-orphan",
      at: "2026-07-30T01:02:03.004Z",
      routeId: "route-1",
      modelProfileId: "mp-removed",
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costMicros: 42,
    };

    const projected = projectRouteAttempts([removed]);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ attemptId: "attempt-orphan", modelProfileId: "mp-removed", costMicros: 42 });
    expect(projected[0]?.modelId).toBeUndefined();
    expect(projected[0]?.providerId).toBeUndefined();
  });

  it("Capabilities registry 조회·설치 결과에서 awaiting-approval 식별자를 보존한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.searchRegistry("calendar")).resolves.toEqual([{ versionId: "version-1" }]);
    await expect(service.loadRegistryInfo("version-1")).resolves.toEqual({ versionId: "version-1" });
    await expect(service.loadCapabilities()).resolves.toEqual({
      extensions: [],
      inventory: [{ packageName: "calendar" }],
    });
    await expect(
      service.installRegistry({
        versionId: "version-1",
        environment: "production",
        riskClass: "medium",
        executionId: "execution-1",
      }),
    ).resolves.toEqual({ outcome: "awaiting-approval", approvalId: "approval-install-1" });
    expect(native.query).toHaveBeenCalledWith("registry.search", { query: "calendar", limit: 20 });
    expect(native.query).toHaveBeenCalledWith("registry.info", { versionId: "version-1" });
    expect(native.query).toHaveBeenCalledWith("registry.inventory", {});
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "registry.install",
        payload: { versionId: "version-1", environment: "production", riskClass: "medium", executionId: "execution-1" },
      }),
    );
  });

  it("승인 대기 Registry 설치는 같은 명령·상관관계 식별자와 승인 ID로 재개한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "generated-id" });
    const request = {
      versionId: "version-1",
      environment: "production",
      riskClass: "medium",
      executionId: "execution-1",
    };
    const identity = { commandId: "registry-install-command-1", correlationId: "registry-install-correlation-1" };

    await service.installRegistry(request, identity);
    await service.installRegistry({ ...request, installApprovalId: "approval-install-1" }, identity);

    expect(native.command).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandId: "registry-install-command-1",
        correlationId: "registry-install-correlation-1",
        operation: "registry.install",
        payload: request,
      }),
    );
    expect(native.command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandId: "registry-install-command-1",
        correlationId: "registry-install-correlation-1",
        operation: "registry.install",
        payload: { ...request, installApprovalId: "approval-install-1" },
      }),
    );
  });

  it("성장 기록은 기존 읽기 전용 query 네 개로만 조회한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect((service as DesktopService & { loadGrowth(): Promise<unknown> }).loadGrowth()).resolves.toMatchObject({
      configuration: { governanceDecisionId: "decision-growth-0001" },
      memories: [{ memoryVersionId: "memory-0001", revision: 3, entries: [{ key: "verification-required" }] }],
      suggestions: [{ status: "awaiting-review" }],
      effects: [{ result: "improved" }],
    });
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining(["growth.configuration.get", "growth.memories", "growth.suggestions", "growth.effects"]),
    );
  });

  it("개선 상세의 거절은 revision과 사유를 typed command로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.rejectGrowthSuggestion({
      suggestionId: "suggestion-0001",
      expectedRevision: 2,
      reason: "현재 근거가 부족합니다",
    });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.suggestion.reject",
        payload: {
          suggestionId: "suggestion-0001",
          expectedRevision: 2,
          reason: "현재 근거가 부족합니다",
        },
      }),
    );
  });

  it("경로 예산 한도는 지출을 리셋하지 않는 전용 명령으로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.setRouteBudget({ routeId: "route-1", requestBudgetMicros: 1_000, totalBudgetMicros: 50_000 });

    // router.route.configure를 쓰면 새 route_id가 생기고 spent_micros가 0으로 돌아갑니다.
    // 한도를 못 거는 것보다 나쁜 상태라 전용 명령을 씁니다.
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "router.route.budget.set",
        payload: { routeId: "route-1", requestBudgetMicros: 1_000, totalBudgetMicros: 50_000 },
      }),
    );
  });

  it("조직 편성은 Organization Version을 낙관적 잠금으로 실어 typed command로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.applyOrganizationChange({
      expectedVersion: 7,
      change: {
        kind: "create",
        handle: "refund-analysis",
        name: "환불 분석",
        responsibility: "환불 지연 구간 조사",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      },
    });

    // 조직 화면이 읽기 전용이던 이유가 이 명령이 타입 계약에 없어서였습니다. CLI만 부를 수 있었습니다.
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "organization.command",
        expectedRevision: 7,
        payload: expect.objectContaining({ kind: "create", handle: "refund-analysis" }),
      }),
    );
  });

  it("개선 상세의 승인은 revision과 사유를 typed command로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.approveGrowthSuggestion({
      suggestionId: "suggestion-0001",
      expectedRevision: 2,
      reason: "평가와 대상 checksum을 확인했습니다",
    });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.suggestion.approve",
        payload: {
          suggestionId: "suggestion-0001",
          expectedRevision: 2,
          reason: "평가와 대상 checksum을 확인했습니다",
        },
      }),
    );
  });
});
