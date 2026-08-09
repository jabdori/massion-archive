import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import {
  listCodingPlanPresets,
  listSubscriptionProviderManifests,
  type ConnectorExecutionKind,
  type SubscriptionAccountService,
  type SubscriptionAuthKind,
  type SubscriptionProviderProtocol,
  type SubscriptionScope,
} from "@massion/subscriptions";

import {
  MODEL_ROUTE_MIGRATION,
  MODEL_VERIFICATION_EVIDENCE_MIGRATION,
  ROUTER_REGISTRY_MIGRATION,
  ROUTER_SUBSCRIPTION_ENDPOINT_MIGRATION,
  ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION,
} from "./schema.js";
import { CredentialVault } from "./vault.js";

export type AdapterKind = "ai-sdk" | "openai-compatible" | "ollama" | "external-gateway" | "subscription-connector";
export type CredentialType =
  "api_key" | "oauth" | "service_account" | "workload_identity" | "subscription_key" | "subscription_session";
export type CredentialStatus = "active" | "cooldown" | "disabled" | "revoked";

export interface ModelProvider {
  readonly provider_id: string;
  readonly organization_id: string;
  readonly display_name: string;
  readonly adapter_kind: AdapterKind;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ProviderEndpoint {
  readonly endpoint_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly name: string;
  readonly base_url: string;
  readonly local: boolean;
  readonly gateway_kind?: "litellm" | "portkey" | "omniroute" | "other";
  readonly subscription_protocol?: SubscriptionProviderProtocol;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ProviderCredential {
  readonly credential_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly endpoint_id: string;
  readonly label: string;
  readonly credential_type: CredentialType;
  readonly status: CredentialStatus;
  readonly version: number;
  readonly secret_version: number;
  readonly priority: number;
  readonly weight: number;
  readonly request_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_micros: number;
  readonly quota_limit?: number;
  readonly quota_remaining?: number;
  readonly quota_reset_at?: unknown;
  readonly cooldown_until?: unknown;
  readonly last_selected_sequence: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly material_kind?: "encrypted_secret" | "connector_session";
  readonly subscription_account_id?: string;
  readonly subscription_connector_id?: string;
  readonly subscription_scope?: SubscriptionScope;
}

export type CredentialMaterial =
  | { readonly kind: "encrypted_secret"; readonly secret: string; readonly secretVersion: number }
  | {
      readonly kind: "connector_session";
      readonly accountId: string;
      readonly connectorId: string;
      readonly scope: SubscriptionScope;
    };

interface CredentialSecretVersion {
  readonly secret_version_id: string;
  readonly organization_id: string;
  readonly credential_id: string;
  readonly version: number;
  readonly algorithm: "aes-256-gcm";
  readonly ciphertext: string;
  readonly iv: string;
  readonly auth_tag: string;
  readonly aad: string;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface RouterAuditEvent {
  readonly audit_event_id: string;
  readonly organization_id: string;
  readonly command_id: string;
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly request_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

interface CommandInput {
  readonly commandId: string;
}

export interface RegisterProviderInput extends CommandInput {
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterKind: AdapterKind;
}

export interface RemoveProviderInput extends CommandInput {
  readonly providerId: string;
}

export interface RegisterEndpointInput extends CommandInput {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly local: boolean;
  readonly gatewayKind?: ProviderEndpoint["gateway_kind"];
}

export interface AddCredentialInput extends CommandInput {
  readonly providerId: string;
  readonly endpointId: string;
  readonly label: string;
  readonly credentialType: CredentialType;
  readonly secret: string;
  readonly priority: number;
  readonly weight: number;
}

export interface AddConnectorCredentialInput extends CommandInput {
  readonly providerId: string;
  readonly endpointId: string;
  readonly label: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly scope: SubscriptionScope;
  readonly priority: number;
  readonly weight: number;
}

export interface AddSubscriptionCredentialInput extends CommandInput {
  readonly providerId: string;
  readonly endpointId: string;
  readonly label: string;
  readonly authKind: Extract<SubscriptionAuthKind, "api-key" | "subscription-key">;
  readonly secret: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly scope: SubscriptionScope;
  readonly priority: number;
  readonly weight: number;
  readonly acceptExperimental?: boolean;
}

export interface EnsureSubscriptionProviderInput extends CommandInput {
  readonly providerId: string;
  readonly endpointUrl?: string;
  readonly protocol?: SubscriptionProviderProtocol;
}

export interface SubscriptionProviderConnectionSpec {
  readonly providerId: string;
  readonly displayName: string;
  readonly executionKind: ConnectorExecutionKind;
  readonly connectionSurface: "server-and-edge" | "server-only" | "edge-only";
  readonly authKinds: readonly SubscriptionAuthKind[];
  readonly billingKinds: readonly string[];
  readonly availability: "supported" | "experimental" | "requires-provider-approval";
  readonly endpointUrl: string;
  readonly protocol: SubscriptionProviderProtocol;
  readonly usageScope?: "interactive-coding" | "agent-api" | "api-gateway";
}

export interface ProviderServiceOptions {
  readonly accounts?: SubscriptionAccountService;
}

export interface RotateCredentialInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly secret: string;
}

export interface RevokeCredentialInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
}

export interface RevokeSubscriptionAccountCredentialsInput extends CommandInput {
  readonly accountId: string;
}

export interface UpdateCredentialQuotaInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

const CREDENTIAL_TYPES = new Set<CredentialType>(["api_key", "oauth", "service_account", "workload_identity"]);
const GATEWAY_KINDS = new Set<NonNullable<ProviderEndpoint["gateway_kind"]>>([
  "litellm",
  "portkey",
  "omniroute",
  "other",
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedEndpointUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("구독 Provider endpoint는 HTTPS여야 합니다");
  return url.toString().replace(/\/$/u, "");
}

function subscriptionConnectionSpec(input: {
  readonly providerId: string;
  readonly endpointUrl?: string;
  readonly protocol?: SubscriptionProviderProtocol;
}): SubscriptionProviderConnectionSpec {
  const manifest = listSubscriptionProviderManifests().find((candidate) => candidate.id === input.providerId);
  const preset = listCodingPlanPresets().find((candidate) => candidate.id === input.providerId);
  if (!manifest && !preset) throw new Error(`구독 Provider catalog를 찾을 수 없습니다: ${input.providerId}`);
  const connectionSurface = manifest?.connectionSurface ?? preset?.connectionSurface;
  if (connectionSurface === undefined || connectionSurface === "unavailable") {
    throw new Error("현재 Massion에서 실제 연결·실행 경로가 검증되지 않은 구독 Provider입니다");
  }

  const endpoints = [
    ...(manifest?.endpointAllowlist.map((endpointUrl) => ({
      endpointUrl: normalizedEndpointUrl(endpointUrl),
      protocol: manifest.protocol,
    })) ?? []),
    ...(preset?.routes.map((route) => ({
      endpointUrl: normalizedEndpointUrl(route.baseUrl),
      protocol: route.protocol,
    })) ?? []),
  ];
  if (endpoints.length === 0 && manifest) {
    endpoints.push({
      endpointUrl: `massion-connector:///${manifest.id}/${manifest.protocol}`,
      protocol: manifest.protocol,
    });
  }
  const uniqueEndpoints = [
    ...new Map(endpoints.map((endpoint) => [`${endpoint.protocol}\0${endpoint.endpointUrl}`, endpoint])).values(),
  ];
  const requestedUrl = input.endpointUrl === undefined ? undefined : normalizedEndpointUrl(input.endpointUrl);
  const matching = uniqueEndpoints.filter(
    (endpoint) =>
      (requestedUrl === undefined || endpoint.endpointUrl === requestedUrl) &&
      (input.protocol === undefined || endpoint.protocol === input.protocol),
  );
  if (matching.length === 0)
    throw new Error("구독 Provider endpoint 또는 protocol이 공식 allowlist와 일치하지 않습니다");
  if (matching.length !== 1) throw new Error("구독 Provider endpoint 선택에는 endpoint URL과 protocol이 필요합니다");
  const endpoint = matching[0];
  if (!endpoint) throw new Error("구독 Provider endpoint 선택 결과가 없습니다");

  const authKinds = [
    ...new Set<SubscriptionAuthKind>([
      ...(manifest?.authKinds ?? []),
      ...((preset?.authKinds ?? []) as readonly SubscriptionAuthKind[]),
    ]),
  ].sort();
  const billingKinds = [...new Set([...(manifest?.billingKinds ?? []), ...(preset?.billingKinds ?? [])])].sort();
  const availability =
    manifest?.availability === "requires-provider-approval" || preset?.availability === "requires-provider-approval"
      ? "requires-provider-approval"
      : manifest?.availability === "experimental"
        ? "experimental"
        : "supported";
  return {
    providerId: input.providerId,
    displayName: manifest?.displayName ?? preset?.displayName ?? input.providerId,
    executionKind: manifest?.executionKind ?? "model",
    connectionSurface,
    authKinds,
    billingKinds,
    availability,
    endpointUrl: endpoint.endpointUrl,
    protocol: endpoint.protocol,
    ...(preset?.usageScope === undefined ? {} : { usageScope: preset.usageScope }),
  };
}

function requiresConnectorLocation(connection: SubscriptionProviderConnectionSpec, location: "server" | "edge"): void {
  if (connection.connectionSurface === "server-only" && location !== "server") {
    throw new Error("이 구독 Provider는 서버 Connector에서만 연결할 수 있습니다");
  }
  if (connection.connectionSurface === "edge-only" && location !== "edge") {
    throw new Error("이 구독 Provider는 사용자 기기 Connector에서만 연결할 수 있습니다");
  }
}

function hasSubscriptionLineage(credential: ProviderCredential): boolean {
  return (
    credential.subscription_account_id !== undefined ||
    credential.subscription_connector_id !== undefined ||
    credential.subscription_scope !== undefined
  );
}

function freshQuotaExhausted(windows: unknown): boolean {
  if (!Array.isArray(windows)) throw new Error("구독 quota snapshot 형식이 유효하지 않습니다");
  const now = Date.now();
  return windows.some((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("구독 quota window 형식이 유효하지 않습니다");
    const window = candidate as {
      readonly observedAt?: unknown;
      readonly remaining?: unknown;
      readonly remainingRatio?: unknown;
      readonly resetsAt?: unknown;
    };
    if (typeof window.observedAt !== "string") throw new Error("구독 quota 관측 시각이 유효하지 않습니다");
    const observedAt = new Date(window.observedAt).getTime();
    let resetIsActive = true;
    if (window.resetsAt !== undefined) {
      if (typeof window.resetsAt !== "string") throw new Error("구독 quota reset 시각이 유효하지 않습니다");
      const resetsAt = new Date(window.resetsAt).getTime();
      if (!Number.isFinite(resetsAt)) throw new Error("구독 quota reset 시각이 유효하지 않습니다");
      resetIsActive = resetsAt > now;
    }
    return (
      Number.isFinite(observedAt) &&
      Math.abs(now - observedAt) <= 5 * 60 * 1_000 &&
      resetIsActive &&
      (window.remaining === 0 || window.remainingRatio === 0)
    );
  });
}

export class ProviderService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly vault: CredentialVault,
    private readonly options: ProviderServiceOptions,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    vault: CredentialVault,
    options: ProviderServiceOptions = {},
  ): Promise<ProviderService> {
    await applyMigrations(database, [
      ROUTER_REGISTRY_MIGRATION,
      // Provider 제거가 딸린 모델 등록·검증 근거까지 정리하므로 같은 스키마를 보장합니다.
      MODEL_ROUTE_MIGRATION,
      MODEL_VERIFICATION_EVIDENCE_MIGRATION,
      ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION,
      ROUTER_SUBSCRIPTION_ENDPOINT_MIGRATION,
    ]);
    return new ProviderService(database, organizations, vault, options);
  }

  public async ensureSubscriptionProvider(
    context: TenantContext,
    input: EnsureSubscriptionProviderInput,
    executor: QueryExecutor = this.database,
  ): Promise<{
    provider: ModelProvider;
    endpoint: ProviderEndpoint;
    connection: SubscriptionProviderConnectionSpec;
    audit: RouterAuditEvent;
  }> {
    return await this.command(
      context,
      input.commandId,
      "subscription_provider_ensured",
      canonicalJson(input),
      async (tx) => {
        const connection = subscriptionConnectionSpec(input);
        const [existingProviders] = await tx.query<[ModelProvider[]]>(
          `SELECT * OMIT id FROM model_provider
           WHERE organization_id = $organization_id AND provider_id = $provider_id LIMIT 1;`,
          { organization_id: context.organizationId, provider_id: connection.providerId },
        );
        let provider = existingProviders[0];
        if (provider && (provider.adapter_kind !== "subscription-connector" || !provider.enabled)) {
          throw new Error("같은 ID의 Provider가 구독 연결기와 호환되지 않습니다");
        }
        if (!provider) {
          const [created] = await tx.query<[ModelProvider[]]>(
            `CREATE model_provider CONTENT {
              provider_id: $provider_id, organization_id: $organization_id, display_name: $display_name,
              adapter_kind: 'subscription-connector', enabled: true, created_at: time::now(), updated_at: time::now()
            } RETURN AFTER;`,
            {
              provider_id: connection.providerId,
              organization_id: context.organizationId,
              display_name: connection.displayName,
            },
          );
          provider = created[0];
        }
        if (!provider) throw new Error("구독 Provider 생성 결과가 없습니다");

        const [existingEndpoints] = await tx.query<[ProviderEndpoint[]]>(
          `SELECT * OMIT id FROM provider_endpoint
           WHERE organization_id = $organization_id AND provider_id = $provider_id
             AND base_url = $base_url AND subscription_protocol = $subscription_protocol LIMIT 1;`,
          {
            organization_id: context.organizationId,
            provider_id: connection.providerId,
            base_url: connection.endpointUrl,
            subscription_protocol: connection.protocol,
          },
        );
        let endpoint = existingEndpoints[0];
        if (endpoint && !endpoint.enabled) throw new Error("비활성화된 구독 Provider endpoint입니다");
        if (!endpoint) {
          const suffix = createHash("sha256")
            .update(`${connection.protocol}\0${connection.endpointUrl}`)
            .digest("hex")
            .slice(0, 10);
          const [created] = await tx.query<[ProviderEndpoint[]]>(
            `CREATE provider_endpoint CONTENT {
              endpoint_id: $endpoint_id, organization_id: $organization_id, provider_id: $provider_id,
              name: $name, base_url: $base_url, local: false, gateway_kind: NONE,
              subscription_protocol: $subscription_protocol, enabled: true,
              created_at: time::now(), updated_at: time::now()
            } RETURN AFTER;`,
            {
              endpoint_id: randomUUID(),
              organization_id: context.organizationId,
              provider_id: connection.providerId,
              name: `Subscription ${connection.protocol} ${suffix}`,
              base_url: connection.endpointUrl,
              subscription_protocol: connection.protocol,
            },
          );
          endpoint = created[0];
        }
        if (!endpoint) throw new Error("구독 Provider endpoint 생성 결과가 없습니다");
        return { provider, endpoint, connection };
      },
      { roles: ["owner", "admin", "member"], executor },
    );
  }

  public async registerProvider(
    context: TenantContext,
    input: RegisterProviderInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ provider: ModelProvider; audit: RouterAuditEvent }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.providerId)) throw new Error("Provider ID 형식이 유효하지 않습니다");
    if (!input.displayName.trim()) throw new Error("Provider 표시 이름은 비어 있을 수 없습니다");
    return await this.command(
      context,
      input.commandId,
      "provider_registered",
      canonicalJson(input),
      async (tx) => {
        // 같은 Provider를 다시 등록하는 것은 사용자가 폼을 다시 제출한 경우이므로
        // UNIQUE 충돌로 내부 오류를 내지 않고 기존 등록을 그대로 돌려줍니다.
        const [existing] = await tx.query<[ModelProvider[]]>(
          "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id AND provider_id = $provider_id LIMIT 1;",
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        const current = existing[0];
        if (current) {
          if (current.adapter_kind !== input.adapterKind)
            throw new Error("이미 등록된 Provider와 어댑터 종류가 다릅니다");
          return { provider: current };
        }
        const [providers] = await tx.query<[ModelProvider[]]>(
          "CREATE model_provider CONTENT { provider_id: $provider_id, organization_id: $organization_id, display_name: $display_name, adapter_kind: $adapter_kind, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            provider_id: input.providerId,
            organization_id: context.organizationId,
            display_name: input.displayName.trim(),
            adapter_kind: input.adapterKind,
          },
        );
        if (!providers[0]) throw new Error("Provider 생성 결과가 없습니다");
        return { provider: providers[0] };
      },
      { executor },
    );
  }

  public async registerEndpoint(
    context: TenantContext,
    input: RegisterEndpointInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ endpoint: ProviderEndpoint; audit: RouterAuditEvent }> {
    const url = new URL(input.baseUrl);
    if (!input.local && url.protocol !== "https:") throw new Error("외부 Provider endpoint는 HTTPS여야 합니다");
    if (input.local && !["http:", "https:"].includes(url.protocol))
      throw new Error("로컬 endpoint URL이 유효하지 않습니다");
    if (input.gatewayKind && !GATEWAY_KINDS.has(input.gatewayKind)) throw new Error("지원하지 않는 Gateway입니다");
    return await this.command(
      context,
      input.commandId,
      "provider_endpoint_registered",
      canonicalJson(input),
      async (tx) => {
        const provider = await this.requireProvider(tx, context.organizationId, input.providerId);
        if (provider.adapter_kind === "external-gateway" && !input.gatewayKind)
          throw new Error("external-gateway Provider에는 gatewayKind가 필요합니다");
        if (provider.adapter_kind !== "external-gateway" && input.gatewayKind)
          throw new Error("gatewayKind는 external-gateway Provider에만 사용할 수 있습니다");
        const name = input.name.trim();
        const baseUrl = url.toString().replace(/\/$/, "");
        const [existing] = await tx.query<[ProviderEndpoint[]]>(
          "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id AND name = $name LIMIT 1;",
          { organization_id: context.organizationId, provider_id: input.providerId, name },
        );
        const current = existing[0];
        if (current) {
          if (current.base_url !== baseUrl) throw new Error("같은 이름의 endpoint가 다른 주소로 등록돼 있습니다");
          return { endpoint: current };
        }
        const [endpoints] = await tx.query<[ProviderEndpoint[]]>(
          "CREATE provider_endpoint CONTENT { endpoint_id: $endpoint_id, organization_id: $organization_id, provider_id: $provider_id, name: $name, base_url: $base_url, local: $local, gateway_kind: $gateway_kind, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            endpoint_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            name,
            base_url: baseUrl,
            local: input.local,
            gateway_kind: input.gatewayKind,
          },
        );
        if (!endpoints[0]) throw new Error("Provider Endpoint 생성 결과가 없습니다");
        return { endpoint: endpoints[0] };
      },
      { executor },
    );
  }

  /**
   * 잘못 등록한 Provider를 지우는 경로입니다. 실행 계보는 정본이므로 route attempt가
   * 남아 있으면 지우지 않고 거절합니다. 구독 연결은 자체 해제 흐름이 소유합니다.
   */
  public async removeProvider(
    context: TenantContext,
    input: RemoveProviderInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ providerId: string; removed: boolean; audit: RouterAuditEvent }> {
    return await this.command(
      context,
      input.commandId,
      "provider_removed",
      canonicalJson(input),
      async (tx) => {
        // requireProvider는 활성만 봅니다. 은퇴시킨 것을 다시 지우려면 비활성도 찾아야 합니다.
        const [existing] = await tx.query<[ModelProvider[]]>(
          "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id AND provider_id = $provider_id LIMIT 1;",
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        const provider = existing[0];
        if (!provider) throw new Error(`Provider를 찾을 수 없습니다: ${input.providerId}`);
        if (provider.adapter_kind === "subscription-connector")
          throw new Error("구독으로 연결한 Provider는 구독 해제로만 정리할 수 있습니다");
        const [profiles] = await tx.query<[{ readonly model_profile_id: string }[]]>(
          "SELECT model_profile_id FROM model_profile WHERE organization_id = $organization_id AND provider_id = $provider_id;",
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        const profileIds = profiles.map((profile) => profile.model_profile_id);
        let retired = false;
        if (profileIds.length > 0) {
          const [attempts] = await tx.query<[{ readonly count: number }[]]>(
            "SELECT count() FROM route_attempt WHERE organization_id = $organization_id AND model_profile_id IN $profile_ids GROUP ALL;",
            { organization_id: context.organizationId, profile_ids: profileIds },
          );
          const referencedByAttempts = (attempts[0]?.count ?? 0) > 0;
          // 처음 제거하면 실행 계보를 지키려고 은퇴만 시킵니다. 이미 은퇴한 것을 다시 제거하면
          // 사용자가 두 번 확인한 것이므로 등록 자체를 지웁니다. route_attempt 행은 그대로 남습니다.
          retired = referencedByAttempts && provider.enabled;
          await tx.query(
            "DELETE model_route_candidate WHERE organization_id = $organization_id AND model_profile_id IN $profile_ids;",
            { organization_id: context.organizationId, profile_ids: profileIds },
          );
          if (!referencedByAttempts) {
            // 검증 근거는 스키마가 immutable로 못 박았습니다. 모델이 실재했다는 기록은
            // Provider 등록보다 오래 살아야 하므로 지우지 않고 남깁니다.
            //
            // 같은 이유로 호출 기록이 가리키는 profile도 남깁니다. 여기서 `retired`를 조건으로 쓰면
            // 두 번째 제거(그때는 provider.enabled가 이미 false)가 route_attempt는 남긴 채 profile만
            // 지워 고아 행을 만들고, listAttempts가 그 행에서 던져 예산·라우터 패널이 통째로 죽습니다.
            // 지울지 말지를 정하는 것은 「몇 번째 제거인가」가 아니라 「계보가 참조하는가」입니다.
            await tx.query(
              "DELETE model_profile WHERE organization_id = $organization_id AND model_profile_id IN $profile_ids;",
              { organization_id: context.organizationId, profile_ids: profileIds },
            );
          }
        }
        const [credentials] = await tx.query<[{ readonly credential_id: string }[]]>(
          "SELECT credential_id FROM provider_credential WHERE organization_id = $organization_id AND provider_id = $provider_id;",
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        const credentialIds = credentials.map((credential) => credential.credential_id);
        if (credentialIds.length > 0) {
          await tx.query(
            "DELETE credential_secret_version WHERE organization_id = $organization_id AND credential_id IN $credential_ids; DELETE provider_credential WHERE organization_id = $organization_id AND credential_id IN $credential_ids;",
            { organization_id: context.organizationId, credential_ids: credentialIds },
          );
        }
        if (retired) {
          await tx.query(
            "UPDATE model_provider SET enabled = false, updated_at = time::now() WHERE organization_id = $organization_id AND provider_id = $provider_id; UPDATE provider_endpoint SET enabled = false, updated_at = time::now() WHERE organization_id = $organization_id AND provider_id = $provider_id;",
            { organization_id: context.organizationId, provider_id: input.providerId },
          );
          return { providerId: input.providerId, removed: false };
        }
        await tx.query(
          "DELETE provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id; DELETE model_provider WHERE organization_id = $organization_id AND provider_id = $provider_id;",
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        return { providerId: input.providerId, removed: true };
      },
      { executor },
    );
  }

  public async listProviders(
    context: TenantContext,
    executor: QueryExecutor = this.database,
  ): Promise<ModelProvider[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [providers] = await executor.query<[ModelProvider[]]>(
      "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id ORDER BY display_name ASC, provider_id ASC;",
      { organization_id: context.organizationId },
    );
    return providers;
  }

  public async listEndpoints(
    context: TenantContext,
    providerId?: string,
    executor: QueryExecutor = this.database,
  ): Promise<ProviderEndpoint[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [endpoints] = await executor.query<[ProviderEndpoint[]]>(
      providerId === undefined
        ? "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id ORDER BY provider_id ASC, name ASC, endpoint_id ASC;"
        : "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id ORDER BY name ASC, endpoint_id ASC;",
      { organization_id: context.organizationId, provider_id: providerId },
    );
    return endpoints;
  }

  public async addCredential(
    context: TenantContext,
    input: AddCredentialInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    if (!CREDENTIAL_TYPES.has(input.credentialType)) throw new Error("지원하지 않는 Credential type입니다");
    if (input.priority < 0 || input.weight < 1) throw new Error("Credential priority와 weight가 유효하지 않습니다");
    const requestJson = canonicalJson({
      ...input,
      secret: "[REDACTED]",
      secretFingerprint: this.vault.fingerprint(input.secret),
    });
    return await this.command(
      context,
      input.commandId,
      "credential_added",
      requestJson,
      async (tx) => {
        const provider = await this.requireProvider(tx, context.organizationId, input.providerId);
        if (provider.adapter_kind === "subscription-connector") {
          throw new Error("구독 연결기 Provider에는 평문 Credential을 추가할 수 없습니다");
        }
        await this.requireEndpoint(tx, context.organizationId, input.providerId, input.endpointId);
        const credentialId = randomUUID();
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          "CREATE provider_credential CONTENT { credential_id: $credential_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, label: $label, credential_type: $credential_type, status: 'active', version: 1, secret_version: 1, priority: $priority, weight: $weight, request_count: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            credential_id: credentialId,
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            label: input.label.trim(),
            credential_type: input.credentialType,
            priority: input.priority,
            weight: input.weight,
          },
        );
        const credential = credentials[0];
        if (!credential) throw new Error("Credential 생성 결과가 없습니다");
        await this.insertSecret(tx, context, credential, 1, input.secret);
        return { credential };
      },
      { executor },
    );
  }

  public async addConnectorCredential(
    context: TenantContext,
    input: AddConnectorCredentialInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    if (input.priority < 0 || input.weight < 1) throw new Error("Credential priority와 weight가 유효하지 않습니다");
    if (!input.label.trim()) throw new Error("Credential label은 비어 있을 수 없습니다");
    const accounts = this.options.accounts;
    if (!accounts) throw new Error("구독 계정 서비스가 구성되지 않았습니다");
    return await this.command(
      context,
      input.commandId,
      "connector_credential_added",
      canonicalJson(input),
      async (tx) => {
        await this.requireProvider(tx, context.organizationId, input.providerId);
        await this.requireEndpoint(tx, context.organizationId, input.providerId, input.endpointId);
        const account = await accounts.requireBindable(context, input.accountId, input.scope, tx);
        if (account.provider_id !== input.providerId) throw new Error("구독 계정과 Provider가 일치하지 않습니다");
        if (account.connector_id !== input.connectorId) throw new Error("구독 계정과 Connector가 일치하지 않습니다");
        if (account.owner_user_id !== context.userId && context.role === "member") {
          throw new Error("구독 계정 소유자 또는 조직 관리자만 Connector Credential을 만들 수 있습니다");
        }
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          `CREATE provider_credential CONTENT {
            credential_id: $credential_id, organization_id: $organization_id, provider_id: $provider_id,
            endpoint_id: $endpoint_id, label: $label, credential_type: 'subscription_session', status: 'active',
            version: 1, secret_version: 0, priority: $priority, weight: $weight, request_count: 0,
            input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0,
            material_kind: 'connector_session', subscription_account_id: $subscription_account_id,
            subscription_connector_id: $subscription_connector_id, subscription_scope: $subscription_scope,
            created_at: time::now(), updated_at: time::now()
          } RETURN AFTER;`,
          {
            credential_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            label: input.label.trim(),
            priority: input.priority,
            weight: input.weight,
            subscription_account_id: input.accountId,
            subscription_connector_id: input.connectorId,
            subscription_scope: input.scope,
          },
        );
        if (!credentials[0]) throw new Error("Connector Credential 생성 결과가 없습니다");
        return { credential: credentials[0] };
      },
      { roles: ["owner", "admin", "member"], executor },
    );
  }

  public async addSubscriptionCredential(
    context: TenantContext,
    input: AddSubscriptionCredentialInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    if (input.priority < 0 || input.weight < 1) throw new Error("Credential priority와 weight가 유효하지 않습니다");
    if (!input.label.trim()) throw new Error("Credential label은 비어 있을 수 없습니다");
    if (!input.secret.trim()) throw new Error("구독 Credential secret은 비어 있을 수 없습니다");
    const accounts = this.options.accounts;
    if (!accounts) throw new Error("구독 계정 서비스가 구성되지 않았습니다");
    const requestJson = canonicalJson({
      ...input,
      secret: "[REDACTED]",
      secretFingerprint: this.vault.fingerprint(input.secret),
    });
    return await this.command(
      context,
      input.commandId,
      "subscription_secret_credential_added",
      requestJson,
      async (tx) => {
        const provider = await this.requireProvider(tx, context.organizationId, input.providerId);
        if (provider.adapter_kind !== "subscription-connector") {
          throw new Error("암호화 구독 Credential은 구독 연결기 Provider에만 추가할 수 있습니다");
        }
        const endpoint = await this.requireEndpoint(tx, context.organizationId, input.providerId, input.endpointId);
        if (!endpoint.subscription_protocol) throw new Error("구독 Provider endpoint protocol이 없습니다");
        const connection = subscriptionConnectionSpec({
          providerId: input.providerId,
          endpointUrl: endpoint.base_url,
          protocol: endpoint.subscription_protocol,
        });
        if (connection.executionKind !== "model") {
          throw new Error("암호화 구독 Credential은 model 실행 종류에만 사용할 수 있습니다");
        }
        if (connection.availability === "requires-provider-approval") {
          throw new Error("이 구독 Provider는 공식 제공자 승인이 확인된 뒤에만 연결할 수 있습니다");
        }
        if (connection.availability === "experimental" && input.acceptExperimental !== true) {
          throw new Error("실험적 구독 Provider 연결에는 명시적 동의가 필요합니다");
        }
        if (connection.usageScope === "interactive-coding") {
          throw new Error(
            "대화형 코딩 전용 구독은 전용 interactive 실행 정책이 구현되기 전까지 direct model backend로 사용할 수 없습니다",
          );
        }
        if (!connection.authKinds.includes(input.authKind)) {
          throw new Error("구독 Provider가 허용하지 않는 인증 방식입니다");
        }
        const account = await accounts.requireBindable(context, input.accountId, input.scope, tx);
        if (!connection.billingKinds.includes(account.billing_kind)) {
          throw new Error("구독 Provider가 허용하지 않는 결제 유형입니다");
        }
        if (account.provider_id !== input.providerId) throw new Error("구독 계정과 Provider가 일치하지 않습니다");
        if (account.connector_id !== input.connectorId) throw new Error("구독 계정과 Connector가 일치하지 않습니다");
        if (account.owner_user_id !== context.userId && context.role === "member") {
          throw new Error("구독 계정 소유자 또는 조직 관리자만 구독 Credential을 만들 수 있습니다");
        }
        const [connectors] = await tx.query<
          [
            Array<{
              readonly location: "server" | "edge";
              readonly execution_kind: ConnectorExecutionKind;
              readonly capabilities: readonly string[];
            }>,
          ]
        >(
          `SELECT location, execution_kind, capabilities FROM subscription_connector
           WHERE organization_id = $organization_id AND connector_id = $connector_id LIMIT 1;`,
          { organization_id: context.organizationId, connector_id: input.connectorId },
        );
        const connector = connectors[0];
        if (!connector) throw new Error("구독 Credential Connector를 찾을 수 없습니다");
        requiresConnectorLocation(connection, connector.location);
        if (connector.execution_kind !== "model")
          throw new Error("구독 Credential Connector 실행 종류가 model이 아닙니다");
        if (!connector.capabilities.includes(input.providerId)) {
          throw new Error("Connector가 구독 Provider capability를 선언하지 않았습니다");
        }
        const credentialId = randomUUID();
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          `CREATE provider_credential CONTENT {
            credential_id: $credential_id, organization_id: $organization_id, provider_id: $provider_id,
            endpoint_id: $endpoint_id, label: $label, credential_type: $credential_type, status: 'active',
            version: 1, secret_version: 1, priority: $priority, weight: $weight, request_count: 0,
            input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0,
            material_kind: 'encrypted_secret', subscription_account_id: $subscription_account_id,
            subscription_connector_id: $subscription_connector_id, subscription_scope: $subscription_scope,
            created_at: time::now(), updated_at: time::now()
          } RETURN AFTER;`,
          {
            credential_id: credentialId,
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            label: input.label.trim(),
            credential_type: input.authKind === "subscription-key" ? "subscription_key" : "api_key",
            priority: input.priority,
            weight: input.weight,
            subscription_account_id: input.accountId,
            subscription_connector_id: input.connectorId,
            subscription_scope: input.scope,
          },
        );
        const credential = credentials[0];
        if (!credential) throw new Error("암호화 구독 Credential 생성 결과가 없습니다");
        await this.insertSecret(tx, context, credential, 1, input.secret);
        return { credential };
      },
      { roles: ["owner", "admin", "member"], executor },
    );
  }

  public async rotateCredential(
    context: TenantContext,
    input: RotateCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    const requestJson = canonicalJson({
      ...input,
      secret: "[REDACTED]",
      secretFingerprint: this.vault.fingerprint(input.secret),
    });
    return await this.command(context, input.commandId, "credential_rotated", requestJson, async (tx) => {
      const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
      if (credential.version !== input.expectedVersion)
        throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
      if (credential.status === "revoked") throw new Error("폐기된 Credential은 회전할 수 없습니다");
      const nextSecretVersion = credential.secret_version + 1;
      await this.insertSecret(tx, context, credential, nextSecretVersion, input.secret);
      await tx.query(
        "UPDATE provider_credential SET version = $version, secret_version = $secret_version, status = 'active', cooldown_until = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          version: credential.version + 1,
          secret_version: nextSecretVersion,
          organization_id: context.organizationId,
          credential_id: credential.credential_id,
        },
      );
      return {
        credential: {
          ...credential,
          version: credential.version + 1,
          secret_version: nextSecretVersion,
          status: "active",
        },
      };
    });
  }

  public async revokeCredential(
    context: TenantContext,
    input: RevokeCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    return await this.command(context, input.commandId, "credential_revoked", canonicalJson(input), async (tx) => {
      const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
      if (credential.version !== input.expectedVersion)
        throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
      await tx.query(
        "UPDATE provider_credential SET version = $version, status = 'revoked', updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          version: credential.version + 1,
          organization_id: context.organizationId,
          credential_id: credential.credential_id,
        },
      );
      return { credential: { ...credential, version: credential.version + 1, status: "revoked" } };
    });
  }

  public async revokeSubscriptionAccountCredentials(
    context: TenantContext,
    input: RevokeSubscriptionAccountCredentialsInput,
    executor: QueryExecutor = this.database,
  ): Promise<{ credentials: readonly ProviderCredential[]; audit: RouterAuditEvent }> {
    const accountId = input.accountId.trim();
    if (!accountId) throw new Error("구독 계정 ID는 비어 있을 수 없습니다");
    return await this.command(
      context,
      input.commandId,
      "subscription_account_credentials_revoked",
      canonicalJson({ commandId: input.commandId, accountId }),
      async (tx) => {
        const [accounts] = await tx.query<[Array<{ readonly owner_user_id: string }>]>(
          `SELECT owner_user_id FROM subscription_account
           WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
          { organization_id: context.organizationId, account_id: accountId },
        );
        const account = accounts[0];
        if (!account) throw new Error("구독 계정을 찾을 수 없습니다");
        if (account.owner_user_id !== context.userId) {
          throw new Error("구독 계정 소유자만 연결된 Credential을 폐기할 수 있습니다");
        }
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          `UPDATE provider_credential SET status = 'revoked', version += 1,
             cooldown_until = NONE, updated_at = time::now()
           WHERE organization_id = $organization_id AND subscription_account_id = $account_id
             AND status != 'revoked'
           RETURN AFTER;`,
          { organization_id: context.organizationId, account_id: accountId },
        );
        return { credentials };
      },
      { roles: ["owner", "admin", "member"], executor },
    );
  }

  public async updateCredentialQuota(
    context: TenantContext,
    input: UpdateCredentialQuotaInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    const resetAt = new Date(input.resetAt);
    if (
      !Number.isInteger(input.limit) ||
      !Number.isInteger(input.remaining) ||
      input.limit < 1 ||
      input.remaining < 0 ||
      input.remaining > input.limit ||
      !Number.isFinite(resetAt.getTime())
    ) {
      throw new Error("Credential quota 값이 유효하지 않습니다");
    }
    return await this.command(
      context,
      input.commandId,
      "credential_quota_updated",
      canonicalJson(input),
      async (tx) => {
        const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
        if (credential.version !== input.expectedVersion)
          throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
        if (credential.status === "revoked") throw new Error("폐기된 Credential quota는 갱신할 수 없습니다");
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          "UPDATE provider_credential SET version += 1, quota_limit = $quota_limit, quota_remaining = $quota_remaining, quota_reset_at = $quota_reset_at, status = IF status = 'cooldown' AND cooldown_until <= time::now() { 'active' } ELSE { status }, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            credential_id: credential.credential_id,
            quota_limit: input.limit,
            quota_remaining: input.remaining,
            quota_reset_at: resetAt,
          },
        );
        if (!credentials[0]) throw new Error("Credential quota 갱신 결과가 없습니다");
        return { credential: credentials[0] };
      },
    );
  }

  public async listCredentials(
    context: TenantContext,
    providerId?: string,
    executor: QueryExecutor = this.database,
  ): Promise<ProviderCredential[]> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND ($provider_id = NONE OR provider_id = $provider_id) ORDER BY label ASC;",
      { organization_id: context.organizationId, provider_id: providerId },
    );
    return credentials;
  }

  public async getProvider(context: TenantContext, providerId: string): Promise<ModelProvider> {
    await this.organizations.verifyTenantContext(context);
    return await this.requireProvider(this.database, context.organizationId, providerId);
  }

  public async revealSecret(context: TenantContext, credentialId: string): Promise<string> {
    await this.organizations.verifyTenantContext(context);
    const credential = await this.requireCredential(this.database, context.organizationId, credentialId);
    return await this.resolveExecutionSecret(context, credential, this.database);
  }

  public async resolveExecutionSecret(
    context: TenantContext,
    credential: ProviderCredential,
    executor: QueryExecutor,
  ): Promise<string> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    return await this.resolveExecutionSecretVersion(context, credential, credential.secret_version, executor);
  }

  public async resolveExecutionMaterial(
    context: TenantContext,
    credential: ProviderCredential,
    executor: QueryExecutor,
    secretVersion = credential.secret_version,
  ): Promise<CredentialMaterial> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    const materialKind: unknown = credential.material_kind;
    if (materialKind !== undefined && materialKind !== "encrypted_secret" && materialKind !== "connector_session") {
      throw new Error("지원하지 않는 Credential material kind입니다");
    }
    const subscriptionAccess = hasSubscriptionLineage(credential)
      ? await this.requireSubscriptionCredentialUsable(context, credential, executor)
      : undefined;
    if (credential.material_kind === "connector_session") {
      const accountId = credential.subscription_account_id;
      const connectorId = credential.subscription_connector_id;
      const scope = credential.subscription_scope;
      if (!accountId || !connectorId || !scope) {
        throw new Error("Connector Credential 구성이 불완전합니다");
      }
      if (!subscriptionAccess) throw new Error("Connector Credential의 구독 계정 접근 계보가 없습니다");
      return { kind: "connector_session", accountId, connectorId, scope: subscriptionAccess.scope };
    }
    const secret = await this.resolveExecutionSecretVersion(context, credential, secretVersion, executor);
    return { kind: "encrypted_secret", secret, secretVersion };
  }

  public async resolveExecutionSecretVersion(
    context: TenantContext,
    credential: ProviderCredential,
    secretVersion: number,
    executor: QueryExecutor,
  ): Promise<string> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    if (credential.material_kind === "connector_session") {
      throw new Error("Connector session Credential에는 복호화할 secret이 없습니다");
    }
    const secret = await this.requireSecret(executor, context.organizationId, credential, secretVersion);
    return this.vault.decrypt(
      { algorithm: "aes-256-gcm", ciphertext: secret.ciphertext, iv: secret.iv, authTag: secret.auth_tag },
      secret.aad,
    );
  }

  private async command<Payload extends object>(
    context: TenantContext,
    commandId: string,
    eventType: string,
    requestJson: string,
    operation: (executor: QueryExecutor) => Promise<Payload>,
    options: {
      readonly roles?: readonly TenantContext["role"][];
      readonly executor?: QueryExecutor;
    } = {},
  ): Promise<Payload & { audit: RouterAuditEvent }> {
    const roles = options.roles ?? ["owner", "admin"];
    const execute = async (tx: QueryExecutor): Promise<Payload & { audit: RouterAuditEvent }> => {
      await this.organizations.verifyTenantContext(context, roles, tx);
      const [existing] = await tx.query<[RouterAuditEvent[]]>(
        "SELECT * OMIT id FROM router_audit_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (existing[0]) {
        if (existing[0].actor_user_id !== context.userId) {
          throw new Error("같은 commandId를 다른 사용자가 재사용할 수 없습니다");
        }
        if (existing[0].request_json !== requestJson)
          throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
        return JSON.parse(existing[0].result_json) as Payload & { audit: RouterAuditEvent };
      }
      const payload = await operation(tx);
      const [events] = await tx.query<[RouterAuditEvent[]]>(
        "CREATE router_audit_event CONTENT { audit_event_id: $audit_event_id, organization_id: $organization_id, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, request_json: $request_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
        {
          audit_event_id: randomUUID(),
          organization_id: context.organizationId,
          command_id: commandId,
          event_type: eventType,
          actor_user_id: context.userId,
          request_json: requestJson,
        },
      );
      const audit = events[0];
      if (!audit) throw new Error("Router audit event 생성 결과가 없습니다");
      const result = { ...payload, audit };
      await tx.query(
        "UPDATE router_audit_event SET result_json = $result_json WHERE audit_event_id = $audit_event_id;",
        {
          result_json: JSON.stringify(result),
          audit_event_id: audit.audit_event_id,
        },
      );
      return result;
    };
    const executor = options.executor ?? this.database;
    return executor === this.database ? await this.database.transaction(execute) : await execute(executor);
  }

  private async insertSecret(
    executor: QueryExecutor,
    context: TenantContext,
    credential: ProviderCredential,
    version: number,
    plaintext: string,
  ): Promise<void> {
    const aad = `${context.organizationId}:${credential.provider_id}:${credential.endpoint_id}:${credential.credential_id}:${String(version)}`;
    const encrypted = this.vault.encrypt(plaintext, aad);
    await executor.query(
      "CREATE credential_secret_version CONTENT { secret_version_id: $secret_version_id, organization_id: $organization_id, credential_id: $credential_id, version: $version, algorithm: $algorithm, ciphertext: $ciphertext, iv: $iv, auth_tag: $auth_tag, aad: $aad, created_by: $created_by, created_at: time::now() };",
      {
        secret_version_id: randomUUID(),
        organization_id: context.organizationId,
        credential_id: credential.credential_id,
        version,
        algorithm: encrypted.algorithm,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        aad,
        created_by: context.userId,
      },
    );
  }

  private async requireSubscriptionCredentialUsable(
    context: TenantContext,
    credential: ProviderCredential,
    executor: QueryExecutor,
  ): Promise<Awaited<ReturnType<SubscriptionAccountService["requireRoutingAccess"]>>> {
    const accounts = this.options.accounts;
    const accountId = credential.subscription_account_id;
    const connectorId = credential.subscription_connector_id;
    const scope = credential.subscription_scope;
    if (!accounts || !accountId || !connectorId || !scope) {
      throw new Error("구독 Credential 계보 구성이 불완전합니다");
    }
    const access = await accounts.requireRoutingAccess(context, accountId, executor);
    const account = access.account;
    if (account.provider_id !== credential.provider_id)
      throw new Error("구독 계정과 Provider binding이 일치하지 않습니다");
    if (account.connector_id !== connectorId) throw new Error("구독 계정과 Connector binding이 일치하지 않습니다");
    const [currentRows] = await executor.query<[Array<{ readonly snapshot_id: string }>]>(
      `SELECT snapshot_id FROM subscription_quota_current
       WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
      { organization_id: context.organizationId, account_id: accountId },
    );
    const current = currentRows[0];
    if (!current) return access;
    const [snapshots] = await executor.query<[Array<{ readonly windows_json: string }>]>(
      `SELECT windows_json FROM subscription_quota_snapshot
       WHERE organization_id = $organization_id AND account_id = $account_id
         AND snapshot_id = $snapshot_id LIMIT 1;`,
      { organization_id: context.organizationId, account_id: accountId, snapshot_id: current.snapshot_id },
    );
    const snapshot = snapshots[0];
    if (!snapshot) throw new Error("구독 Credential의 현재 quota snapshot을 찾을 수 없습니다");
    if (freshQuotaExhausted(JSON.parse(snapshot.windows_json) as unknown)) {
      throw new Error("구독 Credential의 신선한 quota가 소진되었습니다");
    }
    return access;
  }

  private async requireProvider(
    executor: QueryExecutor,
    organizationId: string,
    providerId: string,
  ): Promise<ModelProvider> {
    const [providers] = await executor.query<[ModelProvider[]]>(
      "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id AND provider_id = $provider_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, provider_id: providerId },
    );
    if (!providers[0]) throw new Error(`활성 Provider를 찾을 수 없습니다: ${providerId}`);
    return providers[0];
  }

  private async requireEndpoint(
    executor: QueryExecutor,
    organizationId: string,
    providerId: string,
    endpointId: string,
  ): Promise<ProviderEndpoint> {
    const [endpoints] = await executor.query<[ProviderEndpoint[]]>(
      "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id AND endpoint_id = $endpoint_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, provider_id: providerId, endpoint_id: endpointId },
    );
    if (!endpoints[0]) throw new Error(`활성 Provider Endpoint를 찾을 수 없습니다: ${endpointId}`);
    return endpoints[0];
  }

  private async requireCredential(
    executor: QueryExecutor,
    organizationId: string,
    credentialId: string,
  ): Promise<ProviderCredential> {
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND credential_id = $credential_id LIMIT 1;",
      { organization_id: organizationId, credential_id: credentialId },
    );
    if (!credentials[0]) throw new Error(`Credential을 찾을 수 없습니다: ${credentialId}`);
    return credentials[0];
  }

  private async requireSecret(
    executor: QueryExecutor,
    organizationId: string,
    credential: ProviderCredential,
    version = credential.secret_version,
  ): Promise<CredentialSecretVersion> {
    const [secrets] = await executor.query<[CredentialSecretVersion[]]>(
      "SELECT secret_version_id, organization_id, credential_id, version, algorithm, ciphertext, iv, auth_tag, aad, created_by, created_at FROM credential_secret_version WHERE organization_id = $organization_id AND credential_id = $credential_id AND version = $version LIMIT 1;",
      { organization_id: organizationId, credential_id: credential.credential_id, version },
    );
    if (!secrets[0]) throw new Error("Credential secret version을 찾을 수 없습니다");
    return secrets[0];
  }
}
