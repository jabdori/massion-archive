import type { ExtensionPermissionDeclaration } from "@massion/extension-sdk";
import type { TenantContext } from "@massion/identity";

export interface ExtensionWorkerSessionView {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly installationId: string;
  readonly versionId: string;
  readonly activationGeneration: number;
  readonly state: "starting" | "healthy" | "draining" | "stopped" | "failed" | "blocked";
  readonly permissions: ExtensionPermissionDeclaration;
}

export type ExtensionCapabilityOperation =
  | { readonly kind: "tool"; readonly toolId: string; readonly operation: string; readonly input: unknown }
  | {
      readonly kind: "network";
      readonly origin: string;
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly body?: unknown;
      readonly secretSlot?: string;
    }
  | { readonly kind: "file.read"; readonly mount: string; readonly path: string }
  | { readonly kind: "file.write"; readonly mount: string; readonly path: string; readonly content: string }
  | { readonly kind: "mcp"; readonly serverId: string; readonly tool: string; readonly input: unknown }
  | { readonly kind: "event.subscribe"; readonly eventType: string }
  | {
      readonly kind: "storage.put";
      readonly key: string;
      readonly value: unknown;
      readonly expectedVersion?: number;
    }
  | { readonly kind: "storage.get"; readonly key: string }
  | { readonly kind: "storage.list"; readonly limit?: number };

export interface ExtensionCapabilityCallInput {
  readonly sessionId: string;
  readonly workId: string;
  readonly commandId: string;
  readonly deadline: Date;
  readonly operation: ExtensionCapabilityOperation;
}

export interface ExtensionBrokerDependencies {
  readonly sessions: { resolve(sessionId: string): Promise<ExtensionWorkerSessionView> };
  readonly emergency: { assertExecutionAllowed(context: TenantContext): Promise<void> };
  readonly tools: {
    invoke(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly commandId: string;
      readonly toolId: string;
      readonly operation: string;
      readonly input: unknown;
      readonly deadline: Date;
    }): Promise<unknown>;
  };
  readonly network: {
    request(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly commandId: string;
      readonly origin: string;
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
      readonly secretSlot?: string;
      readonly allowedOrigins: readonly string[];
      readonly deadline: Date;
    }): Promise<{ readonly status: number; readonly body: unknown; readonly finalOrigin: string }>;
  };
  readonly files: {
    read(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly mount: string;
      readonly path: string;
      readonly deadline: Date;
    }): Promise<unknown>;
    write(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly mount: string;
      readonly path: string;
      readonly content: string;
      readonly deadline: Date;
    }): Promise<unknown>;
  };
  readonly mcp: {
    invoke(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly serverId: string;
      readonly tool: string;
      readonly input: unknown;
      readonly deadline: Date;
    }): Promise<unknown>;
  };
  readonly events: {
    subscribe(input: {
      readonly context: TenantContext;
      readonly workId: string;
      readonly eventType: string;
      readonly deadline: Date;
    }): Promise<unknown>;
  };
  readonly storage: {
    put(
      context: TenantContext,
      input: {
        readonly commandId: string;
        readonly installationId: string;
        readonly versionId: string;
        readonly key: string;
        readonly value: unknown;
        readonly expectedVersion?: number;
        readonly quotaBytes: number;
        readonly maxValueBytes: number;
      },
    ): Promise<unknown>;
    // `put`은 객체 인자, `get`·`list`는 위치 인자입니다 — ExtensionStorageService의 실제 모양입니다.
    // 예전에는 셋 다 객체 인자로 선언돼 있어, 이 broker와 실제 storage 서비스가 한 번도 함께
    // 컴파일된 적이 없었습니다. 조립하려는 순간 타입 오류가 나는 선언이었습니다.
    get(context: TenantContext, installationId: string, key: string): Promise<unknown>;
    list(context: TenantContext, installationId: string, limit?: number): Promise<unknown>;
  };
}

function assertBounded(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024)
    throw new Error("Extension capability payload byte 상한을 초과했습니다");
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 10) throw new Error("Extension capability payload 깊이 상한을 초과했습니다");
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error("Extension capability payload에 prototype key를 사용할 수 없습니다");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function assertLogicalPath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Extension file logical path가 유효하지 않습니다");
  }
}

function assertSafeResult(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s]+/iu.test(encoded)
  ) {
    throw new Error("Extension capability 결과에 secret이 포함됐습니다");
  }
  assertBounded(value);
}

export class ExtensionCapabilityBroker {
  private readonly inFlight = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();

  public constructor(
    private readonly dependencies: ExtensionBrokerDependencies,
    private readonly limits: { readonly maxConcurrent?: number; readonly maxPerMinute?: number } = {},
  ) {}

  public async call(context: TenantContext, input: ExtensionCapabilityCallInput): Promise<unknown> {
    if (!Number.isFinite(input.deadline.getTime()) || input.deadline.getTime() <= Date.now()) {
      throw new Error("Extension capability deadline이 만료됐습니다");
    }
    assertBounded(input.operation);
    const session = await this.dependencies.sessions.resolve(input.sessionId);
    if (session.organizationId !== context.organizationId)
      throw new Error("Extension worker session organization이 다릅니다");
    if (session.state !== "healthy") throw new Error("Extension worker session은 healthy 상태여야 합니다");
    await this.dependencies.emergency.assertExecutionAllowed(context);
    this.enter(session.sessionId);
    try {
      const result = await this.dispatch(context, session, input);
      assertSafeResult(result);
      return result;
    } finally {
      this.inFlight.set(session.sessionId, Math.max(0, (this.inFlight.get(session.sessionId) ?? 1) - 1));
    }
  }

  private enter(sessionId: string): void {
    const concurrent = this.inFlight.get(sessionId) ?? 0;
    if (concurrent >= (this.limits.maxConcurrent ?? 16))
      throw new Error("Extension capability 동시 실행 상한을 초과했습니다");
    const now = Date.now();
    const attempts = (this.attempts.get(sessionId) ?? []).filter((time) => time > now - 60_000);
    if (attempts.length >= (this.limits.maxPerMinute ?? 100))
      throw new Error("Extension capability rate 상한을 초과했습니다");
    attempts.push(now);
    this.attempts.set(sessionId, attempts);
    this.inFlight.set(sessionId, concurrent + 1);
  }

  private async dispatch(
    context: TenantContext,
    session: ExtensionWorkerSessionView,
    input: ExtensionCapabilityCallInput,
  ): Promise<unknown> {
    const operation = input.operation;
    if (operation.kind === "tool") {
      const declared = session.permissions.tools.some(
        (tool) => tool.id === operation.toolId && tool.operations.includes(operation.operation),
      );
      if (!declared) throw new Error("선언하지 않은 Extension tool capability입니다");
      return await this.dependencies.tools.invoke({
        context,
        workId: input.workId,
        commandId: input.commandId,
        toolId: operation.toolId,
        operation: operation.operation,
        input: operation.input,
        deadline: input.deadline,
      });
    }
    if (operation.kind === "network") {
      const declared = session.permissions.network.some(
        (network) => network.origin === operation.origin && network.methods.includes(operation.method),
      );
      if (!declared) throw new Error("선언하지 않은 Extension network capability입니다");
      if (operation.secretSlot && !session.permissions.secrets.some((secret) => secret.slot === operation.secretSlot)) {
        throw new Error("선언하지 않은 Extension secret slot입니다");
      }
      if (!operation.path.startsWith("/") || operation.path.includes("..")) {
        throw new Error("Extension network path가 유효하지 않습니다");
      }
      const allowedOrigins = session.permissions.network.map((network) => network.origin);
      const result = await this.dependencies.network.request({
        context,
        workId: input.workId,
        commandId: input.commandId,
        origin: operation.origin,
        method: operation.method,
        path: operation.path,
        ...(operation.body === undefined ? {} : { body: operation.body }),
        ...(operation.secretSlot === undefined ? {} : { secretSlot: operation.secretSlot }),
        allowedOrigins,
        deadline: input.deadline,
      });
      if (!allowedOrigins.includes(result.finalOrigin))
        throw new Error("Extension network redirect가 allowlist를 벗어났습니다");
      return result;
    }
    if (operation.kind === "file.read" || operation.kind === "file.write") {
      const declared = session.permissions.files.find((file) => file.mount === operation.mount);
      if (!declared) throw new Error("선언하지 않은 Extension file mount입니다");
      if (operation.kind === "file.write" && declared.access !== "write") {
        throw new Error("Extension file mount에 write 권한이 없습니다");
      }
      assertLogicalPath(operation.path);
      return operation.kind === "file.read"
        ? await this.dependencies.files.read({
            context,
            workId: input.workId,
            mount: operation.mount,
            path: operation.path,
            deadline: input.deadline,
          })
        : await this.dependencies.files.write({
            context,
            workId: input.workId,
            mount: operation.mount,
            path: operation.path,
            content: operation.content,
            deadline: input.deadline,
          });
    }
    if (operation.kind === "mcp") {
      if (!session.permissions.mcp.includes(operation.serverId)) {
        throw new Error("선언하지 않은 Extension MCP capability입니다");
      }
      return await this.dependencies.mcp.invoke({
        context,
        workId: input.workId,
        serverId: operation.serverId,
        tool: operation.tool,
        input: operation.input,
        deadline: input.deadline,
      });
    }
    if (operation.kind === "event.subscribe") {
      if (!session.permissions.events.includes(operation.eventType)) {
        throw new Error("선언하지 않은 Extension event capability입니다");
      }
      return await this.dependencies.events.subscribe({
        context,
        workId: input.workId,
        eventType: operation.eventType,
        deadline: input.deadline,
      });
    }
    if (operation.kind === "storage.put") {
      return await this.dependencies.storage.put(context, {
        commandId: input.commandId,
        installationId: session.installationId,
        versionId: session.versionId,
        key: operation.key,
        value: operation.value,
        ...(operation.expectedVersion === undefined ? {} : { expectedVersion: operation.expectedVersion }),
        quotaBytes: session.permissions.storage.quotaBytes,
        maxValueBytes: session.permissions.storage.maxValueBytes,
      });
    }
    if (operation.kind === "storage.get") {
      return await this.dependencies.storage.get(context, session.installationId, operation.key);
    }
    return await this.dependencies.storage.list(context, session.installationId, operation.limit);
  }
}
