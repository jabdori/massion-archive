import { ApplicationBootstrapCapability, ApplicationHttpClient } from "@massion/application";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseServerConfig } from "./config.js";
import { createMassionDaemon } from "./product.js";
import * as productModule from "./product.js";

const bootstrapCapability = Buffer.alloc(32, 72).toString("base64url");

describe("Massion server model optimization product boundary", () => {
  it("서버 시작은 GovernanceService 생성 전에 managed default 정책을 reconcile한다", async () => {
    const source = await readFile(new URL("./product.ts", import.meta.url), "utf8");
    const policyStore = source.indexOf("const policies = await PolicyStore.create(database, organizations)");
    const reconciliation = source.indexOf("await policies.reconcileManagedDefaultsAtStartup()", policyStore);
    const governanceService = source.indexOf("const governance = await GovernanceService.create", policyStore);

    expect(policyStore).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeGreaterThan(policyStore);
    expect(governanceService).toBeGreaterThan(reconciliation);
  });

  it("모델 최적화 acquire는 실행 context가 확정한 workspace access와 capability를 함께 전달한다", async () => {
    const source = await readFile(new URL("./product.ts", import.meta.url), "utf8");
    const start = source.indexOf("const workspace = await subscriptionExecutionContext.resolve");
    const end = source.indexOf("return await executeOptimizationCase", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const optimizationAcquire = source.slice(start, end);

    expect([
      optimizationAcquire.includes("workspaceAccess: workspace.workspaceAccess"),
      optimizationAcquire.includes("workspaceCapability: workspace.workspaceCapability"),
    ]).toEqual([true, true]);
  });

  it("활성 모델 batch resolver는 비어 있거나 비활성·다른 역할인 batch를 사용하지 않는다", () => {
    const resolve = (
      productModule as unknown as {
        modelPreferenceFromActiveBatch?: (
          roleKey: string | undefined,
          batch: Record<string, unknown> | undefined,
        ) => { readonly profileIds: readonly string[]; readonly batchId: string } | undefined;
      }
    ).modelPreferenceFromActiveBatch;
    expect(resolve).toEqual(expect.any(Function));
    const active = {
      batchId: "batch-assurance-1",
      organizationId: "organization-1",
      roleKey: "assurance",
      version: 1,
      recommendationId: "recommendation-1",
      policyVersionId: "policy-1",
      status: "active",
      primaryModelProfileId: "profile-primary",
      fallbackModelProfileIds: ["profile-fallback"],
      checksum: "a".repeat(64),
    };

    expect(resolve?.("assurance", active)).toEqual({
      profileIds: ["profile-primary", "profile-fallback"],
      batchId: "batch-assurance-1",
    });
    expect(
      resolve?.("assurance", { ...active, primaryModelProfileId: undefined, fallbackModelProfileIds: [] }),
    ).toBeUndefined();
    expect(resolve?.("assurance", { ...active, status: "limited" })).toBeUndefined();
    expect(resolve?.("growth", active)).toBeUndefined();
  });

  it("Task 신호가 있어도 축별 표본이 없으면 역할 baseline 선택 근거를 남긴다", () => {
    const receipt = (
      productModule as unknown as {
        placementReceiptForTask?: (task: Record<string, unknown>) => Record<string, unknown>;
      }
    ).placementReceiptForTask;
    expect(receipt).toEqual(expect.any(Function));
    expect(
      receipt?.({
        work_id: "work-axis-1",
        task_id: "task-axis-1",
        task_axis: "code-understanding",
        reasoning_difficulty: "high",
      }),
    ).toEqual({
      workId: "work-axis-1",
      taskId: "task-axis-1",
      taskAxis: "code-understanding",
      reasoningDifficulty: "high",
      selectionBasis: "role-baseline-task-axis-evidence-unavailable",
    });
    expect(receipt?.({ work_id: "work-legacy-1", task_id: "legacy-task-1" })).toEqual({
      workId: "work-legacy-1",
      taskId: "legacy-task-1",
      selectionBasis: "role-baseline-task-signal-missing",
    });
  });

  it("서버 bootstrap부터 실제 로컬 모델 평가·receipt·추천까지 연결한다", async () => {
    const modelServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "massion-evaluation-completion",
          object: "chat.completion",
          created: 1,
          model: "massion-evaluation-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "평가완료" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
      );
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");

    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-model-optimization-product-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 62).toString("base64url"),
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
        bootstrapAuthorization: new ApplicationBootstrapCapability({
          capability: Buffer.from(bootstrapCapability, "base64url"),
          expiresAt: Date.now() + 60_000,
        }),
      },
    );
    const address = await daemon.start();

    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "model-optimization-bootstrap-0001",
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
        })) as { outcome: string; data: Record<string, unknown> };

      await command("router.provider.register", {
        providerId: "local-evaluation",
        displayName: "Local Evaluation",
        adapterKind: "openai-compatible",
      });
      const endpoint = await command("router.endpoint.register", {
        providerId: "local-evaluation",
        name: "Evaluation API",
        baseUrl: `http://127.0.0.1:${String(modelAddress.port)}/v1`,
        local: true,
      });
      await command("router.credential.add", {
        providerId: "local-evaluation",
        endpointId: endpoint.data.endpointId,
        label: "evaluation-account",
        credentialType: "api_key",
        secret: "evaluation-secret",
        priority: 1,
        weight: 1,
      });
      const model = await command("router.model.register", {
        providerId: "local-evaluation",
        endpointId: endpoint.data.endpointId,
        modelId: "massion-evaluation-model",
        routeKind: "chat",
        contextWindow: 32_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "evaluation-model",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      });
      const route = await command("router.route.configure", {
        name: "evaluation-quality",
        routeKind: "chat",
        credentialPolicy: "round-robin",
        dataPolicy: "external-allowed",
        equivalenceGroup: "evaluation-model",
        minEvalScore: 0,
        requireTools: false,
        requireStructuredOutput: false,
        requireVision: false,
        requireStreaming: false,
        maxContextTokens: 32_000,
        requestBudgetMicros: 1_000_000,
        totalBudgetMicros: 10_000_000,
      });
      await command("router.candidate.add", {
        routeId: route.data.routeId,
        modelProfileId: model.data.modelProfileId,
        priority: 1,
      });

      const bundle = await command("optimization.bundle.create", {
        roleKey: "assurance",
        runtimeVersion: "server-test-runtime",
        cases: [
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "a".repeat(64),
            toolsChecksum: "b".repeat(64),
            environmentChecksum: "c".repeat(64),
            expectedOutcome: "평가완료",
          },
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "d".repeat(64),
            toolsChecksum: "e".repeat(64),
            environmentChecksum: "f".repeat(64),
            expectedOutcome: "평가완료",
          },
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "1".repeat(64),
            toolsChecksum: "2".repeat(64),
            environmentChecksum: "3".repeat(64),
            expectedOutcome: "평가완료",
          },
        ],
      });
      expect(bundle.outcome).toBe("succeeded");
      const receipt = await command("optimization.evaluation.execute", {
        roleKey: "assurance",
        bundleId: bundle.data.bundleId,
        modelProfileId: model.data.modelProfileId,
        runtimeVersion: "server-test-runtime",
      });
      expect(receipt).toMatchObject({
        outcome: "succeeded",
        data: {
          roleKey: "assurance",
          modelProfileId: model.data.modelProfileId,
          sampleCount: 3,
          qualityScore: 1,
          completed: true,
        },
      });

      const recommendation = await command("optimization.recommend", {
        roleKey: "assurance",
        candidates: [
          {
            modelProfileId: model.data.modelProfileId,
            modelId: model.data.modelId,
            routeId: route.data.routeId,
            providerId: "local-evaluation",
            verified: true,
            supportsStructuredOutput: true,
            supportsTools: true,
            supportsStreaming: true,
            dataPolicy: "external-allowed",
          },
        ],
        receipts: [receipt.data],
        requirements: {
          requiresTools: false,
          requiresStructuredOutput: false,
          requiresStreaming: false,
          dataPolicy: "external-allowed",
        },
      });
      expect(recommendation).toMatchObject({
        outcome: "succeeded",
        data: {
          roleKey: "assurance",
          primaryModelProfileId: model.data.modelProfileId,
          status: "pending-approval",
        },
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 20_000);
});
