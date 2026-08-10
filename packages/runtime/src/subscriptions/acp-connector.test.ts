import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  CopilotAcpConnector,
  GeminiCliAcpConnector,
  GrokBuildAcpConnector,
  MAXIMUM_ACP_OUTPUT_BYTES,
  NodeAcpClientFactory,
  type AcpClient,
  type AcpClientFactory,
  type AcpPromptResult,
  type AcpSession,
} from "./acp-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("Node ACP process factory", () => {
  it("공식 SDK NDJSON process와 initialize·session·prompt를 실제로 왕복한다", async () => {
    const factory = new NodeAcpClientFactory();
    const fixture = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url));
    const client = await factory.create({
      executable: process.execPath,
      args: [fixture],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    });

    try {
      const session = await client.openSession({ workspaceRoot: "/tmp" });
      await expect(session.prompt("안녕하세요")).resolves.toEqual({
        text: "fixture:안녕하세요",
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 3 },
      });
    } finally {
      await client.close();
    }
  });

  it("ACP file system capability와 read request를 실제 NDJSON process에서 왕복한다", async () => {
    const factory = new NodeAcpClientFactory();
    const fixture = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url));
    const readTextFile = vi.fn().mockResolvedValue({ content: "안전한 내용" });
    const client = await factory.create({
      executable: process.execPath,
      args: [fixture],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
      fileSystem: {
        writeEnabled: false,
        readTextFile,
        writeTextFile: vi.fn().mockRejectedValue(new Error("읽기 전용")),
      },
    });

    try {
      const session = await client.openSession({ workspaceRoot: "/tmp" });
      await expect(session.prompt("fs-read")).resolves.toMatchObject({ text: "fixture-fs:안전한 내용" });
      expect(readTextFile).toHaveBeenCalledWith({ sessionId: session.sessionId, path: "/tmp/fixture.txt" });
    } finally {
      await client.close();
    }
  });

  it("ACP session이 공개한 model option에 실제 model ID가 있을 때만 선택한다", async () => {
    const factory = new NodeAcpClientFactory();
    const fixture = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url));
    const client = await factory.create({
      executable: process.execPath,
      args: [fixture],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    });

    try {
      await expect(client.openSession({ workspaceRoot: "/tmp", modelId: "fixture-model" })).resolves.toMatchObject({
        sessionId: expect.stringMatching(/^fixture-session-/u),
      });
      await expect(client.openSession({ workspaceRoot: "/tmp", modelId: "provider-default" })).rejects.toThrow(
        /provider-default|model ID/u,
      );
      await expect(client.openSession({ workspaceRoot: "/tmp", modelId: "missing-model" })).rejects.toThrow(
        /model.*discovery|model ID/u,
      );
      const controller = new AbortController();
      controller.abort("health timeout");
      await expect(client.openSession({ workspaceRoot: "/tmp", signal: controller.signal })).rejects.toThrow(
        /중단|abort|closed/u,
      );
    } finally {
      await client.close();
    }
  });

  it("ACP Agent가 출력 상한을 넘기면 누적하지 않고 취소 신호를 보낸 뒤 제한 결과로 끝낸다", async () => {
    const factory = new NodeAcpClientFactory();
    const fixture = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url));
    const client = await factory.create({
      executable: process.execPath,
      args: [fixture],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    });

    try {
      const session = await client.openSession({ workspaceRoot: "/tmp" });
      await expect(session.prompt("output-limit")).resolves.toMatchObject({ outputLimit: true });
      const result = await session.prompt("output-limit");
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAXIMUM_ACP_OUTPUT_BYTES);
    } finally {
      await client.close();
    }
  });
});

describe("GitHub Copilot ACP Connector", () => {
  it("ACP file proxy가 workspace 밖 읽기·symlink 탈출과 read-only 쓰기를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-acp-fs-"));
    const workspaceRoot = join(root, "workspace");
    const outsideRoot = join(root, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    await writeFile(join(workspaceRoot, "inside.txt"), "첫째\n둘째\n셋째\n", "utf8");
    await writeFile(join(outsideRoot, "secret.txt"), "secret", "utf8");
    await symlink(outsideRoot, join(workspaceRoot, "escape"), "dir");
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-fs",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new CopilotAcpConnector(
      { executable: "/opt/massion/connectors/copilot", workspaceAccess: "read-only" },
      { create } satisfies AcpClientFactory,
    );

    try {
      await connector.execute(context, {
        executionId: "execution-fs",
        workId: "work-fs",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot,
        profileRoot: join(root, "profile"),
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      });
      const fileSystem = create.mock.calls[0]?.[0].fileSystem;
      expect(fileSystem).toBeDefined();
      await expect(
        fileSystem?.readTextFile({
          sessionId: "session-fs",
          path: join(workspaceRoot, "inside.txt"),
          line: 2,
          limit: 1,
        }),
      ).resolves.toEqual({ content: "둘째" });
      await expect(
        fileSystem?.readTextFile({ sessionId: "session-fs", path: join(outsideRoot, "secret.txt") }),
      ).rejects.toThrow(/workspace|범위/u);
      await expect(
        fileSystem?.readTextFile({ sessionId: "session-fs", path: join(workspaceRoot, "escape", "secret.txt") }),
      ).rejects.toThrow(/workspace|범위|symlink/u);
      await expect(
        fileSystem?.writeTextFile({
          sessionId: "session-fs",
          path: join(workspaceRoot, "new.txt"),
          content: "blocked",
        }),
      ).rejects.toThrow(/읽기 전용|read-only/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("workspace-write ACP file proxy는 내부 regular file만 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-acp-write-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-write",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new CopilotAcpConnector(
      { executable: "/opt/massion/connectors/copilot", workspaceAccess: "workspace-write" },
      { create } satisfies AcpClientFactory,
    );

    try {
      await connector.execute(context, {
        executionId: "execution-write",
        workId: "work-write",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot,
        profileRoot: join(root, "profile"),
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      });
      const fileSystem = create.mock.calls[0]?.[0].fileSystem;
      await fileSystem?.writeTextFile({
        sessionId: "session-write",
        path: join(workspaceRoot, "new.txt"),
        content: "safe",
      });
      await expect(readFile(join(workspaceRoot, "new.txt"), "utf8")).resolves.toBe("safe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shell 없이 공식 ACP command를 계정 profile과 workspace에 연결한다", async () => {
    const prompt = vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" });
    const openSession = vi.fn().mockResolvedValue({ sessionId: "session-1", prompt, cancel: vi.fn() });
    const create = vi.fn().mockResolvedValue({ openSession, close: vi.fn() });
    const connector = new CopilotAcpConnector(
      {
        executable: "/opt/massion/connectors/copilot",
      },
      { create } satisfies AcpClientFactory,
    );

    const result = await connector.execute(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/copilot-profile-1",
      environment: { PATH: "/usr/bin", GH_TOKEN: "do-not-forward" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/opt/massion/connectors/copilot",
        args: ["--acp", "--stdio"],
        cwd: "/tmp/work-1",
        env: { PATH: "/usr/bin", COPILOT_HOME: "/tmp/copilot-profile-1" },
        shell: false,
        requestPermission: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(openSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/tmp/work-1", signal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({ outcome: "completed", sessionId: "session-1", value: "완료" });
  });

  it("라우터의 실제 model ID를 ACP session model discovery에 전달하고 provider-default 별칭은 거부한다", async () => {
    const openSession = vi.fn().mockResolvedValue({
      sessionId: "session-model",
      prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
      cancel: vi.fn(),
    });
    const create = vi.fn().mockResolvedValue({ openSession, close: vi.fn() });
    const input = {
      executionId: "execution-model",
      workId: "work-model",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-model",
      profileRoot: "/tmp/copilot-profile-model",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    } as const;

    await new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot", model: "claude-sonnet-4.6" }, {
      create,
    } satisfies AcpClientFactory).execute(context, input);
    expect(openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/tmp/work-model",
        modelId: "claude-sonnet-4.6",
        signal: expect.any(AbortSignal),
      }),
    );

    await expect(
      new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot", model: "provider-default" }, {
        create,
      } satisfies AcpClientFactory).execute(context, input),
    ).rejects.toThrow(/provider-default|model ID/u);
  });

  it("session ID를 prompt 전에 등록해 실행 중 ACP cancel을 한 번만 보낸다", async () => {
    let finishPrompt: ((result: { text: string; stopReason: string }) => void) | undefined;
    const prompt = vi.fn().mockImplementation(
      () =>
        new Promise<{ text: string; stopReason: string }>((resolve) => {
          finishPrompt = resolve;
        }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const session: AcpSession = { sessionId: "session-live", prompt, cancel };
    const close = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ openSession: vi.fn().mockResolvedValue(session), close });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    const execution = connector.execute(context, {
      executionId: "execution-live",
      workId: "work-live",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "오래 걸리는 작업",
      workspaceRoot: "/tmp/work-live",
      profileRoot: "/tmp/copilot-profile-live",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    await connector.cancel(context, "execution-live");
    finishPrompt?.({ text: "", stopReason: "cancelled" });

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      executionId: "execution-live",
      sessionId: "session-live",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("ACP initialize 중 취소되면 session이 생기기 전에 process를 중단하고 취소 결과를 반환한다", async () => {
    let resolveClient: ((client: AcpClient) => void) | undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockImplementation(
      (input: { readonly signal?: AbortSignal }) =>
        new Promise((resolve) => {
          resolveClient = resolve as (client: AcpClient) => void;
          input.signal?.addEventListener("abort", () => undefined, { once: true });
        }),
    );
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);
    const execution = connector.execute(context, {
      executionId: "execution-initializing-cancel",
      workId: "work-initializing-cancel",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "초기화 중 취소",
      workspaceRoot: "/tmp/work-initializing-cancel",
      profileRoot: "/tmp/copilot-profile-initializing-cancel",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const signal = create.mock.calls[0]?.[0].signal;

    await connector.cancel(context, "execution-initializing-cancel");
    expect(signal?.aborted).toBe(true);
    resolveClient?.({
      openSession: vi.fn(),
      close,
    } as never);

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      executionId: "execution-initializing-cancel",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "output 상한",
      response: {
        text: "부분 출력",
        stopReason: "end_turn",
        outputLimit: true,
        usage: { inputTokens: 8, outputTokens: 37 },
      } satisfies AcpPromptResult,
      expected: {
        outcome: "failed",
        category: "acp-output-limit",
        retryable: false,
        signal: { kind: "input" },
        emittedTokens: 1,
        sideEffectsStarted: true,
        usage: { inputTokens: 8, outputTokens: 37 },
      },
    },
    {
      label: "비정상 종료",
      response: {
        text: "부분 출력",
        stopReason: "max_tokens",
        usage: { inputTokens: 8, outputTokens: 37 },
      } satisfies AcpPromptResult,
      expected: {
        outcome: "failed",
        category: "acp-max_tokens",
        retryable: false,
        emittedTokens: 1,
        sideEffectsStarted: true,
        usage: { inputTokens: 8, outputTokens: 37 },
      },
    },
    {
      label: "취소",
      response: {
        text: "부분 출력",
        stopReason: "cancelled",
        usage: { inputTokens: 8, outputTokens: 37 },
      } satisfies AcpPromptResult,
      expected: {
        outcome: "cancelled",
        emittedTokens: 1,
        usage: { inputTokens: 8, outputTokens: 37 },
      },
    },
  ])("ACP $label terminal은 출력 조각과 확정 usage를 보존한다", async ({ label, response, expected }) => {
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: `session-${label}`,
        prompt: vi.fn().mockResolvedValue(response),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    const result = await connector.execute(context, {
      executionId: `execution-${label}`,
      workId: `work-${label}`,
      agentHandle: "software-engineering.backend-specialist",
      prompt: "terminal 근거 검증",
      workspaceRoot: `/tmp/work-${label}`,
      profileRoot: `/tmp/copilot-profile-${label}`,
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain("부분 출력");
  });

  it("terminal 결과 뒤 client 정리 실패는 결과를 덮지 않고 원문 없는 운영 경고로 분리한다", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-cleanup-failure",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn().mockRejectedValue(new Error("secret cleanup failure")),
    });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    await expect(
      connector.execute(context, {
        executionId: "execution-cleanup-failure",
        workId: "work-cleanup-failure",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "정리 실패 검증",
        workspaceRoot: "/tmp/work-cleanup-failure",
        profileRoot: "/tmp/copilot-profile-cleanup-failure",
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).resolves.toMatchObject({ outcome: "completed", value: "완료" });
    expect(warning).toHaveBeenCalledWith("ACP client 정리에 실패했습니다", {
      code: "MASSION_ACP_CLEANUP_FAILED",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret cleanup failure");
    warning.mockRestore();
  });

  it("실행 파일 절대 경로를 명시하지 않으면 process를 만들지 않는다", async () => {
    const create = vi.fn();
    const connector = new CopilotAcpConnector({ executable: "copilot" }, { create } satisfies AcpClientFactory);

    await expect(
      connector.execute(context, {
        executionId: "execution-relative",
        workId: "work-relative",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot: "/tmp/work-relative",
        profileRoot: "/tmp/copilot-profile-relative",
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toThrow("절대 경로");
    expect(create).not.toHaveBeenCalled();
  });

  it("공식 Copilot ACP tool filter flag로 요청별 허용·제외 범위를 전달한다", async () => {
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-tools",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    await connector.execute(context, {
      executionId: "execution-tools",
      workId: "work-tools",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-tools",
      profileRoot: "/tmp/copilot-profile-tools",
      environment: { PATH: "/usr/bin" },
      allowedTools: ["read_file", "write_file"],
      disallowedTools: ["shell(rm *)"],
    });

    expect(create.mock.calls[0]?.[0].args).toEqual([
      "--acp",
      "--stdio",
      "--available-tools",
      "read_file,write_file",
      "--excluded-tools",
      "shell(rm *)",
    ]);
  });
});

describe("Google Gemini CLI ACP Connector", () => {
  it("기업·Cloud profile을 공식 Gemini ACP command와 GEMINI_CLI_HOME으로 격리한다", async () => {
    const prompt = vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" });
    const openSession = vi.fn().mockResolvedValue({ sessionId: "gemini-session", prompt, cancel: vi.fn() });
    const create = vi.fn().mockResolvedValue({ openSession, close: vi.fn() });
    const connector = new GeminiCliAcpConnector(
      { executable: "/opt/massion/connectors/gemini", model: "gemini-3.1-pro" },
      {
        create,
      } satisfies AcpClientFactory,
    );

    await connector.execute(context, {
      executionId: "gemini-execution",
      workId: "gemini-work",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/gemini-work",
      profileRoot: "/tmp/gemini-profile",
      environment: { PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "do-not-forward" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/opt/massion/connectors/gemini",
        args: ["--model", "gemini-3.1-pro", "--acp"],
        cwd: "/tmp/gemini-work",
        env: { PATH: "/usr/bin", GEMINI_CLI_HOME: "/tmp/gemini-profile" },
        shell: false,
        requestPermission: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(openSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/tmp/gemini-work", signal: expect.any(AbortSignal) }),
    );
  });

  it("Gemini ACP가 표현하지 못하는 요청별 tool filter를 조용히 무시하지 않는다", async () => {
    const create = vi.fn();
    const connector = new GeminiCliAcpConnector({ executable: "/opt/massion/connectors/gemini" }, {
      create,
    } satisfies AcpClientFactory);

    await expect(
      connector.execute(context, {
        executionId: "gemini-tools",
        workId: "gemini-work-tools",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot: "/tmp/gemini-work-tools",
        profileRoot: "/tmp/gemini-profile-tools",
        environment: { PATH: "/usr/bin" },
        allowedTools: ["read_file"],
        disallowedTools: [],
      }),
    ).rejects.toThrow("요청별 도구 filter");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("xAI Grok Build ACP Connector", () => {
  it("공식 ACP command·cached login·profile home·tool filter를 process에 전달한다", async () => {
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "grok-session",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new GrokBuildAcpConnector({ executable: "/opt/massion/connectors/grok", model: "grok-build" }, {
      create,
    } satisfies AcpClientFactory);

    await connector.execute(context, {
      executionId: "grok-execution",
      workId: "grok-work",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/grok-work",
      profileRoot: "/tmp/grok-profile",
      environment: { PATH: "/usr/bin", XAI_API_KEY: "do-not-forward" },
      allowedTools: ["read_file"],
      disallowedTools: ["shell(rm *)"],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/opt/massion/connectors/grok",
        args: [
          "--no-auto-update",
          "--model",
          "grok-build",
          "agent",
          "stdio",
          "--tools",
          "read_file",
          "--disallowed-tools",
          "shell(rm *)",
        ],
        cwd: "/tmp/grok-work",
        env: { PATH: "/usr/bin", GROK_HOME: "/tmp/grok-profile" },
        shell: false,
        requestPermission: expect.any(Function),
        authenticationMethod: "cached_token",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(create.mock.results[0]).toBeDefined();
    expect(JSON.stringify(create.mock.calls[0])).not.toContain("do-not-forward");
  });
});
