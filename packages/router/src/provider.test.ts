import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { SubscriptionAccountService } from "@massion/subscriptions";

import { ProviderService } from "./provider.js";
import { CredentialVault } from "./vault.js";

describe("Provider와 암호화 Credential lifecycle", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let service: ProviderService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
  });

  afterEach(async () => database.close());

  async function providerEndpoint() {
    const provider = await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      displayName: "OpenAI",
      adapterKind: "ai-sdk",
    });
    const endpoint = await service.registerEndpoint(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider.provider_id,
      name: "OpenAI API",
      baseUrl: "https://api.openai.com/v1",
      local: false,
    });
    return { provider: provider.provider, endpoint: endpoint.endpoint };
  }

  it("Provider·Endpoint와 여러 Credential을 등록하되 평문을 DB·audit에 남기지 않는다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const first = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account-a",
      credentialType: "api_key",
      secret: "sk-account-a",
      priority: 1,
      weight: 1,
    });
    const second = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account-b",
      credentialType: "api_key",
      secret: "sk-account-b",
      priority: 1,
      weight: 2,
    });

    expect(await service.revealSecret(context, first.credential.credential_id)).toBe("sk-account-a");
    expect(await service.revealSecret(context, second.credential.credential_id)).toBe("sk-account-b");
    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM router_audit_event;",
      ),
    );
    expect(raw).not.toContain("sk-account-a");
    expect(raw).not.toContain("sk-account-b");
    await expect(service.listProviders(context)).resolves.toEqual([
      expect.objectContaining({ provider_id: provider.provider_id, display_name: "OpenAI" }),
    ]);
    await expect(service.listEndpoints(context, provider.provider_id)).resolves.toEqual([
      expect.objectContaining({ endpoint_id: endpoint.endpoint_id, base_url: "https://api.openai.com/v1" }),
    ]);
    expect(await service.listCredentials(context, provider.provider_id)).toHaveLength(2);
  });

  it("구독 계정을 secret 없는 Connector session Credential로 등록하고 계정 단위로 폐기한다", async () => {
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), { accounts });
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'codex-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['codex'], status: 'ready', created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Codex Subscription",
      connectorId: "codex-edge",
      profileLocator: "local-codex-profile",
      billingKind: "consumer-subscription",
    });
    const { provider, endpoint } = await providerEndpoint();
    const added = await service.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "codex-subscription",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });

    expect(added.credential).toMatchObject({
      material_kind: "connector_session",
      subscription_account_id: account.account_id,
      subscription_connector_id: "codex-edge",
      secret_version: 0,
    });
    await expect(service.resolveExecutionMaterial(context, added.credential, database)).resolves.toEqual({
      kind: "connector_session",
      accountId: account.account_id,
      connectorId: "codex-edge",
      scope: "personal",
    });
    expect(
      JSON.stringify(
        await database.query("SELECT * FROM credential_secret_version WHERE credential_id = $credential_id;", {
          credential_id: added.credential.credential_id,
        }),
      ),
    ).toBe("[[]]");

    const revokeCommandId = crypto.randomUUID();
    const revoked = await service.revokeSubscriptionAccountCredentials(context, {
      commandId: revokeCommandId,
      accountId: account.account_id,
    });
    expect(revoked.credentials).toEqual([
      expect.objectContaining({ credential_id: added.credential.credential_id, status: "revoked", version: 2 }),
    ]);
    await expect(
      service.revokeSubscriptionAccountCredentials(context, {
        commandId: revokeCommandId,
        accountId: account.account_id,
      }),
    ).resolves.toMatchObject({
      credentials: [
        expect.objectContaining({ credential_id: added.credential.credential_id, status: "revoked", version: 2 }),
      ],
      audit: { audit_event_id: revoked.audit.audit_event_id, command_id: revokeCommandId },
    });
    const stored = (await service.listCredentials(context, provider.provider_id)).find(
      (credential) => credential.credential_id === added.credential.credential_id,
    );
    if (!stored) throw new Error("폐기된 구독 Credential을 찾을 수 없습니다");
    await expect(service.resolveExecutionMaterial(context, stored, database)).rejects.toThrow("활성 Credential");
  });

  it("model 구독 키를 암호화하면서 계정·Connector·scope 계보를 보존한다", async () => {
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), { accounts });
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'minimax-model', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', execution_kind: 'model', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['minimax-token-plan'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const ensured = await service.ensureSubscriptionProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "MiniMax Token Plan",
      connectorId: "minimax-model",
      profileLocator: "minimax-account",
      billingKind: "token-plan",
      requiredExecutionKind: "model",
      requiredCapability: "minimax-token-plan",
    });
    await expect(
      database.query<[Array<{ readonly location: string }>]>(
        "SELECT location FROM subscription_connector WHERE organization_id = $organization_id AND connector_id = 'minimax-model';",
        { organization_id: context.organizationId },
      ),
    ).resolves.toEqual([[{ location: "server" }]]);
    const added = await service.addSubscriptionCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointId: ensured.endpoint.endpoint_id,
      label: "MiniMax Token Plan key",
      authKind: "subscription-key",
      secret: "minimax-subscription-key",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });

    expect(added.credential).toMatchObject({
      credential_type: "subscription_key",
      material_kind: "encrypted_secret",
      secret_version: 1,
      subscription_account_id: account.account_id,
      subscription_connector_id: "minimax-model",
      subscription_scope: "personal",
    });
    await expect(service.resolveExecutionMaterial(context, added.credential, database)).resolves.toEqual({
      kind: "encrypted_secret",
      secret: "minimax-subscription-key",
      secretVersion: 1,
    });
    await expect(
      service.resolveExecutionMaterial(
        context,
        { ...added.credential, material_kind: "unknown" as "encrypted_secret" },
        database,
      ),
    ).rejects.toThrow("material kind");
    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM router_audit_event;",
      ),
    );
    expect(raw).not.toContain("minimax-subscription-key");
  });

  it("실제 연결 표면이 없는 대화형 코딩 plan은 Provider·계정·암호화 Credential을 만들지 않는다", async () => {
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), { accounts });
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'interactive-kimi', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', execution_kind: 'model', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['kimi-coding-plan'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    await expect(
      service.ensureSubscriptionProvider(context, {
        commandId: crypto.randomUUID(),
        providerId: "kimi-coding-plan",
      }),
    ).rejects.toThrow(/실제 연결|검증되지/u);
    expect(
      JSON.stringify(
        await database.query(
          "SELECT * FROM model_provider; SELECT * FROM subscription_account; SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM router_audit_event WHERE event_type = 'subscription_secret_credential_added';",
        ),
      ),
    ).not.toContain("interactive-kimi-secret");
  });

  it("서버 전용 MiniMax Token Plan은 Edge Connector 주입을 거부한다", async () => {
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), { accounts });
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'minimax-edge-rejected', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', execution_kind: 'model', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['minimax-token-plan'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const ensured = await service.ensureSubscriptionProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "차단될 MiniMax Edge",
      connectorId: "minimax-edge-rejected",
      profileLocator: "edge-minimax-profile",
      billingKind: "token-plan",
      requiredExecutionKind: "model",
      requiredCapability: "minimax-token-plan",
    });

    await expect(
      service.addSubscriptionCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "minimax-token-plan",
        endpointId: ensured.endpoint.endpoint_id,
        label: "차단될 MiniMax key",
        authKind: "subscription-key",
        secret: "edge-minimax-secret",
        accountId: account.account_id,
        connectorId: account.connector_id,
        scope: "personal",
        priority: 1,
        weight: 1,
      }),
    ).rejects.toThrow("서버 Connector");
    expect(
      JSON.stringify(
        await database.query("SELECT * FROM provider_credential; SELECT * FROM credential_secret_version;"),
      ),
    ).not.toContain("edge-minimax-secret");
  });

  it("encrypted 구독 Credential은 계정·Connector·scope·신선한 quota가 유효할 때만 해독한다", async () => {
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), { accounts });
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'quota-model', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', execution_kind: 'model', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['minimax-token-plan'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const ensured = await service.ensureSubscriptionProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "Quota MiniMax",
      connectorId: "quota-model",
      profileLocator: "quota-kimi",
      billingKind: "token-plan",
      requiredExecutionKind: "model",
      requiredCapability: "minimax-token-plan",
    });
    await expect(
      database.query<[Array<{ readonly location: string }>]>(
        "SELECT location FROM subscription_connector WHERE organization_id = $organization_id AND connector_id = 'quota-model';",
        { organization_id: context.organizationId },
      ),
    ).resolves.toEqual([[{ location: "server" }]]);
    const added = await service.addSubscriptionCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointId: ensured.endpoint.endpoint_id,
      label: "Quota MiniMax key",
      authKind: "subscription-key",
      secret: "quota-secret",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    await database.query(
      `CREATE subscription_quota_snapshot CONTENT {
        snapshot_id: 'fresh-exhausted', organization_id: $organization_id, account_id: $account_id,
        windows_json: $windows_json, checksum: $checksum, exhausted: true,
        observed_at: time::now(), created_at: time::now()
      };
      CREATE subscription_quota_current CONTENT {
        organization_id: $organization_id, account_id: $account_id, snapshot_id: 'fresh-exhausted',
        minimum_remaining_ratio: 0f, earliest_reset_at: NONE, exhausted: true,
        observed_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: context.organizationId,
        account_id: account.account_id,
        windows_json: JSON.stringify([
          {
            kind: "five-hour",
            remainingRatio: 0,
            observedAt: new Date().toISOString(),
            source: "provider-reported",
            confidence: "reported",
          },
        ]),
        checksum: "a".repeat(64),
      },
    );

    await expect(service.resolveExecutionMaterial(context, added.credential, database)).rejects.toThrow("quota");
    await database.query(
      `DELETE subscription_quota_current WHERE organization_id = $organization_id AND account_id = $account_id;
       UPDATE subscription_account SET status = 'offline'
       WHERE organization_id = $organization_id AND account_id = $account_id;`,
      { organization_id: context.organizationId, account_id: account.account_id },
    );
    await expect(service.resolveExecutionMaterial(context, added.credential, database)).rejects.toThrow("활성 상태");
  });

  it("secret 회전은 새 immutable version을 만들고 revoke 후 복호화를 거부한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const added = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account",
      credentialType: "oauth",
      secret: "token-v1",
      priority: 1,
      weight: 1,
    });
    const rotated = await service.rotateCredential(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 1,
      secret: "token-v2",
    });

    expect(rotated.credential.secret_version).toBe(2);
    expect(await service.revealSecret(context, added.credential.credential_id)).toBe("token-v2");
    const revoked = await service.revokeCredential(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 2,
    });
    expect(revoked.credential.status).toBe("revoked");
    await expect(service.revealSecret(context, added.credential.credential_id)).rejects.toThrow("활성");
  });

  it("quota limit·remaining·reset을 version 선행조건으로 갱신한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const added = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "quota-account",
      credentialType: "api_key",
      secret: "secret",
      priority: 1,
      weight: 1,
    });
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const updated = await service.updateCredentialQuota(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 1,
      limit: 1_000,
      remaining: 750,
      resetAt,
    });

    expect(updated.credential.version).toBe(2);
    expect(updated.credential.quota_limit).toBe(1_000);
    expect(updated.credential.quota_remaining).toBe(750);
    expect(new Date(String(updated.credential.quota_reset_at)).toISOString()).toBe(resetAt);
    await expect(
      service.updateCredentialQuota(context, {
        commandId: crypto.randomUUID(),
        credentialId: added.credential.credential_id,
        expectedVersion: 1,
        limit: 1_000,
        remaining: 700,
        resetAt,
      }),
    ).rejects.toThrow("version");
  });

  it("비공식 소비자 구독 credential type과 cross-tenant 접근을 거부한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    await expect(
      service.addCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: provider.provider_id,
        endpointId: endpoint.endpoint_id,
        label: "chatgpt",
        credentialType: "consumer_subscription" as "api_key",
        secret: "cookie",
        priority: 1,
        weight: 1,
      }),
    ).rejects.toThrow("지원하지 않는 Credential type");
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(
      service.listCredentials({ ...otherContext, organizationId: context.organizationId }, provider.provider_id),
    ).rejects.toThrow("TenantContext");
  });

  it("external gateway는 지원 gateway kind를 필수로 하고 일반 Provider에는 이를 허용하지 않는다", async () => {
    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "gateway",
      displayName: "Gateway",
      adapterKind: "external-gateway",
    });
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "gateway",
        name: "Missing kind",
        baseUrl: "https://gateway.example/v1",
        local: false,
      }),
    ).rejects.toThrow("gatewayKind");
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "gateway",
        name: "Unknown",
        baseUrl: "https://gateway.example/v1",
        local: false,
        gatewayKind: "unknown" as "litellm",
      }),
    ).rejects.toThrow("지원하지 않는 Gateway");

    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "direct",
      displayName: "Direct",
      adapterKind: "openai-compatible",
    });
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "direct",
        name: "Wrong gateway metadata",
        baseUrl: "https://direct.example/v1",
        local: false,
        gatewayKind: "portkey",
      }),
    ).rejects.toThrow("external-gateway");
  });

  it("정본에 없는 adapter와 outbound 보안 경계를 우회하는 endpoint를 저장하지 않는다", async () => {
    await expect(
      service.registerProvider(context, {
        commandId: crypto.randomUUID(),
        providerId: "fake-anthropic",
        displayName: "Fake Anthropic",
        adapterKind: "anthropic" as "openai-compatible",
      }),
    ).rejects.toThrow("Adapter");

    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "direct-secure",
      displayName: "Direct Secure",
      adapterKind: "openai-compatible",
    });
    for (const baseUrl of [
      "https://user:secret@gateway.example/v1",
      "https://gateway.example/v1?token=secret",
      "https://gateway.example/v1#models",
    ]) {
      await expect(
        service.registerEndpoint(context, {
          commandId: crypto.randomUUID(),
          providerId: "direct-secure",
          name: baseUrl,
          baseUrl,
          local: false,
        }),
      ).rejects.toThrow("endpoint URL");
    }
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "direct-secure",
        name: "Private network disguised as local",
        baseUrl: "http://192.168.1.10:11434",
        local: true,
      }),
    ).rejects.toThrow("loopback");
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "direct-secure",
        name: "Public endpoint disguised as local",
        baseUrl: "https://api.openai.com/v1",
        local: true,
      }),
    ).rejects.toThrow("loopback");
    for (const baseUrl of [
      "https://localhost./v1",
      "https://[::ffff:7f00:1]/v1",
      "https://10.0.0.1/v1",
      "https://169.254.169.254/latest",
    ]) {
      await expect(
        service.registerEndpoint(context, {
          commandId: crypto.randomUUID(),
          providerId: "direct-secure",
          name: baseUrl,
          baseUrl,
          local: false,
        }),
      ).rejects.toThrow("endpoint URL");
    }
  });
  it("참조가 없는 Provider는 endpoint·credential과 함께 제거한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "기본 키",
      credentialType: "api_key",
      secret: "sk-remove-me",
      priority: 0,
      weight: 100,
    });

    const removal = await service.removeProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
    });

    expect(removal.removed).toBe(true);
    expect(await service.listProviders(context)).toHaveLength(0);
    expect(await service.listEndpoints(context)).toHaveLength(0);
    expect(await service.listCredentials(context)).toHaveLength(0);
  });

  it("실행 계보가 있으면 제거 대신 비활성화하고 라우팅 후보에서 뺀다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "기본 키",
      credentialType: "api_key",
      secret: "sk-retire-me",
      priority: 0,
      weight: 100,
    });
    const modelProfileId = crypto.randomUUID();
    await database.query(
      "CREATE model_profile CONTENT { model_profile_id: $model_profile_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, model_id: 'retired-model', route_kind: 'chat', context_window: 1000, supports_tools: false, supports_structured_output: false, supports_vision: false, supports_streaming: false, equivalence_group: 'test-group', eval_score: 0.9f, verified: false, enabled: true, created_at: time::now(), updated_at: time::now() };",
      {
        model_profile_id: modelProfileId,
        organization_id: context.organizationId,
        provider_id: provider.provider_id,
        endpoint_id: endpoint.endpoint_id,
      },
    );
    await database.query(
      "CREATE route_attempt CONTENT { attempt_id: $attempt_id, organization_id: $organization_id, route_id: 'route-1', model_profile_id: $model_profile_id, candidate_id: 'candidate-1', credential_id: 'credential-1', credential_secret_version: 1, command_id: 'command-1', status: 'failed', selection_sequence: 1, estimated_tokens: 0, reserved_cost_micros: 0, explanation_json: '{}', created_at: time::now(), updated_at: time::now() };",
      { attempt_id: crypto.randomUUID(), organization_id: context.organizationId, model_profile_id: modelProfileId },
    );

    const outcome = await service.removeProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
    });

    expect(outcome.removed).toBe(false);
    const providers = await service.listProviders(context);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.enabled).toBe(false);
    expect(await service.listCredentials(context)).toHaveLength(0);
  });

  it("이미 은퇴한 Provider를 다시 제거하면 등록을 지운다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const modelProfileId = crypto.randomUUID();
    await database.query(
      "CREATE model_profile CONTENT { model_profile_id: $model_profile_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, model_id: 'retired-twice', route_kind: 'chat', context_window: 1000, supports_tools: false, supports_structured_output: false, supports_vision: false, supports_streaming: false, equivalence_group: 'test-group', eval_score: 0.9f, verified: false, enabled: true, created_at: time::now(), updated_at: time::now() };",
      {
        model_profile_id: modelProfileId,
        organization_id: context.organizationId,
        provider_id: provider.provider_id,
        endpoint_id: endpoint.endpoint_id,
      },
    );
    await database.query(
      "CREATE route_attempt CONTENT { attempt_id: $attempt_id, organization_id: $organization_id, route_id: 'route-1', model_profile_id: $model_profile_id, candidate_id: 'candidate-1', credential_id: 'credential-1', credential_secret_version: 1, command_id: 'command-1', status: 'failed', selection_sequence: 1, estimated_tokens: 0, reserved_cost_micros: 0, explanation_json: '{}', created_at: time::now(), updated_at: time::now() };",
      { attempt_id: crypto.randomUUID(), organization_id: context.organizationId, model_profile_id: modelProfileId },
    );

    // 검증 근거는 immutable입니다. 있는 채로도 제거가 끝까지 가야 합니다.
    await database.query(
      "CREATE model_verification_evidence CONTENT { evidence_id: $evidence_id, organization_id: $organization_id, model_profile_id: $model_profile_id, model_id: 'retired-twice', evidence_kind: 'runtime-availability', source: 'test', source_version: 'v1', claim_json: '{}', claim_digest: $digest, observed_at: time::now(), created_by: $actor, created_at: time::now() };",
      {
        evidence_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        model_profile_id: modelProfileId,
        digest: "a".repeat(64),
        actor: context.userId,
      },
    );

    const first = await service.removeProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
    });
    expect(first.removed).toBe(false);

    const second = await service.removeProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
    });

    expect(second.removed).toBe(true);
    expect(await service.listProviders(context)).toHaveLength(0);
    // 검증 근거는 immutable이라 삭제 대상이 아닙니다.
    const [evidence] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() FROM model_verification_evidence WHERE organization_id = $organization_id GROUP ALL;",
      { organization_id: context.organizationId },
    );
    expect(evidence[0]?.count ?? 0).toBe(1);
    // 실행 기록 자체는 지우지 않습니다.
    const [attempts] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() FROM route_attempt WHERE organization_id = $organization_id GROUP ALL;",
      { organization_id: context.organizationId },
    );
    expect(attempts[0]?.count).toBe(1);
    // 그 기록이 가리키는 model_profile도 남겨야 합니다. 지우면 listAttempts가 고아 행에서 던져
    // 예산·라우터 패널이 통째로 죽습니다. 지울지는 「몇 번째 제거인가」가 아니라 「계보가 참조하는가」가 정합니다.
    const [survivingProfiles] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() FROM model_profile WHERE organization_id = $organization_id AND model_profile_id = $model_profile_id GROUP ALL;",
      { organization_id: context.organizationId, model_profile_id: modelProfileId },
    );
    expect(survivingProfiles[0]?.count).toBe(1);
  });

  it("호출 기록이 없는 Provider의 model_profile은 제거와 함께 지운다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const modelProfileId = crypto.randomUUID();
    await database.query(
      "CREATE model_profile CONTENT { model_profile_id: $model_profile_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, model_id: 'never-called', route_kind: 'chat', context_window: 1000, supports_tools: false, supports_structured_output: false, supports_vision: false, supports_streaming: false, equivalence_group: 'test-group', eval_score: 0.9f, verified: false, enabled: true, created_at: time::now(), updated_at: time::now() };",
      {
        model_profile_id: modelProfileId,
        organization_id: context.organizationId,
        provider_id: provider.provider_id,
        endpoint_id: endpoint.endpoint_id,
      },
    );

    const removal = await service.removeProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
    });

    expect(removal.removed).toBe(true);
    const [profiles] = await database.query<[{ readonly count: number }[]]>(
      "SELECT count() FROM model_profile WHERE organization_id = $organization_id GROUP ALL;",
      { organization_id: context.organizationId },
    );
    expect(profiles[0]?.count ?? 0).toBe(0);
  });

  it("구독 연결 Provider는 제거 대신 구독 해제를 요구한다", async () => {
    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "subscribed",
      displayName: "Subscribed",
      adapterKind: "subscription-connector",
    });

    await expect(
      service.removeProvider(context, { commandId: crypto.randomUUID(), providerId: "subscribed" }),
    ).rejects.toThrow("구독");
  });

  it("없는 Provider 제거는 명확히 거절한다", async () => {
    await expect(
      service.removeProvider(context, { commandId: crypto.randomUUID(), providerId: "missing" }),
    ).rejects.toThrow();
  });
});
