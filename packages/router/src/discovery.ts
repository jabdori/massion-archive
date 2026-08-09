import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface DiscoveryRequest {
  readonly adapterKind: "ollama" | "openai-compatible";
  readonly baseUrl: string;
  readonly secret?: string;
  readonly local?: boolean;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly ownedBy?: string;
  readonly canonicalId?: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
  readonly supportsStructuredOutput?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsStreaming?: boolean;
  readonly inputCostMicrosPerMillion?: number;
  readonly outputCostMicrosPerMillion?: number;
  readonly expirationDate?: string;
}

export interface DiscoveryResult {
  readonly status: "available" | "partial" | "degraded";
  readonly models: readonly DiscoveredModel[];
  readonly invalidCount: number;
  readonly duplicateCount: number;
  readonly diagnostic?: {
    readonly reason: string;
    readonly recovery: string;
    readonly retryAt?: string;
  };
}

export type SupportedGateway = "litellm" | "portkey" | "omniroute";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 10_000;

class DiscoveryFailure extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
  }
}

export function validateGatewayModelId(_gateway: SupportedGateway, modelId: string): string {
  return validateModelId(modelId);
}

export async function discoverModels(request: DiscoveryRequest, fetcher?: typeof fetch): Promise<DiscoveryResult> {
  try {
    const url = discoveryUrl(request);
    const headers = {
      accept: "application/json",
      ...(request.secret ? { authorization: `Bearer ${request.secret}` } : {}),
    };
    const response = fetcher
      ? await fetcher(url.toString(), { headers, redirect: "error", signal: AbortSignal.timeout(10_000) })
      : await createSecureProviderFetch(request.local === true)(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
    if (response.status !== 200 || response.headers.has("content-range")) {
      const result =
        response.status === 206 || response.headers.has("content-range")
          ? degraded("partial-content")
          : httpFailure(response);
      await cancelResponse(response);
      return result;
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mediaType || (mediaType !== "application/json" && !mediaType.endsWith("+json"))) {
      await cancelResponse(response);
      return degraded("invalid-content-type");
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
      await cancelResponse(response);
      return degraded("response-too-large");
    }
    const text = await readBoundedBody(response);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return degraded("invalid-json");
    }
    try {
      return request.adapterKind === "ollama" ? parseOllama(body) : parseOpenAi(body);
    } catch {
      return degraded("invalid-response");
    }
  } catch (error) {
    if (error instanceof DiscoveryFailure) return degraded(error.reason);
    if (isAbortError(error)) return degraded("timeout");
    return degraded("network-failed");
  }
}

function parseOllama(body: unknown): DiscoveryResult {
  if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("invalid Ollama response");
  return normalizeRows(
    body.models,
    (value) => {
      if (!isRecord(value)) return undefined;
      const id =
        typeof value.model === "string" ? value.model : typeof value.name === "string" ? value.name : undefined;
      return id ? { id: validateModelId(id), ownedBy: "local" } : undefined;
    },
    "Ollama",
  );
}

function parseOpenAi(body: unknown): DiscoveryResult {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("invalid OpenAI response");
  if (body.links !== undefined) {
    if (!isRecord(body.links)) throw new Error("invalid links");
    if (body.links.next !== undefined && body.links.next !== null) {
      if (typeof body.links.next !== "string" || body.links.next.length === 0) throw new Error("invalid next link");
      return degraded("pagination-unsupported");
    }
  }
  if (
    body.total_count !== undefined &&
    (!Number.isSafeInteger(body.total_count) || Number(body.total_count) !== body.data.length)
  ) {
    return degraded("invalid-total-count");
  }
  return normalizeRows(body.data, parseOpenAiModel, "OpenAI");
}

function parseOpenAiModel(value: unknown): DiscoveredModel | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const contextCandidates = [optionalPositiveInteger(value.context_length)];
  if (value.top_provider !== undefined && value.top_provider !== null && !isRecord(value.top_provider)) {
    throw new Error("invalid top provider");
  }
  if (isRecord(value.top_provider)) contextCandidates.push(optionalPositiveInteger(value.top_provider.context_length));
  const contextWindow = contextCandidates.filter((item): item is number => item !== undefined).sort((a, b) => a - b)[0];
  const supportedParameters = stringArray(value.supported_parameters);
  if (value.architecture !== undefined && value.architecture !== null && !isRecord(value.architecture)) {
    throw new Error("invalid architecture");
  }
  const inputModalities = isRecord(value.architecture) ? stringArray(value.architecture.input_modalities) : undefined;
  if (value.pricing !== undefined && value.pricing !== null && !isRecord(value.pricing)) {
    throw new Error("invalid pricing");
  }
  const pricing = isRecord(value.pricing) ? value.pricing : undefined;
  const ownedBy = optionalString(value.owned_by, 256);
  const canonicalId = optionalString(value.canonical_slug, 256);
  const displayName = optionalDisplayName(value.name);
  const supportsTools = supportedParameters?.includes("tools");
  const supportsStructuredOutput = supportedParameters?.includes("structured_outputs");
  const supportsVision = inputModalities?.includes("image");
  const inputCostMicrosPerMillion = pricing === undefined ? undefined : maximumPrice(pricing, "prompt");
  const outputCostMicrosPerMillion = pricing === undefined ? undefined : maximumPrice(pricing, "completion");
  const expirationDate = optionalDate(value.expiration_date);
  return {
    id: validateModelId(value.id),
    ...(ownedBy === undefined ? {} : { ownedBy }),
    ...(canonicalId === undefined ? {} : { canonicalId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(supportsStructuredOutput === undefined ? {} : { supportsStructuredOutput }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(inputCostMicrosPerMillion === undefined ? {} : { inputCostMicrosPerMillion }),
    ...(outputCostMicrosPerMillion === undefined ? {} : { outputCostMicrosPerMillion }),
    ...(expirationDate === undefined ? {} : { expirationDate }),
  };
}

function normalizeRows(
  rows: readonly unknown[],
  parse: (value: unknown) => DiscoveredModel | undefined,
  _source: string,
): DiscoveryResult {
  if (rows.length > MAX_MODELS) return degraded("model-count-exceeded");
  const models = new Map<string, DiscoveredModel>();
  const conflicts = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const row of rows) {
    let model: DiscoveredModel | undefined;
    try {
      model = parse(row);
    } catch {
      invalidCount += 1;
      continue;
    }
    if (!model) {
      invalidCount += 1;
      continue;
    }
    if (conflicts.has(model.id)) {
      duplicateCount += 1;
      continue;
    }
    const existing = models.get(model.id);
    if (!existing) {
      models.set(model.id, model);
      continue;
    }
    duplicateCount += 1;
    if (JSON.stringify(existing) !== JSON.stringify(model)) {
      invalidCount += 1;
      models.delete(model.id);
      conflicts.add(model.id);
    }
  }
  return {
    status: invalidCount > 0 ? "partial" : "available",
    models: [...models.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    invalidCount,
    duplicateCount,
    ...(invalidCount > 0
      ? {
          diagnostic: {
            reason: "invalid-model-rows",
            recovery: "Provider 모델 응답 일부가 유효하지 않습니다. 기존 정상 목록을 유지하고 다시 동기화해주세요.",
          },
        }
      : {}),
  };
}

function maximumPrice(pricing: Record<string, unknown>, field: "prompt" | "completion"): number | undefined {
  const values: unknown[] = [pricing[field]];
  if (pricing.overrides !== undefined && !Array.isArray(pricing.overrides)) throw new Error("invalid price overrides");
  if (Array.isArray(pricing.overrides)) {
    for (const override of pricing.overrides) {
      if (!isRecord(override)) throw new Error("invalid price override");
      values.push(override[field]);
    }
  }
  const prices = values
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => {
      if (typeof value !== "string") throw new Error("invalid price");
      return value === "-1" ? [] : [decimalPrice(value)];
    });
  return prices.length === 0 ? undefined : Math.max(...prices);
}

function decimalPrice(value: string): number {
  if (value.length > 32) throw new Error("price too long");
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) throw new Error("invalid price");
  const fraction = match[2] ?? "";
  if (fraction.length > 18) throw new Error("price precision exceeded");
  const numerator = BigInt(`${match[1] ?? "0"}${fraction}`) * 1_000_000_000_000n;
  const denominator = 10n ** BigInt(fraction.length);
  const roundedUp = (numerator + denominator - 1n) / denominator;
  if (roundedUp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("price overflow");
  return Number(roundedUp);
}

function validateModelId(modelId: string): string {
  let hasControlCharacter = false;
  for (const character of modelId) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (modelId.length === 0 || modelId.length > 256 || modelId.trim() !== modelId || hasControlCharacter) {
    throw new Error("Gateway model ID 형식이 유효하지 않습니다");
  }
  return modelId;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > maxLength) {
    throw new Error("invalid optional string");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) throw new Error("invalid optional string");
  }
  return value;
}

function optionalDate(value: unknown): string | undefined {
  const candidate = optionalString(value, 64);
  if (candidate === undefined) return undefined;
  const parsed = new Date(candidate);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(candidate) || !Number.isFinite(parsed.getTime())) {
    throw new Error("invalid date");
  }
  return candidate;
}

function optionalDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("invalid display name");
  return optionalString(value.trim(), 512);
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid string array");
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("invalid positive integer");
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryUrl(request: DiscoveryRequest): URL {
  const url = validateDiscoveryBaseUrl(request.baseUrl, request.local === true);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${request.adapterKind === "ollama" ? "/api/tags" : "/models"}`;
  return url;
}

export function validateDiscoveryBaseUrl(baseUrl: string, local: boolean): URL {
  if (typeof baseUrl !== "string" || typeof local !== "boolean") throw new Error("invalid endpoint URL");
  const url = validateProviderRequestUrl(baseUrl, local);
  if (url.search) throw new Error("invalid endpoint URL");
  return url;
}

function validateProviderRequestUrl(input: string | URL, local: boolean): URL {
  const url = new URL(input);
  if (url.username || url.password || url.hash) throw new Error("invalid endpoint URL");
  if (local) {
    if (!["http:", "https:"].includes(url.protocol) || !isLoopbackHostname(url.hostname)) {
      throw new Error("local endpoint must be loopback");
    }
  } else if (
    url.protocol !== "https:" ||
    isLoopbackHostname(url.hostname) ||
    isBlockedIp(normalizedHostname(url.hostname))
  ) {
    throw new Error("external endpoint must be public HTTPS");
  }
  return url;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DiscoveryFailure("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 이미 닫힌 오류 응답도 원래 Provider 진단을 바꾸지 않습니다.
  }
}

export function createSecureProviderFetch(local: boolean): typeof fetch {
  if (typeof local !== "boolean") throw new Error("invalid endpoint locality");
  return async (input, init) => await secureProviderFetch(input, init, local);
}

async function secureProviderFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  local: boolean,
): Promise<Response> {
  const providerRequest = new Request(input, init);
  const url = validateProviderRequestUrl(providerRequest.url, local);
  const signal = providerRequest.signal;
  if (signal.aborted) throw new DOMException("Provider request aborted", "AbortError");
  const hostname = normalizedHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : (await abortable(lookup(hostname, { all: true, order: "verbatim" }), signal)).map((address) => ({
        address: address.address,
        family: address.family === 6 ? (6 as const) : (4 as const),
      }));
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) =>
        !address.family ||
        isIP(address.address) !== address.family ||
        (local ? !isLoopbackIp(address.address) : isBlockedIp(address.address)),
    )
  ) {
    throw new Error("Provider endpoint address is not allowed");
  }
  const body = providerRequest.body ? Buffer.from(await abortable(providerRequest.arrayBuffer(), signal)) : undefined;
  if (signal.aborted) throw new DOMException("Provider request aborted", "AbortError");
  const headers = Object.fromEntries(providerRequest.headers.entries());
  let lastError: unknown;
  const mayRetryAddress = ["GET", "HEAD", "OPTIONS"].includes(providerRequest.method);
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, providerRequest.method, headers, body, hostname, address, signal);
    } catch (error) {
      if (signal.aborted) throw new DOMException("Provider request aborted", "AbortError");
      lastError = error;
      if (!mayRetryAddress) break;
    }
  }
  throw new Error(lastError ? "Provider request failed" : "Provider endpoint address is missing");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Provider request aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new DOMException("Provider request aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function requestPinnedAddress(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | undefined,
  hostname: string,
  address: { readonly address: string; readonly family: 4 | 6 },
  signal: AbortSignal,
): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        servername: url.protocol === "https:" && !isIP(hostname) ? hostname : undefined,
        signal,
        headers: { ...headers, host: url.host },
      },
      (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = incoming.statusCode ?? 500;
          const bodyless = method === "HEAD" || [204, 205, 304].includes(status);
          if (bodyless) incoming.destroy();
          resolve(
            new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
              status,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function normalizedHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unbracketed.toLowerCase().replace(/\.$/u, "");
}

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizedHostname(value);
  return hostname === "localhost" || isLoopbackIp(hostname);
}

function isLoopbackIp(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) return ipv4InCidr(ipv4, "127.0.0.0", 8);
  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return false;
  const mapped = embeddedIpv4(ipv6, "mapped");
  return ipv6 === 1n || (mapped !== undefined && ipv4InCidr(mapped, "127.0.0.0", 8));
}

function isBlockedIp(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return false;
  const translated = embeddedIpv4(ipv6, "nat64");
  if (translated !== undefined && isBlockedIpv4(translated)) return true;
  // IANA IPv6 Address Space 기준 public unicast는 2000::/3이며, 표준 NAT64 /96만 별도로 전역 도달 가능합니다.
  if (translated === undefined && !ipv6InCidr(ipv6, "2000::", 3)) return true;
  const sixToFour = embeddedIpv4(ipv6, "6to4");
  if (sixToFour !== undefined && isBlockedIpv4(sixToFour)) return true;
  if (ipv6InCidr(ipv6, "2001::", 23)) {
    const globallyReachableException =
      ["2001:1::1", "2001:1::2", "2001:1::3"].some((address) => ipv6 === parseIpv6(address)) ||
      (
        [
          ["2001:3::", 32],
          ["2001:4:112::", 48],
          ["2001:20::", 28],
          ["2001:30::", 28],
        ] as const
      ).some(([prefix, bits]) => ipv6InCidr(ipv6, prefix, bits));
    if (!globallyReachableException) return true;
  }
  return (
    [
      ["2001:db8::", 32],
      ["3fff::", 20],
    ] as const
  ).some(([prefix, bits]) => ipv6InCidr(ipv6, prefix, bits));
}

function isBlockedIpv4(value: number): boolean {
  if (ipv4InCidr(value, "192.0.0.0", 24)) {
    return value !== parseIpv4("192.0.0.9") && value !== parseIpv4("192.0.0.10");
  }
  // IANA IPv4 Special-Purpose Address Registry(2025-10-09)의 비전역 목적지 범위입니다.
  return (
    [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ] as const
  ).some(([prefix, bits]) => ipv4InCidr(value, prefix, bits));
}

function parseIpv4(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  return value.split(".").reduce((result, octet) => (result << 8) + Number(octet), 0) >>> 0;
}

function parseIpv6(value: string): bigint | undefined {
  if (isIP(value) !== 6) return undefined;
  let normalized = value.toLowerCase();
  const dottedStart = normalized.lastIndexOf(":");
  if (normalized.includes(".") && dottedStart >= 0) {
    const embedded = parseIpv4(normalized.slice(dottedStart + 1));
    if (embedded === undefined) return undefined;
    normalized = `${normalized.slice(0, dottedStart)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  return words.reduce((result, word) => (result << 16n) | BigInt(Number.parseInt(word, 16)), 0n);
}

function ipv4InCidr(value: number, prefix: string, bits: number): boolean {
  const base = parseIpv4(prefix);
  if (base === undefined) return false;
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

function ipv6InCidr(value: bigint, prefix: string, bits: number): boolean {
  const base = parseIpv6(prefix);
  return base !== undefined && (bits === 0 || value >> BigInt(128 - bits) === base >> BigInt(128 - bits));
}

function embeddedIpv4(value: bigint, kind: "mapped" | "nat64" | "6to4"): number | undefined {
  if (kind === "mapped" && !ipv6InCidr(value, "::ffff:0:0", 96)) return undefined;
  if (kind === "nat64" && !ipv6InCidr(value, "64:ff9b::", 96)) return undefined;
  if (kind === "6to4") {
    return ipv6InCidr(value, "2002::", 16) ? Number((value >> 80n) & 0xffff_ffffn) : undefined;
  }
  return Number(value & 0xffff_ffffn);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function httpFailure(response: Response): DiscoveryResult {
  const reason =
    response.status === 401
      ? "authentication"
      : response.status === 403
        ? "permission"
        : response.status === 429
          ? "rate-limited"
          : response.status >= 500
            ? "unavailable"
            : "http-error";
  const retryAfter = response.headers.get("retry-after");
  return degraded(reason, retryAfter ? retryAt(retryAfter) : undefined);
}

function retryAt(value: string): string | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const timestamp = Date.now() + seconds * 1_000;
    if (Number.isFinite(timestamp) && timestamp <= 8_640_000_000_000_000) return new Date(timestamp).toISOString();
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function degraded(reason: string, retryAtValue?: string): DiscoveryResult {
  return {
    status: "degraded",
    models: [],
    invalidCount: 0,
    duplicateCount: 0,
    diagnostic: {
      reason,
      recovery: "Endpoint 주소, 실행 상태와 Credential을 확인한 뒤 discovery를 다시 실행해주세요.",
      ...(retryAtValue ? { retryAt: retryAtValue } : {}),
    },
  };
}
