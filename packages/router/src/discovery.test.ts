import { lookup } from "node:dns/promises";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  createSecureProviderFetch,
  discoverModels,
  validateDiscoveryBaseUrl,
  validateGatewayModelId,
} from "./discovery.js";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

describe("Provider model discovery 계약", () => {
  it("Ollama /api/tags 응답에서 모델 ID를 추출한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 5_000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverModels(
      { adapterKind: "ollama", baseUrl: "http://127.0.0.1:11434", local: true },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", expect.any(Object));
    expect(result).toEqual({
      status: "available",
      models: [{ id: "qwen3:8b", ownedBy: "local" }],
      invalidCount: 0,
      duplicateCount: 0,
    });
  });

  it("OpenAI-compatible /v1/models 응답과 Bearer 인증을 사용한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [{ id: "coding-model", owned_by: "gateway" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1", secret: "token" },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
    expect(result).toEqual({
      status: "available",
      models: [{ id: "coding-model", ownedBy: "gateway" }],
      invalidCount: 0,
      duplicateCount: 0,
    });
  });

  it("OpenRouter 확장 metadata를 보존하되 API에 없는 capability를 꾸며내지 않는다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "vendor/vision-model",
              canonical_slug: "vendor/vision-model-20260810",
              name: "Vision Model",
              context_length: 131_072,
              top_provider: { context_length: 65_536 },
              architecture: { input_modalities: ["text", "image"] },
              supported_parameters: ["tools", "structured_outputs"],
              pricing: { prompt: "0.0000001", completion: "0.0000002" },
              expiration_date: "2027-01-01",
            },
            { id: "minimal-model", owned_by: "gateway" },
          ],
          total_count: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", secret: "token" },
      fetcher,
    );

    expect(result).toMatchObject({
      status: "available",
      invalidCount: 0,
      duplicateCount: 0,
      models: [
        {
          id: "minimal-model",
          ownedBy: "gateway",
        },
        {
          id: "vendor/vision-model",
          canonicalId: "vendor/vision-model-20260810",
          displayName: "Vision Model",
          contextWindow: 65_536,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsVision: true,
          inputCostMicrosPerMillion: 100_000,
          outputCostMicrosPerMillion: 200_000,
          expirationDate: "2027-01-01",
        },
      ],
    });
    expect(result.models[0]).not.toHaveProperty("supportsStreaming");
  });

  it("OpenRouter variable-price router와 표시 이름 공백을 unknown·정규화로 보존한다", async () => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "openrouter/auto", name: "OpenRouter Auto ", pricing: { prompt: "-1", completion: "-1" } }],
            total_count: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    expect(result).toMatchObject({
      status: "available",
      models: [{ id: "openrouter/auto", displayName: "OpenRouter Auto" }],
    });
    expect(result.models[0]).not.toHaveProperty("inputCostMicrosPerMillion");
  });

  it("잘못된 행과 충돌 duplicate를 partial로 격리하고 결정적인 모델 목록을 만든다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "z-model", owned_by: "owner" },
            { id: "bad\nmodel" },
            { id: "same", context_length: 1_024 },
            { id: "same", context_length: 2_048 },
            { id: "z-model", owned_by: "owner" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      fetcher,
    );

    expect(result).toMatchObject({
      status: "partial",
      models: [{ id: "z-model", ownedBy: "owner" }],
      invalidCount: 2,
      duplicateCount: 2,
    });
  });

  it("redirect와 JSON이 아닌 응답을 적용 가능한 catalog로 처리하지 않는다", async () => {
    const redirecting = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example/models" } }));
    const redirected = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1", secret: "secret" },
      redirecting,
    );
    expect(redirecting).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(redirected.status).toBe("degraded");
    expect(JSON.stringify(redirected)).not.toContain("secret");

    const html = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    expect(html.status).toBe("degraded");
  });

  it("chunked 응답을 읽는 중 byte 상한에서 중단한다", async () => {
    let emitted = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (emitted === 12) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
    );

    expect(result).toMatchObject({ status: "degraded", diagnostic: { reason: "response-too-large" } });
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(12);
  });

  it("제공됐지만 잘못된 metadata와 과대 가격을 unknown으로 세탁하지 않는다", async () => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "valid-minimal" },
              { id: "bad-context", context_length: -1 },
              { id: "bad-architecture", architecture: "vision" },
              { id: "bad-price-type", pricing: { prompt: 1 } },
              { id: "bad-price-size", pricing: { prompt: `0.${"1".repeat(100)}` } },
              { id: "bad-expiration", expiration_date: "next week" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    expect(result).toMatchObject({
      status: "partial",
      models: [{ id: "valid-minimal" }],
      invalidCount: 5,
    });
  });

  it("invalid JSON과 과대 Retry-After를 안전한 진단으로 구분한다", async () => {
    const invalidJson = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{", { status: 200, headers: { "content-type": "application/json" } })),
    );
    expect(invalidJson).toMatchObject({ status: "degraded", diagnostic: { reason: "invalid-json" } });

    const limited = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "999999999999999999999" } })),
    );
    expect(limited).toMatchObject({ status: "degraded", diagnostic: { reason: "rate-limited" } });
  });

  it("total_count보다 일부만 온 목록을 완전 snapshot으로 승인하지 않는다", async () => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "partial-page" }], total_count: 400, links: { next: null } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(result).toMatchObject({ status: "degraded", diagnostic: { reason: "invalid-total-count" } });
  });

  it.each([
    { status: 206, headers: {} },
    { status: 200, headers: { "content-range": "items 0-0/2" } },
  ])("부분 HTTP 응답 $status를 완전 snapshot으로 승인하지 않는다", async ({ status, headers }) => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "partial-model" }] }), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    );

    expect(result).toMatchObject({ status: "degraded", diagnostic: { reason: "partial-content" } });
  });

  it.each([
    { links: [], reason: "invalid-response" },
    { links: { next: 1 }, reason: "invalid-response" },
    { links: { next: "" }, reason: "invalid-response" },
    { links: { next: "https://gateway.example/v1/models?page=2" }, reason: "pagination-unsupported" },
  ])("비정상 또는 후속 pagination $links를 완전 snapshot으로 승인하지 않는다", async ({ links, reason }) => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "first-page" }], links }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    expect(result).toMatchObject({ status: "degraded", diagnostic: { reason } });
  });

  it("IANA 비전역 IPv6와 IPv4 임베딩 우회를 숫자 범위로 거부한다", () => {
    for (const baseUrl of [
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:a9fe:101]/v1",
      "https://[64:ff9b::a00:1]/v1",
      "https://[64:ff9b::a9fe:101]/v1",
      "https://[64:ff9b:1::c0a8:101]/v1",
      "https://[2002:a00:1::]/v1",
      "https://[2002:a9fe:101::]/v1",
      "https://[fc00::1]/v1",
      "https://[fe80::1]/v1",
      "https://[2001:db8::1]/v1",
      "https://[3fff::1]/v1",
      "https://[5f00::1]/v1",
    ]) {
      expect(() => validateDiscoveryBaseUrl(baseUrl, false), baseUrl).toThrow("public HTTPS");
    }
    expect(validateDiscoveryBaseUrl("https://[64:ff9b::808:808]/v1", false).hostname).toBe("[64:ff9b::808:808]");
    expect(validateDiscoveryBaseUrl("http://[::ffff:7f00:1]/v1", true).hostname).toBe("[::ffff:7f00:1]");
  });

  it("DNS 결과 하나라도 private이면 public 주소와 섞여 있어도 연결 전에 거부한다", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "fd00::1", family: 6 },
    ]);

    const failure = await createSecureProviderFetch(false)("https://mixed.example/v1/models", {
      headers: { authorization: "Bearer must-not-leak" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("address is not allowed");
    expect(String(failure)).not.toContain("must-not-leak");
  });

  it("secure transport는 redirect를 추적하지 않아 인증 header를 재전송하지 않는다", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(302, { location: "/redirected" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소가 유효하지 않습니다");
      const response = await createSecureProviderFetch(true)(`http://127.0.0.1:${String(address.port)}/models`, {
        headers: { authorization: "Bearer secret-never-forwarded" },
      });

      expect(response.status).toBe(302);
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("secure transport는 응답 전 실패한 POST를 다음 DNS 주소로 재전송하지 않는다", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소가 유효하지 않습니다");
      vi.mocked(lookup).mockResolvedValueOnce([
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]);

      await expect(
        createSecureProviderFetch(true)(`http://localhost:${String(address.port)}/generate`, {
          method: "POST",
          body: "request",
        }),
      ).rejects.toThrow("Provider request failed");
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("secure transport는 응답을 streaming하고 abort 시 열린 body를 중단한다", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소가 유효하지 않습니다");
      const abort = new AbortController();
      const response = await createSecureProviderFetch(true)(`http://127.0.0.1:${String(address.port)}/stream`, {
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      expect(await reader?.read()).toMatchObject({ done: false });
      abort.abort();
      await expect(reader?.read()).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("실제 transport가 localhost 다중 주소와 bodyless 상태를 daemon 종료 없이 처리한다", async () => {
    let status = 200;
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 200 ? JSON.stringify({ models: [{ name: "local-model" }] }) : undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소가 유효하지 않습니다");
      const available = await discoverModels({
        adapterKind: "ollama",
        baseUrl: `http://localhost:${String(address.port)}`,
        local: true,
      });
      expect(available).toMatchObject({ status: "available", models: [{ id: "local-model" }] });
      for (const bodylessStatus of [204, 205, 304]) {
        status = bodylessStatus;
        const result = await discoverModels({
          adapterKind: "ollama",
          baseUrl: `http://127.0.0.1:${String(address.port)}`,
          local: true,
        });
        expect(result.status).toBe("degraded");
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("실제 transport가 IPv6 loopback에 고정해 연결한다", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "ipv6-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("테스트 IPv6 주소가 유효하지 않습니다");
      await expect(
        discoverModels({
          adapterKind: "ollama",
          baseUrl: `http://[::1]:${String(address.port)}`,
          local: true,
        }),
      ).resolves.toMatchObject({ status: "available", models: [{ id: "ipv6-model" }] });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("연결 실패를 꾸며내지 않고 복구 조치가 있는 degraded 진단으로 반환한다", async () => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
    );

    expect(result.status).toBe("degraded");
    expect(result.models).toEqual([]);
    expect(result.diagnostic?.recovery).toContain("Endpoint");
  });

  it("LiteLLM·Portkey model alias와 OmniRoute combo ID를 안전한 식별자로 검증한다", () => {
    expect(validateGatewayModelId("litellm", "coding-model")).toBe("coding-model");
    expect(validateGatewayModelId("portkey", "@quality-route")).toBe("@quality-route");
    expect(validateGatewayModelId("omniroute", "auto/coding")).toBe("auto/coding");
    expect(validateGatewayModelId("omniroute", "premium-coding")).toBe("premium-coding");
    expect(() => validateGatewayModelId("omniroute", "bad\nmodel")).toThrow("model ID");
    expect(() => validateGatewayModelId("litellm", " ")).toThrow("model ID");
  });
});
