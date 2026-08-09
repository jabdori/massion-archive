import type { ExtensionPermissionDeclaration } from "@massion/extension-sdk";
import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import {
  ExtensionCapabilityBroker,
  type ExtensionBrokerDependencies,
  type ExtensionWorkerSessionView,
} from "./capability-broker.js";
import type { ExtensionStorageService } from "./storage.js";

/*
 * broker가 선언한 storage 의존과 실제 `ExtensionStorageService`가 같은 모양인지 컴파일 시점에 봅니다.
 *
 * 이 확인이 없던 동안 broker는 `get`·`list`를 객체 인자로 선언했고 서비스는 위치 인자를 썼습니다.
 * broker가 생산에 조립된 적이 없어 아무도 몰랐고, 테스트도 `put`만 지나갔습니다. 조립하려는 순간
 * 타입 오류가 나는 선언이 남아 있으면, 그 다음 사람이 "미구현"이 아니라 "고장"을 만납니다.
 */
type StorageDependency = ExtensionBrokerDependencies["storage"];
const _storageServiceSatisfiesBroker: (service: ExtensionStorageService) => StorageDependency = (service) => service;
void _storageServiceSatisfiesBroker;

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const permissions: ExtensionPermissionDeclaration = {
  tools: [{ id: "issue.read", operations: ["invoke"] }],
  network: [{ origin: "https://api.example.com", methods: ["GET"] }],
  files: [
    { mount: "repository", access: "read" },
    { mount: "output", access: "write" },
  ],
  secrets: [{ slot: "api-token", purpose: "API 인증" }],
  process: [],
  mcp: ["github-mcp"],
  storage: { quotaBytes: 1024, maxValueBytes: 256 },
  events: ["work.completed.v1"],
};

function session(overrides: Partial<ExtensionWorkerSessionView> = {}): ExtensionWorkerSessionView {
  return {
    sessionId: "session-1",
    organizationId: context.organizationId,
    installationId: "installation-1",
    versionId: "version-1",
    activationGeneration: 1,
    state: "healthy",
    permissions,
    ...overrides,
  };
}

function dependencies(overrides: Partial<ExtensionBrokerDependencies> = {}): ExtensionBrokerDependencies {
  return {
    sessions: { resolve: async () => session() },
    emergency: { assertExecutionAllowed: async () => undefined },
    tools: { invoke: async (input) => ({ toolId: input.toolId, value: input.input }) },
    network: {
      request: async (input) => ({ status: 200, body: { ok: true }, finalOrigin: input.origin }),
    },
    files: {
      read: async (input) => ({ mount: input.mount, path: input.path, content: "content" }),
      write: async () => ({ written: true }),
    },
    mcp: { invoke: async (input) => ({ serverId: input.serverId }) },
    events: { subscribe: async (input) => ({ subscriptionId: `${input.eventType}-subscription` }) },
    storage: {
      put: async (_context, input) => input,
      get: async (_context, input) => input,
      list: async (_context, input) => [input],
    },
    ...overrides,
  };
}

describe("ExtensionCapabilityBroker", () => {
  it("healthy active session의 선언된 tool만 호출한다", async () => {
    const broker = new ExtensionCapabilityBroker(dependencies());
    const result = await broker.call(context, {
      sessionId: "session-1",
      workId: "work-1",
      commandId: "tool-command-1",
      deadline: new Date(Date.now() + 5_000),
      operation: { kind: "tool", toolId: "issue.read", operation: "invoke", input: { issue: 1 } },
    });
    expect(result).toEqual({ toolId: "issue.read", value: { issue: 1 } });
  });

  it.each([
    ["tenant", session({ organizationId: "other-organization" }), "organization"],
    ["inactive", session({ state: "stopped" }), "healthy"],
  ])("%s session을 거부한다", async (_name, workerSession, message) => {
    const broker = new ExtensionCapabilityBroker(
      dependencies({ sessions: { resolve: async () => workerSession as ExtensionWorkerSessionView } }),
    );
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "blocked-command",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "tool", toolId: "issue.read", operation: "invoke", input: {} },
      }),
    ).rejects.toThrow(message);
  });

  it("미선언 capability와 지난 deadline을 거부한다", async () => {
    const broker = new ExtensionCapabilityBroker(dependencies());
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "undeclared-tool",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "tool", toolId: "issue.delete", operation: "invoke", input: {} },
      }),
    ).rejects.toThrow("선언");
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "expired",
        deadline: new Date(0),
        operation: { kind: "tool", toolId: "issue.read", operation: "invoke", input: {} },
      }),
    ).rejects.toThrow("deadline");
  });

  it("network origin·method·secret slot을 검증하고 redirect escape를 거부한다", async () => {
    const calls: unknown[] = [];
    const broker = new ExtensionCapabilityBroker(
      dependencies({
        network: {
          async request(input) {
            calls.push(input);
            return { status: 200, body: { authorization: "[REDACTED]" }, finalOrigin: "https://evil.example" };
          },
        },
      }),
    );
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "network-command",
        deadline: new Date(Date.now() + 5_000),
        operation: {
          kind: "network",
          origin: "https://api.example.com",
          method: "GET",
          path: "/issues",
          secretSlot: "api-token",
        },
      }),
    ).rejects.toThrow("redirect");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("secret-value");
  });

  it("file mount access·MCP·event declaration을 각각 검증한다", async () => {
    const broker = new ExtensionCapabilityBroker(dependencies());
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "write-readonly",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "file.write", mount: "repository", path: "file.ts", content: "x" },
      }),
    ).rejects.toThrow("write");
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "mcp-command",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "mcp", serverId: "github-mcp", tool: "issues", input: {} },
      }),
    ).resolves.toEqual({ serverId: "github-mcp" });
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "event-command",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "event.subscribe", eventType: "work.completed.v1" },
      }),
    ).resolves.toEqual({ subscriptionId: "work.completed.v1-subscription" });
  });

  it("storage quota와 namespace는 worker 입력이 아니라 active session에서 고정한다", async () => {
    const calls: unknown[] = [];
    const broker = new ExtensionCapabilityBroker(
      dependencies({
        storage: {
          async put(_context, input) {
            calls.push(input);
            return { stored: true };
          },
          get: async () => undefined,
          list: async () => [],
        },
      }),
    );
    await expect(
      broker.call(context, {
        sessionId: "session-1",
        workId: "work-1",
        commandId: "storage-command",
        deadline: new Date(Date.now() + 5_000),
        operation: { kind: "storage.put", key: "cursor", value: { page: 1 } },
      }),
    ).resolves.toEqual({ stored: true });
    expect(calls).toEqual([
      expect.objectContaining({
        installationId: "installation-1",
        versionId: "version-1",
        quotaBytes: 1024,
        maxValueBytes: 256,
      }),
    ]);
  });
});
