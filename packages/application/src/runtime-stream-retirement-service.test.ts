import { IdentityService } from "@massion/identity";
import { RUNTIME_EXECUTION_MIGRATION } from "@massion/runtime";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeStreamRetirementService } from "./runtime-stream-retirement.js";
import {
  APPLICATION_EVENT_MIGRATION,
  APPLICATION_OUTBOX_MIGRATION,
  APPLICATION_RUNTIME_STREAM_RETIREMENT_STATE_MIGRATION,
} from "./schema.js";

interface RuntimeEventRecord {
  readonly event_id: string;
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
}

describe("RuntimeStreamRetirementService", () => {
  let database: MassionDatabase;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await IdentityService.create(database);
    await database.query(
      "CREATE organization CONTENT { organization_id: 'organization-1', kind: 'personal', name: 'Retirement', created_at: time::now() };",
    );
    await applyMigrations(database, [
      RUNTIME_EXECUTION_MIGRATION,
      APPLICATION_OUTBOX_MIGRATION,
      APPLICATION_EVENT_MIGRATION,
      APPLICATION_RUNTIME_STREAM_RETIREMENT_STATE_MIGRATION,
    ]);
  });

  afterEach(async () => await database.close());

  async function createEvent(eventId: string, eventType = "model_text_delta", raw = true): Promise<void> {
    await database.query(
      `CREATE runtime_event CONTENT {
        event_id: $event_id,
        organization_id: 'organization-1',
        execution_id: 'execution-1',
        command_id: $command_id,
        sequence: $sequence,
        event_type: $event_type,
        request_json: $request_json,
        payload_json: $payload_json,
        result_json: $result_json,
        created_at: time::now()
      };`,
      {
        event_id: eventId,
        command_id: `command-${eventId}`,
        sequence: Number(eventId.replace(/\D/gu, "")) || 1,
        event_type: eventType,
        request_json: raw ? '{"secret":"request"}' : "{}",
        payload_json: raw ? '{"secret":"payload"}' : "{}",
        result_json: raw ? '{"secret":"result"}' : "{}",
      },
    );
  }

  async function events(): Promise<RuntimeEventRecord[]> {
    const [records] = await database.query<[RuntimeEventRecord[]]>(
      "SELECT event_id, event_type, request_json, payload_json, result_json FROM runtime_event ORDER BY event_id ASC;",
    );
    return records;
  }

  async function pendingRawOutboxSourceIds(): Promise<string[]> {
    const [records] = await database.query<[{ source_id: string }[]]>(
      "SELECT source_id FROM application_outbox WHERE organization_id = 'organization-1' AND source_kind = 'runtime-event' AND state = 'pending' ORDER BY source_id ASC;",
    );
    return records.map((record) => record.source_id);
  }

  it("idempotent bounded batches는 raw model event만 tombstone한다", async () => {
    await createEvent("event-1");
    await createEvent("event-2");
    await createEvent("event-3");
    await createEvent("event-4", "execution_succeeded");
    await createEvent("event-5", "model_already_empty", false);

    const service = new RuntimeStreamRetirementService(database, { batchSize: 2 });
    await expect(service.retireNextBatch()).resolves.toBe(2);
    await expect(service.retireNextBatch()).resolves.toBe(1);
    await expect(service.retireNextBatch()).resolves.toBe(0);
    await expect(service.retireNextBatch()).resolves.toBe(1);
    await expect(service.retireNextBatch()).resolves.toBe(0);

    expect(await events()).toEqual([
      {
        event_id: "event-1",
        event_type: "model_text_delta",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
      {
        event_id: "event-2",
        event_type: "model_text_delta",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
      {
        event_id: "event-3",
        event_type: "model_text_delta",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
      {
        event_id: "event-4",
        event_type: "execution_succeeded",
        request_json: '{"secret":"request"}',
        payload_json: '{"secret":"payload"}',
        result_json: '{"secret":"result"}',
      },
      {
        event_id: "event-5",
        event_type: "model_already_empty",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
    ]);
    await service.close();
  });

  it("이미 tombstone된 pending raw outbox도 bounded repair로 제거한다", async () => {
    await createEvent("event-tombstoned-pending", "model_text_delta", false);
    const service = new RuntimeStreamRetirementService(database, { batchSize: 1 });

    await expect(service.retireNextBatch()).resolves.toBe(0);
    await expect(service.retireNextBatch()).resolves.toBe(0);
    await expect(service.retireNextBatch()).resolves.toBe(1);
    expect(await pendingRawOutboxSourceIds()).toEqual([]);
    await expect(service.retireNextBatch()).resolves.toBe(0);
    await service.close();
  });

  it("완료 checkpoint가 있으면 legacy scan을 다시 시작하지 않는다", async () => {
    await database.query(
      `UPSERT application_runtime_stream_retirement_state:volatile_model_stream_v1 SET
        raw_cursor = '', phase = 'raw', repair_organization_after = '', repair_organization_id = NONE,
        repair_source_after = '', completed_at = time::now() RETURN NONE;`,
    );
    const transaction = vi.spyOn(database, "transaction");
    const service = new RuntimeStreamRetirementService(database);

    await expect(service.retireNextBatch()).resolves.toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    await service.close();
  });

  it("checkpoint cursor는 재시작 뒤 이미 처리한 raw event를 건너뛴다", async () => {
    await createEvent("event-1");
    await createEvent("event-2");
    const first = new RuntimeStreamRetirementService(database, { batchSize: 1 });

    await expect(first.retireNextBatch()).resolves.toBe(1);
    await first.close();
    const [checkpoint] = await database.query<
      [{ readonly raw_cursor: string; readonly phase: string; readonly completed_at?: unknown }[]]
    >(
      "SELECT raw_cursor, phase, completed_at FROM application_runtime_stream_retirement_state:volatile_model_stream_v1;",
    );
    expect(checkpoint).toEqual([{ raw_cursor: "event-1", phase: "raw", completed_at: undefined }]);

    const resumed = new RuntimeStreamRetirementService(database, { batchSize: 1 });
    await expect(resumed.retireNextBatch()).resolves.toBe(1);
    expect((await events()).map((event) => event.payload_json)).toEqual(["{}", "{}"]);
    await resumed.close();
  });

  it("transaction 재시도 안에서는 raw phase 완료를 앞당기지 않는다", async () => {
    const query = vi.fn(async (statement: string, _bindings?: Record<string, unknown>) => {
      void _bindings;
      if (statement.includes("ORDER BY event_id ASC") || statement.includes("FROM organization")) return [[]];
      if (statement.includes("UPSERT application_runtime_stream_retirement_state")) return [[]];
      throw new Error("예상하지 않은 retirement query입니다");
    });
    const transaction = vi.fn<MassionDatabase["transaction"]>().mockImplementation(async (operation) => {
      await operation({ query } as never);
      return await operation({ query } as never);
    });
    const service = new RuntimeStreamRetirementService({
      query: vi.fn().mockResolvedValue([[]]),
      transaction,
    } as unknown as MassionDatabase);

    await expect(service.retireNextBatch()).resolves.toBe(0);
    expect(query.mock.calls.filter(([statement]) => statement.includes("ORDER BY event_id ASC")).length).toBe(2);
    await service.close();
  });

  it("outbox 정합화와 JSON tombstone은 한 transaction으로 rollback한다", async () => {
    await createEvent("event-rollback");
    await database.query(
      `DEFINE EVENT runtime_stream_retirement_rollback ON runtime_event
      WHEN $event = 'UPDATE' AND $after.event_id = 'event-rollback'
      THEN { THROW 'runtime retirement rollback injection'; };`,
    );
    const service = new RuntimeStreamRetirementService(database, { batchSize: 1 });

    await expect(service.retireNextBatch()).rejects.toThrow("runtime retirement rollback injection");

    expect(await events()).toEqual([
      {
        event_id: "event-rollback",
        event_type: "model_text_delta",
        request_json: '{"secret":"request"}',
        payload_json: '{"secret":"payload"}',
        result_json: '{"secret":"result"}',
      },
    ]);
    const [outboxes] = await database.query<[{ state: string; public_event_id?: string }[]]>(
      "SELECT state, public_event_id FROM application_outbox WHERE organization_id = 'organization-1' AND source_kind = 'runtime-event' AND source_id = 'event-rollback';",
    );
    expect(outboxes).toEqual([{ state: "pending", public_event_id: undefined }]);
    await service.close();
  });

  it("공개 event 없는 pending raw outbox 묶음은 같이 제거한다", async () => {
    await createEvent("event-101");
    await createEvent("event-102");
    const service = new RuntimeStreamRetirementService(database, { batchSize: 2 });

    await expect(service.retireNextBatch()).resolves.toBe(2);

    expect(await pendingRawOutboxSourceIds()).toEqual([]);
    expect(await events()).toEqual([
      {
        event_id: "event-101",
        event_type: "model_text_delta",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
      {
        event_id: "event-102",
        event_type: "model_text_delta",
        request_json: "{}",
        payload_json: "{}",
        result_json: "{}",
      },
    ]);
    await service.close();
  });

  it("raw scan은 고정 event page를 먼저 읽고 raw source만 composite outbox index로 정합화한다", async () => {
    const events = [
      {
        organization_id: "organization-a",
        event_id: "event-a",
        event_type: "execution_succeeded",
        request_json: '{"secret":"request"}',
        payload_json: '{"secret":"payload"}',
        result_json: '{"secret":"result"}',
      },
      {
        organization_id: "organization-b",
        event_id: "event-b",
        event_type: "model_text_delta",
        request_json: '{"secret":"request"}',
        payload_json: '{"secret":"payload"}',
        result_json: '{"secret":"result"}',
      },
    ];
    const query = vi.fn().mockResolvedValueOnce([events]).mockResolvedValue([[]]);
    const transaction = vi
      .fn<MassionDatabase["transaction"]>()
      .mockImplementation(async (operation) => await operation({ query } as never));
    const service = new RuntimeStreamRetirementService(
      { transaction, query: vi.fn().mockResolvedValue([[]]) } as unknown as MassionDatabase,
      { batchSize: 2 },
    );

    await expect(service.retireNextBatch()).resolves.toBe(1);

    const scanned = query.mock.calls[0];
    if (!scanned) throw new Error("raw event page query가 필요합니다");
    expect(scanned[0]).toContain("WITH INDEX runtime_event_id");
    expect(scanned[0]).toContain("event_id > $cursor");
    expect(scanned[0]).not.toContain("string::starts_with");
    expect(scanned[0]).not.toContain("request_json !=");
    const reconciliation = query.mock.calls[1];
    if (!reconciliation) throw new Error("outbox reconciliation query가 필요합니다");
    expect(reconciliation[0]).toContain("WITH INDEX application_outbox_source");
    expect(reconciliation[0]).toContain(
      "organization_id = $organization_0 AND source_kind = 'runtime-event' AND source_id = $source_id_0",
    );
    expect(reconciliation[1]).toMatchObject({
      organization_0: "organization-b",
      source_id_0: "event-b",
    });
    await service.close();
  });

  it("repair는 indexed source page를 읽고 pending raw만 local filtering으로 정리한다", async () => {
    const query = vi.fn(async (statement: string, _bindings?: Record<string, unknown>) => {
      void _bindings;
      if (statement.includes("FROM organization")) return [[{ organization_id: "organization-1" }]];
      if (statement.includes("AND source_id > $source_after"))
        return [
          [
            { organization_id: "organization-1", source_id: "event-projected", state: "projected" },
            { organization_id: "organization-1", source_id: "event-raw", state: "pending" },
          ],
        ];
      if (statement.includes("FROM runtime_event"))
        return [
          [
            {
              organization_id: "organization-1",
              event_id: "event-raw",
              event_type: "model_text_delta",
              request_json: "{}",
              payload_json: "{}",
              result_json: "{}",
            },
          ],
        ];
      if (
        statement.includes("LET $pending") ||
        statement.includes("UPSERT application_runtime_stream_retirement_state")
      )
        return [[]];
      throw new Error("예상하지 않은 repair query입니다");
    });
    const transaction = vi
      .fn<MassionDatabase["transaction"]>()
      .mockImplementation(async (operation) => await operation({ query } as never));
    const service = new RuntimeStreamRetirementService(
      {
        query: vi.fn().mockResolvedValue([
          [
            {
              raw_cursor: "",
              phase: "repair",
              repair_organization_after: "",
              repair_organization_id: undefined,
              repair_source_after: "",
            },
          ],
        ]),
        transaction,
      } as unknown as MassionDatabase,
      { batchSize: 2 },
    );

    await expect(service.retireNextBatch()).resolves.toBe(1);

    const page = query.mock.calls.find(([statement]) => statement.includes("AND source_id > $source_after"));
    if (!page) throw new Error("repair outbox page query가 필요합니다");
    expect(page[0]).toContain("WITH INDEX application_outbox_source");
    expect(page[0]).not.toContain("AND state = 'pending'");
    const reconciliation = query.mock.calls.find(([statement]) => statement.includes("LET $pending"));
    if (!reconciliation) throw new Error("repair raw reconciliation query가 필요합니다");
    expect(reconciliation[1]).toMatchObject({ organization_0: "organization-1", source_id_0: "event-raw" });
    await service.close();
  });

  it("start는 즉시 반환하고 완료를 한 번만 보고한다", async () => {
    await createEvent("event-1");
    await createEvent("event-2");
    const onComplete = vi.fn();
    const service = new RuntimeStreamRetirementService(database, { batchSize: 1, pauseMs: 0, onComplete });

    expect(service.start()).toBeUndefined();
    expect(onComplete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledWith(2);
    const [checkpoint] = await database.query<[{ readonly completed_at: unknown }[]]>(
      "SELECT completed_at FROM application_runtime_stream_retirement_state:volatile_model_stream_v1;",
    );
    expect(checkpoint).toHaveLength(1);
    service.start();
    await Promise.resolve();
    expect(onComplete).toHaveBeenCalledOnce();
    await service.close();
  });

  it("실패는 bounded backoff 뒤 retry하고 close 뒤에는 늦은 batch를 만들지 않는다", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const transaction = vi
      .fn<MassionDatabase["transaction"]>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ processed: 1, retired: 1, more: true, cursor: "event-1" })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(
        async () =>
          await new Promise<{
            readonly processed: number;
            readonly retired: number;
            readonly more: boolean;
            readonly cursor: string;
          }>((resolve) => {
            release = () => resolve({ processed: 1, retired: 1, more: true, cursor: "event-2" });
          }),
      );
    const onFailure = vi.fn();
    const fakeDatabase = { transaction, query: vi.fn().mockResolvedValue([[]]) } as unknown as MassionDatabase;
    const retrying = new RuntimeStreamRetirementService(fakeDatabase, { pauseMs: 1, onFailure });

    try {
      retrying.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailure).toHaveBeenCalledOnce();
      expect(transaction).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(999);
      expect(transaction).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(transaction).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(transaction).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(999);
      expect(transaction).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledTimes(4);

      const closing = retrying.close();
      release?.();
      await closing;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(transaction).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("동시에 요청해도 active batch는 하나만 둔다", async () => {
    let release!: () => void;
    const transaction = vi.fn<MassionDatabase["transaction"]>().mockImplementation(
      async () =>
        await new Promise<{
          readonly processed: number;
          readonly retired: number;
          readonly more: boolean;
          readonly cursor: string;
        }>((resolve) => {
          release = () => resolve({ processed: 1, retired: 1, more: true, cursor: "event-1" });
        }),
    );
    const service = new RuntimeStreamRetirementService({
      transaction,
      query: vi.fn().mockResolvedValue([[]]),
    } as unknown as MassionDatabase);
    const first = service.retireNextBatch();
    const second = service.retireNextBatch();
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    await service.close();
  });

  it("batch size와 pause는 허용 범위를 검증한다", async () => {
    for (const batchSize of [0, 1_001, 1.5, Number.NaN]) {
      expect(() => new RuntimeStreamRetirementService(database, { batchSize })).toThrow();
    }
    for (const pauseMs of [-1, 60_001, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new RuntimeStreamRetirementService(database, { pauseMs })).toThrow();
    }
    expect(() => new RuntimeStreamRetirementService(database, { batchSize: 1, pauseMs: 0 })).not.toThrow();
    expect(() => new RuntimeStreamRetirementService(database, { batchSize: 1_000, pauseMs: 60_000 })).not.toThrow();
  });
});
