import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TenantContext } from "@massion/identity";
import type {
  ConnectorRuntimeResolutionInput,
  SubscriptionAgentAdapter,
  SubscriptionAgentInput,
  SubscriptionAgentResult,
} from "@massion/runtime";
import { normalizeCodexExecutionEvidence, SubscriptionStructuredOutputError } from "@massion/runtime";
import type {
  ConnectorEvent,
  ConnectorSessionLease,
  SubscriptionAccount,
  SubscriptionConnector,
} from "@massion/subscriptions";
import { createEdgeWorkspaceExecutionCapability, createEdgeWorkspaceRootCapability } from "@massion/subscriptions";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MassionSubscriptionRuntimeResolver,
  subscriptionAgentAdapterId,
  type NativeSubscriptionAgentFactory,
  type SubscriptionRuntimeBroker,
  type SubscriptionRuntimeResolverOptions,
} from "./subscription-runtime-resolver.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const roots: string[] = [];
const EDGE_ROOT_CAPABILITY = createEdgeWorkspaceRootCapability(Buffer.alloc(32, 9), "/edge/local/workspace");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function account(overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    account_id: "account-1",
    organization_id: context.organizationId,
    owner_user_id: context.userId,
    provider_id: "openai-codex",
    alias: "업무 계정",
    scope: "personal",
    connector_id: "connector-1",
    profile_fingerprint: "redacted-fingerprint",
    billing_kind: "consumer-subscription",
    status: "active",
    consent_version: 0,
    version: 1,
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function connector(overrides: Partial<SubscriptionConnector> = {}): SubscriptionConnector {
  return {
    connector_id: "connector-1",
    organization_id: context.organizationId,
    owner_user_id: context.userId,
    location: "server",
    execution_kind: "agent-runtime",
    protocol: "massion.connector.v1",
    version: "1.0.0",
    public_key: "public-key",
    capabilities: ["openai-codex"],
    status: "ready",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function edgeAgentConnector(overrides: Partial<SubscriptionConnector> = {}): SubscriptionConnector {
  return connector({
    location: "edge",
    capabilities: ["openai-codex", EDGE_ROOT_CAPABILITY],
    ...overrides,
  });
}

function lease(overrides: Partial<ConnectorSessionLease> = {}): ConnectorSessionLease {
  return {
    leaseId: "lease-1",
    executionId: "execution-1",
    accountId: "account-1",
    connectorId: "connector-1",
    workId: "work-1",
    agentHandle: "software-engineering.engineering-lead",
    routeAttemptId: "attempt-1",
    quotaSnapshotId: "quota-1",
    status: "active",
    expiresAt: "2026-07-12T01:00:00.000Z",
    complete: vi.fn(),
    fail: vi.fn(),
    renew: vi.fn(),
    ...overrides,
  };
}

function resolution(overrides: Partial<ConnectorRuntimeResolutionInput> = {}): ConnectorRuntimeResolutionInput {
  return {
    executionId: "execution-1",
    workId: "work-1",
    taskId: "task-1",
    agentHandle: "software-engineering.engineering-lead",
    workspaceAccess: "workspace-write",
    workspaceCapability: "workspace-capability-1",
    workspaceRoot: "/untrusted/request/path",
    providerId: "openai-codex",
    modelId: "gpt-5.6-codex",
    accountId: "account-1",
    connectorId: "connector-1",
    scope: "personal",
    routeAttemptId: "attempt-1",
    quotaSnapshotId: "quota-1",
    sessionLeaseId: "lease-1",
    ...overrides,
  };
}

class TestBroker implements SubscriptionRuntimeBroker {
  public readonly invocations: Array<{
    input: unknown;
    signal?: AbortSignal;
  }> = [];

  public constructor(
    private readonly currentLease: ConnectorSessionLease,
    private readonly events: readonly ConnectorEvent[] = [],
  ) {}

  public getLease(): Promise<ConnectorSessionLease> {
    return Promise.resolve(this.currentLease);
  }

  public async *invoke(_context: TenantContext, input: unknown, signal?: AbortSignal): AsyncIterable<ConnectorEvent> {
    this.invocations.push({ input, ...(signal ? { signal } : {}) });
    for (const event of this.events) yield event;
  }
}

async function options(
  input: {
    currentAccount?: SubscriptionAccount;
    currentConnector?: SubscriptionConnector;
    currentLease?: ConnectorSessionLease;
    events?: readonly ConnectorEvent[];
    nativeFactory?: NativeSubscriptionAgentFactory;
    executableAllowlist?: Readonly<Record<string, string>>;
  } = {},
): Promise<SubscriptionRuntimeResolverOptions & { readonly broker: TestBroker; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "massion-subscription-runtime-"));
  roots.push(root);
  const currentAccount = input.currentAccount ?? account();
  const currentConnector = input.currentConnector ?? connector();
  const broker = new TestBroker(input.currentLease ?? lease(), input.events);
  return {
    root,
    accounts: { requireUsable: vi.fn().mockResolvedValue(currentAccount) },
    connectors: { get: vi.fn().mockResolvedValue(currentConnector) },
    broker,
    workspaceCapabilities: {
      verify: vi.fn().mockResolvedValue({
        workspaceRoot: "/approved/capability/workspace",
        workspaceAccess: "workspace-write",
        allowedTools: [],
        disallowedTools: [],
      }),
    },
    policies: {
      resolve: vi.fn().mockResolvedValue({
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        permissionMode: "governed",
        autonomyRevision: 0,
      }),
    },
    profileRoot: root,
    executableAllowlist: input.executableAllowlist ?? {
      codex: "/opt/massion/connectors/codex",
      claude: "/opt/massion/connectors/claude",
      gemini: "/opt/massion/connectors/gemini",
      copilot: "/opt/massion/connectors/copilot",
      grok: "/opt/massion/connectors/grok",
      antigravity: "/opt/massion/connectors/agy",
    },
    ...(input.nativeFactory ? { nativeFactory: input.nativeFactory } : {}),
  };
}

describe("구독 실행 해석기", () => {
  it("내장 Agent 제공자를 정확한 adapter에 fail-closed로 매핑한다", () => {
    expect(subscriptionAgentAdapterId("openai-codex")).toBe("codex");
    expect(subscriptionAgentAdapterId("anthropic-claude-code")).toBe("claude");
    expect(subscriptionAgentAdapterId("google-gemini-cli-enterprise")).toBe("gemini-acp");
    expect(subscriptionAgentAdapterId("github-copilot")).toBe("copilot-acp");
    expect(subscriptionAgentAdapterId("xai-grok-build")).toBe("grok-acp");
    expect(subscriptionAgentAdapterId("google-antigravity-cli")).toBe("antigravity");
    expect(() => subscriptionAgentAdapterId("unknown-provider")).toThrow("지원하지 않는 구독 Provider");
    expect(() => subscriptionAgentAdapterId("minimax-token-plan")).toThrow("Agent runtime이 아닙니다");
  });

  it("서버 실행은 승인된 workspace와 owner-only 계정 profile 및 allowlist 실행 파일만 사용한다", async () => {
    const unsafeAccountId = "../../secret@example.com/profile";
    let agentInput: SubscriptionAgentInput | undefined;
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockImplementation((_context, input: SubscriptionAgentInput) => {
        agentInput = input;
        return Promise.resolve({
          outcome: "completed",
          executionId: input.executionId,
          sessionId: "provider-session-1",
          value: "완료",
        });
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const create = vi.fn().mockReturnValue(adapter);
    const configured = await options({
      currentAccount: account({
        account_id: unsafeAccountId,
        profile_fingerprint: "/Users/private/.config/raw-profile-locator",
      }),
      currentLease: lease({ accountId: unsafeAccountId }),
      nativeFactory: { create },
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    const binding = await resolver.resolve(context, resolution({ accountId: unsafeAccountId }));
    expect(binding.kind).toBe("agent-runtime");
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    await expect(
      binding.executor.execute({ executionId: "execution-1", prompt: "작업을 수행하세요" }),
    ).resolves.toMatchObject({
      outcome: "completed",
      value: "완료",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "codex",
        executable: "/opt/massion/connectors/codex",
        modelId: "gpt-5.6-codex",
        policy: {
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          permissionMode: "governed",
          autonomyRevision: 0,
        },
      }),
    );
    expect(agentInput).toMatchObject({
      workspaceRoot: "/approved/capability/workspace",
      allowedTools: [],
      disallowedTools: [],
      environment: { PATH: "/opt/massion/connectors", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    expect(agentInput?.profileRoot.startsWith(`${await realpath(configured.root)}/`)).toBe(true);
    expect((await stat(agentInput?.profileRoot ?? "")).mode & 0o077).toBe(0);
    expect(JSON.stringify(agentInput)).not.toContain("HOME");
    expect(JSON.stringify(agentInput)).not.toMatch(/secret@example\.com|Users\/private|raw-profile-locator/u);
    expect(configured.workspaceCapabilities.verify).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        taskId: "task-1",
        workspaceAccess: "workspace-write",
        workspaceCapability: "workspace-capability-1",
      }),
    );
    expect(configured.policies.resolve).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        taskId: "task-1",
        workspaceAccess: "workspace-write",
        workspaceRoot: "/approved/capability/workspace",
      }),
    );
  });

  it("Codex·Claude는 명시 override가 없으면 pinned SDK bundled runtime을 사용한다", async () => {
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "completed",
        executionId: "execution-1",
        sessionId: "provider-session-1",
        value: "완료",
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const create = vi.fn().mockReturnValue(adapter);
    const configured = await options({ nativeFactory: { create }, executableAllowlist: {} });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    const binding = await resolver.resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    await binding.executor.execute({ executionId: "execution-1", prompt: "기본 설치" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "codex", executable: undefined }));
  });

  it("native 실행의 abortSignal을 adapter cancel에 연결하고 listener를 정리한다", async () => {
    let finish: ((result: SubscriptionAgentResult) => void) | undefined;
    const cancel = vi.fn().mockImplementation(() => {
      finish?.({ outcome: "cancelled", executionId: "execution-1", sessionId: "provider-session-1" });
      return Promise.resolve();
    });
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockImplementation(
        () =>
          new Promise<SubscriptionAgentResult>((resolveExecution) => {
            finish = resolveExecution;
          }),
      ),
      resume: vi.fn(),
      cancel,
    };
    const configured = await options({ nativeFactory: { create: vi.fn().mockReturnValue(adapter) } });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);
    const binding = await resolver.resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const execution = binding.executor.execute({
      executionId: "execution-1",
      prompt: "취소 대기",
      abortSignal: controller.signal,
    });
    controller.abort("사용자 취소");

    await expect(execution).resolves.toMatchObject({ outcome: "cancelled" });
    expect(cancel).toHaveBeenCalledWith(context, "execution-1");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("별도 capability verifier가 거부한 workspace를 adapter에 전달하지 않는다", async () => {
    const create = vi.fn();
    const configured = await options({ nativeFactory: { create } });
    vi.mocked(configured.workspaceCapabilities.verify).mockRejectedValue(new Error("workspace capability denied"));
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    await expect(resolver.resolve(context, resolution())).rejects.toThrow("workspace capability denied");
    expect(create).not.toHaveBeenCalled();
  });

  it("계정·Connector·Provider·Session Lease 계보가 다르면 실행을 거부한다", async () => {
    const configured = await options({
      currentAccount: account({ provider_id: "anthropic-claude-code", alias: "secret@example.com" }),
      currentLease: lease({ routeAttemptId: "different-attempt" }),
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    const error = await resolver.resolve(context, resolution()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("계보가 일치하지 않습니다");
    expect(JSON.stringify(error)).not.toContain("secret@example.com");
    expect(configured.broker.invocations).toHaveLength(0);
  });

  it("조직에 공유된 계정을 다른 사용자가 실행해도 Connector 소유자는 계정 소유자와 같아야 한다", async () => {
    const sharedContext: TenantContext = {
      ...context,
      userId: "organization-member-2",
      membershipId: "membership-2",
      role: "member",
    };
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const create = vi.fn().mockReturnValue(adapter);
    const configured = await options({
      currentAccount: account({ scope: "organization", owner_user_id: "account-owner-1" }),
      currentConnector: connector({ owner_user_id: "organization-member-2" }),
      nativeFactory: { create },
    });

    await expect(
      new MassionSubscriptionRuntimeResolver(configured).resolve(sharedContext, resolution({ scope: "organization" })),
    ).rejects.toThrow("계보가 일치하지 않습니다");
    expect(create).not.toHaveBeenCalled();
  });

  it("정본 port가 알 수 없는 Connector 위치를 반환해도 server로 간주하지 않는다", async () => {
    const configured = await options({
      currentConnector: connector({ location: "cloud" as never }),
      nativeFactory: { create: vi.fn() },
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    await expect(resolver.resolve(context, resolution())).rejects.toThrow("계보가 일치하지 않습니다");
  });

  it("Edge model frame을 AI SDK 결과로 변환하고 lease·route 계보를 유지한다", async () => {
    const currentAccount = account({
      provider_id: "minimax-token-plan",
      billing_kind: "token-plan",
    });
    const currentConnector = connector({
      location: "edge",
      execution_kind: "model",
      capabilities: ["minimax-token-plan"],
    });
    const configured = await options({
      currentAccount,
      currentConnector,
      events: [
        { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "안녕" } },
        { kind: "usage", sequence: 1, payload: { inputTokens: 7, outputTokens: 2 } },
        { kind: "done", sequence: 2, payload: { finishReason: "stop" } },
      ],
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    const binding = await resolver.resolve(
      context,
      resolution({ providerId: "minimax-token-plan", modelId: "MiniMax-M3" }),
    );
    expect(binding.kind).toBe("model");
    if (binding.kind !== "model") throw new Error("Model binding이 필요합니다");
    if (typeof binding.model === "string" || binding.model.specificationVersion !== "v3") {
      throw new Error("V3 Model binding이 필요합니다");
    }
    const result = await binding.model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "인사하세요" }] }],
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "안녕" }],
      finishReason: { unified: "stop" },
      usage: { inputTokens: { total: 7 }, outputTokens: { total: 2 } },
    });
    expect(configured.broker.invocations[0]?.input).toMatchObject({
      protocol: "massion.connector.v1",
      leaseId: "lease-1",
      operation: "generate",
      payload: {
        providerId: "minimax-token-plan",
        modelId: "MiniMax-M3",
        routeAttemptId: "attempt-1",
        sessionLeaseId: "lease-1",
      },
    });
  });

  it("검증된 server provisioning 정본이 없는 model Connector를 실행하지 않는다", async () => {
    const configured = await options({
      currentAccount: account({ provider_id: "minimax-token-plan" }),
      currentConnector: connector({
        location: "server",
        execution_kind: "model",
        capabilities: ["minimax-token-plan"],
      }),
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    await expect(resolver.resolve(context, resolution({ providerId: "minimax-token-plan" }))).rejects.toThrow(
      "provisioning 정본",
    );
    expect(configured.broker.invocations).toHaveLength(0);
  });

  it("Edge model의 usage 이전·이후 frame 순서 위반을 거부한다", async () => {
    const configured = await options({
      currentAccount: account({ provider_id: "minimax-token-plan" }),
      currentConnector: connector({
        location: "edge",
        execution_kind: "model",
        capabilities: ["minimax-token-plan"],
      }),
      events: [
        { kind: "usage", sequence: 0, payload: { inputTokens: 1, outputTokens: 1 } },
        { kind: "data", sequence: 1, payload: { type: "text-delta", delta: "늦은 frame" } },
        { kind: "done", sequence: 2, payload: { finishReason: "stop" } },
      ],
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);
    const binding = await resolver.resolve(context, resolution({ providerId: "minimax-token-plan" }));
    if (binding.kind !== "model") throw new Error("Model binding이 필요합니다");
    if (typeof binding.model === "string" || binding.model.specificationVersion !== "v3") {
      throw new Error("V3 Model binding이 필요합니다");
    }

    await expect(
      binding.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "실패" }] }] }),
    ).rejects.toThrow("frame 순서");
  });

  it("Edge Agent 결과와 사용량을 변환하되 원격 suspend capability를 과장하지 않는다", async () => {
    const executionEvidence = normalizeCodexExecutionEvidence(
      [
        {
          id: "command-edge-agent-1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "Tests passed",
          exit_code: 0,
          status: "completed",
        },
      ],
      "/workspace",
    );
    if (!executionEvidence) throw new Error("Edge 실행 근거 fixture를 만들지 못했습니다");
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "완료" } },
        { kind: "usage", sequence: 1, payload: { inputTokens: 4, outputTokens: 1 } },
        {
          kind: "done",
          sequence: 2,
          payload: { outcome: "completed", sessionId: "remote-session-1", executionEvidence },
        },
      ],
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);
    const binding = await resolver.resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "작업" })).resolves.toEqual({
      outcome: "completed",
      executionId: "execution-1",
      sessionId: "remote-session-1",
      value: "완료",
      usage: { inputTokens: 4, outputTokens: 1 },
      executionEvidence,
    });
    expect(configured.broker.invocations[0]?.input.payload).toMatchObject({
      policy: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
      },
    });
    expect(configured.broker.invocations[0]?.input.payload).not.toHaveProperty("policy.permissionMode");
    expect(configured.broker.invocations[0]?.input.payload).not.toHaveProperty("policy.autonomyRevision");

    const suspended = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        {
          kind: "done",
          sequence: 0,
          payload: { outcome: "suspended", sessionId: "session", approvalId: "approval" },
        },
      ],
    });
    const suspendedBinding = await new MassionSubscriptionRuntimeResolver(suspended).resolve(context, resolution());
    if (suspendedBinding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    await expect(suspendedBinding.executor.execute({ executionId: "execution-1", prompt: "승인" })).rejects.toThrow(
      "지원하지 않는 terminal 결과",
    );

    const malformed = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        {
          kind: "done",
          sequence: 0,
          payload: {
            outcome: "completed",
            sessionId: "remote-session-1",
            executionEvidence: { schemaVersion: "forged" },
          },
        },
      ],
    });
    const malformedBinding = await new MassionSubscriptionRuntimeResolver(malformed).resolve(context, resolution());
    if (malformedBinding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    await expect(malformedBinding.executor.execute({ executionId: "execution-1", prompt: "작업" })).rejects.toThrow(
      "실행 근거",
    );
  });

  it("Edge Agent에는 서버 절대 경로 대신 조직·Work·실행 계보에 묶인 불투명 workspace capability만 보낸다", async () => {
    const configured = await options({
      currentConnector: connector({
        location: "edge",
        capabilities: ["openai-codex", EDGE_ROOT_CAPABILITY],
      }),
      events: [
        {
          kind: "done",
          sequence: 0,
          payload: { outcome: "completed", sessionId: "remote-session-1" },
        },
      ],
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);
    const binding = await resolver.resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await binding.executor.execute({ executionId: "execution-1", prompt: "경로 비공개" });

    const invocation = configured.broker.invocations[0]?.input as {
      readonly payload?: Record<string, unknown>;
    };
    const expected = createEdgeWorkspaceExecutionCapability(EDGE_ROOT_CAPABILITY, {
      organizationId: context.organizationId,
      connectorId: "connector-1",
      providerId: "openai-codex",
      accountId: "account-1",
      routeAttemptId: "attempt-1",
      sessionLeaseId: "lease-1",
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.engineering-lead",
    });
    expect(invocation.payload).toMatchObject({
      accountId: "account-1",
      workspaceCapability: expected,
    });
    expect(invocation.payload).not.toHaveProperty("workspaceRoot");
    expect(JSON.stringify(invocation)).not.toContain("/approved/capability/workspace");
    expect(JSON.stringify(invocation)).not.toContain("/untrusted/request/path");
  });

  it("승인 transport가 없는 Edge Agent에 on-request 정책을 연결하지 않는다", async () => {
    const configured = await options({ currentConnector: edgeAgentConnector() });
    vi.mocked(configured.policies.resolve).mockResolvedValue({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      permissionMode: "governed",
      autonomyRevision: 0,
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);

    await expect(resolver.resolve(context, resolution())).rejects.toThrow("승인 transport");
    expect(configured.broker.invocations).toHaveLength(0);
  });

  it("Codex native on-request 정책은 app-server 승인 adapter까지 전달한다", async () => {
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "completed",
        executionId: "execution-1",
        sessionId: "thread-review",
        value: "완료",
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const create = vi.fn().mockReturnValue(adapter);
    const configured = await options({ nativeFactory: { create } });
    vi.mocked(configured.policies.resolve).mockResolvedValue({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      permissionMode: "governed",
      autonomyRevision: 0,
    });

    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());

    expect(binding.kind).toBe("agent-runtime");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "codex",
        modelId: "gpt-5.6-codex",
        policy: expect.objectContaining({ approvalPolicy: "on-request" }),
      }),
    );
  });

  it("deny 승인 방식은 native·Edge provider 호출 전에 실행을 차단한다", async () => {
    const create = vi.fn();
    const native = await options({ nativeFactory: { create } });
    vi.mocked(native.policies.resolve).mockResolvedValue({
      sandboxMode: "workspace-write",
      approvalPolicy: "deny",
      networkAccessEnabled: false,
      permissionMode: "governed",
      autonomyRevision: 0,
    });
    await expect(new MassionSubscriptionRuntimeResolver(native).resolve(context, resolution())).rejects.toThrow(
      "조직 정책에서 차단",
    );
    expect(create).not.toHaveBeenCalled();
    expect(native.broker.invocations).toHaveLength(0);

    const edge = await options({ currentConnector: edgeAgentConnector() });
    vi.mocked(edge.policies.resolve).mockResolvedValue({
      sandboxMode: "workspace-write",
      approvalPolicy: "deny",
      networkAccessEnabled: false,
      permissionMode: "governed",
      autonomyRevision: 0,
    });
    await expect(new MassionSubscriptionRuntimeResolver(edge).resolve(context, resolution())).rejects.toThrow(
      "조직 정책에서 차단",
    );
    expect(edge.broker.invocations).toHaveLength(0);
  });

  it("native checkpoint executor는 승인 결과와 원래 session을 같은 adapter에 재개한다", async () => {
    const execute = vi.fn().mockResolvedValue({
      outcome: "suspended",
      executionId: "execution-1",
      sessionId: "provider-session-review",
      approvalId: "approval-review",
    });
    const resume = vi.fn().mockResolvedValue({
      outcome: "completed",
      executionId: "execution-1",
      sessionId: "provider-session-review",
      value: "완료",
    });
    const adapter: SubscriptionAgentAdapter = { execute, resume, cancel: vi.fn() };
    const configured = await options({ nativeFactory: { create: () => adapter } });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime" || !binding.executor.resume) {
      throw new Error("재개 가능한 Agent runtime binding이 필요합니다");
    }
    await binding.executor.execute({ executionId: "execution-1", prompt: "승인 전 작업" });

    await expect(
      binding.executor.resume({
        executionId: "execution-1",
        sessionId: "provider-session-review",
        approvalId: "approval-review",
        approved: true,
      }),
    ).resolves.toMatchObject({ outcome: "completed", value: "완료" });
    expect(resume).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ executionId: "execution-1", prompt: "승인 전 작업" }),
      { sessionId: "provider-session-review", approvalId: "approval-review", approved: true },
    );
  });

  it("원격 오류의 token·email·profile 원문을 결과에 노출하지 않는다", async () => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        { kind: "usage", sequence: 0, payload: { inputTokens: 8, outputTokens: 2 } },
        {
          kind: "error",
          sequence: 1,
          payload: {
            category: "invalid category secret@example.com token-raw",
            message: "profile=/Users/private/.config token=raw-token",
            retryable: true,
            signal: { kind: "http", statusCode: 429, retryAfter: "raw-token secret@example.com" },
            emittedTokens: 0,
            sideEffectsStarted: false,
            usage: { inputTokens: 8, outputTokens: 2 },
          },
        },
      ],
    });
    const resolver = new MassionSubscriptionRuntimeResolver(configured);
    const binding = await resolver.resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    const result = await binding.executor.execute({ executionId: "execution-1", prompt: "실패" });
    expect(result).toMatchObject({
      outcome: "failed",
      category: "remote-connector-error",
      retryable: true,
      signal: { kind: "http", statusCode: 429 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      usage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret@example\.com|raw-token|Users\/private/u);
  });

  it("원격 실패의 usage frame과 error usage가 정확히 같을 때만 하나의 confirmed usage로 보존한다", async () => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "일부" } },
        { kind: "data", sequence: 1, payload: { type: "text-delta", delta: "출력" } },
        { kind: "usage", sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } },
        {
          kind: "error",
          sequence: 3,
          payload: {
            category: "provider",
            retryable: true,
            signal: { kind: "network" },
            emittedTokens: 2,
            sideEffectsStarted: false,
            usage: { inputTokens: 8, outputTokens: 37 },
          },
        },
      ],
    });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "실패" })).resolves.toMatchObject({
      outcome: "failed",
      usage: { inputTokens: 8, outputTokens: 37 },
      emittedTokens: 2,
      sideEffectsStarted: false,
    });
  });

  it("원격 Agent가 출력·usage 뒤 취소되면 확인된 사실을 cancelled 결과에 보존한다", async () => {
    let streaming!: () => void;
    const reachedUsage = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    const configured = await options({ currentConnector: edgeAgentConnector() });
    const broker: SubscriptionRuntimeBroker = {
      getLease: async () => await configured.broker.getLease(),
      invoke: async function* (_context, _request, signal) {
        yield { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "일부" } };
        yield { kind: "data", sequence: 1, payload: { type: "text-delta", delta: "출력" } };
        yield { kind: "usage", sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } };
        streaming();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const binding = await new MassionSubscriptionRuntimeResolver({ ...configured, broker }).resolve(
      context,
      resolution(),
    );
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    const controller = new AbortController();
    const execution = binding.executor.execute({
      executionId: "execution-1",
      prompt: "취소",
      abortSignal: controller.signal,
    });

    await reachedUsage;
    controller.abort("사용자 취소");

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      usage: { inputTokens: 8, outputTokens: 37 },
      emittedTokens: 2,
    });
  });

  it("원격 구조화 출력 검증 오류가 출력·usage 관측 사실을 보존한다", async () => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "{" } },
        { kind: "data", sequence: 1, payload: { type: "text-delta", delta: "}" } },
        { kind: "usage", sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } },
        {
          kind: "done",
          sequence: 3,
          payload: { outcome: "completed", sessionId: "remote-session-structured", value: {} },
        },
      ],
    });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime" || !binding.executor.executeStructured) {
      throw new Error("구조화 Agent runtime binding이 필요합니다");
    }

    const error = await binding.executor
      .executeStructured(
        { executionId: "execution-1", prompt: "구조화" },
        {
          name: "result",
          jsonSchema: { type: "object" },
          validate: () => ({ success: false, error: new Error("schema mismatch") }),
        },
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SubscriptionStructuredOutputError);
    expect(error).toMatchObject({
      emittedTokens: 2,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
  });

  it.each([
    {
      name: "실행 근거 오류",
      events: [
        { kind: "data" as const, sequence: 0, payload: { type: "text-delta", delta: "일부" } },
        { kind: "data" as const, sequence: 1, payload: { type: "text-delta", delta: "출력" } },
        { kind: "usage" as const, sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } },
        {
          kind: "done" as const,
          sequence: 3,
          payload: {
            outcome: "completed",
            sessionId: "remote-session-evidence",
            executionEvidence: { schemaVersion: "forged" },
          },
        },
      ],
    },
    {
      name: "terminal 누락",
      events: [
        { kind: "data" as const, sequence: 0, payload: { type: "text-delta", delta: "일부" } },
        { kind: "data" as const, sequence: 1, payload: { type: "text-delta", delta: "출력" } },
        { kind: "usage" as const, sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } },
      ],
    },
  ])("원격 $name 뒤에도 출력·usage를 fail-closed 결과에 보존한다", async ({ events }) => {
    const configured = await options({ currentConnector: edgeAgentConnector(), events });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "실패" })).resolves.toMatchObject({
      outcome: "failed",
      category: "remote-connector-error",
      retryable: false,
      signal: { kind: "unknown" },
      emittedTokens: 2,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
  });

  it("원격 transport가 출력·usage 뒤 끊겨도 관측 사실을 network 실패에 보존한다", async () => {
    const configured = await options({ currentConnector: edgeAgentConnector() });
    const broker: SubscriptionRuntimeBroker = {
      getLease: async () => await configured.broker.getLease(),
      invoke: async function* () {
        yield { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "일부" } };
        yield { kind: "data", sequence: 1, payload: { type: "text-delta", delta: "출력" } };
        yield { kind: "usage", sequence: 2, payload: { inputTokens: 8, outputTokens: 37 } };
        throw new TypeError("socket secret@example.com");
      },
    };
    const binding = await new MassionSubscriptionRuntimeResolver({ ...configured, broker }).resolve(
      context,
      resolution(),
    );
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    const result = await binding.executor.execute({ executionId: "execution-1", prompt: "실패" });
    expect(result).toMatchObject({
      outcome: "failed",
      category: "remote-connector-error",
      retryable: false,
      signal: { kind: "network" },
      emittedTokens: 2,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
    expect(JSON.stringify(result)).not.toContain("secret@example.com");
  });

  it("원격 실패의 usage 계보 충돌·부분·음수 값은 모두 fail-closed한다", async () => {
    const cases = [
      {
        name: "계보 충돌",
        events: [
          { kind: "usage" as const, sequence: 0, payload: { inputTokens: 8, outputTokens: 37 } },
          {
            kind: "error" as const,
            sequence: 1,
            payload: { signal: { kind: "network" }, usage: { inputTokens: 8, outputTokens: 2 } },
          },
        ],
      },
      {
        name: "payload-only usage",
        events: [
          {
            kind: "error" as const,
            sequence: 0,
            payload: { signal: { kind: "network" }, usage: { inputTokens: 8, outputTokens: 37 } },
          },
        ],
      },
      {
        name: "frame-only usage",
        events: [
          { kind: "usage" as const, sequence: 0, payload: { inputTokens: 8, outputTokens: 37 } },
          { kind: "error" as const, sequence: 1, payload: { signal: { kind: "network" } } },
        ],
      },
      {
        name: "부분 usage",
        events: [
          {
            kind: "error" as const,
            sequence: 0,
            payload: { signal: { kind: "network" }, usage: { inputTokens: 8 } },
          },
        ],
      },
      {
        name: "음수 usage",
        events: [
          {
            kind: "error" as const,
            sequence: 0,
            payload: { signal: { kind: "network" }, usage: { inputTokens: 8, outputTokens: -1 } },
          },
        ],
      },
    ];

    for (const value of cases) {
      const configured = await options({ currentConnector: edgeAgentConnector(), events: value.events });
      const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
      if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
      await expect(
        binding.executor.execute({ executionId: "execution-1", prompt: value.name }),
        value.name,
      ).rejects.toThrow(/usage|token/u);
    }
  });

  it.each([
    ["소수", 1.5],
    ["안전 정수 범위 초과", Number.MAX_SAFE_INTEGER + 1],
  ])("원격 실패의 %s emittedTokens를 거부한다", async (_name, emittedTokens) => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        {
          kind: "error",
          sequence: 0,
          payload: { signal: { kind: "network" }, emittedTokens, sideEffectsStarted: false },
        },
      ],
    });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "실패" })).rejects.toThrow(
      /출력 token/u,
    );
  });

  it("원격 실패가 emittedTokens를 생략한 채 부작용 없음을 주장하면 fail-closed한다", async () => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        {
          kind: "error",
          sequence: 0,
          payload: { category: "provider", retryable: true, signal: { kind: "network" }, sideEffectsStarted: false },
        },
      ],
    });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "실패" })).resolves.toMatchObject({
      outcome: "failed",
      emittedTokens: 0,
      sideEffectsStarted: true,
    });
  });

  it("원격 취소 terminal도 confirmed usage와 관찰된 fragment 수를 분리해 보존한다", async () => {
    const configured = await options({
      currentConnector: edgeAgentConnector(),
      events: [
        { kind: "data", sequence: 0, payload: { type: "text-delta", delta: "일부" } },
        { kind: "usage", sequence: 1, payload: { inputTokens: 8, outputTokens: 37 } },
        {
          kind: "error",
          sequence: 2,
          payload: {
            category: "cancelled",
            signal: { kind: "cancelled" },
            emittedTokens: 2,
            usage: { inputTokens: 8, outputTokens: 37 },
          },
        },
      ],
    });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(binding.executor.execute({ executionId: "execution-1", prompt: "취소" })).resolves.toMatchObject({
      outcome: "cancelled",
      usage: { inputTokens: 8, outputTokens: 37 },
      emittedTokens: 2,
    });
  });

  it("native adapter가 증명한 실패 신호·출력·부작용을 보존하고 누락 값은 fail-closed한다", async () => {
    const verifiedAdapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "failed",
        executionId: "execution-1",
        category: "authentication",
        retryable: true,
        signal: { kind: "http", statusCode: 401 },
        emittedTokens: 0,
        sideEffectsStarted: false,
        usage: { inputTokens: 8, outputTokens: 2 },
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const verifiedOptions = await options({ nativeFactory: { create: () => verifiedAdapter } });
    const verified = await new MassionSubscriptionRuntimeResolver(verifiedOptions).resolve(context, resolution());
    if (verified.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(verified.executor.execute({ executionId: "execution-1", prompt: "인증 확인" })).resolves.toEqual({
      outcome: "failed",
      executionId: "execution-1",
      category: "authentication",
      retryable: true,
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      usage: { inputTokens: 8, outputTokens: 2 },
    });

    const unknownAdapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockResolvedValue({
        outcome: "failed",
        executionId: "execution-1",
        category: "opaque-runtime-failure",
        retryable: false,
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const unknownOptions = await options({ nativeFactory: { create: () => unknownAdapter } });
    const unknown = await new MassionSubscriptionRuntimeResolver(unknownOptions).resolve(context, resolution());
    if (unknown.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");

    await expect(unknown.executor.execute({ executionId: "execution-1", prompt: "불명확한 실패" })).resolves.toEqual({
      outcome: "failed",
      executionId: "execution-1",
      category: "opaque-runtime-failure",
      retryable: false,
      signal: { kind: "unknown" },
      emittedTokens: 0,
      sideEffectsStarted: true,
    });
  });

  it("native 취소 정리가 실패해도 이미 확인된 결과 사실을 typed 실패에 보존한다", async () => {
    let finish: ((result: SubscriptionAgentResult) => void) | undefined;
    const cancel = vi.fn().mockImplementation(() => {
      finish?.({
        outcome: "cancelled",
        executionId: "execution-1",
        sessionId: "provider-session-cancel",
        emittedTokens: 2,
        usage: { inputTokens: 8, outputTokens: 37 },
      });
      return Promise.reject(new Error("cancel cleanup failed"));
    });
    const adapter: SubscriptionAgentAdapter = {
      execute: vi.fn().mockImplementation(
        () =>
          new Promise<SubscriptionAgentResult>((resolveExecution) => {
            finish = resolveExecution;
          }),
      ),
      resume: vi.fn(),
      cancel,
    };
    const configured = await options({ nativeFactory: { create: () => adapter } });
    const binding = await new MassionSubscriptionRuntimeResolver(configured).resolve(context, resolution());
    if (binding.kind !== "agent-runtime") throw new Error("Agent runtime binding이 필요합니다");
    const controller = new AbortController();
    const execution = binding.executor.execute({
      executionId: "execution-1",
      prompt: "취소",
      abortSignal: controller.signal,
    });

    controller.abort("사용자 취소");

    await expect(execution).resolves.toMatchObject({
      outcome: "failed",
      category: "subscription-cancel",
      retryable: false,
      signal: { kind: "cancelled" },
      emittedTokens: 2,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
  });

  it("Antigravity 최소 버전 미만 model을 실행 전에 거부한다", async () => {
    const antigravity = await options({
      currentAccount: account({ provider_id: "google-antigravity-cli" }),
      currentConnector: connector({
        location: "edge",
        version: "1.0.8",
        capabilities: ["google-antigravity-cli"],
      }),
    });
    await expect(
      new MassionSubscriptionRuntimeResolver(antigravity).resolve(
        context,
        resolution({ providerId: "google-antigravity-cli" }),
      ),
    ).rejects.toThrow("최소 version");
    expect(antigravity.broker.invocations).toHaveLength(0);
  });
});
