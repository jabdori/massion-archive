import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { TenantContext } from "@massion/identity";

import {
  normalizeConfirmedAgentUsage,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
  type SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export interface AcpPromptResult {
  readonly text: string;
  readonly stopReason: StopReason;
  readonly usage?: unknown;
  readonly outputLimit?: boolean;
}

export interface AcpSession {
  readonly sessionId: string;
  prompt(prompt: string): Promise<AcpPromptResult>;
  cancel(): Promise<void>;
}

export interface AcpClient {
  openSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId?: string;
    readonly modelId?: string;
    readonly signal?: AbortSignal;
  }): Promise<AcpSession>;
  close(): Promise<void> | void;
}

async function closeAcpClient(client: AcpClient): Promise<void> {
  try {
    await client.close();
  } catch {
    process.emitWarning("ACP client 정리에 실패했습니다", { code: "MASSION_ACP_CLEANUP_FAILED" });
  }
}

export type AcpPermissionRequest = (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

export interface AcpFileSystemBridge {
  readonly writeEnabled: boolean;
  readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(request: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

export interface AcpClientFactory {
  create(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly requestPermission: AcpPermissionRequest;
    readonly authenticationMethod?: string;
    readonly fileSystem?: AcpFileSystemBridge;
    readonly signal?: AbortSignal;
  }): Promise<AcpClient>;
}

export interface AcpPermissionBridge {
  request(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly request: RequestPermissionRequest;
    },
  ): Promise<RequestPermissionResponse>;
}

const DENY_PERMISSIONS: AcpPermissionBridge = {
  request: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
};
const MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_READ_LINES = 100_000;
export const MAXIMUM_ACP_OUTPUT_BYTES = 64 * 1024;

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function filePath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error("ACP file 경로는 절대 경로여야 합니다");
  return resolve(value);
}

function workspaceFileSystem(workspaceRoot: string, access: "read-only" | "workspace-write"): AcpFileSystemBridge {
  const canonicalRoot = (async () => {
    const root = filePath(workspaceRoot);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("ACP workspace root가 안전하지 않습니다");
    const canonical = await realpath(root);
    return { lexical: root, canonical };
  })();

  const existingFile = async (path: string): Promise<string> => {
    const root = await canonicalRoot;
    const candidate = filePath(path);
    if (!within(root.lexical, candidate)) throw new Error("ACP file 경로가 workspace 범위를 벗어났습니다");
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("ACP file은 link가 없는 regular file이어야 합니다");
    }
    if (metadata.size > MAXIMUM_FILE_BYTES) throw new Error("ACP file byte 상한을 초과했습니다");
    const canonical = await realpath(candidate);
    const expected = resolve(root.canonical, relative(root.lexical, candidate));
    if (canonical !== expected || !within(root.canonical, canonical)) {
      throw new Error("ACP file symlink가 workspace를 벗어났습니다");
    }
    return canonical;
  };

  const writableFile = async (path: string): Promise<string> => {
    const root = await canonicalRoot;
    const candidate = filePath(path);
    if (!within(root.lexical, candidate) || candidate === root.lexical) {
      throw new Error("ACP file 경로가 workspace 범위를 벗어났습니다");
    }
    const parent = dirname(candidate);
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error("ACP file 상위 경로가 안전하지 않습니다");
    }
    const canonicalParent = await realpath(parent);
    const expectedParent = resolve(root.canonical, relative(root.lexical, parent));
    if (canonicalParent !== expectedParent || !within(root.canonical, canonicalParent)) {
      throw new Error("ACP file 상위 경로가 workspace 범위를 벗어났습니다");
    }
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error("ACP file은 link가 없는 regular file이어야 합니다");
      }
      const canonical = await realpath(candidate);
      const expected = resolve(root.canonical, relative(root.lexical, candidate));
      if (canonical !== expected || !within(root.canonical, canonical)) {
        throw new Error("ACP file symlink가 workspace를 벗어났습니다");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return candidate;
  };

  return {
    writeEnabled: access === "workspace-write",
    readTextFile: async (request) => {
      const path = await existingFile(request.path);
      const content = await readFile(path, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAXIMUM_FILE_BYTES) {
        throw new Error("ACP file byte 상한을 초과했습니다");
      }
      if (request.line === undefined && request.limit === undefined) return { content };
      const line = request.line ?? 1;
      const limit = request.limit ?? MAXIMUM_READ_LINES;
      if (
        !Number.isSafeInteger(line) ||
        line < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        limit > MAXIMUM_READ_LINES
      ) {
        throw new Error("ACP file line 범위가 유효하지 않습니다");
      }
      return {
        content: content
          .split(/\r?\n/u)
          .slice(line - 1, line - 1 + limit)
          .join("\n"),
      };
    },
    writeTextFile: async (request) => {
      if (access !== "workspace-write") throw new Error("읽기 전용 ACP workspace에는 쓸 수 없습니다");
      if (Buffer.byteLength(request.content, "utf8") > MAXIMUM_FILE_BYTES) {
        throw new Error("ACP file byte 상한을 초과했습니다");
      }
      const path = await writableFile(request.path);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error("ACP file은 link가 없는 regular file이어야 합니다");
        }
        await handle.writeFile(request.content, "utf8");
      } finally {
        await handle.close();
      }
      return {};
    },
  };
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (exited: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = (): void => {
      finish(true);
    };
    const onError = (): void => {
      finish(true);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

class NodeAcpSession implements AcpSession {
  public constructor(
    public readonly sessionId: string,
    private readonly client: NodeAcpClient,
  ) {}

  public async prompt(prompt: string): Promise<AcpPromptResult> {
    return await this.client.prompt(this.sessionId, prompt);
  }

  public async cancel(): Promise<void> {
    await this.client.cancel(this.sessionId);
  }
}

class NodeAcpClient implements AcpClient {
  private readonly connection: ClientConnection;
  private readonly textBySession = new Map<
    string,
    { readonly chunks: string[]; bytes: number; outputLimit: boolean; cancellationRequested: boolean }
  >();
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    requestPermission: AcpPermissionRequest,
    private readonly fileSystem?: AcpFileSystemBridge,
  ) {
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const app = client({ name: "massion" })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => await requestPermission(params))
      .onNotification(methods.client.session.update, ({ params }) => {
        this.recordUpdate(params);
      });
    if (fileSystem) {
      app.onRequest(methods.client.fs.readTextFile, async ({ params }) => await fileSystem.readTextFile(params));
      app.onRequest(methods.client.fs.writeTextFile, async ({ params }) => await fileSystem.writeTextFile(params));
    }
    this.connection = app.connect(ndJsonStream(output, input));
    child.stderr.resume();
  }

  public async initialize(authenticationMethod?: string, signal?: AbortSignal): Promise<void> {
    const response = await this.connection.agent.request(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: this.fileSystem
          ? { fs: { readTextFile: true, writeTextFile: this.fileSystem.writeEnabled } }
          : {},
        clientInfo: { name: "massion", version: "1.0.0" },
      },
      signal ? { cancellationSignal: signal } : undefined,
    );
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`지원하지 않는 ACP protocol version입니다: ${String(response.protocolVersion)}`);
    }
    if (authenticationMethod) {
      if (!response.authMethods?.some((method) => method.id === authenticationMethod)) {
        throw new Error(`ACP Agent가 인증 방식을 지원하지 않습니다: ${authenticationMethod}`);
      }
      await this.connection.agent.request(
        methods.agent.authenticate,
        {
          methodId: authenticationMethod,
          _meta: { headless: true },
        },
        signal ? { cancellationSignal: signal } : undefined,
      );
    }
  }

  public async openSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId?: string;
    readonly modelId?: string;
    readonly signal?: AbortSignal;
  }): Promise<AcpSession> {
    if (input.signal?.aborted) throw new Error("ACP session 열기가 중단됐습니다");
    const abort = (): void => {
      this.connection.close(new Error("ACP session 열기가 중단됐습니다"));
      this.child.kill("SIGKILL");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      let configOptions: Array<SessionConfigOption> | null | undefined;
      let sessionId: string;
      if (input.sessionId) {
        const response = await this.connection.agent.request(
          methods.agent.session.load,
          { cwd: input.workspaceRoot, mcpServers: [], sessionId: input.sessionId },
          input.signal ? { cancellationSignal: input.signal } : undefined,
        );
        sessionId = input.sessionId;
        configOptions = response.configOptions;
      } else {
        const response = await this.connection.agent.request(
          methods.agent.session.new,
          { cwd: input.workspaceRoot, mcpServers: [] },
          input.signal ? { cancellationSignal: input.signal } : undefined,
        );
        sessionId = response.sessionId;
        configOptions = response.configOptions;
      }
      if (input.modelId) await this.selectModel(sessionId, configOptions, input.modelId, input.signal);
      return new NodeAcpSession(sessionId, this);
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  public async prompt(sessionId: string, prompt: string): Promise<AcpPromptResult> {
    const output = { chunks: [], bytes: 0, outputLimit: false, cancellationRequested: false };
    this.textBySession.set(sessionId, output);
    try {
      const response = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      const usage = response._meta?.["quota"];
      return {
        text: output.chunks.join(""),
        stopReason: response.stopReason,
        ...(usage === undefined ? {} : { usage }),
        ...(output.outputLimit ? { outputLimit: true } : {}),
      };
    } finally {
      this.textBySession.delete(sessionId);
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private recordUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
    const output = this.textBySession.get(notification.sessionId);
    if (!output || output.outputLimit) return;
    const bytes = Buffer.byteLength(update.content.text, "utf8");
    if (output.bytes + bytes > MAXIMUM_ACP_OUTPUT_BYTES) {
      output.outputLimit = true;
      if (!output.cancellationRequested) {
        output.cancellationRequested = true;
        void this.cancel(notification.sessionId).catch(() => undefined);
      }
      return;
    }
    output.chunks.push(update.content.text);
    output.bytes += bytes;
  }

  private async selectModel(
    sessionId: string,
    configOptions: Array<SessionConfigOption> | null | undefined,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (modelId === "provider-default") {
      throw new Error("provider-default 별칭은 검증된 ACP model ID가 아닙니다");
    }
    const modelOptions = (configOptions ?? []).filter(
      (option): option is Extract<SessionConfigOption, { type: "select" }> =>
        option.type === "select" && option.category === "model",
    );
    if (modelOptions.length !== 1 || !modelOptions[0]) {
      throw new Error("ACP Agent가 단일 model discovery 계약을 제공하지 않습니다");
    }
    const values = modelOptions[0].options.flatMap((option) =>
      "options" in option ? option.options.map((child) => child.value) : [option.value],
    );
    if (!values.includes(modelId)) throw new Error("요청한 model ID가 ACP model discovery에 없습니다");
    await this.connection.agent.request(
      methods.agent.session.setConfigOption,
      { sessionId, configId: modelOptions[0].id, value: modelId },
      signal ? { cancellationSignal: signal } : undefined,
    );
  }

  private async shutdown(): Promise<void> {
    this.connection.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (childHasExited(this.child)) return;
    this.child.kill("SIGTERM");
    if (await waitForChildExit(this.child, 2_000)) return;
    this.child.kill("SIGKILL");
    await waitForChildExit(this.child, 2_000);
  }
}

export class NodeAcpClientFactory implements AcpClientFactory {
  public async create(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly requestPermission: AcpPermissionRequest;
    readonly authenticationMethod?: string;
    readonly fileSystem?: AcpFileSystemBridge;
    readonly signal?: AbortSignal;
  }): Promise<AcpClient> {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: input.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new NodeAcpClient(child, input.requestPermission, input.fileSystem);
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.initialize(input.authenticationMethod, input.signal);
      return client;
    } catch (error) {
      await closeAcpClient(client);
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

interface ActiveAcpExecution {
  readonly client: AcpClient;
  readonly session: AcpSession;
  cancelled: boolean;
  closePromise?: Promise<void>;
}

interface InitializingAcpExecution {
  readonly controller: AbortController;
  cancelled: boolean;
}

interface AcpProcessConnectorOptions {
  readonly providerName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly profileEnvironmentVariable: string;
  readonly toolPolicy: "copilot-flags" | "grok-flags" | "unsupported";
  readonly authenticationMethod?: string;
  readonly model?: string;
  readonly modelSelection: "session-config" | "process-argument";
  readonly workspaceAccess?: "read-only" | "workspace-write";
}

const NODE_ACP_FACTORY = new NodeAcpClientFactory();

function toolPattern(value: string): string {
  if (!value || value.length > 512 || value.startsWith("--") || /[\0\r\n]/u.test(value)) {
    throw new Error("ACP 도구 filter 값이 유효하지 않습니다");
  }
  return value;
}

function modelId(value: string): string {
  if (value === "provider-default" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) || /[\0\r\n]/u.test(value)) {
    throw new Error("provider-default 별칭이 아닌 검증된 model ID가 필요합니다");
  }
  return value;
}

export class AcpProcessConnector implements SubscriptionAgentAdapter {
  public static readonly protocolVersion = PROTOCOL_VERSION;
  private readonly active = new Map<string, ActiveAcpExecution | InitializingAcpExecution>();

  public constructor(
    private readonly options: AcpProcessConnectorOptions,
    private readonly factory: AcpClientFactory = NODE_ACP_FACTORY,
    private readonly permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {}

  public async execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error(`${this.options.providerName} workspace와 profile root는 절대 경로여야 합니다`);
    }
    if (!isAbsolute(this.options.executable)) {
      throw new Error(`${this.options.providerName} ACP 실행 파일은 절대 경로여야 합니다`);
    }
    const selectedModel = this.options.model ? modelId(this.options.model) : undefined;
    if (
      this.options.toolPolicy === "unsupported" &&
      (input.allowedTools.length > 0 || input.disallowedTools.length > 0)
    ) {
      throw new Error(`${this.options.providerName} ACP는 Massion 요청별 도구 filter를 지원하지 않습니다`);
    }
    const env = Object.fromEntries(
      ["PATH", "LANG", "LC_ALL"].flatMap((key) => {
        const value = input.environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    env[this.options.profileEnvironmentVariable] = input.profileRoot;
    const allowedTools = input.allowedTools.map(toolPattern).join(",");
    const disallowedTools = input.disallowedTools.map(toolPattern).join(",");
    const toolArgs =
      this.options.toolPolicy === "copilot-flags"
        ? [
            ...(allowedTools ? ["--available-tools", allowedTools] : []),
            ...(disallowedTools ? ["--excluded-tools", disallowedTools] : []),
          ]
        : this.options.toolPolicy === "grok-flags"
          ? [
              ...(allowedTools ? ["--tools", allowedTools] : []),
              ...(disallowedTools ? ["--disallowed-tools", disallowedTools] : []),
            ]
          : [];
    if (this.active.has(input.executionId)) throw new Error("ACP 실행 ID가 이미 사용 중입니다");
    const initializing: InitializingAcpExecution = { controller: new AbortController(), cancelled: false };
    this.active.set(input.executionId, initializing);
    let client: AcpClient | undefined;
    try {
      client = await this.factory.create({
        executable: this.options.executable,
        args: [...this.options.args, ...toolArgs],
        cwd: input.workspaceRoot,
        env,
        shell: false,
        requestPermission: async (request) => {
          const response = await this.permissions.request(context, {
            executionId: input.executionId,
            workId: input.workId,
            agentHandle: input.agentHandle,
            request,
          });
          const outcome = response.outcome;
          if (outcome.outcome !== "selected") return response;
          return request.options.some((option) => option.optionId === outcome.optionId)
            ? response
            : { outcome: { outcome: "cancelled" } };
        },
        ...(this.options.authenticationMethod ? { authenticationMethod: this.options.authenticationMethod } : {}),
        ...(this.options.workspaceAccess
          ? { fileSystem: workspaceFileSystem(input.workspaceRoot, this.options.workspaceAccess) }
          : {}),
        signal: initializing.controller.signal,
      });
      if (initializing.cancelled) {
        await closeAcpClient(client);
        return { outcome: "cancelled", executionId: input.executionId };
      }
      const session = await client.openSession({
        workspaceRoot: input.workspaceRoot,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(selectedModel && this.options.modelSelection === "session-config" ? { modelId: selectedModel } : {}),
        signal: initializing.controller.signal,
      });
      if (initializing.controller.signal.aborted) {
        await closeAcpClient(client);
        return { outcome: "cancelled", executionId: input.executionId, sessionId: session.sessionId };
      }
      const active: ActiveAcpExecution = { client, session, cancelled: false };
      this.active.set(input.executionId, active);
      try {
        const response = await session.prompt(input.prompt);
        const confirmedUsage = normalizeConfirmedAgentUsage(response.usage);
        const emittedTokens = Math.max(response.text ? 1 : 0, (confirmedUsage?.outputTokens ?? 0) > 0 ? 1 : 0);
        if (active.cancelled || response.stopReason === "cancelled") {
          return {
            outcome: "cancelled",
            executionId: input.executionId,
            sessionId: session.sessionId,
            emittedTokens,
            ...(confirmedUsage ? { usage: confirmedUsage } : {}),
          };
        }
        if (response.outputLimit) {
          return {
            outcome: "failed",
            executionId: input.executionId,
            sessionId: session.sessionId,
            category: "acp-output-limit",
            retryable: false,
            signal: { kind: "input" },
            emittedTokens,
            sideEffectsStarted: true,
            ...(confirmedUsage ? { usage: confirmedUsage } : {}),
          };
        }
        if (response.stopReason !== "end_turn") {
          return {
            outcome: "failed",
            executionId: input.executionId,
            sessionId: session.sessionId,
            category: `acp-${response.stopReason}`,
            retryable: false,
            emittedTokens,
            sideEffectsStarted: true,
            ...(confirmedUsage ? { usage: confirmedUsage } : {}),
          };
        }
        return {
          outcome: "completed",
          executionId: input.executionId,
          sessionId: session.sessionId,
          value: response.text,
          ...(response.usage === undefined ? {} : { usage: response.usage }),
        };
      } catch (error) {
        if (active.cancelled) {
          return { outcome: "cancelled", executionId: input.executionId, sessionId: session.sessionId };
        }
        throw error;
      } finally {
        if (this.active.get(input.executionId) === active) this.active.delete(input.executionId);
        await this.close(active);
      }
    } catch (error) {
      if (initializing.cancelled) return { outcome: "cancelled", executionId: input.executionId };
      throw error;
    } finally {
      if (this.active.get(input.executionId) === initializing) this.active.delete(input.executionId);
    }
  }

  public async resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult> {
    if (!approval.approved) {
      return { outcome: "cancelled", executionId: input.executionId, sessionId: approval.sessionId };
    }
    return await this.execute(context, { ...input, sessionId: approval.sessionId });
  }

  public async cancel(_context: TenantContext, executionId: string): Promise<void> {
    const active = this.active.get(executionId);
    if (!active) return;
    if ("controller" in active) {
      active.cancelled = true;
      active.controller.abort();
      return;
    }
    active.cancelled = true;
    try {
      await active.session.cancel();
    } finally {
      await this.close(active);
      if (this.active.get(executionId) === active) this.active.delete(executionId);
    }
  }

  private close(active: ActiveAcpExecution): Promise<void> {
    active.closePromise ??= closeAcpClient(active.client);
    return active.closePromise;
  }
}

export class CopilotAcpConnector extends AcpProcessConnector {
  public constructor(
    options: {
      readonly executable: string;
      readonly model?: string;
      readonly workspaceAccess?: "read-only" | "workspace-write";
    },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "GitHub Copilot",
        executable: options.executable,
        args: ["--acp", "--stdio"],
        profileEnvironmentVariable: "COPILOT_HOME",
        toolPolicy: "copilot-flags",
        modelSelection: "session-config",
        ...(options.model ? { model: options.model } : {}),
        ...(options.workspaceAccess ? { workspaceAccess: options.workspaceAccess } : {}),
      },
      factory,
      permissions,
    );
  }
}

export class GeminiCliAcpConnector extends AcpProcessConnector {
  public constructor(
    options: {
      readonly executable: string;
      readonly model?: string;
      readonly workspaceAccess?: "read-only" | "workspace-write";
      readonly sandbox?: boolean;
    },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "Google Gemini CLI",
        executable: options.executable,
        args: [
          ...(options.sandbox ? ["--sandbox"] : []),
          ...(options.model ? ["--model", modelId(options.model)] : []),
          "--acp",
        ],
        profileEnvironmentVariable: "GEMINI_CLI_HOME",
        toolPolicy: "unsupported",
        modelSelection: "process-argument",
        ...(options.model ? { model: options.model } : {}),
        ...(options.workspaceAccess ? { workspaceAccess: options.workspaceAccess } : {}),
      },
      factory,
      permissions,
    );
  }
}

export class GrokBuildAcpConnector extends AcpProcessConnector {
  public constructor(
    options: {
      readonly executable: string;
      readonly model?: string;
      readonly workspaceAccess?: "read-only" | "workspace-write";
      readonly sandbox?: "strict";
    },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "xAI Grok Build",
        executable: options.executable,
        args: [
          "--no-auto-update",
          ...(options.sandbox ? ["--sandbox", options.sandbox] : []),
          ...(options.model ? ["--model", modelId(options.model)] : []),
          "agent",
          "stdio",
        ],
        profileEnvironmentVariable: "GROK_HOME",
        toolPolicy: "grok-flags",
        authenticationMethod: "cached_token",
        modelSelection: "process-argument",
        ...(options.model ? { model: options.model } : {}),
        ...(options.workspaceAccess ? { workspaceAccess: options.workspaceAccess } : {}),
      },
      factory,
      permissions,
    );
  }
}
