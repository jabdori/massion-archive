import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent, AgentRegistry, VoltAgent } from "@voltagent/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { RouteAttempt } from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { AgentExecutionInput } from "./contracts.js";
import { MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, MASSION_TENANT_CONTEXT_KEY } from "./agent-configuration.js";
import { runtimeAgentName } from "./agent-topology.js";
import { RuntimeExecutionStore } from "./execution-store.js";
import { DirectExecutionLifecycle } from "./lifecycle.js";
import type {
  RoutedAgentRuntimeLease,
  RoutedAgentRuntimeResult,
  RoutedModelFactory,
  RoutedModelLease,
} from "./model-factory.js";
import { RuntimeRecovery } from "./recovery.js";
import { SubscriptionStructuredOutputError } from "./subscriptions/agent-runtime.js";
import { normalizeVoltAgentStreamPart, RoutedModelRegistry, VoltAgentRunner } from "./voltagent-runner.js";

const USAGE = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

describe("VoltAgent AgentRunner", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: RuntimeExecutionStore;
  let voltAgent: VoltAgent;
  let registry: RoutedModelRegistry;
  let agentId: string;
  let rejectionListeners: ReturnType<typeof process.rawListeners>;
  let terminationListeners: ReturnType<typeof process.rawListeners>;
  let interruptListeners: ReturnType<typeof process.rawListeners>;

  beforeEach(async () => {
    rejectionListeners = process.rawListeners("unhandledRejection");
    terminationListeners = process.rawListeners("SIGTERM");
    interruptListeners = process.rawListeners("SIGINT");
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
    registry = new RoutedModelRegistry();
    agentId = `${context.organizationId}:representative`;
    voltAgent = new VoltAgent({
      agents: {
        representative: new Agent({
          id: agentId,
          name: runtimeAgentName(context.organizationId, "representative"),
          instructions: ({ context: executionContext }) => {
            expect(executionContext.get(MASSION_RUNTIME_EXECUTION_CONTEXT_KEY)).toEqual(expect.any(String));
            expect(executionContext.get(MASSION_TENANT_CONTEXT_KEY)).toEqual(context);
            return "Respond";
          },
          model: registry.resolve,
          maxRetries: 0,
        }),
      },
    });
    await voltAgent.ready;
  });

  afterEach(async () => {
    AgentRegistry.getInstance().removeAgent(agentId);
    await voltAgent.shutdown();
    await database.close();
    for (const listener of process.rawListeners("unhandledRejection")) {
      if (!rejectionListeners.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
    for (const listener of process.rawListeners("SIGTERM")) {
      if (!terminationListeners.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.rawListeners("SIGINT")) {
      if (!interruptListeners.includes(listener)) process.removeListener("SIGINT", listener);
    }
  });

  function input(): AgentExecutionInput {
    return {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "representative",
      modelRoute: "coding-balanced",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      input: "hello",
    };
  }

  function lease(
    model: MockLanguageModelV3,
    attemptId = crypto.randomUUID(),
    fallbackAllowed = false,
  ): RoutedModelLease {
    return {
      kind: "model",
      attemptId,
      credentialId: crypto.randomUUID(),
      modelProfileId: "model-profile-1",
      optimizationBatchId: "optimization-batch-1",
      preferenceApplied: true,
      model,
      supportsStructuredOutput: true,
      complete: vi.fn().mockResolvedValue({ status: "succeeded" } as RouteAttempt),
      fail: vi.fn().mockResolvedValue({ status: "failed", fallbackAllowed }),
    };
  }

  function agentLease(
    result: RoutedAgentRuntimeResult,
    attemptId = crypto.randomUUID(),
    sessionLeaseId = crypto.randomUUID(),
    fallbackAllowed = false,
    preserveExecutionId = false,
    subscription: { readonly workId: string; readonly agentHandle: string } = {
      workId: "work-1",
      agentHandle: "representative",
    },
  ): RoutedAgentRuntimeLease {
    return {
      kind: "agent-runtime",
      attemptId,
      credentialId: crypto.randomUUID(),
      modelProfileId: "model-profile-1",
      optimizationBatchId: "optimization-batch-1",
      preferenceApplied: true,
      sessionLeaseId,
      sessionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      subscription: {
        ...subscription,
        accountId: "account-1",
        connectorId: "connector-1",
        adapterId: "connector-1",
      },
      renewSession: vi.fn(async ({ expectedExpiresAt }) => expectedExpiresAt),
      executor: {
        execute: vi.fn(async ({ executionId }) => (preserveExecutionId ? result : { ...result, executionId })),
      },
      complete: vi.fn().mockResolvedValue({ status: "succeeded" } as RouteAttempt),
      fail: vi.fn().mockResolvedValue({ status: "failed", fallbackAllowed }),
    };
  }

  function subscriptionReceiptFixture(): {
    readonly stages: string[];
    readonly receipts: {
      readonly read: ReturnType<typeof vi.fn>;
      readonly recover: ReturnType<typeof vi.fn>;
      readonly recordRouteSessionAcquired: ReturnType<typeof vi.fn>;
      readonly recordInvocationStarted: ReturnType<typeof vi.fn>;
      readonly recordCheckpointObserved: ReturnType<typeof vi.fn>;
      readonly recordTerminalObserved: ReturnType<typeof vi.fn>;
      readonly recordSettlementCompleted: ReturnType<typeof vi.fn>;
    };
  } {
    const stages: string[] = [];
    return {
      stages,
      receipts: {
        read: vi.fn(),
        recover: vi.fn(),
        recordRouteSessionAcquired: vi.fn(async () => {
          stages.push("acquired");
        }),
        recordInvocationStarted: vi.fn(async () => {
          stages.push("started");
        }),
        recordCheckpointObserved: vi.fn(async () => {
          stages.push("checkpoint");
        }),
        recordTerminalObserved: vi.fn(async () => {
          stages.push("terminal");
        }),
        recordSettlementCompleted: vi.fn(async () => {
          stages.push("settled");
        }),
      },
    };
  }

  it("종료는 새 실행 수신을 막고 활성 Provider 실행이 취소 정산될 때까지 기다린다", async () => {
    const routed = agentLease({
      outcome: "completed",
      executionId: "runtime에서-대체",
      sessionId: "shutdown-session",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              resolve({ outcome: "cancelled", executionId, sessionId: "shutdown-session" });
            },
            { once: true },
          );
        }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const pending = runner.execute(context, input());
    await vi.waitFor(() => expect(runner.activeCount).toBe(1));
    expect(runner.activeExecutionIds()).toHaveLength(1);

    await runner.shutdown("daemon_shutdown");
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(runner.activeExecutionIds()).toEqual([]);
    await expect(runner.execute(context, input())).rejects.toThrow("종료 중");
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
  });

  it("동시에 요청한 종료는 하나로 합치고 Provider 정산이 끝나기 전에는 완료하지 않는다", async () => {
    let settle: (() => void) | undefined;
    const routed = agentLease({
      outcome: "completed",
      executionId: "runtime에서-대체",
      sessionId: "shutdown-session",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              settle = () => {
                resolve({ outcome: "cancelled", executionId, sessionId: "shutdown-session" });
              };
            },
            { once: true },
          );
        }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const pending = runner.execute(context, input());
    await vi.waitFor(() => expect(routed.executor.execute).toHaveBeenCalledOnce());
    const first = runner.shutdown("daemon_shutdown");
    const second = runner.shutdown("ignored_second_reason");
    let completed = false;
    void first.then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(settle).toEqual(expect.any(Function)));
    await Promise.resolve();
    expect(completed).toBe(false);
    settle?.();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(routed.fail).toHaveBeenCalledOnce();
  });

  it("종료는 승인 대기 중인 구독 실행도 Provider에서 취소하고 정산한다", async () => {
    const routed = agentLease({
      outcome: "suspended",
      executionId: "runtime에서-대체",
      sessionId: "approval-session",
      approvalId: "approval-1",
    });
    routed.executor.cancel = vi.fn(async () => undefined);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const suspended = await runner.execute(context, input());
    expect(suspended.status).toBe("suspended");
    expect(runner.activeExecutionIds()).toEqual([suspended.executionId]);

    await runner.shutdown("daemon_shutdown");

    expect(routed.executor.cancel).toHaveBeenCalledOnce();
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
    await expect(store.getRecovery(context, suspended.executionId)).resolves.toMatchObject({
      execution: { status: "cancelled" },
    });
    expect(runner.activeExecutionIds()).toEqual([]);
  });

  it("종료와 겹친 실행 준비가 활성 ID를 만들 때까지 기다린 뒤 빠짐없이 취소한다", async () => {
    let releaseCreate: (() => void) | undefined;
    const originalCreate = store.createExecution.bind(store);
    vi.spyOn(store, "createExecution").mockImplementation(
      async (...arguments_) =>
        await new Promise<Awaited<ReturnType<typeof store.createExecution>>>((resolve) => {
          releaseCreate = () => {
            void originalCreate(...arguments_).then(resolve);
          };
        }),
    );
    const routed = agentLease({
      outcome: "completed",
      executionId: "runtime에서-대체",
      sessionId: "shutdown-session",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          const cancel = () => {
            resolve({ outcome: "cancelled", executionId, sessionId: "shutdown-session" });
          };
          if (abortSignal?.aborted) cancel();
          else abortSignal?.addEventListener("abort", cancel, { once: true });
        }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const pending = runner.execute(context, input());
    await vi.waitFor(() => expect(releaseCreate).toEqual(expect.any(Function)));
    let closed = false;
    const closing = runner.shutdown("daemon_shutdown").then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseCreate?.();
    await closing;
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(runner.activeExecutionIds()).toEqual([]);
  });

  it("실제 VoltAgent generateText를 동적 routed model로 실행하고 usage·terminal event를 정산한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "hello runtime" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const factory: RoutedModelFactory = { acquire: vi.fn().mockResolvedValue(routed) };
    const runner = new VoltAgentRunner(voltAgent, store, factory, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result).toMatchObject({ status: "succeeded", output: "hello runtime" });
    expect(routed.complete).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
    expect(recovery.events.map((event) => event.event_type)).toEqual([
      "execution_queued",
      "execution_running",
      "model.route.selected",
      "execution_succeeded",
    ]);
    expect(recovery.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(recovery.events[2]).toMatchObject({
      event_type: "model.route.selected",
      execution_id: result.executionId,
      payload_json: expect.any(String),
    });
    expect(JSON.parse(recovery.events[2]?.payload_json ?? "null")).toEqual({
      executionId: result.executionId,
      attemptId: routed.attemptId,
      modelProfileId: "model-profile-1",
      routeName: "coding-balanced",
      batchId: "optimization-batch-1",
      preferenceApplied: true,
    });
    expect(registry.size).toBe(0);
  });

  it("빈 text 출력은 모델 임대와 Runtime 실행을 성공 처리하지 않는다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: " \n\t" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result).toMatchObject({ status: "failed", error: { category: "output", retryable: false } });
    expect(routed.complete).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "output" }, inputTokens: 2, outputTokens: 3 }),
    );
    expect(recovery.events.at(-1)?.event_type).toBe("execution_failed");
  });

  it("Agent runtime lease는 VoltAgent LanguageModel로 감싸지 않고 명시적 executor로 실행한다", async () => {
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-1",
      sessionId: "provider-session-1",
      value: "native agent result",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    const acquire = vi.fn().mockResolvedValue(routed);
    const executionContext = {
      resolve: vi.fn().mockResolvedValue({
        workspaceRoot: "/tmp/massion-work-1",
        workspaceAccess: "read-only",
        workspaceCapability: "workspace-capability-1",
        instruction: "Representative instruction",
      }),
    };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry, undefined, executionContext);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result).toMatchObject({ status: "succeeded", output: "native agent result" });
    expect(routed.executor.execute).toHaveBeenCalledWith({
      executionId: result.executionId,
      prompt: "hello",
      abortSignal: expect.any(AbortSignal),
    });
    expect(routed.complete).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 5, outputTokens: 2 }));
    expect(acquire).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        executionId: result.executionId,
        workId: "work-1",
        agentHandle: "representative",
        workspaceRoot: "/tmp/massion-work-1",
        instruction: "Representative instruction",
      }),
    );
    expect(
      recovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual([
      {
        executionId: result.executionId,
        attemptId: routed.attemptId,
        modelProfileId: "model-profile-1",
        routeName: "coding-balanced",
        batchId: "optimization-batch-1",
        preferenceApplied: true,
      },
    ]);
    expect(registry.size).toBe(0);
  });

  it("Work 범위 Runtime Agent는 소유 Work에서만 실행한다", async () => {
    const handle = "temporary-specialist";
    const scopedAgentId = `${context.organizationId}:node-temporary-specialist`;
    voltAgent.registerAgent(
      new Agent({
        id: scopedAgentId,
        name: runtimeAgentName(context.organizationId, handle, "work-1"),
        instructions: "Work 전용 지시",
        model: registry.resolve,
        maxRetries: 0,
      }),
    );
    const ownerLease = agentLease(
      {
        outcome: "completed",
        executionId: "runtime에서-대체",
        sessionId: "owner-session",
        value: "owner result",
      },
      "owner-attempt",
      "owner-lease",
      false,
      false,
      { workId: "work-1", agentHandle: handle },
    );
    const foreignLease = agentLease(
      {
        outcome: "completed",
        executionId: "runtime에서-대체",
        sessionId: "foreign-session",
        value: "foreign result",
      },
      "foreign-attempt",
      "foreign-lease",
      false,
      false,
      { workId: "work-2", agentHandle: handle },
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValueOnce(ownerLease).mockResolvedValueOnce(foreignLease) },
      registry,
    );

    try {
      await expect(runner.execute(context, { ...input(), agentHandle: handle })).resolves.toMatchObject({
        status: "succeeded",
        output: "owner result",
      });
      await expect(
        runner.execute(context, {
          ...input(),
          commandId: crypto.randomUUID(),
          workId: "work-2",
          agentHandle: handle,
        }),
      ).resolves.toMatchObject({ status: "failed" });
      expect(ownerLease.executor.execute).toHaveBeenCalledOnce();
      expect(foreignLease.executor.execute).not.toHaveBeenCalled();
    } finally {
      AgentRegistry.getInstance().removeAgent(scopedAgentId);
    }
  });

  it("선택 사건 저장이 실패하면 Agent runtime lease를 side effect 전에 정리하고 fallback하지 않는다", async () => {
    const first = agentLease(
      {
        outcome: "completed",
        executionId: "사용되지-않음",
        sessionId: "사용되지-않음",
        value: "사용되지 않음",
      },
      "selection-store-failed-attempt",
      "selection-store-failed-lease",
      true,
    );
    const fallback = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "실행되면 안 됨" }],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        },
      }),
      "selection-store-fallback-attempt",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(fallback);
    const appendEvent = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation(async (tenant, event) => {
      if (event.eventType === "model.route.selected") throw new Error("selection event store unavailable");
      return await appendEvent(tenant, event);
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result.status).toBe("interrupted");
    expect(acquire).toHaveBeenCalledOnce();
    expect(first.executor.execute).not.toHaveBeenCalled();
    expect(first.fail).toHaveBeenCalledOnce();
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ sideEffectsStarted: false }));
  });

  it("선택 사건 append의 동시 version 충돌은 최신 version으로 재시도하고 한 번만 기록한다", async () => {
    const generate = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "concurrent event" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    }));
    const routed = lease(new MockLanguageModelV3({ doGenerate: generate }), "concurrent-selection-attempt");
    const appendEvent = store.appendEvent.bind(store);
    let injected = false;
    vi.spyOn(store, "appendEvent").mockImplementation(async (tenant, event) => {
      if (event.eventType === "model.route.selected" && !injected) {
        injected = true;
        await appendEvent(tenant, {
          commandId: `${event.executionId}:concurrent-observation`,
          executionId: event.executionId,
          expectedVersion: event.expectedVersion,
          eventType: "concurrent_observation",
          payload: {},
        });
      }
      return await appendEvent(tenant, event);
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result).toMatchObject({ status: "succeeded", output: "concurrent event" });
    expect(generate).toHaveBeenCalledOnce();
    expect(routed.fail).not.toHaveBeenCalled();
    expect(recovery.events.filter((event) => event.event_type === "model.route.selected")).toHaveLength(1);
  });

  it("선택 사건의 비-version 오류는 동시 version 증가가 있어도 재시도하지 않는다", async () => {
    const generate = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "실행되면 안 됨" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    }));
    const routed = lease(new MockLanguageModelV3({ doGenerate: generate }), "non-version-selection-attempt");
    const appendEvent = store.appendEvent.bind(store);
    let selectionAppends = 0;
    vi.spyOn(store, "appendEvent").mockImplementation(async (tenant, event) => {
      if (event.eventType !== "model.route.selected") return await appendEvent(tenant, event);
      selectionAppends += 1;
      if (selectionAppends === 1) {
        await appendEvent(tenant, {
          commandId: `${event.executionId}:concurrent-non-version-observation`,
          executionId: event.executionId,
          expectedVersion: event.expectedVersion,
          eventType: "concurrent_observation",
          payload: {},
        });
        throw new Error("selection storage unavailable");
      }
      return await appendEvent(tenant, event);
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.execute(context, input());

    expect(result.status).toBe("interrupted");
    expect(selectionAppends).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledOnce();
  });

  it("선택 사건 CAS 충돌 재시도는 유한 횟수 뒤 lease를 정리한다", async () => {
    const generate = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "실행되면 안 됨" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    }));
    const routed = lease(new MockLanguageModelV3({ doGenerate: generate }), "bounded-selection-attempt");
    const appendEvent = store.appendEvent.bind(store);
    let selectionAppends = 0;
    vi.spyOn(store, "appendEvent").mockImplementation(async (tenant, event) => {
      if (event.eventType === "model.route.selected") {
        selectionAppends += 1;
        if (selectionAppends <= 6) {
          await appendEvent(tenant, {
            commandId: `${event.executionId}:cas-observation:${String(selectionAppends)}`,
            executionId: event.executionId,
            expectedVersion: event.expectedVersion,
            eventType: "concurrent_observation",
            payload: { selectionAppends },
          });
        }
      }
      return await appendEvent(tenant, event);
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.execute(context, input());

    expect(result.status).toBe("interrupted");
    expect(selectionAppends).toBe(4);
    expect(generate).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledOnce();
  });

  it("Agent runtime 실제 경로는 acquired→started→terminal→settled receipt 순서를 지킨다", async () => {
    const stages: string[] = [];
    const routed = agentLease(
      {
        outcome: "completed",
        executionId: "runtime에서-대체",
        sessionId: "provider-session-receipt",
        value: { text: "receipt 완료" },
        usage: { inputTokens: 2, outputTokens: 1 },
      },
      "agent-attempt-receipt",
      "agent-lease-receipt",
    );
    const receipts = {
      read: vi.fn(),
      recover: vi.fn(),
      recordRouteSessionAcquired: vi.fn(async () => {
        stages.push("acquired");
      }),
      recordInvocationStarted: vi.fn(async () => {
        stages.push("started");
      }),
      recordCheckpointObserved: vi.fn(async () => {
        stages.push("checkpoint");
      }),
      recordTerminalObserved: vi.fn(async () => {
        stages.push("terminal");
      }),
      recordSettlementCompleted: vi.fn(async () => {
        stages.push("settled");
      }),
    };
    const factory: RoutedModelFactory = {
      acquire: vi.fn().mockResolvedValue(routed),
      createSubscriptionReceipts: vi.fn(() => receipts as never),
    };
    const runner = new VoltAgentRunner(voltAgent, store, factory, registry);

    const result = await runner.execute(context, input());

    expect(result.status).toBe("succeeded");
    expect(stages).toEqual(["acquired", "started", "terminal", "settled"]);
    expect(routed.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: `${result.executionId}:subscription:agent-attempt-receipt:settlement:router`,
      }),
    );
  });

  it("Agent runtime 내부 timeout reject도 receipt 정산 뒤 interrupted로 종료한다", async () => {
    const { stages, receipts } = subscriptionReceiptFixture();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-timeout",
      sessionId: "provider-session-timeout",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      {
        acquire: vi.fn().mockResolvedValue(routed),
        createSubscriptionReceipts: vi.fn(() => receipts as never),
      },
      registry,
      undefined,
      undefined,
      { agentRuntimeTimeoutMs: 1 },
    );

    const result = await runner.execute(context, input());

    expect(result).toMatchObject({ status: "interrupted", error: { category: "timeout", retryable: true } });
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "timeout" }, emittedTokens: 0, sideEffectsStarted: true }),
    );
    expect(stages).toEqual(["acquired", "started", "terminal", "settled"]);

    const recovery = await store.getRecovery(context, result.executionId);
    receipts.read.mockResolvedValue({ execution: recovery.execution, attempts: [{}] });
    receipts.recover.mockResolvedValue(recovery.execution);
    await expect(runner.recover(context, result.executionId)).resolves.toEqual(result);
    expect(receipts.recover).toHaveBeenCalledOnce();
    expect(routed.fail).toHaveBeenCalledOnce();
    expect(stages).toEqual(["acquired", "started", "terminal", "settled"]);
  });

  it("Model acquire timeout은 실행을 종료하고 늦게 반환된 lease를 정산한다", async () => {
    let resolveLease: ((value: RoutedModelLease) => void) | undefined;
    const pending = new Promise<RoutedModelLease>((resolve) => {
      resolveLease = resolve;
    });
    const routed = lease(new MockLanguageModelV3({ doGenerate: async () => ({}) as never }));
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn(() => pending) },
      registry,
      undefined,
      undefined,
      { modelAcquireTimeoutMs: 1 },
    );

    const result = await runner.execute(context, input());

    expect(result).toMatchObject({ status: "failed", error: { category: "timeout", retryable: true } });
    expect(runner.activeCount).toBe(0);
    resolveLease?.(routed);
    await vi.waitFor(() => {
      expect(routed.fail).toHaveBeenCalledWith(
        expect.objectContaining({ signal: { kind: "timeout" }, emittedTokens: 0, sideEffectsStarted: false }),
      );
    });
  });

  it("구조화 실행과 stream도 같은 Model acquire timeout으로 종료한다", async () => {
    const structuredLease = lease(new MockLanguageModelV3({ doGenerate: async () => ({}) as never }));
    const streamLease = lease(new MockLanguageModelV3({ doGenerate: async () => ({}) as never }));
    let resolveStructured!: (value: RoutedModelLease) => void;
    let resolveStream!: (value: RoutedModelLease) => void;
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      {
        acquire: vi
          .fn()
          .mockImplementationOnce(
            async () => await new Promise<RoutedModelLease>((resolve) => (resolveStructured = resolve)),
          )
          .mockImplementationOnce(
            async () => await new Promise<RoutedModelLease>((resolve) => (resolveStream = resolve)),
          ),
      },
      registry,
      undefined,
      undefined,
      { modelAcquireTimeoutMs: 1 },
    );

    const structured = await runner.executeStructured(context, input(), {
      name: "result",
      description: "result",
      jsonSchema: { type: "object" },
    });
    const events = [];
    for await (const event of runner.stream(context, input())) events.push(event);

    expect(structured).toMatchObject({ status: "failed", error: { category: "timeout" } });
    expect(events.at(-1)?.type).toBe("execution_failed");
    resolveStructured(structuredLease);
    resolveStream(streamLease);
    await vi.waitFor(() => {
      expect(structuredLease.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" } }));
      expect(streamLease.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" } }));
    });
  });

  it("늦게 반환된 lease 정산 실패는 재시도 후 운영 경고를 남긴다", async () => {
    let resolveLease!: (value: RoutedModelLease) => void;
    const routed = lease(new MockLanguageModelV3({ doGenerate: async () => ({}) as never }));
    routed.fail = vi.fn().mockRejectedValue(new Error("정산 실패"));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn(async () => await new Promise<RoutedModelLease>((resolve) => (resolveLease = resolve))) },
      registry,
      undefined,
      undefined,
      { modelAcquireTimeoutMs: 1 },
    );

    await expect(runner.execute(context, input())).resolves.toMatchObject({ status: "failed" });
    resolveLease(routed);

    await vi.waitFor(() => {
      expect(routed.fail).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(
        "늦게 반환된 Model lease 정산에 실패했습니다",
        expect.objectContaining({ code: "MASSION_LATE_MODEL_LEASE_SETTLEMENT_FAILED" }),
      );
    });
    warning.mockRestore();
  });

  it("Model acquire timeout 뒤 부모 취소가 와도 최초 timeout 원인을 보존한다", async () => {
    const controller = new AbortController();
    let resolveLease!: (value: RoutedModelLease) => void;
    let releaseFailureTransition!: () => void;
    const failureTransitionGate = new Promise<void>((resolve) => (releaseFailureTransition = resolve));
    const originalTransition = store.transition.bind(store);
    const transition = vi.spyOn(store, "transition").mockImplementation(async (tenant, value) => {
      if (value.target === "failed") await failureTransitionGate;
      return await originalTransition(tenant, value);
    });
    const routed = lease(new MockLanguageModelV3({ doGenerate: async () => ({}) as never }));
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn(async () => await new Promise<RoutedModelLease>((resolve) => (resolveLease = resolve))) },
      registry,
      undefined,
      undefined,
      { modelAcquireTimeoutMs: 1 },
    );

    const pendingResult = runner.execute(context, { ...input(), signal: controller.signal });
    await vi.waitFor(() => {
      expect(transition).toHaveBeenCalledWith(context, expect.objectContaining({ target: "failed" }));
    });
    controller.abort("application-run-cancelled");
    resolveLease(routed);
    releaseFailureTransition();
    const result = await pendingResult;

    expect(result).toMatchObject({ status: "failed", error: { category: "timeout" } });
    await vi.waitFor(() => {
      expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" } }));
    });
  });

  it("Agent runtime 내부 timeout 취소 결과도 receipt 정산 뒤 interrupted로 종료한다", async () => {
    const { stages, receipts } = subscriptionReceiptFixture();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-timeout-cancelled",
      sessionId: "provider-session-timeout-cancelled",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              resolve({ outcome: "cancelled", executionId, sessionId: "provider-session-timeout-cancelled" });
            },
            { once: true },
          );
        }),
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      {
        acquire: vi.fn().mockResolvedValue(routed),
        createSubscriptionReceipts: vi.fn(() => receipts as never),
      },
      registry,
      undefined,
      undefined,
      { agentRuntimeTimeoutMs: 1 },
    );

    await expect(runner.execute(context, input())).resolves.toMatchObject({
      status: "interrupted",
      error: { category: "timeout", retryable: true },
    });
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "timeout" }, emittedTokens: 0, sideEffectsStarted: true }),
    );
    expect(receipts.recordTerminalObserved).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        outcome: "failed",
        providerSessionId: "provider-session-timeout-cancelled",
        category: "timeout",
      }),
    );
    expect(stages).toEqual(["acquired", "started", "terminal", "settled"]);
  });

  it("Agent runtime timeout이 부모 취소보다 먼저 발생하면 timeout을 보존한다", async () => {
    const controller = new AbortController();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-timeout-race",
      sessionId: "provider-session-timeout-race",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              controller.abort(new DOMException("뒤늦은 부모 취소", "AbortError"));
              resolve({ outcome: "cancelled", executionId, sessionId: "provider-session-timeout-race" });
            },
            { once: true },
          );
        }),
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { agentRuntimeTimeoutMs: 1 },
    );

    await expect(runner.execute(context, { ...input(), signal: controller.signal })).resolves.toMatchObject({
      status: "interrupted",
      error: { category: "timeout", retryable: true },
    });
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "timeout" }, sideEffectsStarted: true }),
    );
  });

  it("부모가 TimeoutError reason으로 먼저 취소하면 cancelled를 유지한다", async () => {
    const controller = new AbortController();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-parent-timeout-reason",
      sessionId: "provider-session-parent-timeout-reason",
      value: "사용되지 않음",
    });
    routed.executor.execute = vi.fn(
      async ({ executionId, abortSignal }) =>
        await new Promise<RoutedAgentRuntimeResult>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              resolve({ outcome: "cancelled", executionId, sessionId: "provider-session-parent-timeout-reason" });
            },
            { once: true },
          );
        }),
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { agentRuntimeTimeoutMs: 30_000 },
    );

    const pending = runner.execute(context, { ...input(), signal: controller.signal });
    await vi.waitFor(() => expect(routed.executor.execute).toHaveBeenCalledOnce());
    controller.abort(new DOMException("상위 계층 시간 제한", "TimeoutError"));

    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
  });

  it("Provider 자체 cancelled 결과는 cancelled를 유지한다", async () => {
    const routed = agentLease({
      outcome: "cancelled",
      executionId: "provider-execution-cancelled",
      sessionId: "provider-session-cancelled",
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    await expect(runner.execute(context, input())).resolves.toMatchObject({ status: "cancelled" });
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
  });

  it("Agent runtime 기본 응답 상한은 300초다", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-default-timeout",
      sessionId: "provider-session-default-timeout",
      value: "완료",
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    try {
      await expect(runner.execute(context, input())).resolves.toMatchObject({ status: "succeeded" });
      expect(timeout).toHaveBeenCalledWith(300_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("구독 승인 ID만 받아 정본 결정을 소비한 뒤 같은 lease를 terminal까지 재개한다", async () => {
    const routed = agentLease(
      {
        outcome: "suspended",
        executionId: "runtime에서-대체",
        sessionId: "provider-session-review",
        approvalId: "approval-review",
      },
      "agent-attempt-review",
      "agent-lease-review",
    );
    const resume = vi.fn(async ({ executionId }: { readonly executionId: string }) => ({
      outcome: "completed" as const,
      executionId,
      sessionId: "provider-session-review",
      value: "승인 뒤 완료",
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    routed.executor.resume = resume;
    const consume = vi.fn().mockResolvedValue("approved");
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { subscriptionApprovals: { consume } },
    );

    const suspended = await runner.execute(context, input());
    await expect(
      runner.resume(context, suspended.executionId, { approvalId: "approval-review", approved: true }),
    ).rejects.toThrow(/approvalId/u);
    const completed = await runner.resume(context, suspended.executionId, { approvalId: "approval-review" });

    expect(suspended.status).toBe("suspended");
    expect(completed).toMatchObject({ status: "succeeded", output: "승인 뒤 완료" });
    expect(consume).toHaveBeenCalledWith(context, {
      executionId: suspended.executionId,
      approvalId: "approval-review",
    });
    expect(resume).toHaveBeenCalledWith({
      executionId: suspended.executionId,
      sessionId: "provider-session-review",
      approvalId: "approval-review",
      approved: true,
      abortSignal: expect.any(AbortSignal),
    });
    expect(routed.complete).toHaveBeenCalledOnce();
  });

  it("승인 소비 뒤 running 전이는 완료됐지만 응답이 유실되어도 같은 승인과 전이를 재사용해 재개한다", async () => {
    const routed = agentLease(
      {
        outcome: "suspended",
        executionId: "runtime에서-대체",
        sessionId: "provider-session-transition-retry",
        approvalId: "approval-transition-retry",
      },
      "agent-attempt-transition-retry",
      "agent-lease-transition-retry",
    );
    routed.executor.resume = vi.fn(async ({ executionId }: { readonly executionId: string }) => ({
      outcome: "completed" as const,
      executionId,
      sessionId: "provider-session-transition-retry",
      value: "재시도 뒤 완료",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const consume = vi
      .fn()
      .mockResolvedValueOnce("approved")
      .mockRejectedValue(new Error("소비된 승인은 다시 소비할 수 없습니다"));
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { subscriptionApprovals: { consume } },
    );
    const suspended = await runner.execute(context, input());
    const transition = store.transition.bind(store);
    let loseResponse = true;
    vi.spyOn(store, "transition").mockImplementation(async (tenant, request) => {
      const result = await transition(tenant, request);
      if (request.commandId.includes(":approval:") && loseResponse) {
        loseResponse = false;
        throw new Error("running 전이 응답이 유실됐습니다");
      }
      return result;
    });

    await expect(
      runner.resume(context, suspended.executionId, { approvalId: "approval-transition-retry" }),
    ).rejects.toThrow("응답이 유실");
    await expect(store.getRecovery(context, suspended.executionId)).resolves.toMatchObject({
      execution: { status: "running" },
    });

    await expect(
      runner.resume(context, suspended.executionId, { approvalId: "approval-transition-retry" }),
    ).resolves.toMatchObject({ status: "succeeded", output: "재시도 뒤 완료" });
    expect(consume).toHaveBeenCalledOnce();
    expect(routed.executor.resume).toHaveBeenCalledOnce();
  });

  it("거부된 구독 승인은 호출자가 바꿀 수 없고 같은 provider 실행을 취소 정산한다", async () => {
    const routed = agentLease({
      outcome: "suspended",
      executionId: "runtime에서-대체",
      sessionId: "provider-session-rejected",
      approvalId: "approval-rejected",
    });
    const resume = vi.fn(async ({ executionId }: { readonly executionId: string }) => ({
      outcome: "cancelled" as const,
      executionId,
      sessionId: "provider-session-rejected",
    }));
    routed.executor.resume = resume;
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { subscriptionApprovals: { consume: async () => "rejected" } },
    );

    const suspended = await runner.execute(context, input());
    const cancelled = await runner.resume(context, suspended.executionId, { approvalId: "approval-rejected" });

    expect(cancelled.status).toBe("cancelled");
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
  });

  it("승인 대기 구독 실행을 사용자가 취소하면 provider와 lease를 함께 취소 정산한다", async () => {
    const routed = agentLease({
      outcome: "suspended",
      executionId: "runtime에서-대체",
      sessionId: "provider-session-cancel",
      approvalId: "approval-cancel",
    });
    routed.executor.cancel = vi.fn().mockResolvedValue(undefined);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const suspended = await runner.execute(context, input());
    await runner.cancel(context, suspended.executionId, "사용자 취소");
    const recovery = await store.getRecovery(context, suspended.executionId);

    expect(recovery.execution.status).toBe("cancelled");
    expect(routed.executor.cancel).toHaveBeenCalledOnce();
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "cancelled" } }));
  });

  it("조직 취소는 현재 조직의 승인 대기 실행을 모두 회수하고 다른 실행 수락은 유지한다", async () => {
    const routed = agentLease({
      outcome: "suspended",
      executionId: "runtime에서-대체",
      sessionId: "provider-session-organization-cancel",
      approvalId: "approval-organization-cancel",
    });
    routed.executor.cancel = vi.fn().mockResolvedValue(undefined);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const suspended = await runner.execute(context, input());
    await runner.cancelOrganization(context, "autonomy_revoked");

    expect(suspended.status).toBe("suspended");
    expect(runner.activeExecutionIds()).toEqual([]);
    expect(routed.executor.cancel).toHaveBeenCalledOnce();
    await expect(runner.execute(context, input())).resolves.toMatchObject({ status: "suspended" });
    await runner.cancelOrganization(context, "test_cleanup");
  });

  it("Agent runtime이 다른 execution ID의 결과를 반환하면 fallback 없이 interrupted로 격리한다", async () => {
    const routed = agentLease(
      {
        outcome: "completed",
        executionId: "different-execution",
        sessionId: "provider-session-mismatch",
        value: "잘못 귀속된 결과",
      },
      "agent-attempt-mismatch",
      "agent-lease-mismatch",
      true,
      true,
    );
    const acquire = vi.fn().mockResolvedValue(routed);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result.status).toBe("interrupted");
    expect(acquire).toHaveBeenCalledOnce();
    expect(routed.complete).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectsStarted: true, emittedTokens: 0, signal: { kind: "unknown" } }),
    );
  });

  it("장기 Agent runtime은 bounded Session Lease를 갱신하고 갱신 실패 시 실행을 중단한다", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const base = agentLease({
      outcome: "completed",
      executionId: "runtime에서-대체",
      sessionId: "provider-session-renew",
      value: "사용되지 않음",
    });
    const routed: RoutedAgentRuntimeLease = {
      ...base,
      sessionExpiresAt: "2030-01-01T00:00:04.000Z",
      renewSession: vi.fn().mockRejectedValue(new Error("renew 충돌")),
      executor: {
        execute: vi.fn(
          async ({ abortSignal }) =>
            await new Promise<RoutedAgentRuntimeResult>((_resolve, reject) => {
              abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
            }),
        ),
      },
    };
    const clock = {
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      schedule: vi.fn((_delayMs: number, task: () => Promise<void>) => {
        tasks.push(task);
        return () => undefined;
      }),
    };
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      { sessionRenewalClock: clock },
    );

    const pending = runner.execute(context, input());
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await tasks[0]?.();
    const result = await pending;

    expect(result.status).toBe("interrupted");
    expect(clock.schedule).toHaveBeenCalledWith(2_000, expect.any(Function));
    expect(routed.renewSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedExpiresAt: "2030-01-01T00:00:04.000Z" }),
    );
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ sideEffectsStarted: true }));
  });

  it("Agent runtime 출력 전 실패는 Router attempt와 Broker lease fallback ID를 함께 넘긴다", async () => {
    const first = agentLease(
      {
        outcome: "failed",
        executionId: "provider-execution-failed",
        category: "timeout",
        retryable: true,
        signal: { kind: "timeout" },
        emittedTokens: 0,
        sideEffectsStarted: false,
      },
      "agent-attempt-1",
      "agent-lease-1",
      true,
    );
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "fallback model" }],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        },
      }),
      "model-attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const executionContext = {
      resolve: vi.fn().mockResolvedValue({
        workspaceRoot: "/tmp/massion-work-1",
        workspaceAccess: "read-only",
        workspaceCapability: "workspace-capability-1",
        instruction: "Representative instruction",
      }),
    };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry, undefined, executionContext);

    const result = await runner.execute(context, { ...input(), workspaceAccess: "workspace-write" });

    expect(result).toMatchObject({ status: "succeeded", output: "fallback model" });
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" }, emittedTokens: 0 }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({
      taskId: "task-1",
      workspaceAccess: "read-only",
      workspaceCapability: "workspace-capability-1",
      fallbackFromAttemptId: "agent-attempt-1",
      fallbackFromLeaseId: "agent-lease-1",
    });
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({
      taskId: "task-1",
      workspaceAccess: "read-only",
      workspaceCapability: "workspace-capability-1",
    });
    expect(executionContext.resolve).toHaveBeenCalledTimes(2);
    for (const call of executionContext.resolve.mock.calls) {
      expect(call[1]).toMatchObject({ taskId: "task-1", workspaceAccess: "workspace-write" });
    }
  });

  it("Agent runtime의 구조화 출력 실패는 부작용이 없으면 동급 모델로 fallback한다", async () => {
    const first = agentLease(
      { outcome: "completed", executionId: "provider-execution-output", sessionId: "session-1", value: "쓰이지 않음" },
      "agent-output-attempt-1",
      "agent-output-lease-1",
      true,
    );
    first.executor.execute = vi.fn(async () => {
      throw new SubscriptionStructuredOutputError("Codex app-server 구조화 출력 검증에 실패했습니다", {
        sideEffectsStarted: false,
        emittedTokens: 0,
      });
    });
    // Router는 실제 부작용 여부로 fallback을 판정하므로 mock도 같은 계약을 따릅니다.
    first.fail = vi.fn(async (usage) => ({ status: "failed", fallbackAllowed: !usage.sideEffectsStarted }));
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "fallback after output failure" }],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        },
      }),
      "model-attempt-output-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result).toMatchObject({ status: "succeeded", output: "fallback after output failure" });
    expect(first.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "output" }, sideEffectsStarted: false }),
    );
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "agent-output-attempt-1" });
  });

  it("Agent runtime의 구조화 출력 실패도 부작용이 관측됐으면 fallback하지 않는다", async () => {
    const routed = agentLease(
      { outcome: "completed", executionId: "provider-execution-output", sessionId: "session-1", value: "쓰이지 않음" },
      "agent-output-attempt-2",
      "agent-output-lease-2",
      true,
    );
    routed.executor.execute = vi.fn(async () => {
      throw new SubscriptionStructuredOutputError("Codex app-server 구조화 출력 검증에 실패했습니다", {
        sideEffectsStarted: true,
        emittedTokens: 3,
      });
    });
    routed.fail = vi.fn(async (usage) => ({ status: "failed", fallbackAllowed: !usage.sideEffectsStarted }));
    const acquire = vi.fn().mockResolvedValue(routed);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result.status).not.toBe("succeeded");
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ sideEffectsStarted: true }));
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("Agent runtime이 출력을 만든 뒤 실패하면 자동 fallback하지 않고 interrupted로 종료한다", async () => {
    const routed = agentLease(
      {
        outcome: "failed",
        executionId: "provider-execution-output",
        category: "provider",
        retryable: true,
        signal: { kind: "network" },
        emittedTokens: 1,
        sideEffectsStarted: false,
      },
      "agent-attempt-output",
      "agent-lease-output",
      true,
    );
    const acquire = vi.fn().mockResolvedValue(routed);
    const executionContext = {
      resolve: vi.fn().mockResolvedValue({
        workspaceRoot: "/tmp/massion-work-1",
        instruction: "Representative instruction",
      }),
    };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry, undefined, executionContext);

    const result = await runner.execute(context, input());

    expect(result).toMatchObject({ status: "interrupted", error: { category: "provider", retryable: true } });
    expect(acquire).toHaveBeenCalledOnce();
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ emittedTokens: 1, outputTokens: 1 }));
  });

  it("JSON Schema로 검증한 structured object를 Runtime 계보와 함께 반환한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "완제품 구현" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "검증 가능한 실행 계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "완제품 구현" } });
    expect(routed.complete).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
  });

  it("JSON Schema 응답 형식을 지원하지 않는 모델은 JSON object와 프롬프트 schema를 사용해 structured 결과로 처리한다", async () => {
    const routed = {
      ...lease(
        new MockLanguageModelV3({
          doGenerate: async (options) => {
            const responseFormat = options.responseFormat as
              { readonly type?: string; readonly schema?: unknown } | undefined;
            if (responseFormat?.type !== "json" || responseFormat.schema !== undefined)
              throw new Error("JSON object response format이 필요합니다");
            if (!JSON.stringify(options.prompt).includes("Massion JSON output schema"))
              throw new Error("프롬프트에 JSON Schema가 필요합니다");
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ objective: "일반 JSON 계획" }) }],
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: USAGE,
              warnings: [],
            };
          },
        }),
      ),
      supportsStructuredOutput: false,
    } as RoutedModelLease & { readonly supportsStructuredOutput: false };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "검증 가능한 실행 계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
      validate: (value: unknown) =>
        value && typeof value === "object" && typeof (value as Record<string, unknown>).objective === "string"
          ? { success: true as const, value }
          : { success: false as const, error: new Error("objective 필드가 필요합니다") },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "일반 JSON 계획" } });
  });

  it("Z.AI Coding Plan의 JSON 계획은 reasoning을 끈다", async () => {
    const routed = {
      ...lease(
        new MockLanguageModelV3({
          provider: "zai-coding-plan.chat",
          doGenerate: async (options) => {
            expect(options.providerOptions).toEqual({
              "zai-coding-plan": { thinking: { type: "disabled" } },
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ objective: "Z.AI JSON 계획" }) }],
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: USAGE,
              warnings: [],
            };
          },
        }),
      ),
      supportsStructuredOutput: false,
    } as RoutedModelLease & { readonly supportsStructuredOutput: false };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "검증 가능한 실행 계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
      validate: (value: unknown) =>
        value && typeof value === "object" && typeof (value as Record<string, unknown>).objective === "string"
          ? { success: true as const, value }
          : { success: false as const, error: new Error("objective 필드가 필요합니다") },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "Z.AI JSON 계획" } });
  });

  it("실행 레코드 생성 중 취소 신호가 오면 Provider를 만들지 않고 cancelled로 끝낸다", async () => {
    const controller = new AbortController();
    const acquire = vi.fn();
    const createExecution = store.createExecution.bind(store);
    vi.spyOn(store, "createExecution").mockImplementation(async (tenant, execution) => {
      const created = await createExecution(tenant, execution);
      controller.abort("application-run-cancelled");
      return created;
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, { ...input(), signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(acquire).not.toHaveBeenCalled();
    await expect(store.getRecovery(context, result.executionId)).resolves.toMatchObject({
      execution: { status: "cancelled" },
    });
  });

  it("구조화 실행도 레코드 생성 중 취소 신호가 오면 Provider를 만들지 않고 cancelled로 끝낸다", async () => {
    const controller = new AbortController();
    const acquire = vi.fn();
    const createExecution = store.createExecution.bind(store);
    vi.spyOn(store, "createExecution").mockImplementation(async (tenant, execution) => {
      const created = await createExecution(tenant, execution);
      controller.abort("application-run-cancelled");
      return created;
    });
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.executeStructured(
      context,
      { ...input(), signal: controller.signal },
      {
        name: "strategy-plan",
        description: "검증 가능한 실행 계획",
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["objective"],
          properties: { objective: { type: "string" } },
        },
      },
    );

    expect(result.status).toBe("cancelled");
    expect(acquire).not.toHaveBeenCalled();
    await expect(store.getRecovery(context, result.executionId)).resolves.toMatchObject({
      execution: { status: "cancelled" },
    });
  });

  it("모델 lease 획득 중 취소되면 반환 뒤 Provider 실행 없이 cancelled로 끝낸다", async () => {
    const controller = new AbortController();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution",
      sessionId: "provider-session",
      value: "사용되지 않음",
    });
    let releaseLease!: (lease: RoutedModelLease) => void;
    const acquire = vi.fn(
      () =>
        new Promise<RoutedModelLease>((resolve) => {
          releaseLease = resolve;
        }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const pending = runner.execute(context, { ...input(), signal: controller.signal });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    controller.abort("application-run-cancelled");
    releaseLease(routed);

    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(routed.executor.execute).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "cancelled" }, sideEffectsStarted: false }),
    );
    await expect(store.getRecovery(context, result.executionId)).resolves.toMatchObject({
      execution: { status: "cancelled" },
    });
  });

  it("Model acquire 완료와 취소가 겹치면 lease를 실행하지 않고 정산한다", async () => {
    const controller = new AbortController();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution-race",
      sessionId: "provider-session-race",
      value: "사용되지 않음",
    });
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      {
        acquire: vi.fn(async () => {
          controller.abort("application-run-cancelled");
          return routed;
        }),
      },
      registry,
    );

    const result = await runner.execute(context, { ...input(), signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(routed.executor.execute).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(routed.fail).toHaveBeenCalledTimes(1);
      expect(routed.fail).toHaveBeenCalledWith(
        expect.objectContaining({ signal: { kind: "cancelled" }, sideEffectsStarted: false }),
      );
    });
  });

  it("구조화 실행도 모델 lease 획득 중 취소되면 반환 뒤 Provider 실행 없이 cancelled로 끝낸다", async () => {
    const controller = new AbortController();
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution",
      sessionId: "provider-session",
      value: { objective: "사용되지 않음" },
    });
    routed.executor.executeStructured = vi.fn(async ({ executionId }) => ({
      outcome: "completed",
      executionId,
      sessionId: "provider-session",
      value: { objective: "사용되지 않음" },
    }));
    let releaseLease!: (lease: RoutedModelLease) => void;
    const acquire = vi.fn(
      () =>
        new Promise<RoutedModelLease>((resolve) => {
          releaseLease = resolve;
        }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const pending = runner.executeStructured(
      context,
      { ...input(), signal: controller.signal },
      {
        name: "strategy-plan",
        description: "검증 가능한 실행 계획",
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["objective"],
          properties: { objective: { type: "string" } },
        },
      },
    );
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    controller.abort("application-run-cancelled");
    releaseLease(routed);

    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(routed.executor.executeStructured).not.toHaveBeenCalled();
    expect(routed.fail).toHaveBeenCalledWith(
      expect.objectContaining({ signal: { kind: "cancelled" }, sideEffectsStarted: false }),
    );
  });

  it("structured 실행도 첫 응답 전 실패를 동급 모델로 fallback한다", async () => {
    const failedModel = new MockLanguageModelV3({
      doGenerate: async () => {
        const error = new Error("unauthorized") as Error & { statusCode: number };
        error.statusCode = 401;
        throw error;
      },
    });
    const first = lease(failedModel, "structured-attempt-1", true);
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "fallback plan" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
      "structured-attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "fallback plan" } });
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "http", statusCode: 401 } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "structured-attempt-1" });
  });

  it("structured output 파싱 실패도 동급 모델로 fallback한다", async () => {
    const first = lease(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("Invalid JSON response");
        },
      }),
      "structured-output-attempt-1",
      true,
    );
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "fallback plan" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
      "structured-output-attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "fallback plan" } });
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "output" } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "structured-output-attempt-1" });
  });

  it("Agent runtime의 영문 structured output 검증 실패를 output 오류로 분류한다", async () => {
    const routed = agentLease({
      outcome: "completed",
      executionId: "provider-execution",
      sessionId: "provider-session",
      value: {},
    });
    routed.executor.executeStructured = vi
      .fn()
      .mockRejectedValue(new Error("StrategyPlan structured output 검증에 실패했습니다"));
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: { type: "object" },
    });

    expect(result).toMatchObject({ status: "failed", error: { category: "output", retryable: false } });
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "output" } }));
  });

  it("Provider timeout의 Operation aborted 오류도 timeout fallback으로 분류한다", async () => {
    const first = lease(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("Operation aborted: The operation was aborted due to timeout");
        },
      }),
      "growth-timeout-attempt-1",
      true,
    );
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "timeout fallback" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
      "growth-timeout-attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "timeout fallback" } });
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "growth-timeout-attempt-1" });
  });

  it("structured schema 실패와 모델 부재를 secret 없는 terminal 상태로 기록한다", async () => {
    const invalid = {
      ...lease(
        new MockLanguageModelV3({
          doGenerate: {
            content: [{ type: "text", text: JSON.stringify({ apiKey: "secret-value" }) }],
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
            warnings: [],
          },
        }),
      ),
      supportsStructuredOutput: false,
    } as RoutedModelLease & { readonly supportsStructuredOutput: false };
    const invalidRunner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(invalid) },
      registry,
    );
    const spec = {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
      validate: (value: unknown) =>
        value && typeof value === "object" && typeof (value as Record<string, unknown>).objective === "string"
          ? { success: true as const, value }
          : { success: false as const, error: new Error("objective 필드가 필요합니다") },
    } as const;

    const failed = await invalidRunner.executeStructured(context, input(), spec);
    const failedRecovery = await store.getRecovery(context, failed.executionId);

    expect(failed).toMatchObject({ status: "failed", error: { category: "output", retryable: false } });
    expect(invalid.fail).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
    expect(JSON.stringify(failedRecovery)).not.toContain("secret-value");

    const blockedRunner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockRejectedValue(new Error("blocked_model_unavailable: route 없음")) },
      registry,
    );
    const blocked = await blockedRunner.executeStructured(context, input(), spec);

    expect(blocked).toEqual({
      executionId: expect.any(String),
      status: "blocked_model_unavailable",
      error: { category: "runtime", retryable: false, userMessage: "Agent 실행에 실패했습니다" },
    });
  });

  it("first-token 전 인증 실패는 Router가 허용한 다음 lease로 fallback한다", async () => {
    const failedModel = new MockLanguageModelV3({
      doGenerate: async () => {
        const error = new Error("unauthorized") as Error & { statusCode: number };
        error.statusCode = 401;
        throw error;
      },
    });
    const first = lease(failedModel, "attempt-1", true);
    const second = {
      ...lease(
        new MockLanguageModelV3({
          doGenerate: {
            content: [{ type: "text", text: "fallback" }],
            finishReason: "stop",
            usage: USAGE,
            warnings: [],
          },
        }),
        "attempt-2",
      ),
      modelProfileId: "model-profile-2",
      optimizationBatchId: undefined,
      preferenceApplied: false,
    } satisfies RoutedModelLease;
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result.output).toBe("fallback");
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "http", statusCode: 401 } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "attempt-1" });
    const recovery = await store.getRecovery(context, result.executionId);
    expect(
      recovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual([
      {
        executionId: result.executionId,
        attemptId: "attempt-1",
        modelProfileId: "model-profile-1",
        routeName: "coding-balanced",
        batchId: "optimization-batch-1",
        preferenceApplied: true,
      },
      {
        executionId: result.executionId,
        attemptId: "attempt-2",
        modelProfileId: "model-profile-2",
        routeName: "coding-balanced",
        preferenceApplied: false,
      },
    ]);
  });

  it("사용 가능한 모델이 없으면 명시적인 blocked 상태로 종료한다", async () => {
    const factory: RoutedModelFactory = {
      acquire: vi.fn().mockRejectedValue(new Error("blocked_model_unavailable: credential 없음")),
    };
    const runner = new VoltAgentRunner(voltAgent, store, factory, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result.status).toBe("blocked_model_unavailable");
    expect(recovery.events.at(-1)?.event_type).toBe("execution_blocked_model_unavailable");
  });

  it("stream part를 단조 Runtime Event로 영속하고 text delta 순서를 성공 출력에 보존한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "hello" },
              { type: "text-delta", id: "text-1", delta: "" },
              { type: "text-delta", id: "text-1", delta: "hello" },
              { type: "text-delta", id: "text-1", delta: "!" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ],
          }),
        },
      }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const events = [];
    for await (const event of runner.stream(context, input())) events.push(event);

    expect(
      events.some((event) => event.type === "model_text_delta" && JSON.stringify(event.payload).includes("hello")),
    ).toBe(true);
    expect(events.every((event, index) => event.sequence > (events[index - 1]?.sequence ?? 0))).toBe(true);
    const first = events[0];
    if (!first) throw new Error("stream event가 없습니다");
    const recovery = await store.getRecovery(context, first.executionId);
    expect(recovery.execution.status).toBe("succeeded");
    expect(JSON.parse(recovery.execution.output_json ?? "null")).toMatchObject({ output: "hellohello!" });
  });

  it("delta observer에 휘발성 실행 델타를 전달하고 observer 오류는 실행에 전파하지 않는다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "환불" },
              { type: "text-delta", id: "text-1", delta: " API" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ],
          }),
        },
      }),
    );
    const observed: { kind: string; text?: string; sequence: number; executionId: string; agentHandle: string }[] = [];
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      undefined,
      undefined,
      {
        deltaObserver: {
          observe: (_observerContext, delta) => {
            observed.push({
              kind: delta.kind,
              ...(delta.text === undefined ? {} : { text: delta.text }),
              sequence: delta.sequence,
              executionId: delta.executionId,
              agentHandle: delta.agentHandle,
            });
            throw new Error("observer 오류는 무시되어야 합니다");
          },
        },
      },
    );

    const events = [];
    for await (const event of runner.stream(context, input())) events.push(event);

    const texts = observed.filter((delta) => delta.kind === "output-text");
    expect(texts.map((delta) => delta.text)).toEqual(["환불", " API"]);
    expect(observed.map((delta) => delta.sequence)).toEqual(observed.map((_, index) => index + 1));
    expect(new Set(observed.map((delta) => delta.executionId)).size).toBe(1);
    expect(observed[0]?.agentHandle).toBe("representative");
    const recovery = await store.getRecovery(context, observed[0]?.executionId ?? "");
    expect(recovery.execution.status).toBe("succeeded");
  });

  it("stream 출력 후 실패는 Router가 허용해도 자동 fallback하지 않고 interrupted로 끝낸다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "partial" },
              { type: "error", error: new Error("upstream disconnected") },
            ],
          }),
        },
      }),
      "stream-attempt-1",
      true,
    );
    const acquire = vi.fn().mockResolvedValue(routed);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const events = [];
    for await (const event of runner.stream(context, input())) events.push(event);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(routed.fail).toHaveBeenCalledWith(expect.objectContaining({ emittedTokens: 1, outputTokens: 1 }));
    expect(events.at(-1)?.type).toBe("execution_interrupted");
    const recovery = await store.getRecovery(context, events.at(-1)?.executionId ?? "");
    expect(recovery.execution.output_json).toBeUndefined();
  });

  it("tool·handoff 귀속 필드는 유지하고 provider secret은 제거한다", () => {
    const payload = normalizeVoltAgentStreamPart({
      type: "tool-call",
      toolName: "delegate_task",
      toolCallId: "handoff-1",
      providerMetadata: { authorization: "secret-token" },
      credential: "secret-token",
    });

    expect(payload).toEqual({ type: "tool-call", toolName: "delegate_task", toolCallId: "handoff-1" });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("stream 실행을 cancel하면 AbortSignal과 영속 상태가 한 번만 cancelled가 된다", async () => {
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            abortSignal?.addEventListener("abort", () => controller.error(new DOMException("cancelled", "AbortError")));
          },
        }),
      }),
    });
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(lease(model)) },
      registry,
    );
    const iterator = runner.stream(context, input())[Symbol.asyncIterator]();
    const queued = await iterator.next();
    if (queued.done) throw new Error("queued event가 없습니다");
    const running = await iterator.next();
    if (running.done) throw new Error("running event가 없습니다");
    const consuming = iterator.next();
    await vi.waitFor(() => expect(registry.size).toBe(1));

    await Promise.all([
      runner.cancel(context, queued.value.executionId, "user"),
      runner.cancel(context, queued.value.executionId, "user"),
    ]);
    await consuming;
    const recovery = await store.getRecovery(context, queued.value.executionId);
    expect(recovery.execution.status).toBe("cancelled");
    expect(recovery.events.filter((event) => event.event_type === "execution_cancelled")).toHaveLength(1);
  });

  it("running event 직후 취소하면 provider 실행을 시작하지 않고 cancelled로 끝낸다", async () => {
    const acquire = vi.fn();
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);
    const iterator = runner.stream(context, input())[Symbol.asyncIterator]();
    const queued = await iterator.next();
    if (queued.done) throw new Error("queued event가 없습니다");
    const running = await iterator.next();
    if (running.done) throw new Error("running event가 없습니다");

    const cancelling = runner.cancel(context, queued.value.executionId, "running 경계 취소");
    const terminal = await iterator.next();
    await cancelling;

    expect(acquire).not.toHaveBeenCalled();
    expect(terminal).toMatchObject({ done: false, value: { type: "execution_cancelled" } });
    await expect(store.getRecovery(context, queued.value.executionId)).resolves.toMatchObject({
      execution: { status: "cancelled" },
    });
  });

  it("framework-neutral suspend·resume·recover 계약을 lifecycle adapter에 연결한다", async () => {
    const lifecycle = {
      suspend: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue({ executionId: "execution-1", status: "succeeded" }),
      recover: vi.fn().mockResolvedValue({ executionId: "execution-1", status: "suspended" }),
    };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn() }, registry, lifecycle);

    await runner.suspend(context, "execution-1", "approval");
    await expect(runner.resume(context, "execution-1", { approved: true })).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(runner.recover(context, "execution-1")).resolves.toMatchObject({ status: "suspended" });

    expect(lifecycle.suspend).toHaveBeenCalledWith(context, "execution-1", "approval");
  });

  it("cold restart는 reserved selection을 사건으로 한 번 복원·정리한 뒤 lifecycle recovery로 이어간다", async () => {
    const created = await store.createExecution(context, input());
    await store.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
    const stages: string[] = [];
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("selection 기록 뒤 process crash"))
      .mockImplementation(async () => {
        stages.push("released");
        return { status: "failed", fallbackAllowed: false };
      });
    const recovered = {
      attemptId: "recovered-attempt-1",
      modelProfileId: "recovered-profile-1",
      optimizationBatchId: "recovered-batch-1",
      preferenceApplied: true,
      fail: release,
    };
    const recoverReservedSelection = vi
      .fn()
      .mockResolvedValueOnce(recovered)
      .mockResolvedValueOnce(recovered)
      .mockResolvedValue(undefined);
    const lifecycle = {
      suspend: vi.fn(),
      resume: vi.fn(),
      recover: vi.fn(async () => {
        stages.push("lifecycle");
        return { executionId: created.execution.execution_id, status: "interrupted" as const };
      }),
    };
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn(), recoverReservedSelection },
      registry,
      lifecycle,
    );

    await expect(runner.recover(context, created.execution.execution_id)).rejects.toThrow("process crash");
    await expect(runner.recover(context, created.execution.execution_id)).resolves.toMatchObject({
      status: "interrupted",
    });
    const recovery = await store.getRecovery(context, created.execution.execution_id);

    expect(stages).toEqual(["released", "lifecycle"]);
    expect(recovered.fail).toHaveBeenNthCalledWith(1, expect.objectContaining({ sideEffectsStarted: false }));
    expect(recovered.fail).toHaveBeenNthCalledWith(2, expect.objectContaining({ sideEffectsStarted: true }));
    expect(
      recovery.events
        .filter((event) => event.event_type === "model.route.selected")
        .map((event) => JSON.parse(event.payload_json)),
    ).toEqual([
      {
        executionId: created.execution.execution_id,
        attemptId: "recovered-attempt-1",
        modelProfileId: "recovered-profile-1",
        routeName: "coding-balanced",
        batchId: "recovered-batch-1",
        preferenceApplied: true,
      },
    ]);
  });

  it("프로세스 재시작으로 live 구독 adapter가 사라진 checkpoint는 interrupted 복구를 요청한다", async () => {
    const interruptSuspended = vi.fn().mockResolvedValue({
      execution_id: "execution-restart",
      status: "interrupted",
    });
    const receipts = {
      read: vi.fn().mockResolvedValue({
        execution: { execution_id: "execution-restart", status: "suspended" },
        attempts: [{ checkpoint: { approvalId: "approval-restart" } }],
      }),
      recover: vi.fn(),
      interruptSuspended,
      recordRouteSessionAcquired: vi.fn(),
      recordInvocationStarted: vi.fn(),
      recordCheckpointObserved: vi.fn(),
      recordTerminalObserved: vi.fn(),
      recordSettlementCompleted: vi.fn(),
    };
    const interruptApproval = vi.fn().mockResolvedValue(undefined);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn() }, registry, undefined, undefined, {
      subscriptionReceipts: receipts as never,
      subscriptionApprovals: { consume: vi.fn(), interrupt: interruptApproval },
    });

    await expect(runner.recover(context, "execution-restart")).resolves.toMatchObject({ status: "interrupted" });
    expect(interruptSuspended).toHaveBeenCalledWith(context, "execution-restart");
    expect(interruptApproval).toHaveBeenCalledWith(context, {
      executionId: "execution-restart",
      approvalId: "approval-restart",
    });
    expect(receipts.recover).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 429", () => Object.assign(new Error("secret-429"), { statusCode: 429 }), "quota", true],
    ["HTTP 503", () => Object.assign(new Error("secret-503"), { statusCode: 503 }), "upstream", true],
    ["HTTP 408", () => Object.assign(new Error("secret-408"), { statusCode: 408 }), "timeout", true],
    ["HTTP 409", () => Object.assign(new Error("secret-409"), { statusCode: 409 }), "upstream", true],
    ["network", () => new TypeError("network-secret"), "network", true],
    ["timeout", () => Object.assign(new Error("timeout-secret"), { name: "TimeoutError" }), "timeout", true],
    ["HTTP 401", () => Object.assign(new Error("secret-401"), { statusCode: 401 }), "authentication", false],
    ["HTTP 402", () => Object.assign(new Error("secret-402"), { statusCode: 402 }), "billing", false],
    ["HTTP 403", () => Object.assign(new Error("secret-403"), { statusCode: 403 }), "policy", false],
    ["HTTP 418", () => Object.assign(new Error("secret-418"), { statusCode: 418 }), "input", false],
    ["output", () => new Error("Invalid JSON response"), "output", false],
    ["unknown", () => new Error("unknown-secret"), "unknown", false],
  ] as const)("직접 %s 실패의 분류를 영속·복구한다", async (_label, error, category, retryable) => {
    const runtimeInput = input();
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw error();
        },
      }),
    );
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(routed) },
      registry,
      new DirectExecutionLifecycle(new RuntimeRecovery(store, { getWorkflowState: async () => null })),
    );

    const result = await runner.execute(context, runtimeInput);
    const replayed = await store.findResultByCommand(context, runtimeInput.commandId);
    const recovered = await runner.recover(context, result.executionId);

    expect(result).toMatchObject({
      status: "failed",
      error: { category, retryable, userMessage: "Agent 실행이 종료됐습니다", causeId: expect.any(String) },
    });
    expect(result.error?.causeId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(replayed).toEqual(result);
    expect(recovered).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
