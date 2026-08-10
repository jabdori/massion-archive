import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { CodexSubscriptionConnector, type CodexSdkFactory } from "./codex-connector.js";
import { normalizeCodexExecutionEvidence } from "./execution-evidence.js";
import { SubscriptionStructuredOutputError } from "./agent-runtime.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("공식 Codex 구독 Connector", () => {
  const profiles: string[] = [];

  afterEach(async () => {
    await Promise.all(profiles.splice(0).map(async (profile) => await rm(profile, { recursive: true, force: true })));
  });

  it("명령과 출력의 secret segment만 redaction하고 일반 단어는 보존한다", () => {
    const evidence = normalizeCodexExecutionEvidence(
      [
        {
          id: "redaction-1",
          type: "command_execution",
          command: "secret=plainsecret123456 api_key=plainapikey123456 TOKEN=plainsecret123456 TURKEY=sandwich",
          aggregated_output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz The bearer capacity remains stable",
          exit_code: 0,
          status: "completed",
        },
      ],
      "/tmp/work-redaction",
    );
    expect(JSON.stringify(evidence)).not.toContain("plainsecret123456");
    expect(JSON.stringify(evidence)).not.toContain("plainapikey123456");
    expect(JSON.stringify(evidence)).toContain("TURKEY=sandwich");
    expect(JSON.stringify(evidence)).toContain("bearer capacity remains stable");
  });

  it("같은 fileChange provider item ID의 전체 원본이 달라지면 fail closed한다", () => {
    expect(() =>
      normalizeCodexExecutionEvidence(
        [
          { id: "files-1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" },
          {
            id: "files-1",
            type: "file_change",
            changes: [
              { path: "a.ts", kind: "update" },
              { path: "b.ts", kind: "update" },
            ],
            status: "completed",
          },
        ],
        "/tmp/work-redaction",
      ),
    ).toThrow("item ID가 충돌");
  });

  async function authenticatedManagedProfile(): Promise<string> {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-sdk-profile-"));
    profiles.push(profile);
    await chmod(profile, 0o700);
    await writeFile(join(profile, "auth.json"), "private-login-state", { mode: 0o600 });
    return profile;
  }

  it("허용된 실행 파일과 조직 실행 정책을 SDK 기본값 대신 명시적으로 전달한다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-policy", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "CODEX_HOME"],
      managedProfile: true,
      executable: "/opt/massion/connectors/codex",
      threadPolicy: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        model: "gpt-5.6-codex",
      },
    });
    const profileRoot = await authenticatedManagedProfile();

    await connector.execute(context, {
      executionId: "execution-policy",
      workId: "work-policy",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "정책을 확인하세요",
      workspaceRoot: "/tmp/work-policy",
      profileRoot,
      environment: { PATH: "/opt/massion/connectors", HOME: "/private/home" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      codexPathOverride: "/opt/massion/connectors/codex",
      env: {
        PATH: "/opt/massion/connectors",
        CODEX_HOME: profileRoot,
        HOME: profileRoot,
      },
      config: { cli_auth_credentials_store: "file" },
    });
    expect(startThread).toHaveBeenCalledWith({
      workingDirectory: "/tmp/work-policy",
      additionalDirectories: ["/tmp/work-policy"],
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      model: "gpt-5.6-codex",
    });
  });

  it("전체 권한은 SDK에 danger-full-access와 네트워크 허용을 그대로 전달한다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-full-access", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH"],
      threadPolicy: {
        sandboxMode: "danger-full-access" as never,
        approvalPolicy: "never",
        networkAccessEnabled: true,
      },
    });

    await connector.execute(context, {
      executionId: "execution-full-access",
      workId: "work-full-access",
      agentHandle: "representative",
      prompt: "전체 권한을 확인하세요",
      workspaceRoot: "/tmp/work-full-access",
      profileRoot: "/tmp/profile-full-access",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        networkAccessEnabled: true,
      }),
    );
    expect(startThread.mock.calls[0]?.[0]).not.toHaveProperty("additionalDirectories");
  });

  it("read-only 정책은 workspace를 추가 쓰기 경로로 승격하지 않는다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-read-only", run });
    const connector = new CodexSubscriptionConnector(
      { create: () => ({ startThread, resumeThread: vi.fn() }) },
      {
        allowedEnvironment: [],
        threadPolicy: {
          sandboxMode: "read-only",
          approvalPolicy: "never",
          networkAccessEnabled: false,
        },
      },
    );

    await connector.execute(context, {
      executionId: "execution-read-only",
      workId: "work-read-only",
      agentHandle: "representative",
      prompt: "읽기 전용 정책을 확인하세요",
      workspaceRoot: "/tmp/work-read-only",
      profileRoot: "/tmp/profile-read-only",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    });

    expect(startThread.mock.calls[0]?.[0]).not.toHaveProperty("additionalDirectories");
  });

  it("위험한 전체 접근 sandbox와 상대 실행 파일을 거부한다", () => {
    const factory = { create: vi.fn() } satisfies CodexSdkFactory;
    expect(
      () =>
        new CodexSubscriptionConnector(factory, {
          allowedEnvironment: ["PATH"],
          executable: "bin/codex",
          threadPolicy: {
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            networkAccessEnabled: false,
          },
        }),
    ).toThrow("절대 경로");
  });

  it("구조화 turn을 격리 workspace와 제한된 환경 변수로 실행한다", async () => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: JSON.stringify({ status: "ok" }),
      items: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const startThread = vi.fn().mockReturnValue({ id: "thread-1", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "CODEX_HOME"],
      managedProfile: true,
    });
    const profileRoot = await authenticatedManagedProfile();

    const result = await connector.executeStructured(
      context,
      {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "software-engineering.engineering-lead",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-1",
        profileRoot,
        environment: { PATH: "/usr/bin", CODEX_HOME: profileRoot, SECRET_TOKEN: "never-forward" },
        allowedTools: [],
        disallowedTools: [],
      },
      {
        name: "status",
        description: "실행 상태",
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string", enum: ["ok"] } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    );

    expect(create).toHaveBeenCalledWith({
      env: { PATH: "/usr/bin", CODEX_HOME: profileRoot, HOME: profileRoot },
      config: { cli_auth_credentials_store: "file" },
    });
    expect(startThread).toHaveBeenCalledWith({ workingDirectory: "/tmp/work-1", skipGitRepoCheck: true });
    const [structuredPrompt, turnOptions] = run.mock.calls[0] ?? [];
    expect(structuredPrompt).toContain("상태를 확인하세요");
    expect(structuredPrompt).toContain("Massion JSON output schema (status)");
    expect(structuredPrompt).toContain('"type":"object"');
    expect(structuredPrompt).toContain("도구 호출");
    expect(turnOptions).not.toHaveProperty("outputSchema");
    expect(result).toMatchObject({ outcome: "completed", sessionId: "thread-1", value: { status: "ok" } });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
  });

  it.each([
    {
      name: "JSON 파싱",
      finalResponse: "not-json",
      items: [],
      validate: undefined,
    },
    {
      name: "schema 검증",
      finalResponse: JSON.stringify({ status: "invalid" }),
      items: [],
      validate: () => ({ success: false as const, error: new Error("status 불일치") }),
    },
    {
      name: "실행 근거 검증",
      finalResponse: JSON.stringify({ status: "ok" }),
      items: [
        {
          id: "duplicate-command",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "1 passed",
          exit_code: 0,
          status: "completed",
        },
        {
          id: "duplicate-command",
          type: "command_execution",
          command: "pnpm lint",
          aggregated_output: "clean",
          exit_code: 0,
          status: "completed",
        },
      ],
      validate: undefined,
    },
  ])("구조화 $name 실패는 confirmed usage와 출력 sentinel을 typed carrier로 보존한다", async (value) => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: value.finalResponse,
      items: value.items,
      usage: { input_tokens: 8, output_tokens: 37 },
    });
    const connector = new CodexSubscriptionConnector({
      create: () => ({ startThread: () => ({ id: "thread-structured-failure", run }), resumeThread: vi.fn() }),
    });
    let failure: unknown;

    try {
      await connector.executeStructured(
        context,
        {
          executionId: "execution-structured-failure",
          workId: "work-structured-failure",
          agentHandle: "representative",
          prompt: "구조화 결과를 반환하세요",
          workspaceRoot: "/tmp/work-structured-failure",
          profileRoot: "/tmp/profile-structured-failure",
          environment: {},
          allowedTools: [],
          disallowedTools: [],
        },
        {
          name: "status",
          description: "상태",
          jsonSchema: { type: "object" },
          ...(value.validate ? { validate: value.validate } : {}),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SubscriptionStructuredOutputError);
    expect(failure).toMatchObject({
      usage: { inputTokens: 8, outputTokens: 37 },
      emittedTokens: 1,
      sideEffectsStarted: true,
    });
  });

  it("응답 text와 usage가 없어도 command/file item을 본 구조화 실패는 부작용을 보존한다", async () => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: "",
      items: [
        {
          id: "file-side-effect",
          type: "file_change",
          changes: [{ path: "src/result.ts", kind: "update" }],
          status: "completed",
        },
      ],
      usage: { input_tokens: 8, output_tokens: 0 },
    });
    const connector = new CodexSubscriptionConnector({
      create: () => ({ startThread: () => ({ id: "thread-side-effect", run }), resumeThread: vi.fn() }),
    });
    let failure: unknown;

    try {
      await connector.executeStructured(
        context,
        {
          executionId: "execution-side-effect",
          workId: "work-side-effect",
          agentHandle: "representative",
          prompt: "구조화 결과를 반환하세요",
          workspaceRoot: "/tmp/work-side-effect",
          profileRoot: "/tmp/profile-side-effect",
          environment: {},
          allowedTools: [],
          disallowedTools: [],
        },
        { name: "status", description: "상태", jsonSchema: { type: "object" } },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      usage: { inputTokens: 8, outputTokens: 0 },
      emittedTokens: 0,
      sideEffectsStarted: true,
    });
  });

  it("일반 실행 근거 검증 실패도 confirmed usage와 부작용을 typed carrier로 보존한다", async () => {
    const connector = new CodexSubscriptionConnector({
      create: () => ({
        startThread: () => ({
          id: "thread-evidence-failure",
          run: vi.fn().mockResolvedValue({
            finalResponse: "완료",
            items: [
              {
                id: "duplicate-command",
                type: "command_execution",
                command: "pnpm test",
                aggregated_output: "1 passed",
                exit_code: 0,
                status: "completed",
              },
              {
                id: "duplicate-command",
                type: "command_execution",
                command: "pnpm lint",
                aggregated_output: "clean",
                exit_code: 0,
                status: "completed",
              },
            ],
            usage: { input_tokens: 8, output_tokens: 37 },
          }),
        }),
        resumeThread: vi.fn(),
      }),
    });

    await expect(
      connector.execute(context, {
        executionId: "execution-evidence-failure",
        workId: "work-evidence-failure",
        agentHandle: "representative",
        prompt: "작업을 완료하세요",
        workspaceRoot: "/tmp/work-evidence-failure",
        profileRoot: "/tmp/profile-evidence-failure",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toMatchObject({
      usage: { inputTokens: 8, outputTokens: 37 },
      emittedTokens: 1,
      sideEffectsStarted: true,
    });
  });

  it("성공한 terminal 명령과 파일 변경만 정규화한 실행 근거로 보존한다", async () => {
    const secret = "sk-this-must-never-reach-a-receipt-123456";
    const run = vi.fn().mockResolvedValue({
      finalResponse: "완료",
      items: [
        {
          id: "command-1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: `9 passed\nTOKEN=${secret}`,
          exit_code: 0,
          status: "completed",
        },
        {
          id: "file-1",
          type: "file_change",
          changes: [{ path: "src/report.ts", kind: "update" }],
          status: "completed",
        },
        { id: "reasoning-1", type: "reasoning", text: "저장하면 안 되는 추론" },
        {
          id: "failed-command",
          type: "command_execution",
          command: "false",
          aggregated_output: "실패",
          exit_code: 1,
          status: "failed",
        },
      ],
      usage: null,
    });
    const startThread = vi.fn().mockReturnValue({ id: "thread-evidence", run });
    const connector = new CodexSubscriptionConnector({ create: vi.fn().mockReturnValue({ startThread }) });

    const result = await connector.execute(context, {
      executionId: "execution-evidence",
      workId: "work-evidence",
      agentHandle: "representative",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-evidence",
      profileRoot: "/tmp/profile-evidence",
      environment: {},
      allowedTools: [],
      disallowedTools: [],
    });

    expect(result).toMatchObject({
      outcome: "completed",
      value: "완료",
      executionEvidence: {
        items: [
          expect.objectContaining({
            providerItemId: "command-1",
            kind: "command",
            command: "pnpm test",
            exitCode: 0,
            status: "completed",
          }),
          expect.objectContaining({
            providerItemId: "file-1:0",
            kind: "file",
            path: "src/report.ts",
            changeKind: "modified",
            status: "completed",
          }),
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("추론");
  });

  it("관리 Codex profile의 auth.json이 없으면 SDK client를 만들지 않고 실행을 거부한다", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-sdk-missing-auth-"));
    profiles.push(profileRoot);
    await chmod(profileRoot, 0o700);
    const create = vi.fn();
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH"],
      managedProfile: true,
    });

    await expect(
      connector.execute(context, {
        executionId: "execution-missing-auth",
        workId: "work-missing-auth",
        agentHandle: "representative",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-missing-auth",
        profileRoot,
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toThrow(/auth\.json|재인증/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("외부 Edge profile은 사용자가 선택한 credential storage와 HOME을 바꾸지 않는다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-external", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "HOME", "CODEX_HOME"],
    });

    await connector.execute(context, {
      executionId: "execution-external",
      workId: "work-external",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "외부 profile을 확인하세요",
      workspaceRoot: "/tmp/work-external",
      profileRoot: "/tmp/profile-external",
      environment: { PATH: "/usr/bin", HOME: "/private/external-home" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      env: {
        PATH: "/usr/bin",
        HOME: "/private/external-home",
        CODEX_HOME: "/tmp/profile-external",
      },
    });
  });

  it("저장된 공식 thread ID로 같은 session을 재개한다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const resumeThread = vi.fn().mockReturnValue({ id: "thread-existing", run });
    const connector = new CodexSubscriptionConnector(
      { create: () => ({ startThread: vi.fn(), resumeThread }) },
      {
        allowedEnvironment: ["PATH"],
        threadPolicy: {
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: false,
        },
      },
    );

    await connector.execute(context, {
      executionId: "execution-2",
      workId: "work-1",
      agentHandle: "representative",
      prompt: "계속하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/profile-1",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
      sessionId: "thread-existing",
    });

    expect(resumeThread).toHaveBeenCalledWith("thread-existing", {
      workingDirectory: "/tmp/work-1",
      additionalDirectories: ["/tmp/work-1"],
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    });
  });

  it.each([
    ["메시지", new Error("HTTP 401 Unauthorized")],
    ["status", Object.assign(new Error("인증이 필요합니다"), { status: 401 })],
    ["statusCode", Object.assign(new Error("인증이 필요합니다"), { statusCode: 401 })],
    ["code", Object.assign(new Error("인증이 필요합니다"), { code: 401 })],
    ["cause", new Error("SDK 실행 실패", { cause: { statusCode: 401 } })],
  ])("공식 SDK에 없는 %s 401 형태는 fallback 가능한 실패로 분류하지 않는다", async (_label, failure) => {
    const connector = new CodexSubscriptionConnector({
      create: () => ({
        startThread: () => ({
          id: "thread-untrusted-401",
          run: vi.fn().mockRejectedValue(failure),
          runStreamed: vi.fn().mockResolvedValue({
            events: (async function* () {
              yield { type: "turn.started" };
              throw failure;
            })(),
          }),
        }),
        resumeThread: vi.fn(),
      }),
    } as CodexSdkFactory);

    await expect(
      connector.execute(context, {
        executionId: "execution-untrusted-401",
        workId: "work-untrusted-401",
        agentHandle: "representative",
        prompt: "신뢰할 수 없는 오류를 확인하세요",
        workspaceRoot: "/tmp/work-untrusted-401",
        profileRoot: "/tmp/profile-untrusted-401",
        environment: {},
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toBe(failure);
  });

  it("실행 중인 turn을 취소하면 SDK AbortSignal을 중단한다", async () => {
    let turnSignal: AbortSignal | undefined;
    const run = vi.fn().mockImplementation(
      (_input, options?: { readonly signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          turnSignal = options?.signal;
          turnSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const connector = new CodexSubscriptionConnector({
      create: () => ({
        startThread: () => ({ id: "thread-cancel", run }),
        resumeThread: vi.fn(),
      }),
    });
    const execution = connector.execute(context, {
      executionId: "execution-cancel",
      workId: "work-1",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "취소 대기",
      workspaceRoot: "/tmp/work-cancel",
      profileRoot: "/tmp/profile-cancel",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });

    await connector.cancel(context, "execution-cancel");

    expect(turnSignal?.aborted).toBe(true);
    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      executionId: "execution-cancel",
      sessionId: "thread-cancel",
    });
  });
});
