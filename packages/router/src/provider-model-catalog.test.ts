import { createHash, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { ProviderService } from "./provider.js";
import { CredentialVault } from "./vault.js";

describe("Provider 모델 카탈로그 동기화", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: ProviderService;
  let endpointId: string;
  const vaultKey = randomBytes(32);

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await ProviderService.create(database, organizations, new CredentialVault(vaultKey));
    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openrouter",
      displayName: "OpenRouter",
      adapterKind: "openai-compatible",
    });
    endpointId = (
      await service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "openrouter",
        name: "OpenRouter API",
        baseUrl: "https://openrouter.ai/api/v1",
        local: false,
      })
    ).endpoint.endpoint_id;
    await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openrouter",
      endpointId,
      label: "Primary",
      credentialType: "api_key",
      secret: "catalog-secret",
      priority: 0,
      weight: 1,
    });
  });

  afterEach(async () => database.close());

  it("활성 Credential로 발견한 모델을 별도 snapshot에 저장하고 재시작 뒤 복원한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a", "model-b"));
    const result = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models?output_modalities=all",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer catalog-secret" }) }),
    );
    expect(result).toMatchObject({
      status: "available",
      activeCount: 2,
      authenticationScope: "credential",
      credentialVersion: 1,
      credentialSecretVersion: 1,
    });
    const catalog = await service.listModelCatalog(context, endpointId);
    expect(catalog.models.map((model) => [model.model_id, model.state])).toEqual([
      ["model-a", "active"],
      ["model-b", "active"],
    ]);
    expect(catalog.status).toMatchObject({
      status: "available",
      active_count: 2,
      authentication_scope: "credential",
      credential_version: 1,
      credential_secret_version: 1,
    });

    service = await ProviderService.create(
      database,
      await OrganizationService.create(database),
      new CredentialVault(vaultKey),
    );
    await expect(service.listModelCatalog(context, endpointId)).resolves.toMatchObject({
      models: [{ model_id: "model-a" }, { model_id: "model-b" }],
    });
    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM provider_model_catalog_entry; SELECT * FROM provider_model_catalog_sync; SELECT * FROM router_audit_event; SELECT * FROM model_profile;",
      ),
    );
    expect(raw).not.toContain("catalog-secret");
    expect(raw.endsWith(",[]]")).toBe(true);
  });

  it("실패·부분 응답은 마지막 정상 snapshot을 보존하고 완전 snapshot만 stale을 전이한다", async () => {
    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a", "model-b")),
    );
    const before = await service.listModelCatalog(context, endpointId);
    const modelAId = before.models.find((model) => model.model_id === "model-a")?.catalog_entry_id;

    const limited = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } })),
    );
    expect(limited.status).toBe("degraded");
    expect(
      (await service.listModelCatalog(context, endpointId)).models.filter((model) => model.state === "active"),
    ).toHaveLength(2);

    const partial = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "model-c" }, { id: "bad\nmodel" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(partial.status).toBe("partial");
    expect(
      (await service.listModelCatalog(context, endpointId)).models.filter((model) => model.state === "active"),
    ).toHaveLength(2);

    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-b", "model-c")),
    );
    const after = await service.listModelCatalog(context, endpointId);
    expect(after.models.map((model) => [model.model_id, model.state])).toEqual([
      ["model-b", "active"],
      ["model-c", "active"],
      ["model-a", "stale"],
    ]);
    expect(after.models.find((model) => model.model_id === "model-a")?.catalog_entry_id).toBe(modelAId);
  });

  it("같은 command replay는 네트워크를 다시 호출하지 않는다", async () => {
    const commandId = crypto.randomUUID();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a"));
    const first = await service.synchronizeModelCatalog(context, { commandId, endpointId }, fetcher);
    const replayed = await service.synchronizeModelCatalog(context, { commandId, endpointId }, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replayed).toMatchObject({
      status: first.status,
      snapshotId: first.snapshotId,
      audit: { audit_event_id: first.audit.audit_event_id },
    });
  });

  it("동시에 들어온 같은 command는 한 번만 동기화하고 같은 완료 결과를 공유한다", async () => {
    let release: ((response: Response) => void) | undefined;
    const commandId = crypto.randomUUID();
    const firstFetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const secondFetcher = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("wrong-model"));
    const first = service.synchronizeModelCatalog(context, { commandId, endpointId }, firstFetcher);
    await vi.waitFor(() => expect(firstFetcher).toHaveBeenCalledOnce());
    const second = service.synchronizeModelCatalog(context, { commandId, endpointId }, secondFetcher);

    expect(secondFetcher).not.toHaveBeenCalled();
    release?.(modelsResponse("shared-model"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toMatchObject({
      status: "available",
      snapshotId: firstResult.snapshotId,
      audit: { audit_event_id: firstResult.audit.audit_event_id },
    });
    await expect(service.listModelCatalog(context, endpointId)).resolves.toMatchObject({
      models: [{ model_id: "shared-model", state: "active" }],
      status: { status: "available" },
    });
  });

  it("늦게 끝난 이전 요청이 최신 snapshot을 덮지 않는다", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const first = service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockReturnValue(firstResponse),
    );
    await vi.waitFor(async () => {
      expect((await service.listModelCatalog(context, endpointId)).status?.status).toBe("syncing");
    });
    const second = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("newer-model")),
    );
    releaseFirst?.(modelsResponse("older-model"));

    expect(second.status).toBe("available");
    await expect(first).resolves.toMatchObject({ status: "superseded" });
    expect((await service.listModelCatalog(context, endpointId)).models.map((model) => model.model_id)).toEqual([
      "newer-model",
    ]);
  });

  it("최초 동시 예약도 원자 sequence로 한 snapshot만 적용한다", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let releaseSecond: ((response: Response) => void) | undefined;
    const firstFetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const secondFetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseSecond = resolve;
      }),
    );
    const first = service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      firstFetcher,
    );
    const second = service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      secondFetcher,
    );
    await vi.waitFor(() => {
      expect(firstFetcher).toHaveBeenCalledTimes(1);
      expect(secondFetcher).toHaveBeenCalledTimes(1);
    });
    releaseFirst?.(modelsResponse("first-model"));
    releaseSecond?.(modelsResponse("second-model"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect([firstResult.status, secondResult.status].sort()).toEqual(["available", "superseded"]);
    const expectedModel = firstResult.status === "available" ? "first-model" : "second-model";
    expect((await service.listModelCatalog(context, endpointId)).models.map((model) => model.model_id)).toEqual([
      expectedModel,
    ]);
  });

  it("OpenRouter 규모 400개 동일 snapshot을 짧게 재확인하고 entry를 다시 쓰지 않는다", async () => {
    const ids = Array.from({ length: 400 }, (_value, index) => `vendor/model-${String(index).padStart(3, "0")}`);
    const first = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse(...ids)),
    );
    const before = await service.listModelCatalog(context, endpointId);
    const entryIds = before.models.map((model) => model.catalog_entry_id);
    const sentinelMetadata = `{ "id": "${ids[0] ?? ""}" }`;
    const sentinelDigest = createHash("sha256")
      .update(JSON.stringify({ id: ids[0] }))
      .digest("hex");
    await database.query(
      `UPDATE provider_model_catalog_entry SET
         last_seen_at = d'2020-01-01T00:00:00Z', updated_at = d'2020-01-01T00:00:00Z'
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;
       UPDATE provider_model_catalog_entry SET metadata_json = $metadata_json, metadata_digest = $metadata_digest
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id AND model_id = $model_id;
       UPDATE provider_model_catalog_sync SET last_successful_at = d'2020-01-01T00:00:00Z'
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;`,
      {
        organization_id: context.organizationId,
        endpoint_id: endpointId,
        model_id: ids[0],
        metadata_json: sentinelMetadata,
        metadata_digest: sentinelDigest,
      },
    );
    const transactionQueries: string[][] = [];
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction").mockImplementation(
      async <T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> =>
        await originalTransaction(async (transaction) => {
          const queries: string[] = [];
          transactionQueries.push(queries);
          const guarded: QueryExecutor = {
            query: async <R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> => {
              queries.push(surql);
              if (
                surql.includes("UPDATE provider_model_catalog_entry SET state = 'stale'") ||
                surql.includes("INSERT INTO provider_model_catalog_entry")
              ) {
                throw new Error("Transaction not found");
              }
              return await transaction.query<R>(surql, bindings);
            },
          };
          return await operation(guarded);
        }),
    );
    let replayedSnapshot: Awaited<ReturnType<ProviderService["synchronizeModelCatalog"]>>;
    try {
      replayedSnapshot = await service.synchronizeModelCatalog(
        context,
        { commandId: crypto.randomUUID(), endpointId },
        vi.fn<typeof fetch>().mockResolvedValue(modelsResponse(...ids)),
      );
    } finally {
      transactionSpy.mockRestore();
    }
    const after = await service.listModelCatalog(context, endpointId);
    const [sentinelRows] = await database.query<
      [Array<{ readonly metadata_json: string; readonly metadata_digest: string }>]
    >(
      `SELECT metadata_json, metadata_digest FROM provider_model_catalog_entry
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id AND model_id = $model_id;`,
      { organization_id: context.organizationId, endpoint_id: endpointId, model_id: ids[0] },
    );
    const refreshTransaction = transactionQueries.find((queries) =>
      queries.some((surql) => surql.includes("SET last_seen_at = $observed_at")),
    );

    expect(first).toMatchObject({ status: "available", activeCount: 400 });
    expect(replayedSnapshot).toMatchObject({
      status: "available",
      activeCount: 400,
      snapshotId: first.snapshotId,
    });
    expect(after.models).toHaveLength(400);
    expect(after.models.map((model) => model.catalog_entry_id)).toEqual(entryIds);
    expect(after.models.every((model) => new Date(model.last_seen_at as string).getFullYear() > 2020)).toBe(true);
    expect(after.models.every((model) => new Date(model.updated_at as string).getFullYear() > 2020)).toBe(true);
    expect(after.models.every((model) => model.snapshot_id === first.snapshotId)).toBe(true);
    expect(after.status).toMatchObject({ status: "available", active_count: 400, snapshot_id: first.snapshotId });
    expect(new Date(after.status?.last_successful_at as string).getFullYear()).toBeGreaterThan(2020);
    expect(sentinelRows[0]).toEqual({ metadata_json: sentinelMetadata, metadata_digest: sentinelDigest });
    expect(
      transactionQueries
        .flat()
        .some(
          (surql) =>
            surql.includes("UPDATE provider_model_catalog_entry SET state = 'stale'") ||
            surql.includes("INSERT INTO provider_model_catalog_entry"),
        ),
    ).toBe(false);
    expect(refreshTransaction?.some((surql) => surql.includes("UPDATE provider_model_catalog_sync SET"))).toBe(true);
    expect(refreshTransaction?.some((surql) => surql.includes("CREATE router_audit_event"))).toBe(true);
  });

  it("같은 snapshot을 다시 확인하면 entry ID를 보존하고 lastSeen을 갱신한다", async () => {
    const first = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a")),
    );
    await database.query(
      `UPDATE provider_model_catalog_entry SET last_seen_at = d'2020-01-01T00:00:00Z'
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;`,
      { organization_id: context.organizationId, endpoint_id: endpointId },
    );
    const before = await service.listModelCatalog(context, endpointId);
    const repeated = await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a")),
    );
    const after = await service.listModelCatalog(context, endpointId);

    expect(repeated.snapshotId).toBe(first.snapshotId);
    expect(after.models[0]?.catalog_entry_id).toBe(before.models[0]?.catalog_entry_id);
    expect(new Date(after.models[0]?.last_seen_at as string).getTime()).toBeGreaterThan(
      new Date(before.models[0]?.last_seen_at as string).getTime(),
    );
  });

  it("Credential 추가·폐기는 snapshot을 무효화하고 다음 동기화가 현재 키를 사용한다", async () => {
    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a")),
    );
    const added = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openrouter",
      endpointId,
      label: "Newest",
      credentialType: "api_key",
      secret: "new-catalog-secret",
      priority: 0,
      weight: 1,
    });
    await expect(service.listModelCatalog(context, endpointId)).resolves.toMatchObject({
      status: { status: "degraded", diagnostic_reason: "credential-added" },
    });
    const newestFetcher = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("new-key-model"));
    await service.synchronizeModelCatalog(context, { commandId: crypto.randomUUID(), endpointId }, newestFetcher);
    expect(newestFetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer new-catalog-secret" }) }),
    );

    await service.revokeCredential(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: added.credential.version,
    });
    await expect(service.listModelCatalog(context, endpointId)).resolves.toMatchObject({
      status: { status: "degraded", diagnostic_reason: "credential-revoked" },
    });
    const fallbackFetcher = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("old-key-model"));
    await service.synchronizeModelCatalog(context, { commandId: crypto.randomUUID(), endpointId }, fallbackFetcher);
    expect(fallbackFetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer catalog-secret" }) }),
    );
  });

  it("재시작은 남겨진 syncing을 interrupted 진단으로 복구하고 metadata 변조를 거부한다", async () => {
    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("model-a")),
    );
    await database.query(
      `UPDATE provider_model_catalog_sync SET status = 'syncing'
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;`,
      { organization_id: context.organizationId, endpoint_id: endpointId },
    );
    service = await ProviderService.create(
      database,
      await OrganizationService.create(database),
      new CredentialVault(vaultKey),
    );
    await expect(service.listModelCatalog(context, endpointId)).resolves.toMatchObject({
      status: { status: "degraded", diagnostic_reason: "interrupted" },
    });

    await database.query(
      `UPDATE provider_model_catalog_entry SET metadata_json = '{"id":"tampered"}'
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id;`,
      { organization_id: context.organizationId, endpoint_id: endpointId },
    );
    await expect(service.listModelCatalog(context, endpointId)).rejects.toThrow("metadata 계보");
  });

  it("실행 profile이 없는 stale 관측은 endpoint마다 최근 1000개로 제한한다", async () => {
    const oldIds = Array.from({ length: 1_205 }, (_value, index) => `old/model-${String(index).padStart(4, "0")}`);
    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse(...oldIds)),
    );
    await service.synchronizeModelCatalog(
      context,
      { commandId: crypto.randomUUID(), endpointId },
      vi.fn<typeof fetch>().mockResolvedValue(modelsResponse("current-model")),
    );

    const [counts] = await database.query<[{ readonly count: number; readonly state: string }[]]>(
      `SELECT state, count() FROM provider_model_catalog_entry
       WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id GROUP BY state ORDER BY state ASC;`,
      { organization_id: context.organizationId, endpoint_id: endpointId },
    );
    expect(counts).toEqual([
      { count: 1, state: "active" },
      { count: 1_000, state: "stale" },
    ]);
  });
});

function modelsResponse(...ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
