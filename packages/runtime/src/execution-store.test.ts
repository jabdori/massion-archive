import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";

import { runtimeExecutionResult, RuntimeExecutionStore } from "./execution-store.js";
import {
  RUNTIME_BLOCKED_TRANSITION_MIGRATION,
  RUNTIME_EXECUTION_MIGRATION,
  RUNTIME_PROMPT_LINEAGE_MIGRATION,
} from "./schema.js";

describe("Runtime Execution Store", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let identities: IdentityService;
  let organizations: OrganizationService;
  let store: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function createExecution(commandId = crypto.randomUUID()) {
    return await store.createExecution(context, {
      commandId,
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "delivery-coordination",
      modelRoute: "coding-balanced",
      correlationId: "correlation-1",
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      input: { objective: "implement" },
    });
  }

  it("queued 생성과 running·suspended·running·succeeded 전이를 단조 event로 원자 기록한다", async () => {
    const created = await createExecution();
    expect(created.execution.actor_user_id).toBe(context.userId);
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: { worker: "voltagent" },
    });
    const suspended = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 2,
      target: "suspended",
      payload: { reason: "approval" },
    });
    const resumed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 3,
      target: "running",
      payload: { resumed: true },
    });
    const completed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 4,
      target: "succeeded",
      payload: { output: "done" },
    });

    expect([
      created.execution.status,
      running.execution.status,
      suspended.execution.status,
      resumed.execution.status,
    ]).toEqual(["queued", "running", "suspended", "running"]);
    expect(completed.execution.status).toBe("succeeded");
    expect((await store.listEvents(context, created.execution.execution_id)).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("새 Runtime Execution은 생성 시점의 자율성 snapshot을 고정하고 replay에서는 유지한다", async () => {
    let snapshot: { readonly mode: "automatic" | "review" | "full-access"; readonly revision: number } = {
      mode: "full-access",
      revision: 9,
    };
    const lineageStore = await RuntimeExecutionStore.create(database, organizations, undefined, async () => snapshot);
    const input = {
      commandId: crypto.randomUUID(),
      workId: "work-lineage",
      taskId: "task-lineage",
      agentHandle: "delivery-coordination",
      modelRoute: "coding-balanced",
      correlationId: "correlation-lineage",
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      input: { objective: "lineage" },
    };
    const first = await lineageStore.createExecution(context, input);
    snapshot = { mode: "review", revision: 10 };
    const replay = await lineageStore.createExecution(context, input);
    const next = await lineageStore.createExecution(context, { ...input, commandId: crypto.randomUUID() });

    expect(first.execution).toMatchObject({ autonomy_mode: "full-access", autonomy_revision: 9 });
    expect(replay.execution).toMatchObject({ autonomy_mode: "full-access", autonomy_revision: 9 });
    expect(next.execution).toMatchObject({ autonomy_mode: "review", autonomy_revision: 10 });
  });

  it("잘못된 상태 전이와 stale version을 거부한다", async () => {
    const created = await createExecution();
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        executionId: created.execution.execution_id,
        expectedVersion: 1,
        target: "succeeded",
        payload: {},
      }),
    ).rejects.toThrow("허용되지 않는 Runtime 전이");
    await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        executionId: created.execution.execution_id,
        expectedVersion: 1,
        target: "cancelled",
        payload: {},
      }),
    ).rejects.toThrow("version");
  });

  it("deterministic command로 terminal Runtime 결과를 tenant 경계 안에서 복원한다", async () => {
    const commandId = "runtime-terminal-result-command";
    const created = await createExecution(commandId);
    const running = await store.transition(context, {
      commandId: `${commandId}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await store.transition(context, {
      commandId: `${commandId}:succeeded`,
      executionId: created.execution.execution_id,
      expectedVersion: running.execution.version,
      target: "succeeded",
      payload: { output: { plan: "persisted" } },
    });

    await expect(store.findResultByCommand(context, commandId)).resolves.toEqual({
      executionId: created.execution.execution_id,
      status: "succeeded",
      output: { plan: "persisted" },
    });
    await expect(store.findResultByCommand(context, "missing-command")).resolves.toBeUndefined();
  });

  it.each([
    ["quota", true, "8fcd84ad-68a7-4bb2-a149-61ef1d40e02c"],
    ["upstream", true, undefined],
    ["timeout", true, undefined],
    ["network", true, undefined],
    ["provider", true, undefined],
    ["authentication", false, undefined],
    ["policy", false, undefined],
    ["input", false, undefined],
    ["billing", false, undefined],
    ["output", false, undefined],
    ["unknown", false, undefined],
    ["cancelled", false, undefined],
    ["runtime", false, "ec71ec62-c446-4a6d-bccd-5154885ce86d"],
  ] as const)(
    "failed %s 오류의 retryable·causeId를 command replay에서 보존한다",
    async (category, retryable, causeId) => {
      const commandId = `runtime-failed-${category}-command`;
      const created = await createExecution(commandId);
      const running = await store.transition(context, {
        commandId: `${commandId}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: {},
      });
      await store.transition(context, {
        commandId: `${commandId}:failed`,
        executionId: created.execution.execution_id,
        expectedVersion: running.execution.version,
        target: "failed",
        payload: {
          category,
          retryable,
          ...(causeId === undefined ? {} : { causeId }),
        },
      });

      await expect(store.findResultByCommand(context, commandId)).resolves.toEqual({
        executionId: created.execution.execution_id,
        status: "failed",
        error: {
          category,
          retryable,
          userMessage: "Agent 실행이 종료됐습니다",
          ...(causeId === undefined ? {} : { causeId }),
        },
      });
    },
  );

  it.each([
    ["malformed", "provider-secret-token"],
    ["legacy", JSON.stringify({ message: "provider-secret-token" })],
    ["missing", undefined],
    ["unknown-category", JSON.stringify({ category: "provider-secret-token", retryable: true })],
    ["invalid-combination", JSON.stringify({ category: "quota", retryable: false })],
    ["invalid-provider-combination", JSON.stringify({ category: "provider", retryable: false })],
    ["extra-field", JSON.stringify({ category: "quota", retryable: true, message: "provider-secret-token" })],
  ] as const)("%s failed 오류 계보는 원문을 노출하지 않는 non-retryable 결과로 복원한다", async (kind, errorJson) => {
    const commandId = `runtime-${kind}-error-command`;
    const created = await createExecution(commandId);
    const running = await store.transition(context, {
      commandId: `${commandId}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
    await store.transition(context, {
      commandId: `${commandId}:failed`,
      executionId: created.execution.execution_id,
      expectedVersion: running.execution.version,
      target: "failed",
      payload: {},
    });
    await database.query(
      errorJson === undefined
        ? "UPDATE runtime_execution SET error_json = NONE WHERE organization_id = $organization_id AND execution_id = $execution_id;"
        : "UPDATE runtime_execution SET error_json = $error_json WHERE organization_id = $organization_id AND execution_id = $execution_id;",
      {
        organization_id: context.organizationId,
        execution_id: created.execution.execution_id,
        error_json: errorJson,
      },
    );

    const replayed = await store.findResultByCommand(context, commandId);
    expect(replayed).toEqual({
      executionId: created.execution.execution_id,
      status: "failed",
      error: { category: "runtime", retryable: false, userMessage: "Agent 실행이 종료됐습니다" },
    });
    expect(JSON.stringify(replayed)).not.toContain("provider-secret-token");
  });

  it.each(["provider-secret-token", "a".repeat(64)])(
    "임의 causeId %s는 제거하고 검증된 오류 분류만 보존한다",
    async (causeId) => {
      const commandId = "runtime-arbitrary-cause-command";
      const created = await createExecution(commandId);
      const running = await store.transition(context, {
        commandId: `${commandId}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: {},
      });
      await store.transition(context, {
        commandId: `${commandId}:failed`,
        executionId: created.execution.execution_id,
        expectedVersion: running.execution.version,
        target: "failed",
        payload: { category: "quota", retryable: true, causeId },
      });

      const replayed = await store.findResultByCommand(context, commandId);
      expect(replayed).toEqual({
        executionId: created.execution.execution_id,
        status: "failed",
        error: { category: "quota", retryable: true, userMessage: "Agent 실행이 종료됐습니다" },
      });
      expect(JSON.stringify(replayed)).not.toContain(causeId);
    },
  );

  it("blocked 결과는 기존 generic runtime 오류 형태를 보존한다", async () => {
    const created = await createExecution("runtime-blocked-shape-command");
    const blocked = await store.transition(context, {
      commandId: "runtime-blocked-shape-terminal",
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "blocked_model_unavailable",
      payload: { category: "quota", retryable: true },
    });
    expect(runtimeExecutionResult(blocked.execution)).toEqual({
      executionId: created.execution.execution_id,
      status: "blocked_model_unavailable",
      error: { category: "runtime", retryable: false, userMessage: "Agent 실행에 실패했습니다" },
    });

    for (const target of ["failed", "interrupted"] as const) {
      const state = await createExecution(`runtime-${target}-shape-command`);
      const running = await store.transition(context, {
        commandId: `runtime-${target}-shape-running`,
        executionId: state.execution.execution_id,
        expectedVersion: state.execution.version,
        target: "running",
        payload: {},
      });
      const terminal = await store.transition(context, {
        commandId: `runtime-${target}-shape-terminal`,
        executionId: state.execution.execution_id,
        expectedVersion: running.execution.version,
        target,
        payload: { category: "network", retryable: true },
      });
      expect(runtimeExecutionResult(terminal.execution)).toMatchObject({
        status: target,
        error: { category: "network", retryable: true },
      });
    }

    for (const status of ["succeeded", "cancelled", "suspended"] as const) {
      expect(
        runtimeExecutionResult({
          ...created.execution,
          status,
          error_json: JSON.stringify({ category: "network", retryable: true }),
        }),
      ).not.toHaveProperty("error");
    }
  });

  it("malformed output_json은 원문 없이 생략하고 failed 오류 fallback은 유지한다", async () => {
    const secret = "provider-output-secret";
    for (const status of ["succeeded", "failed"] as const) {
      const commandId = `runtime-malformed-output-${status}`;
      const created = await createExecution(commandId);
      const running = await store.transition(context, {
        commandId: `${commandId}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: {},
      });
      await store.transition(context, {
        commandId: `${commandId}:terminal`,
        executionId: created.execution.execution_id,
        expectedVersion: running.execution.version,
        target: status,
        payload: status === "succeeded" ? { output: "safe" } : {},
      });
      await database.query(
        "UPDATE runtime_execution SET output_json = $output_json WHERE organization_id = $organization_id AND execution_id = $execution_id;",
        {
          organization_id: context.organizationId,
          execution_id: created.execution.execution_id,
          output_json: secret,
        },
      );

      const replayed = await store.findResultByCommand(context, commandId);
      expect(replayed).toMatchObject({ executionId: created.execution.execution_id, status });
      expect(replayed).not.toHaveProperty("output");
      if (status === "failed") {
        expect(replayed).toMatchObject({
          error: { category: "runtime", retryable: false, userMessage: "Agent 실행이 종료됐습니다" },
        });
      }
      expect(JSON.stringify(replayed)).not.toContain(secret);
    }
  });

  it("직접 DB 우회와 같은 version의 동시 전이 중 하나를 거부한다", async () => {
    const direct = await createExecution();
    await expect(
      database.query("UPDATE runtime_execution SET status = 'succeeded' WHERE execution_id = $execution_id;", {
        execution_id: direct.execution.execution_id,
      }),
    ).rejects.toThrow("허용되지 않는 Runtime 전이");
    expect((await store.getRecovery(context, direct.execution.execution_id)).execution.status).toBe("queued");

    const concurrent = await createExecution();
    const results = await Promise.allSettled(
      ["running", "cancelled"].map((target) =>
        store.transition(context, {
          commandId: crypto.randomUUID(),
          executionId: concurrent.execution.execution_id,
          expectedVersion: 1,
          target: target as "running" | "cancelled",
          payload: {},
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("같은 command와 요청은 멱등이고 다른 요청은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await createExecution(commandId);
    const repeated = await createExecution(commandId);
    expect(repeated.execution.execution_id).toBe(first.execution.execution_id);
    await expect(
      store.createExecution(context, {
        commandId,
        workId: "different",
        agentHandle: "representative",
        modelRoute: "planning-quality",
        correlationId: "different",
        estimatedTokens: 1,
        estimatedCostMicros: 1,
        input: {},
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("같은 실행 상관관계(correlation)의 현재 사용자 Execution만 생성 순서로 찾는다", async () => {
    const first = await createExecution("correlation-command-1");
    const second = await createExecution("correlation-command-2");

    await expect(store.listByCorrelation(context, "correlation-1")).resolves.toEqual([
      expect.objectContaining({ execution_id: first.execution.execution_id, actor_user_id: context.userId }),
      expect.objectContaining({ execution_id: second.execution.execution_id, actor_user_id: context.userId }),
    ]);
    await expect(store.listByCorrelation(context, "missing-correlation")).resolves.toEqual([]);
    await expect(store.listByCorrelation(context, " \n")).rejects.toThrow("상관관계");
  });

  it("owner가 자율성 mode·revision으로 조직의 활성 실행을 조회하고 member 접근은 거부한다", async () => {
    const lineageStore = await RuntimeExecutionStore.create(
      database,
      await OrganizationService.create(database),
      undefined,
      async () => ({
        mode: "full-access",
        revision: 2,
      }),
    );
    const created = await lineageStore.createExecution(context, {
      commandId: "autonomy-active-list-command",
      workId: "autonomy-active-list-work",
      agentHandle: "representative",
      modelRoute: "coding-balanced",
      correlationId: "autonomy-active-list-correlation",
      estimatedTokens: 1,
      estimatedCostMicros: 1,
      input: { text: "active" },
    });
    await lineageStore.transition(context, {
      commandId: "autonomy-active-list-running",
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });

    await expect(lineageStore.listActiveByAutonomy(context, { mode: "full-access", revision: 2 })).resolves.toEqual([
      expect.objectContaining({ execution_id: created.execution.execution_id, autonomy_revision: 2 }),
    ]);
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({
      email: "autonomy-active-member@example.com",
      displayName: "Member",
    });
    await organizations.addMember(context, other.user.user_id, "member");
    const otherContext = await organizations.resolveTenantContext(other.user.user_id, context.organizationId);
    await expect(lineageStore.listActiveByAutonomy(otherContext, { mode: "full-access", revision: 2 })).rejects.toThrow(
      "권한",
    );
  });

  it("workflow binding과 recovery snapshot을 저장하고 tenant 위조를 거부한다", async () => {
    const created = await createExecution();
    await store.bindWorkflow(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      workflowId: "task-workflow",
      workflowExecutionId: "wf-1",
    });
    const recovered = await store.getRecovery(context, created.execution.execution_id);
    expect(recovered.binding?.workflow_execution_id).toBe("wf-1");
    expect(recovered.events).toHaveLength(2);

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(
      store.getRecovery({ ...otherContext, organizationId: context.organizationId }, created.execution.execution_id),
    ).rejects.toThrow("TenantContext");
  });

  it("같은 조직의 다른 사용자에게 실행·event·복구 후보를 노출하지 않는다", async () => {
    const team = await organizations.createTeam(context.userId, "Runtime Team");
    const ownerContext = await organizations.resolveTenantContext(context.userId, team.organization.organization_id);
    const member = await identities.registerPersonalUser({ email: "member@example.com", displayName: "Member" });
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(
      member.user.user_id,
      team.organization.organization_id,
    );
    const created = await store.createExecution(ownerContext, {
      commandId: "owner-command",
      workId: "team-work",
      agentHandle: "delivery-coordination",
      modelRoute: "coding-balanced",
      correlationId: "team-correlation",
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      input: { objective: "private subscription execution" },
    });
    await store.transition(ownerContext, {
      commandId: "owner-running",
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });

    await expect(store.getRecovery(memberContext, created.execution.execution_id)).rejects.toThrow("Runtime Execution");
    await expect(store.listEvents(memberContext, created.execution.execution_id)).rejects.toThrow("Runtime Execution");
    await expect(
      store.transition(memberContext, {
        commandId: "member-transition",
        executionId: created.execution.execution_id,
        expectedVersion: 2,
        target: "suspended",
        payload: {},
      }),
    ).rejects.toThrow("Runtime Execution");
    await expect(store.listRecoverable(memberContext)).resolves.toEqual([]);
    await expect(store.listByCorrelation(memberContext, "team-correlation")).resolves.toEqual([]);
    await expect(store.findExecutionIdByCommand(memberContext, "owner-command")).resolves.toBeUndefined();
    await expect(store.findResultByCommand(memberContext, "owner-command")).resolves.toBeUndefined();
    await expect(
      store.createExecution(memberContext, {
        commandId: "owner-command",
        workId: "team-work",
        agentHandle: "delivery-coordination",
        modelRoute: "coding-balanced",
        correlationId: "team-correlation",
        estimatedTokens: 100,
        estimatedCostMicros: 100,
        input: { objective: "private subscription execution" },
      }),
    ).rejects.toThrow("행위자 계보");
  });

  it("행위자 계보 변경과 계보 없는 새 실행을 Database event로 거부한다", async () => {
    const created = await createExecution();

    await expect(
      database.query(
        "UPDATE runtime_execution SET actor_user_id = $actor_user_id WHERE execution_id = $execution_id;",
        { actor_user_id: crypto.randomUUID(), execution_id: created.execution.execution_id },
      ),
    ).rejects.toThrow("행위자 계보");
    await expect(
      database.query(
        `CREATE runtime_execution CONTENT {
          execution_id: $execution_id,
          organization_id: $organization_id,
          work_id: 'legacy-forbidden',
          agent_handle: 'delivery-coordination',
          model_route: 'coding-balanced',
          correlation_id: 'legacy-forbidden',
          input_json: '{}',
          status: 'running',
          version: 1,
          event_sequence: 1,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        { execution_id: crypto.randomUUID(), organization_id: context.organizationId },
      ),
    ).rejects.toThrow("행위자 계보");
  });

  it("0094 이전 실행은 추측 보정하지 않고 계보 없는 시작 복구 후보로 남긴다", async () => {
    const legacyDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    try {
      const legacyIdentities = await IdentityService.create(legacyDatabase);
      const legacyOrganizations = await OrganizationService.create(legacyDatabase);
      const owner = await legacyIdentities.registerPersonalUser({
        email: "legacy@example.com",
        displayName: "Legacy Owner",
      });
      await applyMigrations(legacyDatabase, [
        RUNTIME_EXECUTION_MIGRATION,
        RUNTIME_BLOCKED_TRANSITION_MIGRATION,
        RUNTIME_PROMPT_LINEAGE_MIGRATION,
      ]);
      await legacyDatabase.query(
        `CREATE runtime_execution CONTENT {
          execution_id: 'legacy-running',
          organization_id: $organization_id,
          work_id: 'legacy-work',
          agent_handle: 'delivery-coordination',
          model_route: 'coding-balanced',
          correlation_id: 'legacy-correlation',
          input_json: '{}',
          status: 'running',
          version: 1,
          event_sequence: 1,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        { organization_id: owner.organization.organization_id },
      );

      const upgraded = await RuntimeExecutionStore.create(legacyDatabase, legacyOrganizations);
      await expect(upgraded.listStartupRecoverable()).resolves.toEqual([
        {
          execution_id: "legacy-running",
          organization_id: owner.organization.organization_id,
          status: "running",
        },
      ]);
    } finally {
      await legacyDatabase.close();
    }
  });

  it("상태 변경 없이 stream event를 append하고 version·sequence를 함께 전진시킨다", async () => {
    const created = await createExecution();
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    const appended = await store.appendEvent(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: running.execution.version,
      eventType: "model_text_delta",
      payload: { delta: "hello" },
    });

    expect(appended.execution.status).toBe("running");
    expect(appended.execution.version).toBe(3);
    expect(appended.event.sequence).toBe(3);
    expect(JSON.parse(appended.event.payload_json)).toEqual({ delta: "hello" });
  });

  it("retired raw stream event는 물리 tombstone 전에도 replay를 거부한다", async () => {
    const created = await createExecution();
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    const input = {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: running.execution.version,
      eventType: "model_text_delta",
      payload: { delta: "private" },
    } as const;
    await store.appendEvent(context, input);

    await expect(store.appendEvent(context, input)).rejects.toThrow("retired raw Runtime Event");
    expect(await store.listEvents(context, created.execution.execution_id)).toHaveLength(3);
  });

  it("영속 저널 명령을 version 없이 동시 재생해도 사건 하나만 기록한다", async () => {
    const created = await createExecution();
    await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    const input = {
      commandId: `${created.execution.execution_id}:subscription:route-session-acquired`,
      executionId: created.execution.execution_id,
      eventType: "subscription_route_session_acquired" as const,
      payload: {
        executionId: created.execution.execution_id,
        workId: "work-1",
        agentHandle: "delivery-coordination",
        routeAttemptId: "attempt-1",
        leaseId: "lease-1",
        accountId: "account-1",
        connectorId: "connector-1",
        adapterId: "adapter-1",
      },
    };

    const [left, right] = await Promise.all([
      store.appendSubscriptionReceipt(context, input),
      store.appendSubscriptionReceipt(context, input),
    ]);
    const events = (await store.listEvents(context, created.execution.execution_id)).filter(
      (event) => event.event_type === "subscription_route_session_acquired",
    );

    expect(events).toHaveLength(1);
    expect(left.event.event_id).toBe(right.event.event_id);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(left.execution.version).toBe(3);
    expect(right.execution.version).toBe(3);

    await expect(
      store.appendSubscriptionReceipt(context, {
        ...input,
        payload: { ...input.payload, routeAttemptId: "attempt-2" },
      }),
    ).rejects.toThrow("같은 commandId");
  });
});
