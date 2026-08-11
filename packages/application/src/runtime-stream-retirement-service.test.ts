import { RUNTIME_EXECUTION_MIGRATION } from "@massion/runtime";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeStreamRetirementService } from "./runtime-stream-retirement.js";
import { APPLICATION_EVENT_MIGRATION, APPLICATION_OUTBOX_MIGRATION } from "./schema.js";

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
    await applyMigrations(database, [
      RUNTIME_EXECUTION_MIGRATION,
      APPLICATION_OUTBOX_MIGRATION,
      APPLICATION_EVENT_MIGRATION,
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

  it("start는 즉시 반환하고 완료를 한 번만 보고한다", async () => {
    await createEvent("event-1");
    await createEvent("event-2");
    const onComplete = vi.fn();
    const service = new RuntimeStreamRetirementService(database, { batchSize: 1, pauseMs: 0, onComplete });

    expect(service.start()).toBeUndefined();
    expect(onComplete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledWith(2);
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
      .mockResolvedValueOnce({ count: 1, cursor: "event-1" })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(
        async () =>
          await new Promise<{ readonly count: number; readonly cursor: string }>((resolve) => {
            release = () => resolve({ count: 1, cursor: "event-2" });
          }),
      );
    const onFailure = vi.fn();
    const fakeDatabase = { transaction } as unknown as MassionDatabase;
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
        await new Promise<{ readonly count: number; readonly cursor: string }>((resolve) => {
          release = () => resolve({ count: 1, cursor: "event-1" });
        }),
    );
    const service = new RuntimeStreamRetirementService({ transaction } as unknown as MassionDatabase);
    const first = service.retireNextBatch();
    const second = service.retireNextBatch();
    expect(transaction).toHaveBeenCalledOnce();
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
