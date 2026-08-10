import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import type { TenantContext } from "@massion/identity";
import type { SubscriptionPermissionBridge } from "@massion/runtime";

import type { CodexAppServerConnection, CodexAppServerOptions } from "./codex-app-server.js";
import { CodexAppServerSubscriptionConnector, type CodexAppServerOpen } from "./codex-app-server-agent.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const inputTemplate = {
  executionId: "execution-review",
  workId: "work-review",
  agentHandle: "software-engineering.backend-specialist",
  prompt: "상태를 확인하고 필요한 파일을 고치세요",
  workspaceRoot: "/tmp/massion-workspace",
  profileRoot: "",
  environment: { PATH: "/usr/bin", LANG: "ko_KR.UTF-8", SECRET_TOKEN: "never-forward" },
  allowedTools: [],
  disallowedTools: [],
} as const;

let input: typeof inputTemplate;
const profiles: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object가 필요합니다");
  return value as Record<string, unknown>;
}

describe("Codex app-server 구독 실행 adapter", () => {
  beforeEach(async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-app-server-profile-"));
    profiles.push(profileRoot);
    await chmod(profileRoot, 0o700);
    await writeFile(join(profileRoot, "auth.json"), "private-login-state", { mode: 0o600 });
    input = { ...inputTemplate, profileRoot };
  });

  afterEach(async () => {
    await Promise.all(profiles.splice(0).map(async (profile) => await rm(profile, { recursive: true, force: true })));
  });

  function failedTurnConnector(
    error: unknown,
    beforeFailure: readonly { readonly method: string; readonly params: unknown }[] = [],
    outputTokens = 0,
    notificationError: unknown = error,
    inputTokens = 0,
  ): CodexAppServerSubscriptionConnector {
    let options: CodexAppServerOptions | undefined;
    const connection: CodexAppServerConnection = {
      get closed() {
        return false;
      },
      close: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-auth-failed" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            void (async () => {
              await options?.onNotification?.({
                method: "turn/started",
                params: {
                  threadId: "thread-auth-failed",
                  turn: { id: "turn-auth-failed", status: "inProgress", error: null },
                },
              });
              for (const notification of beforeFailure) await options?.onNotification?.(notification);
              await options?.onNotification?.({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-auth-failed",
                  turnId: "turn-auth-failed",
                  tokenUsage: {
                    last: {
                      totalTokens: inputTokens + outputTokens,
                      inputTokens,
                      cachedInputTokens: 0,
                      outputTokens,
                    },
                  },
                },
              });
              await options?.onNotification?.({
                method: "error",
                params: {
                  threadId: "thread-auth-failed",
                  turnId: "turn-auth-failed",
                  error: notificationError,
                  willRetry: false,
                },
              });
              await options?.onNotification?.({
                method: "turn/completed",
                params: {
                  threadId: "thread-auth-failed",
                  turn: { id: "turn-auth-failed", status: "failed", error, items: [] },
                },
              });
            })();
          });
          return { turn: { id: "turn-auth-failed" } };
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      }),
    };
    return new CodexAppServerSubscriptionConnector(
      { request: vi.fn() },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      vi.fn(async (_command, _arguments, _environment, configuredOptions) => {
        options = configuredOptions;
        return connection;
      }),
    );
  }

  it("관리 Codex profile의 auth.json이 없으면 app-server process를 열지 않고 실행을 거부한다", async () => {
    await rm(join(input.profileRoot, "auth.json"));
    const open = vi.fn() satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request: vi.fn() } satisfies SubscriptionPermissionBridge,
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );

    await expect(connector.execute(context, input)).rejects.toThrow(/auth\.json|재인증/u);
    expect(open).not.toHaveBeenCalled();
  });

  it("command 승인을 Governance에 중단하고 같은 server request를 승인한 뒤 turn을 완료한다", async () => {
    const request = vi
      .fn<SubscriptionPermissionBridge["request"]>()
      .mockResolvedValueOnce({
        outcome: "suspend",
        approvalId: "governance-approval-1",
      })
      .mockResolvedValueOnce({ outcome: "allow" });
    let options: CodexAppServerOptions | undefined;
    let approvalResponse: unknown;
    let fileApprovalResponse: unknown;
    let closed = false;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const connection: CodexAppServerConnection = {
      get closed() {
        return closed;
      },
      close: vi.fn(async () => {
        closed = true;
      }),
      notify: vi.fn(async () => undefined),
      request: vi.fn(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-review" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            const handler = options?.requestHandlers?.["item/commandExecution/requestApproval"];
            if (!handler) throw new Error("command approval handler가 필요합니다");
            void handler(
              {
                id: "server-request-1",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  itemId: "command-item-1",
                  startedAtMs: 1_000,
                  command: "git status --short",
                  cwd: "/tmp/massion-workspace",
                  reason: "workspace 확인",
                },
              },
              connection,
            ).then(async (response) => {
              approvalResponse = response;
              const fileHandler = options?.requestHandlers?.["item/fileChange/requestApproval"];
              if (!fileHandler) throw new Error("file approval handler가 필요합니다");
              fileApprovalResponse = await fileHandler(
                {
                  id: "server-request-2",
                  method: "item/fileChange/requestApproval",
                  params: {
                    threadId: "thread-review",
                    turnId: "turn-review",
                    itemId: "file-item-1",
                    startedAtMs: 1_500,
                    reason: "파일 수정",
                    grantRoot: "/tmp/massion-workspace",
                  },
                },
                connection,
              );
              await options?.onNotification?.({
                method: "item/completed",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  completedAtMs: 2_000,
                  item: { type: "agentMessage", id: "message-1", text: "검증 완료", phase: "final_answer" },
                },
              });
              await options?.onNotification?.({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  tokenUsage: {
                    last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 },
                  },
                },
              });
              await options?.onNotification?.({
                method: "turn/completed",
                params: {
                  threadId: "thread-review",
                  turn: { id: "turn-review", status: "completed", error: null },
                },
              });
            });
          });
          return { turn: { id: "turn-review" } };
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      }),
    };
    const open = vi.fn(async (_command, arguments_, environment, configuredOptions) => {
      expect(arguments_).toEqual(["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"']);
      expect(environment).toEqual({
        CODEX_HOME: input.profileRoot,
        HOME: input.profileRoot,
        LANG: "ko_KR.UTF-8",
        NO_COLOR: "1",
        PATH: "/usr/bin",
      });
      expect(JSON.stringify(environment)).not.toContain("never-forward");
      options = configuredOptions;
      return connection;
    }) satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );

    await expect(connector.execute(context, input)).resolves.toEqual({
      outcome: "suspended",
      executionId: "execution-review",
      sessionId: "thread-review",
      approvalId: "governance-approval-1",
    });
    expect(connection.closed).toBe(false);
    expect(request).toHaveBeenCalledWith(context, {
      executionId: "execution-review",
      workId: "work-review",
      agentHandle: "software-engineering.backend-specialist",
      toolName: "CodexCommandExecution",
      toolInput: {
        command: "git status --short",
        cwd: "/tmp/massion-workspace",
        reason: "workspace 확인",
      },
      toolUseId: "command-item-1",
      permissionRequestId: "server-request-1",
    });

    await expect(
      connector.resume(context, input, {
        sessionId: "thread-review",
        approvalId: "governance-approval-1",
        approved: true,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      executionId: "execution-review",
      sessionId: "thread-review",
      value: "검증 완료",
      usage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(approvalResponse).toEqual({ decision: "accept" });
    expect(fileApprovalResponse).toEqual({ decision: "accept" });
    expect(request).toHaveBeenNthCalledWith(2, context, {
      executionId: "execution-review",
      workId: "work-review",
      agentHandle: "software-engineering.backend-specialist",
      toolName: "CodexFileChange",
      toolInput: { reason: "파일 수정", grantRoot: "/tmp/massion-workspace" },
      toolUseId: "file-item-1",
      permissionRequestId: "server-request-2",
    });
    expect(connection.closed).toBe(true);

    const threadStart = record(calls.find((call) => call.method === "thread/start")?.params);
    expect(threadStart).toMatchObject({
      model: "gpt-5.6-codex",
      cwd: "/tmp/massion-workspace",
      runtimeWorkspaceRoots: ["/tmp/massion-workspace"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    const turnStart = record(calls.find((call) => call.method === "turn/start")?.params);
    expect(turnStart).toMatchObject({
      threadId: "thread-review",
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      model: "gpt-5.6-codex",
      cwd: "/tmp/massion-workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/tmp/massion-workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
  });

  it("기존 thread를 재개하고 turn/interrupt로 실행을 취소한다", async () => {
    let options: CodexAppServerOptions | undefined;
    let closed = false;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const connection: CodexAppServerConnection = {
      get closed() {
        return closed;
      },
      close: async () => {
        closed = true;
      },
      notify: async () => undefined,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume") return { thread: { id: "thread-existing" } };
        if (method === "turn/start") return { turn: { id: "turn-cancel" } };
        if (method === "turn/interrupt") {
          queueMicrotask(() => {
            void options?.onNotification?.({
              method: "turn/completed",
              params: { threadId: "thread-existing", turn: { id: "turn-cancel", status: "interrupted", error: null } },
            });
          });
          return {};
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      },
    };
    const open = vi.fn(async (_command, _arguments, _environment, configuredOptions) => {
      options = configuredOptions;
      return connection;
    }) satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request: async () => ({ outcome: "deny", reason: "테스트" }) },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );
    const resumedInput = { ...input, executionId: "execution-cancel", sessionId: "thread-existing" };
    const execution = connector.execute(context, resumedInput);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "turn/start")).toBe(true));

    await connector.cancel(context, "execution-cancel");

    await expect(execution).resolves.toEqual({
      outcome: "cancelled",
      executionId: "execution-cancel",
      sessionId: "thread-existing",
    });
    expect(calls).toContainEqual({
      method: "thread/resume",
      params: expect.objectContaining({
        threadId: "thread-existing",
        model: "gpt-5.6-codex",
        approvalPolicy: "on-request",
        sandbox: "read-only",
      }),
    });
    expect(calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-existing", turnId: "turn-cancel" },
    });
    expect(closed).toBe(true);
  });

  it.each([
    ["명시적인 unauthorized", "unauthorized", 401],
    ["명시적인 HTTP 401", { httpConnectionFailed: { httpStatusCode: 401 } }, 401],
    ["구독 사용량 초과 429", { httpConnectionFailed: { httpStatusCode: 429 } }, 429],
    ["upstream 503", { httpConnectionFailed: { httpStatusCode: 503 } }, 503],
    ["stream 연결 실패 502", { responseStreamConnectionFailed: { httpStatusCode: 502 } }, 502],
    ["stream 끊김 500", { responseStreamDisconnected: { httpStatusCode: 500 } }, 500],
    ["재시도 소진 429", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, 429],
  ])(
    "출력이나 도구 이벤트 전의 %s 오류는 실제 상태 코드를 보존한 fallback 가능한 실패로 반환한다",
    async (_label, codexErrorInfo, statusCode) => {
      const connector = failedTurnConnector({
        message: "Codex turn이 실패했습니다",
        codexErrorInfo,
        additionalDetails: null,
      });

      await expect(connector.execute(context, input)).resolves.toMatchObject({
        outcome: "failed",
        retryable: true,
        signal: { kind: "http", statusCode },
        emittedTokens: 0,
        sideEffectsStarted: false,
      });
    },
  );

  it.each([
    ["결제 필요 402", { httpConnectionFailed: { httpStatusCode: 402 } }, 402],
    ["정책 거부 403", { httpConnectionFailed: { httpStatusCode: 403 } }, 403],
  ])("출력 전의 %s는 상태 코드를 보존하되 router가 fallback을 막도록 위임한다", async (_label, info, statusCode) => {
    const connector = failedTurnConnector({
      message: "Codex turn이 실패했습니다",
      codexErrorInfo: info,
      additionalDetails: null,
    });

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      signal: { kind: "http", statusCode },
      emittedTokens: 0,
      sideEffectsStarted: false,
    });
  });

  it.each([
    [
      "assistant delta",
      [
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-auth-failed",
            turnId: "turn-auth-failed",
            itemId: "message-auth-failed",
            delta: "한",
          },
        },
      ],
      0,
    ],
    [
      "도구 시작",
      [
        {
          method: "item/started",
          params: {
            threadId: "thread-auth-failed",
            turnId: "turn-auth-failed",
            item: { id: "command-auth-failed", type: "commandExecution", command: "pwd", status: "inProgress" },
          },
        },
      ],
      0,
    ],
    ["출력 token", [], 1],
    [
      "알 수 없는 단계",
      [
        {
          method: "provider/futureStage",
          params: { threadId: "thread-auth-failed", turnId: "turn-auth-failed" },
        },
      ],
      0,
    ],
  ])("%s 뒤의 app-server 401은 fallback 가능한 실패로 낮추지 않는다", async (_label, notifications, outputTokens) => {
    const connector = failedTurnConnector(
      {
        message: "인증이 필요합니다",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        additionalDetails: null,
      },
      notifications,
      outputTokens,
    );

    const result = await connector.execute(context, input);

    expect(result).toMatchObject({ outcome: "failed", retryable: false, sideEffectsStarted: true });
  });

  it("실패 turn에서도 app-server가 확정한 8/2 usage를 normalized 값으로 보존한다", async () => {
    const failure = {
      message: "요청이 제한됐습니다",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
      additionalDetails: null,
    };
    const connector = failedTurnConnector(failure, [], 2, failure, 8);

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      usage: { inputTokens: 8, outputTokens: 2 },
      emittedTokens: 1,
      sideEffectsStarted: true,
    });
  });

  it("delta와 8/37 usage 뒤 transport·close가 실패해도 관측 근거를 terminal 실패로 보존한다", async () => {
    let options: CodexAppServerOptions | undefined;
    const connection: CodexAppServerConnection = {
      get closed() {
        return false;
      },
      close: vi.fn().mockRejectedValue(new Error("close failed")),
      notify: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-transport" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            void (async () => {
              await options?.onNotification?.({
                method: "turn/started",
                params: { threadId: "thread-transport", turn: { id: "turn-transport" } },
              });
              await options?.onNotification?.({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread-transport",
                  turnId: "turn-transport",
                  itemId: "message-transport",
                  delta: "일부 출력",
                },
              });
              await options?.onNotification?.({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-transport",
                  turnId: "turn-transport",
                  tokenUsage: {
                    last: { totalTokens: 45, inputTokens: 8, cachedInputTokens: 0, outputTokens: 37 },
                  },
                },
              });
              await options?.onFailure?.(new Error("transport failed"));
            })();
          });
          return { turn: { id: "turn-transport" } };
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      }),
    };
    const connector = new CodexAppServerSubscriptionConnector(
      { request: vi.fn() },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      vi.fn(async (_command, _arguments, _environment, configuredOptions) => {
        options = configuredOptions;
        return connection;
      }),
    );

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      category: "codex-app-server-transport",
      retryable: false,
      signal: { kind: "network" },
      emittedTokens: 1,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
  });

  it.each([
    [
      "명령 실행 item",
      {
        method: "item/started",
        params: {
          threadId: "thread-auth-failed",
          turnId: "turn-auth-failed",
          item: { id: "command-quota", type: "commandExecution", command: "pwd", status: "inProgress" },
        },
      },
    ],
    [
      "assistant delta",
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-auth-failed",
          turnId: "turn-auth-failed",
          itemId: "message-quota",
          delta: "한",
        },
      },
    ],
  ])("%s를 관측한 뒤의 429는 실제 부작용을 보고해 fallback을 막는다", async (_label, notification) => {
    const connector = failedTurnConnector(
      {
        message: "요청이 제한됐습니다",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
        additionalDetails: null,
      },
      [notification],
    );

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      sideEffectsStarted: true,
    });
  });

  it.each([
    ["top-level statusCode", { statusCode: 401 }],
    ["top-level code", { code: 401 }],
    ["cause statusCode", { cause: { statusCode: 401 } }],
    ["알 수 없는 Codex variant", { codexErrorInfo: { futureFailure: { httpStatusCode: 401 } } }],
    ["상태 코드 없는 transport 실패", { codexErrorInfo: { responseStreamDisconnected: {} } }],
    ["HTTP 범위 밖 상태 코드", { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 200 } } }],
  ])("공식 app-server 오류가 아닌 %s 형태는 signal 없이 fail-closed로 반환한다", async (_label, error) => {
    const connector = failedTurnConnector(error);

    const result = await connector.execute(context, input);

    expect(result).toMatchObject({ outcome: "failed", retryable: false });
    expect(result.outcome === "failed" ? result.signal : undefined).toBeUndefined();
  });

  it("앞선 error notification과 무관하게 최종 turn.error의 상태 코드를 정본으로 사용한다", async () => {
    const connector = failedTurnConnector(
      {
        message: "최종 인증 외 오류입니다",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
        additionalDetails: null,
      },
      [],
      0,
      {
        message: "인증이 필요합니다",
        codexErrorInfo: "unauthorized",
        additionalDetails: null,
      },
    );

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      retryable: true,
      signal: { kind: "http", statusCode: 429 },
      sideEffectsStarted: false,
    });
  });

  it("최종 turn.error가 알 수 없는 값이면 앞선 401 notification으로 fallback을 허용하지 않는다", async () => {
    const connector = failedTurnConnector(
      { message: "최종 오류입니다", codexErrorInfo: "other", additionalDetails: null },
      [],
      0,
      { message: "인증이 필요합니다", codexErrorInfo: "unauthorized", additionalDetails: null },
    );

    const result = await connector.execute(context, input);

    expect(result).toMatchObject({ outcome: "failed", retryable: false });
    expect(result.outcome === "failed" ? result.signal : undefined).toBeUndefined();
  });

  it("완료 item notification의 성공 명령과 파일 변경만 실행 근거로 반환한다", async () => {
    let options: CodexAppServerOptions | undefined;
    const connection: CodexAppServerConnection = {
      get closed() {
        return false;
      },
      close: async () => undefined,
      notify: async () => undefined,
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-evidence" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            void (async () => {
              await options?.onNotification?.({
                method: "turn/started",
                params: { threadId: "thread-evidence", turn: { id: "turn-evidence" } },
              });
              await options?.onNotification?.({
                method: "item/completed",
                params: {
                  threadId: "thread-evidence",
                  turnId: "turn-evidence",
                  item: {
                    id: "command-evidence",
                    type: "commandExecution",
                    command: "pnpm test",
                    aggregatedOutput: "9 passed",
                    exitCode: 0,
                    status: "completed",
                  },
                },
              });
              await options?.onNotification?.({
                method: "item/completed",
                params: {
                  threadId: "thread-evidence",
                  turnId: "turn-evidence",
                  item: {
                    id: "file-evidence",
                    type: "fileChange",
                    changes: [{ path: "src/report.ts", kind: { type: "update" } }],
                    status: "completed",
                  },
                },
              });
              await options?.onNotification?.({
                method: "item/completed",
                params: {
                  threadId: "thread-evidence",
                  turnId: "turn-evidence",
                  item: { id: "message-evidence", type: "agentMessage", text: "완료" },
                },
              });
              await options?.onNotification?.({
                method: "turn/completed",
                params: { threadId: "thread-evidence", turn: { id: "turn-evidence", status: "completed" } },
              });
            })();
          });
          return { turn: { id: "turn-evidence" } };
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      },
    };
    const connector = new CodexAppServerSubscriptionConnector(
      { request: async () => ({ outcome: "allow" }) },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      async (_command, _arguments, _environment, configuredOptions) => {
        options = configuredOptions;
        return connection;
      },
    );

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "completed",
      value: "완료",
      executionEvidence: {
        items: [
          expect.objectContaining({ providerItemId: "command-evidence", kind: "command", exitCode: 0 }),
          expect.objectContaining({ providerItemId: "file-evidence:0", kind: "file", path: "src/report.ts" }),
        ],
      },
    });
  });

  it("실제 NDJSON transport에서 thread→turn→승인→완료 순서를 수행한다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-agent.mjs", import.meta.url));
    const connector = new CodexAppServerSubscriptionConnector(
      { request: async () => ({ outcome: "allow" }) },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: process.execPath, commandArguments: [fixturePath] }),
        timeoutMs: 5_000,
      },
    );

    await expect(connector.execute(context, input)).resolves.toEqual({
      outcome: "completed",
      executionId: "execution-review",
      sessionId: "thread-fixture",
      value: "실제 transport 완료",
    });
  });
});
