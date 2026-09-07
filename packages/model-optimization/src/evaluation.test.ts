import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { ModelOptimizationStore, type ModelEvaluationExecutor, type OptimizationModelProfile } from "./evaluation.js";
import {
  MODEL_OPTIMIZATION_HARDENING_MIGRATION,
  MODEL_OPTIMIZATION_MIGRATION,
  MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION,
} from "./schema.js";

const checksum = (letter: string) => letter.repeat(64);

describe("Massion 모델 평가실", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let store: ModelOptimizationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "optimization@example.com",
      displayName: "Optimization",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await ModelOptimizationStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("평가 bundle·run·receipt를 checksum과 함께 append-only로 저장한다", async () => {
    const bundle = await store.createBundle(context, {
      commandId: "bundle-1",
      roleKey: "context-strategy",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "plan",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "run-1",
      roleKey: "context-strategy",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-sol",
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    const receipt = await store.completeEvaluation(context, {
      commandId: "receipt-1",
      runId: run.runId,
      sampleCount: 10,
      qualityScore: 0.92,
      latencyMs: 200,
      costMicros: 12,
      privacyAllowed: true,
      completed: true,
    });

    expect(bundle.version).toBe(1);
    expect(run.status).toBe("running");
    expect(receipt).toMatchObject({
      runId: run.runId,
      modelProfileId: "profile-sol",
      bundleId: bundle.bundleId,
      sampleCount: 10,
    });
    await expect(
      store.completeEvaluation(context, {
        commandId: "receipt-1",
        runId: run.runId,
        sampleCount: 1,
        qualityScore: 0.1,
        latencyMs: 1,
        costMicros: 1,
        privacyAllowed: true,
        completed: true,
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("같은 role의 세 번째 bundle도 transaction 안에서 가장 큰 version 다음에 생성한다", async () => {
    for (let index = 1; index <= 3; index += 1) {
      const bundle = await store.createBundle(context, {
        commandId: `bundle-versioning-${String(index)}`,
        roleKey: "assurance",
        runtimeVersion: "runtime-versioning",
        cases: [
          {
            promptChecksum: checksum(String(index)),
            toolsChecksum: checksum("b"),
            environmentChecksum: checksum("c"),
            expectedOutcome: "pass",
          },
        ],
      });
      expect(bundle.version).toBe(index);
    }
  });

  it("기본 review 정책에서는 추천 승인 전 batch를 활성화하지 않고 shadow를 차단한다", async () => {
    const profile = (id: string): OptimizationModelProfile => ({
      modelProfileId: id,
      modelId: id,
      routeId: `route-${id}`,
      providerId: "openai-codex",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    });
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [profile("profile-quality")],
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-review",
      roleKey: "assurance",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "verify",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "run-review",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-quality",
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    await store.completeEvaluation(context, {
      commandId: "receipt-review",
      runId: run.runId,
      sampleCount: 5,
      qualityScore: 0.95,
      latencyMs: 100,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "recommend-review",
      roleKey: "assurance",
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });
    expect(recommendation.status).toBe("pending-approval");
    await expect(
      store.startEvaluation(context, {
        commandId: "shadow-blocked",
        roleKey: "assurance",
        bundleId: bundle.bundleId,
        modelProfileId: "profile-quality",
        runtimeVersion: "runtime-1",
        inputChecksum: checksum("e"),
        mode: "shadow",
      }),
    ).rejects.toThrow("shadow");
  });

  it("고정된 평가 case를 실행하고 shadow에서는 모든 정본 변경 capability를 차단한다", async () => {
    const execute = vi.fn<ModelEvaluationExecutor["execute"]>(async (input) => ({
      qualityScore: input.case.expectedOutcome === "first" ? 0.8 : 1,
      latencyMs: input.case.expectedOutcome === "first" ? 100 : 300,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
      inputTokens: 20,
      outputTokens: 10,
    }));
    store = await ModelOptimizationStore.create(database, organizations, {
      executor: { execute },
    });
    await store.configurePolicy(context, {
      commandId: "policy-shadow",
      policy: "quality",
      autoOptimize: false,
      productionLearning: false,
      shadowEnabled: true,
      governanceDecisionId: "decision-shadow",
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-execute",
      roleKey: "assurance",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "first",
        },
        {
          promptChecksum: checksum("d"),
          toolsChecksum: checksum("e"),
          environmentChecksum: checksum("f"),
          expectedOutcome: "second",
        },
      ],
    });

    const receipt = await store.executeEvaluation(context, {
      commandId: "execute-shadow",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-shadow",
      runtimeVersion: "runtime-1",
      mode: "shadow",
    });

    expect(receipt).toMatchObject({
      roleKey: "assurance",
      modelProfileId: "profile-shadow",
      sampleCount: 2,
      qualityScore: 0.9,
      latencyMs: 200,
      costMicros: 20,
      privacyAllowed: true,
      completed: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([input]) => input.mode === "shadow")).toBe(true);
    expect(
      execute.mock.calls.every(
        ([input]) =>
          input.capabilities.write === false &&
          input.capabilities.message === false &&
          input.capabilities.deployment === false &&
          input.capabilities.approval === false &&
          input.capabilities.organizationMutation === false,
      ),
    ).toBe(true);
  });

  it("T1 로컬 bench는 서버가 계산한 비용·Provider·데이터 고지를 확인한 뒤 같은 값을 receipt에 고정한다", async () => {
    const execute = vi.fn<ModelEvaluationExecutor["execute"]>(async () => ({
      qualityScore: 1,
      latencyMs: 25,
      costMicros: 3,
      privacyAllowed: true,
      completed: true,
    }));
    const profile: OptimizationModelProfile = {
      modelProfileId: "profile-preflight",
      modelId: "model-preflight",
      routeId: "route-preflight",
      providerId: "provider-preflight",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      contextWindow: 32_000,
      maximumCostMicrosPerCall: 250,
      dataPolicy: "external-allowed",
    };
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [profile],
      executor: { execute },
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-preflight",
      roleKey: "assurance",
      runtimeVersion: "runtime-preflight",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "first",
        },
        {
          promptChecksum: checksum("d"),
          toolsChecksum: checksum("e"),
          environmentChecksum: checksum("f"),
          expectedOutcome: "second",
        },
      ],
    });
    const preflight = await store.previewEvaluation(context, {
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      runtimeVersion: "runtime-preflight",
    });
    expect(preflight).toMatchObject({
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      expectedCallCount: 2,
      maximumCostMicros: 500,
      providerId: "provider-preflight",
      dataKinds: ["evaluation-prompt"],
    });
    await expect(
      store.executeEvaluation(context, {
        commandId: "execute-preflight-stale",
        roleKey: "assurance",
        bundleId: bundle.bundleId,
        modelProfileId: profile.modelProfileId,
        runtimeVersion: "runtime-preflight",
        preflightChecksum: checksum("0"),
      }),
    ).rejects.toThrow("실행 전 고지");
    expect(execute).not.toHaveBeenCalled();

    const receipt = await store.executeEvaluation(context, {
      commandId: "execute-preflight",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      runtimeVersion: "runtime-preflight",
      preflightChecksum: preflight.checksum,
    });
    expect(receipt.evidence).toEqual({
      tier: "t1-local",
      sourceVersion: "runtime-preflight",
      configurationChecksum: preflight.configurationChecksum,
      disclosure: {
        expectedCallCount: 2,
        maximumCostMicros: 500,
        providerId: "provider-preflight",
        dataKinds: ["evaluation-prompt"],
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("축 신호가 완전한 평가 실행은 불변 receipt와 축별 점수를 함께 기록한다", async () => {
    let profileBVerified = true;
    store = await ModelOptimizationStore.create(database, organizations, {
      executor: {
        execute: async (input) => ({
          qualityScore: input.modelProfileId === "profile-a" ? 0.4 : 0.9,
          latencyMs: input.modelProfileId === "profile-a" ? 10 : 20,
          costMicros: 1,
          privacyAllowed: true,
          completed: true,
        }),
      },
      modelCatalog: async () => [
        {
          modelProfileId: "profile-a",
          modelId: "model-a",
          routeId: "route-a",
          providerId: "provider",
          verified: true,
          supportsStructuredOutput: true,
          supportsTools: true,
          supportsStreaming: true,
          dataPolicy: "external-allowed",
        },
        {
          modelProfileId: "profile-b",
          modelId: "model-b",
          routeId: "route-b",
          providerId: "provider",
          verified: profileBVerified,
          supportsStructuredOutput: true,
          supportsTools: true,
          supportsStreaming: true,
          dataPolicy: "external-allowed",
        },
      ],
    });
    await store.configurePolicy(context, {
      commandId: "axis-policy",
      policy: "quality",
      autoOptimize: true,
      productionLearning: false,
      shadowEnabled: false,
      minimumSampleCount: 1,
      governanceDecisionId: "axis-decision",
    });
    const bundle = await store.createBundle(context, {
      commandId: "axis-bundle",
      roleKey: "assurance",
      runtimeVersion: "runtime-axis",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "first",
          taskAxis: "code-understanding",
          reasoningDifficulty: "high",
        },
      ],
    });
    const receiptA = await store.executeEvaluation(context, {
      commandId: "axis-execute-a",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-a",
      runtimeVersion: "runtime-axis",
    });
    const receiptB = await store.executeEvaluation(context, {
      commandId: "axis-execute-b",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-b",
      runtimeVersion: "runtime-axis",
    });
    const [scores] = await database.query<
      [Array<{ readonly receipt_id: string; readonly model_profile_id: string; readonly task_axis: string }>]
    >(
      "SELECT receipt_id, model_profile_id, task_axis FROM optimization_receipt_axis_score WHERE organization_id = $organization_id ORDER BY model_profile_id ASC;",
      { organization_id: context.organizationId },
    );
    expect(scores).toEqual([
      { receipt_id: receiptA.receiptId, model_profile_id: "profile-a", task_axis: "code-understanding" },
      { receipt_id: receiptB.receiptId, model_profile_id: "profile-b", task_axis: "code-understanding" },
    ]);
    const recommendation = await store.recommend(context, {
      commandId: "axis-recommendation",
      roleKey: "assurance",
      requirements: {
        requiresTools: false,
        requiresStructuredOutput: false,
        requiresStreaming: false,
        dataPolicy: "external-allowed",
      },
    });
    const select = () =>
      store.selectTaskAxisModels(context, {
        roleKey: "assurance",
        recommendationId: recommendation.recommendationId,
        modelProfileIds: ["profile-a", "profile-b"],
        taskAxis: "code-understanding",
        reasoningDifficulty: "high",
      });
    expect(recommendation.status).toBe("approved");
    await expect(select()).resolves.toEqual({
      modelProfileIds: ["profile-b", "profile-a"],
      receiptIds: [receiptB.receiptId, receiptA.receiptId],
      bundleId: bundle.bundleId,
      bundleVersion: bundle.version,
    });
    await expect(
      database.query(
        "UPDATE optimization_receipt_axis_score SET quality_score = 0 WHERE organization_id = $organization_id AND receipt_id = $receipt_id;",
        { organization_id: context.organizationId, receipt_id: receiptA.receiptId },
      ),
    ).rejects.toThrow("immutable");

    await database.query("REMOVE EVENT optimization_receipt_immutable ON TABLE optimization_receipt;");
    for (const [field, value, original] of [
      ["run_id", "mismatched-run", receiptA.runId],
      ["role_key", "growth", "assurance"],
      ["model_profile_id", "mismatched-profile", "profile-a"],
      ["bundle_id", "mismatched-bundle", bundle.bundleId],
      ["bundle_version", bundle.version + 1, bundle.version],
    ] as const) {
      await database.query(
        `UPDATE optimization_receipt SET ${field} = $value WHERE organization_id = $organization_id AND receipt_id = $receipt_id;`,
        { organization_id: context.organizationId, receipt_id: receiptA.receiptId, value },
      );
      await expect(select()).resolves.toBeUndefined();
      await database.query(
        `UPDATE optimization_receipt SET ${field} = $value WHERE organization_id = $organization_id AND receipt_id = $receipt_id;`,
        { organization_id: context.organizationId, receipt_id: receiptA.receiptId, value: original },
      );
    }
    await database.query(
      "UPDATE optimization_recommendation SET status = 'pending-approval' WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id;",
      { organization_id: context.organizationId, recommendation_id: recommendation.recommendationId },
    );
    await expect(select()).resolves.toBeUndefined();

    await database.query(
      "UPDATE optimization_recommendation SET status = 'rejected' WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id;",
      { organization_id: context.organizationId, recommendation_id: recommendation.recommendationId },
    );
    await expect(select()).resolves.toBeUndefined();

    await database.query(
      "UPDATE optimization_recommendation SET status = 'approved' WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id;",
      { organization_id: context.organizationId, recommendation_id: recommendation.recommendationId },
    );
    profileBVerified = false;
    await expect(select()).resolves.toBeUndefined();

    profileBVerified = true;
    await database.query(
      "DELETE optimization_receipt WHERE organization_id = $organization_id AND receipt_id = $receipt_id;",
      { organization_id: context.organizationId, receipt_id: receiptA.receiptId },
    );
    await expect(select()).resolves.toBeUndefined();
  });

  it("축별 점수가 없는 legacy bundle은 선택 API에서 역할 baseline으로 되돌린다", async () => {
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [
        {
          modelProfileId: "profile-legacy",
          modelId: "model-legacy",
          routeId: "route-legacy",
          providerId: "provider",
          verified: true,
          supportsStructuredOutput: true,
          supportsTools: true,
          supportsStreaming: true,
          dataPolicy: "external-allowed",
        },
      ],
    });
    await store.configurePolicy(context, {
      commandId: "legacy-axis-policy",
      policy: "quality",
      autoOptimize: false,
      productionLearning: false,
      shadowEnabled: false,
      minimumSampleCount: 1,
      governanceDecisionId: "legacy-axis-decision",
    });
    const bundle = await store.createBundle(context, {
      commandId: "legacy-axis-bundle",
      roleKey: "assurance",
      runtimeVersion: "runtime-legacy",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "pass",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "legacy-axis-run",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-legacy",
      runtimeVersion: "runtime-legacy",
      inputChecksum: checksum("d"),
    });
    await store.completeEvaluation(context, {
      commandId: "legacy-axis-receipt",
      runId: run.runId,
      sampleCount: 1,
      qualityScore: 0.8,
      latencyMs: 10,
      costMicros: 1,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "legacy-axis-recommendation",
      roleKey: "assurance",
      requirements: {
        requiresTools: false,
        requiresStructuredOutput: false,
        requiresStreaming: false,
        dataPolicy: "external-allowed",
      },
    });
    await expect(
      store.selectTaskAxisModels(context, {
        roleKey: "assurance",
        recommendationId: recommendation.recommendationId,
        modelProfileIds: ["profile-legacy"],
        taskAxis: "code-understanding",
        reasoningDifficulty: "high",
      }),
    ).resolves.toBeUndefined();
  });

  it("후보를 생략하면 연결된 model catalog에서만 추천 후보를 읽는다", async () => {
    const profile: OptimizationModelProfile = {
      modelProfileId: "catalog-profile",
      modelId: "catalog-model",
      routeId: "catalog-route",
      providerId: "openai-codex",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    };
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [profile],
    });
    const bundle = await store.createBundle(context, {
      commandId: "catalog-bundle",
      roleKey: "representative",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "respond",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "catalog-run",
      roleKey: "representative",
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    await store.completeEvaluation(context, {
      commandId: "catalog-receipt",
      runId: run.runId,
      sampleCount: 3,
      qualityScore: 0.9,
      latencyMs: 100,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "catalog-recommendation",
      roleKey: "representative",
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });
    expect(recommendation.primaryModelProfileId).toBe(profile.modelProfileId);
  });

  it("조직이 자동 최적화를 명시하면 충분한 receipt의 추천을 승인 상태로 만든다", async () => {
    const profile: OptimizationModelProfile = {
      modelProfileId: "auto-profile",
      modelId: "auto-model",
      routeId: "auto-route",
      providerId: "local-provider",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    };
    store = await ModelOptimizationStore.create(database, organizations, { modelCatalog: async () => [profile] });
    await store.configurePolicy(context, {
      commandId: "policy-auto",
      policy: "quality",
      autoOptimize: true,
      productionLearning: false,
      shadowEnabled: false,
      governanceDecisionId: "decision-auto",
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-auto",
      roleKey: "assurance",
      runtimeVersion: "runtime-auto",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "pass",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "run-auto",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      runtimeVersion: "runtime-auto",
      inputChecksum: checksum("d"),
    });
    const receipt = await store.completeEvaluation(context, {
      commandId: "receipt-auto",
      runId: run.runId,
      sampleCount: 3,
      qualityScore: 0.95,
      latencyMs: 100,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "recommend-auto",
      roleKey: "assurance",
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });

    expect(recommendation).toMatchObject({
      status: "approved",
      primaryModelProfileId: profile.modelProfileId,
      receiptIds: [receipt.receiptId],
    });
  });

  it("추천은 저장된 동일 bundle receipt만 사용한다", async () => {
    const profile = (modelProfileId: string): OptimizationModelProfile => ({
      modelProfileId,
      modelId: modelProfileId,
      routeId: `route-${modelProfileId}`,
      providerId: "provider",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    });
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [profile("profile-a"), profile("profile-b")],
    });
    const createReceipt = async (
      bundleCommandId: string,
      profileId: string,
      qualityScore: number,
    ): Promise<Awaited<ReturnType<typeof store.completeEvaluation>>> => {
      const bundle = await store.createBundle(context, {
        commandId: bundleCommandId,
        roleKey: "assurance",
        runtimeVersion: "runtime-1",
        cases: [
          {
            promptChecksum: checksum("a"),
            toolsChecksum: checksum("b"),
            environmentChecksum: checksum("c"),
            expectedOutcome: "pass",
          },
        ],
      });
      const run = await store.startEvaluation(context, {
        commandId: `${bundleCommandId}-run-${profileId}`,
        roleKey: "assurance",
        bundleId: bundle.bundleId,
        modelProfileId: profileId,
        runtimeVersion: "runtime-1",
        inputChecksum: checksum("d"),
      });
      return await store.completeEvaluation(context, {
        commandId: `${bundleCommandId}-receipt-${profileId}`,
        runId: run.runId,
        sampleCount: 3,
        qualityScore,
        latencyMs: 10,
        costMicros: 1,
        privacyAllowed: true,
        completed: true,
      });
    };

    await createReceipt("bundle-old", "profile-a", 1);
    const sharedA = await createReceipt("bundle-shared", "profile-a", 0.2);
    const sharedB = await createReceipt("bundle-shared", "profile-b", 0.9);
    const recommendation = await store.recommend(context, {
      commandId: "recommend-shared-bundle",
      roleKey: "assurance",
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });

    expect(recommendation).toMatchObject({
      primaryModelProfileId: "profile-b",
      fallbackModelProfileIds: ["profile-a"],
      receiptIds: [sharedA.receiptId, sharedB.receiptId].sort(),
    });
  });

  it("legacy receipt에 evaluation run bundle 계보를 보강하고 불변으로 다시 잠근다", async () => {
    await using legacyDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const organizationId = "organization-legacy";
    await applyMigrations(legacyDatabase, [MODEL_OPTIMIZATION_MIGRATION, MODEL_OPTIMIZATION_HARDENING_MIGRATION]);
    await legacyDatabase.query(
      "CREATE optimization_run CONTENT { run_id: 'run-legacy', organization_id: $organization_id, role_key: 'assurance', bundle_id: 'bundle-legacy', bundle_version: 1, model_profile_id: 'profile-legacy', runtime_version: 'runtime-legacy', mode: 'standard', status: 'completed', input_checksum: $checksum, command_id: 'run-command', request_hash: $checksum, created_by_user_id: 'user-legacy', created_at: time::now(), updated_at: time::now() };",
      { organization_id: organizationId, checksum: checksum("a") },
    );
    await legacyDatabase.query(
      "CREATE optimization_receipt CONTENT { receipt_id: 'receipt-legacy', run_id: 'run-legacy', organization_id: $organization_id, role_key: 'assurance', model_profile_id: 'profile-legacy', bundle_version: 1, sample_count: 3, quality_score: 0.9, latency_ms: 10, cost_micros: 1, privacy_allowed: true, completed: true, input_checksum: $checksum, receipt_checksum: $checksum, command_id: 'receipt-command', request_hash: $checksum, created_at: time::now() };",
      { organization_id: organizationId, checksum: checksum("a") },
    );

    await expect(
      applyMigrations(legacyDatabase, [MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION]),
    ).resolves.toEqual(["0126-model-optimization-receipt-bundle-lineage"]);
    await expect(
      applyMigrations(legacyDatabase, [MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION]),
    ).resolves.toEqual([]);
    const [receipts] = await legacyDatabase.query<[Array<{ bundle_id: string }>]>(
      "SELECT bundle_id FROM optimization_receipt WHERE organization_id = $organization_id AND receipt_id = 'receipt-legacy';",
      { organization_id: organizationId },
    );
    expect(receipts).toEqual([{ bundle_id: "bundle-legacy" }]);
    await expect(
      legacyDatabase.query(
        "UPDATE optimization_receipt SET quality_score = 0.1 WHERE organization_id = $organization_id AND receipt_id = 'receipt-legacy';",
        { organization_id: organizationId },
      ),
    ).rejects.toThrow("immutable");
    expect((await listAppliedMigrations(legacyDatabase)).map((migration) => migration.migration_id)).toContain(
      "0126-model-optimization-receipt-bundle-lineage",
    );
  });

  it("legacy receipt의 tenant 또는 평가 run 계보가 다르면 migration을 rollback한다", async () => {
    await using legacyDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    await applyMigrations(legacyDatabase, [MODEL_OPTIMIZATION_MIGRATION, MODEL_OPTIMIZATION_HARDENING_MIGRATION]);
    await legacyDatabase.query(
      "CREATE optimization_receipt CONTENT { receipt_id: 'receipt-orphan', run_id: 'run-missing', organization_id: 'organization-legacy', role_key: 'assurance', model_profile_id: 'profile-legacy', bundle_version: 1, sample_count: 3, quality_score: 0.9, latency_ms: 10, cost_micros: 1, privacy_allowed: true, completed: true, input_checksum: $checksum, receipt_checksum: $checksum, command_id: 'receipt-command', request_hash: $checksum, created_at: time::now() };",
      { checksum: checksum("a") },
    );

    await expect(
      applyMigrations(legacyDatabase, [MODEL_OPTIMIZATION_RECEIPT_BUNDLE_LINEAGE_MIGRATION]),
    ).rejects.toThrow("bundle 계보가 유효하지 않습니다");
    expect((await listAppliedMigrations(legacyDatabase)).map((migration) => migration.migration_id)).not.toContain(
      "0126-model-optimization-receipt-bundle-lineage",
    );
    await expect(
      legacyDatabase.query("UPDATE optimization_receipt SET quality_score = 0.1 WHERE receipt_id = 'receipt-orphan';"),
    ).rejects.toThrow("immutable");
  });

  it("정책에 실사용 관찰 예산과 보존 기간을 저장하고 범위를 검증한다", async () => {
    const policy = await store.configurePolicy(context, {
      commandId: "policy-retention",
      policy: "value",
      autoOptimize: false,
      productionLearning: true,
      shadowEnabled: false,
      observationBudgetMicros: 25_000,
      observationRetentionDays: 14,
      governanceDecisionId: "decision-retention",
    });
    expect(policy).toMatchObject({ observationBudgetMicros: 25_000, observationRetentionDays: 14 });
    await expect(
      store.configurePolicy(context, {
        commandId: "policy-invalid-budget",
        policy: "value",
        autoOptimize: false,
        productionLearning: true,
        shadowEnabled: false,
        observationBudgetMicros: 0,
        governanceDecisionId: "decision-invalid-budget",
      }),
    ).rejects.toThrow("예산");
  });
});
