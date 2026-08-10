import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CopilotAcpConnector,
  GeminiCliAcpConnector,
  GrokBuildAcpConnector,
  normalizeCodexExecutionEvidence,
  SubscriptionStructuredOutputError,
  type AcpClientFactory,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
} from "@massion/runtime";
import { createEdgeWorkspaceExecutionCapability, createEdgeWorkspaceRootCapability } from "@massion/subscriptions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuiltinEdgeAgentAdapterFactory, EdgeRequestExecutor, type EdgeAgentAdapterFactory } from "./executor.js";
import { ConnectorIdentityStore } from "./identity-store.js";
import { ProviderReauthenticationRequiredError } from "./profile-health.js";
import type { ConnectorCancelFrame, ConnectorEventFrame, ConnectorRequestFrame } from "./protocol.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Edge Connector agent-turn 실행", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  const healthyProfile = {
    verify: async (input: { readonly expectedAuthKind: "cli-profile" | "api-key" }) => ({
      authKind: input.expectedAuthKind,
    }),
  };

  async function fixture(
    providerId:
      | "openai-codex"
      | "anthropic-claude-code"
      | "google-gemini-cli-enterprise"
      | "github-copilot"
      | "xai-grok-build" = "openai-codex",
  ) {
    const fixture = await fixtureDirectory("massion-connector-executor-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const outsideRoot = join(fixture.path, "outside");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    await mkdir(outsideRoot, { mode: 0o700 });
    const executable = join(fixture.path, "provider-cli");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const external = !new Set(["openai-codex", "anthropic-claude-code"]).has(providerId);
    const identityPath = join(fixture.path, "identity.json");
    const pending = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId,
      accountAlias: "개인 Provider",
      authKind: "cli-profile",
      billingKind: providerId === "google-gemini-cli-enterprise" ? "enterprise-subscription" : "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
      ...(external ? { runtimeArtifact: { executable, digest: "a".repeat(64), version: "1.2.3" } } : {}),
    });
    const identity = await new ConnectorIdentityStore(identityPath).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });
    return { identity, workspaceRoot, outsideRoot, executable };
  }

  function rootCapability(identity: Awaited<ReturnType<typeof fixture>>["identity"]): string {
    const capability = identity.capabilities.find((candidate) => candidate.startsWith("massion.workspace-root.v1."));
    if (!capability) throw new Error("테스트 작업공간 root capability가 없습니다");
    return capability;
  }

  function request(
    identity: Awaited<ReturnType<typeof fixture>>["identity"],
    overrides: Record<string, unknown> = {},
  ): ConnectorRequestFrame {
    const workspaceCapability = createEdgeWorkspaceExecutionCapability(rootCapability(identity), {
      organizationId: identity.organizationId,
      connectorId: identity.connectorId,
      providerId: identity.providerId,
      accountId: "account-12345678",
      routeAttemptId: "route-attempt-12345678",
      sessionLeaseId: "lease-12345678",
      executionId: "execution-12345678",
      workId: "work-12345678",
      agentHandle: "software-engineering.backend-specialist",
    });
    return {
      protocol: "massion.connector.v1",
      type: "request",
      requestId: "request-12345678",
      leaseId: "lease-12345678",
      operation: "agent-turn",
      payload: {
        providerId: identity.providerId,
        modelId: "gpt-5.6",
        accountId: "account-12345678",
        routeAttemptId: "route-attempt-12345678",
        sessionLeaseId: "lease-12345678",
        executionId: "execution-12345678",
        workId: "work-12345678",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "작업을 완료해주세요",
        workspaceCapability,
        allowedTools: [],
        disallowedTools: [],
        policy: { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false },
        ...overrides,
      },
    };
  }

  it("고정 profile과 검증된 workspace로 실행하고 data→usage→done을 단조 sequence로 반환한다", async () => {
    const { identity, workspaceRoot } = await fixture();
    const managedWorkspace = join(
      workspaceRoot,
      createHash("sha256").update(identity.organizationId).digest("hex"),
      createHash("sha256").update("work-12345678").digest("hex"),
    );
    let received: SubscriptionAgentInput | undefined;
    const executionEvidence = normalizeCodexExecutionEvidence(
      [
        {
          id: "command-edge-1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "Tests passed",
          exit_code: 0,
          status: "completed",
        },
      ],
      managedWorkspace,
    );
    if (!executionEvidence) throw new Error("Edge 실행 근거 fixture를 만들지 못했습니다");
    const adapter: SubscriptionAgentAdapter = {
      execute: async (_context, input) => {
        received = input;
        return {
          outcome: "completed",
          executionId: input.executionId,
          sessionId: "session-12345678",
          value: "완료했습니다",
          usage: { input_tokens: 12, output_tokens: 3 },
          executionEvidence,
        };
      },
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const factory: EdgeAgentAdapterFactory = { create: vi.fn(() => adapter) };
    const executor = new EdgeRequestExecutor({ identity, factory, healthProbe: healthyProfile });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity, { instruction: "변경 후 검증을 실행하세요" }), async (event) => {
      events.push(event);
    });

    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai-codex",
        modelId: "gpt-5.6",
        profileRoot: identity.profileRoot,
        workspaceRoot: managedWorkspace,
      }),
    );
    expect(received).toMatchObject({
      prompt: "변경 후 검증을 실행하세요\n\n작업을 완료해주세요",
      workspaceRoot: managedWorkspace,
      profileRoot: identity.profileRoot,
      environment: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    expect(managedWorkspace).not.toBe(workspaceRoot);
    expect(events.map((event) => [event.sequence, event.kind])).toEqual([
      [0, "data"],
      [1, "usage"],
      [2, "done"],
    ]);
    expect(events[1]?.payload).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(events[2]?.payload).toMatchObject({ executionEvidence });
    expect(events[2]?.payload).toMatchObject({ outcome: "completed", sessionId: "session-12345678" });
  });

  it("provider 불일치, workspace 탈출, 임의 env·header·provider option을 SDK 호출 전에 거부한다", async () => {
    const { identity, outsideRoot } = await fixture();
    const create = vi.fn();
    const executor = new EdgeRequestExecutor({ identity, factory: { create }, healthProbe: healthyProfile });
    const escapedRootCapability = createEdgeWorkspaceRootCapability(Buffer.alloc(32, 1), outsideRoot);
    const escapedWorkspaceCapability = createEdgeWorkspaceExecutionCapability(escapedRootCapability, {
      organizationId: identity.organizationId,
      connectorId: identity.connectorId,
      providerId: "openai-codex",
      accountId: "account-12345678",
      routeAttemptId: "route-attempt-12345678",
      sessionLeaseId: "lease-12345678",
      executionId: "execution-12345678",
      workId: "work-12345678",
      agentHandle: "software-engineering.backend-specialist",
    });
    for (const invalid of [
      request(identity, { providerId: "anthropic-claude-code" }),
      request(identity, { workspaceCapability: escapedWorkspaceCapability }),
      request(identity, { workspaceCapability: "../../outside" }),
      request(identity, { workspaceRoot: outsideRoot }),
      request(identity, { environment: { SECRET: "never" } }),
      request(identity, { headers: { authorization: "Bearer never" } }),
      request(identity, { providerOptions: { baseUrl: "https://attacker.invalid" } }),
    ]) {
      const events: ConnectorEventFrame[] = [];
      await executor.execute(invalid, async (event) => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sequence: 0,
        kind: "error",
        payload: { category: "invalid-request", retryable: false, sideEffectsStarted: false },
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("Adapter가 반환한 검증되지 않은 실행 근거를 외부 성공 frame으로 내보내지 않는다", async () => {
    const { identity } = await fixture();
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "completed",
        executionId: "execution-12345678",
        sessionId: "session-12345678",
        value: "완료",
        executionEvidence: { schemaVersion: "forged" },
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    } as SubscriptionAgentAdapter;
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
    });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity), async (event) => events.push(event));

    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ category: "provider-runtime-error", sideEffectsStarted: true }),
      }),
    ]);
  });

  it("generate·ACP·승인 대기 결과는 명시적인 fail-closed error로 끝낸다", async () => {
    const { identity } = await fixture();
    const adapter: SubscriptionAgentAdapter = {
      execute: async (context, input): Promise<SubscriptionAgentResult> => ({
        outcome: "suspended",
        executionId: input.executionId,
        sessionId: "session-12345678",
        approvalId: `approval-${context.userId}`,
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
    });
    const unsupported = { ...request(identity), operation: "generate" as const };
    const unsupportedEvents: ConnectorEventFrame[] = [];
    await executor.execute(unsupported, async (event) => {
      unsupportedEvents.push(event);
    });
    expect(unsupportedEvents[0]).toMatchObject({
      kind: "error",
      payload: { category: "unsupported-operation", sideEffectsStarted: false },
    });

    const suspendedEvents: ConnectorEventFrame[] = [];
    await executor.execute(request(identity), async (event) => {
      suspendedEvents.push(event);
    });
    expect(suspendedEvents[0]).toMatchObject({
      kind: "error",
      payload: { category: "unsupported-terminal", sideEffectsStarted: true },
    });
  });

  it("cancel frame과 SIGTERM shutdown이 정확한 실행만 취소한다", async () => {
    const { identity } = await fixture();
    let finish: ((result: SubscriptionAgentResult) => void) | undefined;
    const cancel = vi.fn(async (_context, executionId: string) => {
      finish?.({
        outcome: "cancelled",
        executionId,
        emittedTokens: 2,
        usage: { inputTokens: 8, outputTokens: 37 },
      });
    });
    const adapter: SubscriptionAgentAdapter = {
      execute: async (context, input) => {
        void context;
        void input;
        return await new Promise<SubscriptionAgentResult>((resolve) => {
          finish = resolve;
        });
      },
      resume: vi.fn(),
      cancel,
    };
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
    });
    const events: ConnectorEventFrame[] = [];
    const running = executor.execute(request(identity), async (event) => {
      events.push(event);
    });
    await vi.waitFor(() => expect(executor.activeRequests).toBe(1));
    const cancelFrame: ConnectorCancelFrame = {
      protocol: "massion.connector.v1",
      type: "cancel",
      requestId: "request-12345678",
      leaseId: "lease-12345678",
      reason: "shutdown",
    };
    await executor.cancel(cancelFrame);
    await running;
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: identity.organizationId }),
      "execution-12345678",
    );
    expect(events).toEqual([
      expect.objectContaining({
        sequence: 0,
        kind: "usage",
        payload: { inputTokens: 8, outputTokens: 37 },
      }),
      expect.objectContaining({
        sequence: 1,
        kind: "error",
        payload: expect.objectContaining({
          category: "cancelled",
          emittedTokens: 2,
          usage: { inputTokens: 8, outputTokens: 37 },
        }),
      }),
    ]);
    expect(executor.activeRequests).toBe(0);
  });

  it("SDK 원문 오류의 token·email·경로를 event나 log로 노출하지 않는다", async () => {
    const { identity } = await fixture();
    const adapter: SubscriptionAgentAdapter = {
      execute: () =>
        Promise.reject(new Error("Bearer sk-secret-for-test user@example.com /Users/private/.codex/auth.json")),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const log = vi.fn();
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
      log,
    });
    const events: ConnectorEventFrame[] = [];
    await executor.execute(request(identity), async (event) => {
      events.push(event);
    });
    const output = JSON.stringify({ events, logs: log.mock.calls });
    expect(output).not.toContain("sk-secret-for-test");
    expect(output).not.toContain("user@example.com");
    expect(output).not.toContain("/Users/private");
    expect(events[0]).toMatchObject({
      kind: "error",
      payload: {
        category: "provider-runtime-error",
        retryable: false,
        signal: { kind: "unknown" },
        emittedTokens: 0,
        sideEffectsStarted: true,
      },
    });
    expect(events[0]?.payload).not.toHaveProperty("usage");
  });

  it("구조화 출력 실패가 확인한 usage·출력 조각·부작용을 원문 없이 failure frame에 보존한다", async () => {
    const { identity } = await fixture();
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn(),
      executeStructured: vi.fn().mockRejectedValue(
        new SubscriptionStructuredOutputError("secret structured output", {
          sideEffectsStarted: true,
          emittedTokens: 2,
          usage: { inputTokens: 8, outputTokens: 37 },
        }),
      ),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
    });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(
      request(identity, {
        output: {
          name: "result",
          description: "검증된 결과",
          jsonSchema: { type: "object", properties: { result: { type: "string" } } },
        },
      }),
      async (event) => events.push(event),
    );

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 0,
        kind: "usage",
        payload: { inputTokens: 8, outputTokens: 37 },
      }),
      expect.objectContaining({
        sequence: 1,
        kind: "error",
        payload: {
          category: "provider-runtime-error",
          retryable: false,
          signal: { kind: "unknown" },
          emittedTokens: 2,
          sideEffectsStarted: true,
          usage: { inputTokens: 8, outputTokens: 37 },
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("secret structured output");
  });

  it("workspace capability를 다른 조직·Connector·Work 계보에서 재사용하지 못한다", async () => {
    const { identity } = await fixture();
    const create = vi.fn();
    const executor = new EdgeRequestExecutor({ identity, factory: { create }, healthProbe: healthyProfile });
    const registeredRoot = rootCapability(identity);
    const changedOrganization = createEdgeWorkspaceExecutionCapability(registeredRoot, {
      organizationId: "organization-other-12345678",
      connectorId: identity.connectorId,
      providerId: identity.providerId,
      accountId: "account-12345678",
      routeAttemptId: "route-attempt-12345678",
      sessionLeaseId: "lease-12345678",
      executionId: "execution-12345678",
      workId: "work-12345678",
      agentHandle: "software-engineering.backend-specialist",
    });
    const changedConnector = createEdgeWorkspaceExecutionCapability(registeredRoot, {
      organizationId: identity.organizationId,
      connectorId: "connector-other-12345678",
      providerId: identity.providerId,
      accountId: "account-12345678",
      routeAttemptId: "route-attempt-12345678",
      sessionLeaseId: "lease-12345678",
      executionId: "execution-12345678",
      workId: "work-12345678",
      agentHandle: "software-engineering.backend-specialist",
    });
    const requests = [
      request(identity, { workspaceCapability: changedOrganization }),
      request(identity, { workspaceCapability: changedConnector }),
      request(identity, { workId: "work-other-12345678" }),
      request(identity, { executionId: "execution-other-12345678" }),
      request(identity, { accountId: "account-other-12345678" }),
    ];

    for (const invalid of requests) {
      const events: ConnectorEventFrame[] = [];
      await executor.execute(invalid, async (event) => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "error",
        payload: { category: "invalid-request", sideEffectsStarted: false },
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("등록 후 로컬 root가 symlink로 바뀌면 capability 해석을 fail-closed한다", async () => {
    const { identity, workspaceRoot, outsideRoot } = await fixture();
    await rm(workspaceRoot, { recursive: true });
    await symlink(outsideRoot, workspaceRoot, "dir");
    const create = vi.fn();
    const executor = new EdgeRequestExecutor({ identity, factory: { create }, healthProbe: healthyProfile });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity), async (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      kind: "error",
      payload: { category: "invalid-request", sideEffectsStarted: false },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("실행 직전 profile 재검사가 실패하면 SDK를 시작하지 않고 needs-reauth event를 보낸다", async () => {
    const { identity } = await fixture();
    const create = vi.fn();
    const healthProbe = { verify: vi.fn(() => Promise.reject(new ProviderReauthenticationRequiredError())) };
    const executor = new EdgeRequestExecutor({ identity, factory: { create }, healthProbe });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity), async (event) => {
      events.push(event);
    });

    expect(healthProbe.verify).toHaveBeenCalledWith({
      providerId: identity.providerId,
      profileRoot: identity.profileRoot,
      expectedAuthKind: identity.authKind,
      billingKind: identity.billingKind,
    });
    expect(events).toEqual([
      expect.objectContaining({
        sequence: 0,
        kind: "error",
        payload: {
          category: "needs-reauth",
          retryable: false,
          signal: { kind: "http", statusCode: 401 },
          emittedTokens: 0,
          sideEffectsStarted: false,
        },
      }),
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("adapter가 확인한 출력·부작용·HTTP 실패를 원문 없이 그대로 보존한다", async () => {
    const { identity } = await fixture();
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "failed",
        executionId: "execution-12345678",
        category: "rate-limit",
        retryable: true,
        signal: { kind: "http", statusCode: 429, retryAfter: "120" },
        emittedTokens: 2,
        sideEffectsStarted: false,
        usage: { inputTokens: 8, outputTokens: 2 },
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create: () => adapter },
      healthProbe: healthyProfile,
    });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity), async (event) => {
      events.push(event);
    });

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 0,
        kind: "usage",
        payload: { inputTokens: 8, outputTokens: 2 },
      }),
      expect.objectContaining({
        sequence: 1,
        kind: "error",
        payload: {
          category: "rate-limit",
          retryable: true,
          signal: { kind: "http", statusCode: 429, retryAfter: "120" },
          emittedTokens: 2,
          sideEffectsStarted: false,
          usage: { inputTokens: 8, outputTokens: 2 },
        },
      }),
    ]);
  });

  it.each([
    ["google-gemini-cli-enterprise", GeminiCliAcpConnector],
    ["github-copilot", CopilotAcpConnector],
    ["xai-grok-build", GrokBuildAcpConnector],
  ] as const)(
    "%s Edge factory가 증명된 실행 파일과 실제 model ID로 공식 ACP adapter를 만든다",
    async (providerId, Adapter) => {
      const { identity, workspaceRoot } = await fixture(providerId);
      const acpCreate = vi.fn().mockResolvedValue({
        openSession: vi.fn().mockResolvedValue({
          sessionId: "session-acp",
          prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
          cancel: vi.fn(),
        }),
        close: vi.fn(),
      });
      const factory = new BuiltinEdgeAgentAdapterFactory({ create: acpCreate } satisfies AcpClientFactory);
      const adapter = factory.create({
        providerId,
        modelId: "official-model-id",
        accountId: "account-12345678",
        workspaceRoot,
        profileRoot: identity.profileRoot,
        policy: { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false },
        runtimeArtifact: identity.runtimeArtifact,
      });
      expect(adapter).toBeInstanceOf(Adapter);

      await adapter.execute(
        {
          organizationId: identity.organizationId,
          userId: identity.ownerUserId,
          membershipId: identity.membershipId,
          role: identity.role,
        },
        {
          executionId: "execution-acp",
          workId: "work-acp",
          agentHandle: "software-engineering.backend-specialist",
          prompt: "검증하세요",
          workspaceRoot,
          profileRoot: identity.profileRoot,
          environment: { PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
          allowedTools: [],
          disallowedTools: [],
        },
      );

      const createInput = acpCreate.mock.calls[0]?.[0];
      if (!createInput) throw new Error("ACP factory 입력이 필요합니다");
      expect(createInput.fileSystem).toBeDefined();
      if (providerId === "google-gemini-cli-enterprise") expect(createInput.args).toContain("--sandbox");
      if (providerId === "xai-grok-build")
        expect(createInput.args).toEqual(expect.arrayContaining(["--sandbox", "strict"]));

      const requestPermission = createInput.requestPermission as (request: unknown) => Promise<unknown>;
      await expect(
        requestPermission({
          sessionId: "session-acp",
          toolCall: { toolCallId: "tool-1", kind: "edit", locations: [{ path: join(workspaceRoot, "file.ts") }] },
          options: [
            { optionId: "reject", name: "Reject", kind: "reject_once" },
            { optionId: "allow", name: "Allow", kind: "allow_once" },
          ],
        }),
      ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      await expect(
        requestPermission({
          sessionId: "session-acp",
          toolCall: { toolCallId: "tool-2", kind: "execute" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }),
      ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    },
  );

  it("읽기 전용 정책은 workspace 내부라도 ACP 편집을 거부하고 읽기만 허용한다", async () => {
    const { identity, workspaceRoot } = await fixture("github-copilot");
    const acpCreate = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-read-only",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const adapter = new BuiltinEdgeAgentAdapterFactory({ create: acpCreate } satisfies AcpClientFactory).create({
      providerId: "github-copilot",
      modelId: "official-model-id",
      accountId: "account-12345678",
      workspaceRoot,
      profileRoot: identity.profileRoot,
      policy: { sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false },
      runtimeArtifact: identity.runtimeArtifact,
    });
    await adapter.execute(
      {
        organizationId: identity.organizationId,
        userId: identity.ownerUserId,
        membershipId: identity.membershipId,
        role: identity.role,
      },
      {
        executionId: "execution-read-only",
        workId: "work-read-only",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot,
        profileRoot: identity.profileRoot,
        environment: { PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        allowedTools: [],
        disallowedTools: [],
      },
    );

    const requestPermission = acpCreate.mock.calls[0]?.[0].requestPermission as (request: unknown) => Promise<unknown>;
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }] as const;
    await expect(
      requestPermission({
        sessionId: "session-read-only",
        toolCall: { toolCallId: "tool-read", kind: "read", locations: [{ path: join(workspaceRoot, "file.ts") }] },
        options,
      }),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await expect(
      requestPermission({
        sessionId: "session-read-only",
        toolCall: { toolCallId: "tool-edit", kind: "edit", locations: [{ path: join(workspaceRoot, "file.ts") }] },
        options,
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("실행 직전 외부 runtime digest가 달라지면 profile·ACP process 전에 fail-closed한다", async () => {
    const { identity } = await fixture("github-copilot");
    const create = vi.fn();
    const healthProbe = { verify: vi.fn() };
    const runtimeAttestor = vi.fn(() => Promise.reject(new Error("digest changed /Users/private")));
    const executor = new EdgeRequestExecutor({
      identity,
      factory: { create },
      healthProbe,
      runtimeAttestor,
    });
    const events: ConnectorEventFrame[] = [];

    await executor.execute(request(identity), async (event) => events.push(event));

    expect(runtimeAttestor).toHaveBeenCalledWith("github-copilot", identity.runtimeArtifact);
    expect(healthProbe.verify).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      kind: "error",
      payload: { category: "invalid-request", sideEffectsStarted: false },
    });
    expect(JSON.stringify(events)).not.toContain("/Users/private");
  });
});
