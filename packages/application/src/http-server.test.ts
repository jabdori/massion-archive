import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import type { ApplicationEventV1 } from "./contracts.js";
import { ApplicationEventCursorExpiredError } from "./event-store.js";
import {
  ApplicationBootstrapCapability,
  ApplicationHttpServer,
  type ApplicationBootstrapDisposalReason,
  type ApplicationHttpDependencies,
} from "./http-server.js";

const context = {
  userId: "http-user",
  organizationId: "http-organization",
  membershipId: "http-membership",
  role: "owner" as const,
};

function event(sequence: number): ApplicationEventV1 {
  return {
    schemaVersion: "massion.application.event.v1",
    eventId: `event-http-${String(sequence).padStart(4, "0")}`,
    organizationId: context.organizationId,
    sequence,
    type: "work.changed",
    author: { kind: "system", id: "test" },
    occurredAt: "2026-07-11T00:00:00.000Z",
    payload: { sequence },
  };
}

describe("ApplicationHttpServer", () => {
  let server: ApplicationHttpServer;
  let baseUrl: string;
  let events: ApplicationEventV1[];
  let calls: string[];
  let eventReads: number;
  let eventRecoveries: number;
  let recoverEvents: () => boolean | Promise<boolean>;
  let bootstrapInitialize: () => Promise<unknown>;
  let bootstrapNow: number;
  let bootstrapConsumed: ReturnType<typeof vi.fn<(reason: ApplicationBootstrapDisposalReason) => Promise<void>>>;
  let bootstrapCleanupError: ReturnType<typeof vi.fn<(reason: ApplicationBootstrapDisposalReason) => void>>;

  const bootstrapCapability = Buffer.alloc(32, 7).toString("base64url");

  beforeEach(async () => {
    events = [];
    calls = [];
    eventReads = 0;
    eventRecoveries = 0;
    recoverEvents = () => false;
    bootstrapNow = Date.now();
    bootstrapConsumed = vi.fn(async () => {});
    bootstrapCleanupError = vi.fn<(reason: ApplicationBootstrapDisposalReason) => void>();
    bootstrapInitialize = async () => ({ access: { token: "one-time" } });
    const bootstrapSecret = Buffer.from(bootstrapCapability, "base64url");
    const bootstrapAuthorization = new ApplicationBootstrapCapability({
      capability: bootstrapSecret,
      expiresAt: bootstrapNow + 60_000,
      clock: () => bootstrapNow,
      onDisposed: bootstrapConsumed,
      onCleanupError: bootstrapCleanupError,
    });
    expect(bootstrapSecret).toEqual(Buffer.alloc(32));
    expect(JSON.stringify(bootstrapAuthorization)).toBe("{}");
    const dependencies: ApplicationHttpDependencies = {
      auth: {
        async authenticateAccess(authorization) {
          if (authorization !== "Bearer test-token") throw new Error("invalid token");
          return { context, tokenId: "token-http", scopes: ["application:*"] };
        },
        async refreshLocalAccess(authorization, audience, requiredScopes, input) {
          if (authorization !== "Bearer expired-token") throw new Error("invalid refresh token");
          expect(audience).toBe("massion-api");
          expect(requiredScopes).toEqual([]);
          expect(input.commandId).toBe("refresh-http-token-0001");
          return {
            tokenId: "refreshed-http-token",
            organizationId: context.organizationId,
            userId: context.userId,
            audience,
            scopes: ["application:*"],
            issuedAt: "2026-07-11T00:00:00.000Z",
            expiresAt: "2026-07-11T01:00:00.000Z",
            replayed: false,
            token: "mat_refreshed-token",
          };
        },
      },
      queries: {
        async query(_context, _scopes, operation, payload) {
          calls.push(`query:${operation}`);
          return { schemaVersion: "massion.application.v1", operation, data: payload };
        },
      },
      commands: {
        async dispatch(_context, _scopes, input) {
          calls.push("command");
          return { outcome: (input as { outcome?: string }).outcome ?? "succeeded" };
        },
      },
      events: {
        async recover() {
          eventRecoveries += 1;
          return await recoverEvents();
        },
        async read(_context, input) {
          eventReads += 1;
          if (input.after === 99) throw new ApplicationEventCursorExpiredError(100);
          const selected = events.filter((item) => item.sequence > input.after).slice(0, input.limit);
          return { events: selected, cursor: selected.at(-1)?.sequence ?? input.after };
        },
      },
      tokens: {
        issue: async (_context, input) => ({ tokenId: "issued", ...input }),
        revoke: async () => undefined,
      },
      artifacts: {
        inspect: async (_context, archive) => ({ size: archive.length }),
        install: async (_context, input) => ({ commandId: input.commandId, size: input.archive.length }),
      },
      registryPublisher: {
        publish: async (_context, input) => ({
          commandId: input.commandId,
          size: input.archive.length,
          metadata: input.metadata,
        }),
      },
      connectorEnrollments: {
        issue: async (_context, input) => ({
          enrollmentId: "enrollment-http-1",
          enrollmentCode: "one-time-enrollment-code",
          challengeNonce: "one-time-challenge",
          expiresAt: "2030-01-01T00:10:00.000Z",
          ...input,
        }),
      },
      bootstrap: {
        authorization: bootstrapAuthorization,
        initialize: async () => await bootstrapInitialize(),
      },
      integrations: {
        async handle(input) {
          calls.push(`integration:${input.path}`);
          return { status: 202, body: { accepted: true, bytes: input.body.length } };
        },
      },
      health: {
        async readiness() {
          return { database: true, migrations: true };
        },
      },
    };
    server = new ApplicationHttpServer(dependencies, { pollMs: 5, heartbeatMs: 20 });
    baseUrl = (await server.start()).url;
  });

  afterEach(async () => server.close());

  it("인증된 status·query·command와 method/content negotiation을 제공한다", async () => {
    const headers = { authorization: "Bearer test-token", accept: "application/json" };
    expect((await fetch(`${baseUrl}/api/v1/status`, { headers })).status).toBe(200);
    const query = await fetch(`${baseUrl}/api/v1/query`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operation: "work.list", payload: {} }),
    });
    expect(query.status).toBe(200);
    const accepted = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "accepted" }),
    });
    expect(accepted.status).toBe(202);
    const wrongMethod = await fetch(`${baseUrl}/api/v1/status`, { method: "POST", headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(calls).toEqual(["query:system.status", "query:work.list", "command"]);
  });

  it("제거된 Web UI session 경로를 제공하지 않는다", async () => {
    for (const path of ["sessions", "local-session", "login-tickets", "session"]) {
      const response = await fetch(`${baseUrl}/api/v1/web/${path}`, {
        headers: { authorization: "Bearer test-token", accept: "application/json" },
      });
      expect(response.status).toBe(404);
    }
  });

  it("인증 없이 생존·준비 상태를 공개하고 drain 중 일반 traffic을 거부한다", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "live" });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ components: { database: "ready", migrations: "ready" }, status: "ready" });

    server.beginDrain();
    const draining = await fetch(`${baseUrl}/health/ready`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({ status: "not-ready" });
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/status`, {
          headers: { authorization: "Bearer test-token", accept: "application/json" },
        })
      ).status,
    ).toBe(503);
  });

  it("drain이 활성 SSE 연결을 닫아 server close가 완료된다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body가 없습니다");
    await reader.read();

    const closing = server.close();
    await expect(Promise.race([closing.then(() => true), delay(250).then(() => false)])).resolves.toBe(true);
    await reader.cancel().catch(() => undefined);
    await closing;
  });

  it("component readiness 오류 원문을 숨기고 고정 상태만 반환한다", async () => {
    await server.close();
    server = new ApplicationHttpServer({
      auth: { authenticateAccess: async () => ({ context, tokenId: "token", scopes: ["application:*"] }) },
      queries: { query: async () => ({}) },
      commands: { dispatch: async () => ({}) },
      events: { read: async () => ({ events: [], cursor: 0 }) },
      health: { readiness: async () => Promise.reject(new Error("secret database URL")) },
    });
    baseUrl = (await server.start()).url;

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready" });
  });

  it("Authorization header만 받고 CORS와 JSON byte 상한을 fail-closed한다", async () => {
    expect((await fetch(`${baseUrl}/api/v1/status?token=test-token`)).status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/status`, {
          headers: { origin: "https://evil.example", authorization: "Bearer test-token" },
        })
      ).status,
    ).toBe(403);
    const oversized = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(400);
  });

  it("bootstrap capability가 누락·불일치하면 같은 오류로 거부하고 성공 뒤 replay도 거부한다", async () => {
    const request = async (authorization?: string) =>
      await fetch(`${baseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: "bootstrap-command-0001" }),
      });

    const missing = await request();
    const invalid = await request(`MassionBootstrap ${Buffer.alloc(32, 8).toString("base64url")}`);
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    const { errorId: missingErrorId, ...missingError } = (await missing.json()) as Record<string, unknown>;
    const { errorId: invalidErrorId, ...invalidError } = (await invalid.json()) as Record<string, unknown>;
    expect(missingErrorId).toEqual(expect.any(String));
    expect(invalidErrorId).toEqual(expect.any(String));
    expect(invalidError).toEqual(missingError);

    const response = await request(`MassionBootstrap ${bootstrapCapability}`);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ access: { token: "one-time" } });

    const replay = await request(`MassionBootstrap ${bootstrapCapability}`);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject(missingError);
    expect(bootstrapConsumed).toHaveBeenCalledOnce();
    expect(bootstrapConsumed).toHaveBeenCalledWith("consumed");
  });

  it("동일 bootstrap capability 동시 요청은 하나만 초기화를 소유한다", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    bootstrapInitialize = async () => {
      started?.();
      await waiting;
      return { access: { token: "one-time" } };
    };
    const send = async () =>
      await fetch(`${baseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: {
          authorization: `MassionBootstrap ${bootstrapCapability}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: "bootstrap-command-0001" }),
      });

    const owner = send();
    await entered;
    const raced = send();
    await delay(20);
    release?.();
    expect((await Promise.all([owner, raced])).map(({ status }) => status).sort()).toEqual([201, 401]);
  });

  it("만료된 bootstrap capability는 초기화를 호출하지 않고 거부한다", async () => {
    const initialize = vi.fn(bootstrapInitialize);
    bootstrapInitialize = initialize;
    bootstrapNow += 60_001;

    const response = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      method: "POST",
      headers: {
        authorization: `MassionBootstrap ${bootstrapCapability}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "expired-bootstrap-command-0001" }),
    });

    expect(response.status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
    expect(bootstrapConsumed).toHaveBeenCalledWith("expired");
  });

  it("bootstrap 성공 cleanup 실패가 발급 응답을 잃거나 replay를 다시 열지 않는다", async () => {
    bootstrapConsumed.mockRejectedValueOnce(new Error("capability path cleanup failed: secret-path"));
    const request = async () =>
      await fetch(`${baseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: {
          authorization: `MassionBootstrap ${bootstrapCapability}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: "bootstrap-cleanup-failure-0001" }),
      });

    const issued = await request();
    expect(issued.status).toBe(201);
    expect(await issued.json()).toMatchObject({ access: { token: "one-time" } });
    expect((await request()).status).toBe(401);
    expect(bootstrapCleanupError).toHaveBeenCalledWith("consumed");
    expect(JSON.stringify(bootstrapCleanupError.mock.calls)).not.toContain("secret-path");
  });

  it("bootstrap 초기화 오류는 capability를 폐기하고 이후 replay를 거부한다", async () => {
    bootstrapInitialize = async () => {
      throw new Error("bootstrap initialization failed");
    };
    const request = async () =>
      await fetch(`${baseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: {
          authorization: `MassionBootstrap ${bootstrapCapability}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: "bootstrap-initialize-failure-0001" }),
      });

    expect((await request()).status).toBe(500);
    expect((await request()).status).toBe(401);
    expect(bootstrapConsumed).toHaveBeenCalledWith("failed");
  });

  it("listen 전 close도 bootstrap 비밀을 폐기하고 cleanup을 한 번만 수행한다", async () => {
    await server.close();
    const source = Buffer.alloc(32, 19);
    const disposed = vi.fn();
    const authorization = new ApplicationBootstrapCapability({
      capability: source,
      expiresAt: Date.now() + 60_000,
      onDisposed: disposed,
    });
    server = new ApplicationHttpServer({
      auth: { authenticateAccess: async () => ({ context, tokenId: "token", scopes: ["application:*"] }) },
      queries: { query: async () => ({}) },
      commands: { dispatch: async () => ({}) },
      events: { read: async () => ({ events: [], cursor: 0 }) },
      bootstrap: { authorization, initialize: async () => ({}) },
    });

    expect(source).toEqual(Buffer.alloc(32));
    await server.close();
    await server.close();
    expect(disposed).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledWith("closed");
  });

  it("loopback access refresh는 만료된 Bearer 원문으로만 새 token을 발급한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/access/refresh`, {
      method: "POST",
      headers: {
        authorization: "Bearer expired-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "refresh-http-token-0001" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ access: { token: "mat_refreshed-token", replayed: false } });
  });

  it("loopback access refresh의 잘못된 token은 내부 오류 대신 인증 오류로 반환한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/access/refresh`, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "refresh-http-token-0002" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ category: "authentication", operatorCode: "APP_HTTP_AUTH" });
  });

  it("Connector enrollment code는 인증된 전용 non-cache HTTP 응답으로만 발급한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "connector-enrollment-command-0001",
        location: "edge",
        executionKind: "agent-runtime",
        ttlMs: 60_000,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      enrollmentId: "enrollment-http-1",
      enrollmentCode: "one-time-enrollment-code",
      challengeNonce: "one-time-challenge",
    });
    const serverEnrollment = await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "server-enrollment-must-use-provisioning",
        location: "server",
        executionKind: "agent-runtime",
      }),
    });
    expect(serverEnrollment.status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
          headers: { authorization: "Bearer test-token" },
        })
      ).status,
    ).toBe(405);
  });

  it("binary artifact를 JSON envelope와 분리해 inspect·install한다", async () => {
    const inspect = await fetch(`${baseUrl}/api/v1/artifacts/inspect`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/octet-stream",
      },
      body: Buffer.from("artifact"),
    });
    expect(await inspect.json()).toEqual({ size: 8 });
    const install = await fetch(`${baseUrl}/api/v1/artifacts/install`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/octet-stream",
        "x-massion-command-id": "artifact-command-0001",
      },
      body: Buffer.from("artifact"),
    });
    expect(await install.json()).toEqual({ commandId: "artifact-command-0001", size: 8 });
  });

  it("Registry publish metadata와 artifact를 versioned binary frame으로 분리한다", async () => {
    const metadata = Buffer.from(JSON.stringify({ uploadGrant: "grant-reference", visibility: "public" }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    const response = await fetch(`${baseUrl}/api/v1/registry/publish`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/vnd.massion.registry-publish.v1",
        "x-massion-command-id": "registry-publish-command-1",
      },
      body: Buffer.concat([prefix, metadata, Buffer.from("artifact")]),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      commandId: "registry-publish-command-1",
      size: 8,
      metadata: { uploadGrant: "grant-reference", visibility: "public" },
    });
  });

  it("외부 Integration webhook은 Application bearer 인증 전에 전용 gateway로만 전달한다", async () => {
    const response = await fetch(`${baseUrl}/integrations/github/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: JSON.stringify({ installation: { id: 1 } }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, bytes: 25 });
    expect(calls).toEqual(["integration:/integrations/github/webhooks"]);
  });

  it("SSE가 after를 replay하고 Last-Event-ID 재연결을 우선한다", async () => {
    events.push(event(1), event(2), event(3));
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events/stream?after=1`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream", "last-event-id": "2" },
      signal: abort.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body가 없습니다");
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 2");
    abort.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("일반 event GET은 cursor를 먼저 검증하고 recovery가 만든 event를 같은 응답에 포함한다", async () => {
    recoverEvents = () => {
      events.push(event(1));
      return true;
    };

    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { authorization: "Bearer test-token", accept: "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ events: [expect.objectContaining({ sequence: 1 })] });
    expect(eventReads).toBe(2);
    expect(eventRecoveries).toBe(1);
  });

  it("일반 event GET의 만료 cursor는 recovery를 실행하지 않는다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events?after=99`, {
      headers: { authorization: "Bearer test-token", accept: "application/json" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ operatorCode: "APP_EVENT_CURSOR_EXPIRED" });
    expect(eventReads).toBe(1);
    expect(eventRecoveries).toBe(0);
  });

  it("SSE 시작 때만 outbox를 복구하고 idle poll에서는 projection을 반복하지 않는다", async () => {
    const invalid = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { authorization: "Bearer test-token", accept: "application/json" },
    });
    expect(invalid.status).toBe(400);
    expect(eventRecoveries).toBe(0);

    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(eventReads).toBeGreaterThanOrEqual(3));

    expect(eventRecoveries).toBe(1);
    abort.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it("SSE header를 열기 전에 만료 cursor를 공개 409 오류로 반환한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/stream?after=99`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      category: "conflict",
      operatorCode: "APP_EVENT_CURSOR_EXPIRED",
      retryable: true,
    });
    expect(eventRecoveries).toBe(0);
  });

  it.each([
    { blockedStage: "read" as const, termination: "abort" as const },
    { blockedStage: "recover" as const, termination: "reject" as const },
  ])(
    "maxStreams는 initial $blockedStage 대기 중 추가 stream을 거부하고 $termination 뒤 slot을 복구한다",
    async ({ blockedStage, termination }) => {
      await server.close();
      let reads = 0;
      let recoveries = 0;
      let releaseStage!: () => void;
      let rejectStage!: (error: Error) => void;
      let reportStageEntered!: () => void;
      let reportStageExited!: () => void;
      let blockFirst = true;
      const stageGate = new Promise<void>((resolve, reject) => {
        releaseStage = resolve;
        rejectStage = reject;
      });
      const stageEntered = new Promise<void>((resolve) => {
        reportStageEntered = resolve;
      });
      const stageExited = new Promise<void>((resolve) => {
        reportStageExited = resolve;
      });
      const gated = async (): Promise<void> => {
        blockFirst = false;
        reportStageEntered();
        try {
          await stageGate;
        } finally {
          reportStageExited();
        }
      };
      server = new ApplicationHttpServer(
        {
          auth: {
            authenticateAccess: async () => ({ context, tokenId: "stream-limit-token", scopes: ["application:*"] }),
          },
          queries: { query: async () => ({}) },
          commands: { dispatch: async () => ({}) },
          events: {
            async read(_context, input) {
              reads += 1;
              if (blockedStage === "read" && blockFirst) await gated();
              return { events: [], cursor: input.after };
            },
            async recover() {
              recoveries += 1;
              if (blockedStage === "recover" && blockFirst) await gated();
              return false;
            },
          },
        },
        { maxStreams: 1, pollMs: 5, heartbeatMs: 20 },
      );
      baseUrl = (await server.start()).url;
      const firstAbort = new AbortController();
      const firstRequest = fetch(`${baseUrl}/api/v1/events/stream`, {
        headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
        signal: firstAbort.signal,
      }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      await stageEntered;
      const ownedCounts = { reads, recoveries };

      const overflow = await fetch(`${baseUrl}/api/v1/events/stream`, {
        headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
      });
      expect(overflow.status).toBe(429);
      expect({ reads, recoveries }).toEqual(ownedCounts);

      if (termination === "abort") {
        firstAbort.abort();
        await expect(firstRequest).resolves.toHaveProperty("error");
        await delay(20);
        const abortedOverflowAbort = new AbortController();
        const abortedOverflow = await fetch(`${baseUrl}/api/v1/events/stream`, {
          headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
          signal: abortedOverflowAbort.signal,
        });
        const abortedOverflowStatus = abortedOverflow.status;
        abortedOverflowAbort.abort();
        await abortedOverflow.body?.cancel().catch(() => undefined);
        expect(abortedOverflowStatus).toBe(429);
        expect({ reads, recoveries }).toEqual(ownedCounts);
        releaseStage();
        await stageExited;
        await delay(0);
        expect(recoveries).toBe(0);
      } else {
        rejectStage(new Error("initial stream recovery failed"));
        await expect(firstRequest).resolves.toMatchObject({ response: { status: 500 } });
        await stageExited;
        await delay(0);
      }

      const nextAbort = new AbortController();
      const next = await fetch(`${baseUrl}/api/v1/events/stream`, {
        headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
        signal: nextAbort.signal,
      });
      expect(next.status).toBe(200);
      expect(reads).toBeGreaterThan(ownedCounts.reads);
      expect(recoveries).toBe(ownedCounts.recoveries + 1);
      nextAbort.abort();
      await next.body?.cancel().catch(() => undefined);
    },
  );

  it("loopback 밖 bind는 trusted proxy allowlist 없이는 생성부터 거부한다", () => {
    expect(() => new ApplicationHttpServer({} as ApplicationHttpDependencies, { host: "0.0.0.0" })).toThrow(
      "trusted TLS proxy",
    );
  });
});
