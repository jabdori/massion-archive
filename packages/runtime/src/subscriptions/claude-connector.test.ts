import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  ClaudeSubscriptionConnector,
  type ClaudeQueryHandle,
  type ClaudeAgentQuery,
  type SubscriptionPermissionBridge,
} from "./claude-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

async function invokePreToolUse(
  options: Parameters<ClaudeAgentQuery>[0]["options"],
  input: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly toolUseId: string;
  },
): Promise<unknown> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("PreToolUse hook이 등록되지 않았습니다");
  return await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: input.sessionId,
      transcript_path: `/tmp/${input.sessionId}.jsonl`,
      cwd: "/tmp/work",
      permission_mode: "default",
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_use_id: input.toolUseId,
    },
    input.toolUseId,
    { signal: new AbortController().signal },
  );
}

describe("공식 Claude Agent SDK 구독 Connector", () => {
  it("전체 권한은 Claude bypassPermissions만 전달하고 Massion sandbox·hook을 생략한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield { type: "result", subtype: "success", session_id: "session-full-access", result: "완료", usage: {} };
    });
    const connector = new ClaudeSubscriptionConnector(query, undefined, {
      executable: "/opt/massion/connectors/claude",
      permissionMode: "bypassPermissions" as never,
      allowDangerouslySkipPermissions: true,
      model: "claude-opus-4-8",
    } as never);

    await connector.execute(context, {
      executionId: "execution-full-access",
      workId: "work-full-access",
      agentHandle: "representative",
      prompt: "전체 권한을 확인하세요",
      workspaceRoot: "/tmp/work-full-access",
      profileRoot: "/tmp/claude-profile-full-access",
      environment: { PATH: "/opt/massion/connectors" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          pathToClaudeCodeExecutable: "/opt/massion/connectors/claude",
        }),
      }),
    );
    const options = vi.mocked(query).mock.calls[0]?.[0]?.options;
    expect(options.sandbox).toBeUndefined();
    expect(options.hooks).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
  });

  it("허용된 실행 파일과 fail-closed sandbox 정책을 공식 SDK query에 전달한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield { type: "result", subtype: "success", session_id: "session-policy", result: "완료", usage: {} };
    });
    const connector = new ClaudeSubscriptionConnector(query, undefined, {
      executable: "/opt/massion/connectors/claude",
      permissionMode: "auto",
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [], allowManagedDomainsOnly: true, allowLocalBinding: false },
      },
      model: "claude-opus-4-8",
    });

    await connector.execute(context, {
      executionId: "execution-policy",
      workId: "work-policy",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "정책을 확인하세요",
      workspaceRoot: "/tmp/work-policy",
      profileRoot: "/tmp/claude-profile-policy",
      environment: { PATH: "/opt/massion/connectors", HOME: "/private/home" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: "/opt/massion/connectors/claude",
          permissionMode: "auto",
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: [], allowManagedDomainsOnly: true, allowLocalBinding: false },
          },
          model: "claude-opus-4-8",
        }),
      }),
    );
  });

  it("sandbox 우회 설정과 상대 실행 파일을 거부한다", () => {
    expect(
      () =>
        new ClaudeSubscriptionConnector(undefined, undefined, {
          executable: "bin/claude",
          permissionMode: "bypassPermissions" as never,
          sandbox: { enabled: false, failIfUnavailable: false, allowUnsandboxedCommands: true },
        }),
    ).toThrow();
  });

  it("전체 권한 확인 flag가 없는 bypassPermissions를 거부한다", () => {
    expect(
      () =>
        new ClaudeSubscriptionConnector(undefined, undefined, {
          executable: "/opt/massion/connectors/claude",
          permissionMode: "bypassPermissions",
        } as never),
    ).toThrow("allowDangerouslySkipPermissions");
  });

  it("실행 파일 override가 없으면 pinned Agent SDK bundled runtime을 사용한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield { type: "result", subtype: "success", session_id: "session-bundled", result: "완료", usage: {} };
    });
    const connector = new ClaudeSubscriptionConnector(query, undefined, {
      permissionMode: "auto",
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    });

    await connector.execute(context, {
      executionId: "execution-bundled",
      workId: "work-bundled",
      agentHandle: "representative",
      prompt: "기본 설치",
      workspaceRoot: "/tmp/work-bundled",
      profileRoot: "/tmp/profile-bundled",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    });

    const invoked = vi.mocked(query).mock.calls[0]?.[0];
    expect(invoked?.options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(invoked?.options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/tmp/profile-bundled",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  it("PreToolUse defer 결과와 원 도구 표식이 일치할 때만 Governance 승인 대기로 전환한다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-1" });
    const permissions: SubscriptionPermissionBridge = { request };
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      const decision = await invokePreToolUse(options, {
        sessionId: "session-1",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-use-1",
      });
      expect(decision).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
      });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        session_id: "session-1",
        result: "",
        usage: {},
        deferred_tool_use: { id: "tool-use-1", name: "Bash", input: { command: "git status" } },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, permissions);

    const result = await connector.execute(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "테스트를 실행하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/claude-profile-1",
      environment: { PATH: "/usr/bin", HOME: "/private/home" },
      allowedTools: ["Read"],
      disallowedTools: ["WebFetch"],
    });

    expect(request).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ executionId: "execution-1", toolName: "Bash" }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "테스트를 실행하세요",
        options: expect.objectContaining({
          cwd: "/tmp/work-1",
          allowedTools: ["Read"],
          disallowedTools: ["WebFetch"],
          env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/claude-profile-1" }),
        }),
      }),
    );
    expect(result).toEqual({
      outcome: "suspended",
      executionId: "execution-1",
      sessionId: "session-1",
      approvalId: "approval-1",
    });
    expect(request).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        toolUseId: "tool-use-1",
        permissionRequestId: expect.stringMatching(/^claude-hook-[a-f0-9]{64}$/u),
      }),
    );
  });

  it("승인 재개는 새 prompt 없이 --resume하고 같은 session·호출 ID·도구 이름·입력만 한 번 허용한다", async () => {
    const decisions: unknown[] = [];
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-bound" });
    let invocation = 0;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ prompt, options }) {
      invocation += 1;
      if (invocation === 2) {
        expect(options.resume).toBe("session-bound");
        expect(typeof prompt).not.toBe("string");
        const resumedMessages: unknown[] = [];
        for await (const message of prompt as unknown as AsyncIterable<unknown>) resumedMessages.push(message);
        expect(resumedMessages).toEqual([]);
      }
      decisions.push(
        await invokePreToolUse(options, {
          sessionId: "session-bound",
          toolName: "Bash",
          toolInput: { command: "git status" },
          toolUseId: "tool-original",
        }),
      );
      if (invocation === 1) {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "tool_deferred",
          terminal_reason: "tool_deferred",
          session_id: "session-bound",
          result: "",
          usage: {},
          deferred_tool_use: { id: "tool-original", name: "Bash", input: { command: "git status" } },
        };
        return;
      }
      const providerPermission = await options.canUseTool?.(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-original",
          requestId: "provider-permission-original",
        },
      );
      expect(providerPermission).toMatchObject({ behavior: "allow" });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "session-bound",
        result: "완료",
        usage: {},
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });
    const input = {
      executionId: "execution-bound",
      workId: "work-bound",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-bound",
      profileRoot: "/tmp/profile-bound",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await expect(connector.execute(context, input)).resolves.toMatchObject({
      outcome: "suspended",
      approvalId: "approval-bound",
    });
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-bound",
        sessionId: "session-bound",
      }),
    ).resolves.toMatchObject({ outcome: "completed", sessionId: "session-bound", value: "완료" });

    expect(decisions[0]).toMatchObject({
      hookSpecificOutput: { permissionDecision: "defer" },
    });
    expect(decisions[1]).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("승인 재개 시 원 도구 입력이나 session이 달라지면 실패 폐쇄하고 새 승인을 만들지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-bound" });
    let invocation = 0;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      invocation += 1;
      const decision = await invokePreToolUse(options, {
        sessionId: invocation === 1 ? "session-bound" : "session-changed",
        toolName: "Bash",
        toolInput: { command: invocation === 1 ? "git status" : "git push" },
        toolUseId: "tool-original",
      });
      if (invocation === 1) {
        expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "defer" } });
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "tool_deferred",
          session_id: "session-bound",
          result: "",
          usage: {},
          deferred_tool_use: { id: "tool-original", name: "Bash", input: { command: "git status" } },
        };
        return;
      }
      expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "session-bound",
        result: "거부됨",
        usage: {},
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });
    const input = {
      executionId: "execution-bound-mismatch",
      workId: "work-bound",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-bound",
      profileRoot: "/tmp/profile-bound",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await connector.execute(context, input);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-bound",
        sessionId: "session-bound",
      }),
    ).rejects.toThrow(/원래 도구 호출과 일치하지 않습니다/u);
    expect(request).toHaveBeenCalledOnce();
  });

  it("승인된 같은 원 도구의 PreToolUse가 두 번 전달되면 두 번째 호출을 거부하고 새 승인을 만들지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-hook-replay" });
    let invocation = 0;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      invocation += 1;
      const hookInput = {
        sessionId: "session-hook-replay",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-hook-replay",
      } as const;
      const first = await invokePreToolUse(options, hookInput);
      if (invocation === 1) {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "tool_deferred",
          session_id: "session-hook-replay",
          result: "",
          usage: {},
          deferred_tool_use: { id: "tool-hook-replay", name: "Bash", input: { command: "git status" } },
        };
        return;
      }
      expect(first).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
      const replay = await invokePreToolUse(options, hookInput);
      expect(replay).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "session-hook-replay",
        result: "중복 전달 뒤 결과",
        usage: {},
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });
    const input = {
      executionId: "execution-hook-replay",
      workId: "work-hook-replay",
      agentHandle: "representative",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-hook-replay",
      profileRoot: "/tmp/profile-hook-replay",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await connector.execute(context, input);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-hook-replay",
        sessionId: "session-hook-replay",
      }),
    ).rejects.toThrow(/두 번/u);
    expect(request).toHaveBeenCalledOnce();
  });

  it("deferred_tool_use 표식이 hook 원본과 다르면 승인 대기를 만들지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-marker" });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      await invokePreToolUse(options, {
        sessionId: "session-marker",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-marker",
      });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        session_id: "session-marker",
        result: "",
        usage: {},
        deferred_tool_use: { id: "tool-marker", name: "Bash", input: { command: "git push" } },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request, interrupt });
    const input = {
      executionId: "execution-marker",
      workId: "work-marker",
      agentHandle: "representative",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-marker",
      profileRoot: "/tmp/profile-marker",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await expect(connector.execute(context, input)).rejects.toThrow(/deferred_tool_use/u);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-marker",
        sessionId: "session-marker",
      }),
    ).rejects.toThrow(/승인/u);
    expect(query).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith(context, {
      executionId: "execution-marker",
      approvalId: "approval-marker",
    });
  });

  it("한 turn에서 두 도구가 동시에 defer를 요구하면 두 번째 승인을 만들지 않고 첫 승인도 정리한다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-parallel" });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      const [first, second] = await Promise.all([
        invokePreToolUse(options, {
          sessionId: "session-parallel",
          toolName: "Write",
          toolInput: { file_path: "/tmp/work-parallel/a" },
          toolUseId: "tool-parallel-a",
        }),
        invokePreToolUse(options, {
          sessionId: "session-parallel",
          toolName: "Write",
          toolInput: { file_path: "/tmp/work-parallel/b" },
          toolUseId: "tool-parallel-b",
        }),
      ]);
      expect(first).toMatchObject({ hookSpecificOutput: { permissionDecision: "defer" } });
      expect(second).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        session_id: "session-parallel",
        result: "",
        usage: {},
        deferred_tool_use: {
          id: "tool-parallel-a",
          name: "Write",
          input: { file_path: "/tmp/work-parallel/a" },
        },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request, interrupt });

    await expect(
      connector.execute(context, {
        executionId: "execution-parallel",
        workId: "work-parallel",
        agentHandle: "software-development",
        prompt: "두 파일을 쓰세요",
        workspaceRoot: "/tmp/work-parallel",
        profileRoot: "/tmp/profile-parallel",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toThrow(/단일 도구 호출/u);
    expect(request).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith(context, {
      executionId: "execution-parallel",
      approvalId: "approval-parallel",
    });
  });

  it("--resume에서 PreToolUse가 다시 호출되지 않으면 완료 결과를 신뢰하지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-hook-missing" });
    let invocation = 0;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      invocation += 1;
      if (invocation === 1) {
        await invokePreToolUse(options, {
          sessionId: "session-hook-missing",
          toolName: "Bash",
          toolInput: { command: "git status" },
          toolUseId: "tool-hook-missing",
        });
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "tool_deferred",
          session_id: "session-hook-missing",
          result: "",
          usage: {},
          deferred_tool_use: { id: "tool-hook-missing", name: "Bash", input: { command: "git status" } },
        };
        return;
      }
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "session-hook-missing",
        result: "검증되지 않은 완료",
        usage: {},
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });
    const input = {
      executionId: "execution-hook-missing",
      workId: "work-hook-missing",
      agentHandle: "representative",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-hook-missing",
      profileRoot: "/tmp/profile-hook-missing",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await connector.execute(context, input);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-hook-missing",
        sessionId: "session-hook-missing",
      }),
    ).rejects.toThrow(/다시 평가되지 않았습니다/u);
  });

  it("거부·취소·process 재시작은 deferred session을 재개하지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-stop" });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      await invokePreToolUse(options, {
        sessionId: "session-stop",
        toolName: "Write",
        toolInput: { file_path: "/tmp/work-stop/file" },
        toolUseId: "tool-stop",
      });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        session_id: "session-stop",
        result: "",
        usage: {},
        deferred_tool_use: {
          id: "tool-stop",
          name: "Write",
          input: { file_path: "/tmp/work-stop/file" },
        },
      };
    });
    const input = {
      executionId: "execution-stop",
      workId: "work-stop",
      agentHandle: "software-development",
      prompt: "파일을 쓰세요",
      workspaceRoot: "/tmp/work-stop",
      profileRoot: "/tmp/profile-stop",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    } as const;

    const rejectedConnector = new ClaudeSubscriptionConnector(query, { request });
    await rejectedConnector.execute(context, input);
    await expect(
      rejectedConnector.resume(context, input, {
        approved: false,
        approvalId: "approval-stop",
        sessionId: "session-stop",
      }),
    ).resolves.toMatchObject({ outcome: "cancelled" });
    expect(query).toHaveBeenCalledOnce();

    const cancelledInput = { ...input, executionId: "execution-cancelled" };
    const cancelledConnector = new ClaudeSubscriptionConnector(query, { request, interrupt });
    await cancelledConnector.execute(context, cancelledInput);
    await cancelledConnector.cancel(context, cancelledInput.executionId);
    await expect(
      cancelledConnector.resume(context, cancelledInput, {
        approved: true,
        approvalId: "approval-stop",
        sessionId: "session-stop",
      }),
    ).rejects.toThrow(/승인/u);
    expect(interrupt).toHaveBeenCalledWith(context, {
      executionId: "execution-cancelled",
      approvalId: "approval-stop",
    });

    const restartedConnector = new ClaudeSubscriptionConnector(query, { request });
    await expect(
      restartedConnector.resume(context, input, {
        approved: true,
        approvalId: "approval-stop",
        sessionId: "session-stop",
      }),
    ).rejects.toThrow(/승인/u);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("PreToolUse hook에서 허용하지 않은 provider permission 요청은 거부한다", async () => {
    let permissionDecision: unknown;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      permissionDecision = await options.canUseTool?.(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-use-denied",
          requestId: "provider-permission-denied",
        },
      );
      yield { type: "result", subtype: "error_during_execution", session_id: "session-denied" };
    });
    const connector = new ClaudeSubscriptionConnector(query);

    await expect(
      connector.execute(context, {
        executionId: "execution-denied",
        workId: "work-1",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-denied",
        profileRoot: "/tmp/claude-profile-denied",
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({ outcome: "failed", sessionId: "session-denied" });
    expect(permissionDecision).toMatchObject({
      behavior: "deny",
      message: "Massion PreToolUse 승인이 없는 provider 권한 요청입니다",
    });
  });

  it("같은 provider permission authorization은 한 번만 소비하고 재전달 결과를 신뢰하지 않는다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "allow" });
    const decisions: unknown[] = [];
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      await invokePreToolUse(options, {
        sessionId: "session-provider-replay",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-provider-replay",
      });
      for (const requestId of ["provider-permission-1", "provider-permission-2"]) {
        decisions.push(
          await options.canUseTool?.(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-provider-replay",
              requestId,
            },
          ),
        );
      }
      yield {
        type: "assistant",
        session_id: "session-provider-replay",
        message: { content: [{ type: "text", text: "중복 전달 뒤 일부 출력" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: "session-provider-replay",
        result: "중복 권한 전달 뒤 결과",
        usage: { input_tokens: 8, output_tokens: 37 },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });

    await expect(
      connector.execute(context, {
        executionId: "execution-provider-replay",
        workId: "work-provider-replay",
        agentHandle: "representative",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-provider-replay",
        profileRoot: "/tmp/profile-provider-replay",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      emittedTokens: 1,
      sideEffectsStarted: true,
      usage: { inputTokens: 8, outputTokens: 37 },
    });
    expect(decisions[0]).toMatchObject({ behavior: "allow" });
    expect(decisions[1]).toMatchObject({ behavior: "deny" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("text·tool을 관측한 뒤 SDK transport가 throw해도 typed 실패 근거를 보존한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield {
        type: "assistant",
        session_id: "session-transport",
        message: {
          content: [
            { type: "text", text: "일부 출력" },
            { type: "tool_use", id: "tool-transport", name: "Read", input: { file_path: "/tmp/work/file" } },
          ],
        },
      };
      throw new TypeError("socket disconnected");
    });
    const connector = new ClaudeSubscriptionConnector(query);

    await expect(
      connector.execute(context, {
        executionId: "execution-transport",
        workId: "work-transport",
        agentHandle: "representative",
        prompt: "전송 실패를 확인하세요",
        workspaceRoot: "/tmp/work-transport",
        profileRoot: "/tmp/profile-transport",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      signal: { kind: "network" },
      emittedTokens: 1,
      sideEffectsStarted: true,
    });
  });

  it("text·tool을 관측한 실행을 취소해도 emitted fragment를 보존한다", async () => {
    let release: (() => void) | undefined;
    let observed = false;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interrupt = vi.fn(async () => release?.());
    const handle: ClaudeQueryHandle = {
      async *[Symbol.asyncIterator]() {
        observed = true;
        yield {
          type: "assistant",
          session_id: "session-cancel-observed",
          message: {
            content: [
              { type: "text", text: "일부 출력" },
              { type: "tool_use", id: "tool-cancel", name: "Read", input: { file_path: "/tmp/work/file" } },
            ],
          },
        };
        await wait;
        throw new Error("cancelled");
      },
      interrupt,
      close: vi.fn(),
    };
    const query: ClaudeAgentQuery = vi.fn(() => handle);
    const connector = new ClaudeSubscriptionConnector(query);
    const execution = connector.execute(context, {
      executionId: "execution-cancel-observed",
      workId: "work-cancel-observed",
      agentHandle: "representative",
      prompt: "실행을 취소하세요",
      workspaceRoot: "/tmp/work-cancel-observed",
      profileRoot: "/tmp/profile-cancel-observed",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    });
    await vi.waitFor(() => expect(observed).toBe(true));

    await connector.cancel(context, "execution-cancel-observed");

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      sessionId: "session-cancel-observed",
      emittedTokens: 1,
    });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("승인 ID나 session ID가 다르면 --resume 전에 거부한다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-session" });
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      await invokePreToolUse(options, {
        sessionId: "session-original",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-session",
      });
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        session_id: "session-original",
        result: "",
        usage: {},
        deferred_tool_use: { id: "tool-session", name: "Bash", input: { command: "git status" } },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query, { request });
    const input = {
      executionId: "execution-session",
      workId: "work-session",
      agentHandle: "representative",
      prompt: "상태를 확인하세요",
      workspaceRoot: "/tmp/work-session",
      profileRoot: "/tmp/profile-session",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await connector.execute(context, input);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-session",
        sessionId: "session-forged",
      }),
    ).rejects.toThrow(/session ID/u);
    await expect(
      connector.resume(context, input, {
        approved: true,
        approvalId: "approval-forged",
        sessionId: "session-original",
      }),
    ).rejects.toThrow(/승인 ID/u);
    expect(query).toHaveBeenCalledOnce();
  });

  it("Governance permission bridge가 없으면 PreToolUse에서 도구 사용을 거부한다", async () => {
    let permissionDecision: unknown;
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      permissionDecision = await invokePreToolUse(options, {
        sessionId: "session-no-bridge",
        toolName: "Bash",
        toolInput: { command: "git status" },
        toolUseId: "tool-no-bridge",
      });
      yield { type: "result", subtype: "error_during_execution", session_id: "session-no-bridge" };
    });
    const connector = new ClaudeSubscriptionConnector(query);

    await expect(
      connector.execute(context, {
        executionId: "execution-no-bridge",
        workId: "work-1",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-no-bridge",
        profileRoot: "/tmp/claude-profile-no-bridge",
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({ outcome: "failed", sessionId: "session-no-bridge" });
    expect(permissionDecision).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "Governance permission bridge가 연결되지 않았습니다",
      },
    });
  });

  it("SDK 호출 시작 전 인증 실패는 401·출력 0·부작용 없음으로 구조화한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield {
        type: "assistant",
        error: "authentication_failed",
        session_id: "session-auth-failed",
        message: { content: [] },
      };
      yield {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-auth-failed",
        usage: { input_tokens: 8, output_tokens: 2 },
      };
    });
    const connector = new ClaudeSubscriptionConnector(query);

    await expect(
      connector.execute(context, {
        executionId: "execution-auth-failed",
        workId: "work-auth-failed",
        agentHandle: "representative",
        prompt: "인증 실패를 확인하세요",
        workspaceRoot: "/tmp/work-auth-failed",
        profileRoot: "/tmp/profile-auth-failed",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      usage: { inputTokens: 8, outputTokens: 2 },
    });
  });

  it("출처를 구조적으로 확인할 수 없는 SDK 실패는 부작용 발생으로 fail-closed한다", async () => {
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* () {
      yield { type: "result", subtype: "error_during_execution", session_id: "session-unknown-failed" };
    });
    const connector = new ClaudeSubscriptionConnector(query);

    const result = await connector.execute(context, {
      executionId: "execution-unknown-failed",
      workId: "work-unknown-failed",
      agentHandle: "representative",
      prompt: "알 수 없는 실패를 확인하세요",
      workspaceRoot: "/tmp/work-unknown-failed",
      profileRoot: "/tmp/profile-unknown-failed",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    });
    expect(result).toMatchObject({
      outcome: "failed",
      emittedTokens: 0,
      sideEffectsStarted: true,
    });
    expect(result).not.toHaveProperty("usage");
  });
});
