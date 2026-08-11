import type { MassionDatabase, QueryExecutor } from "@massion/storage";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PAUSE_MS = 50;
const MAX_BATCH_SIZE = 1_000;
const MAX_PAUSE_MS = 60_000;
const MINIMUM_FAILURE_PAUSE_MS = 1_000;

interface RawRuntimeEvent {
  readonly organization_id: string;
  readonly event_id: string;
}

interface RetirementBatch {
  readonly count: number;
  readonly cursor?: string;
}

const RAW_EVENT_BATCH_QUERY = `
SELECT organization_id, event_id FROM runtime_event WITH INDEX runtime_event_id
WHERE event_id > $cursor
  AND string::starts_with(event_type, 'model_')
  AND (request_json != '{}' OR payload_json != '{}' OR result_json != '{}')
ORDER BY event_id ASC
LIMIT $limit;
`;

const RECONCILE_AND_TOMBSTONE_BATCH_QUERY = `
FOR $raw IN $events {
  LET $public_events = SELECT event_id FROM application_event
    WHERE organization_id = $raw.organization_id
      AND source_kind = 'runtime-event'
      AND source_id = $raw.event_id
    LIMIT 1;
  IF array::len($public_events) = 1 {
    UPDATE (SELECT id FROM application_outbox
      WHERE organization_id = $raw.organization_id
        AND source_kind = 'runtime-event'
        AND source_id = $raw.event_id
        AND state = 'pending'
      LIMIT 1)
    SET state = 'projected', public_event_id = $public_events[0].event_id, updated_at = time::now()
    RETURN NONE;
  } ELSE {
    DELETE (SELECT id FROM application_outbox
      WHERE organization_id = $raw.organization_id
        AND source_kind = 'runtime-event'
        AND source_id = $raw.event_id
        AND state = 'pending'
      LIMIT 1)
    RETURN NONE;
  };
};
UPDATE (SELECT id FROM runtime_event
  WHERE event_id IN $event_ids
    AND (request_json != '{}' OR payload_json != '{}' OR result_json != '{}'))
SET request_json = '{}', payload_json = '{}', result_json = '{}'
RETURN NONE;
`;

export interface RuntimeStreamRetirementServiceOptions {
  readonly batchSize?: number;
  readonly pauseMs?: number;
  readonly onFailure?: (reason: unknown) => void | Promise<void>;
  readonly onComplete?: (retired: number) => void | Promise<void>;
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}은(는) ${String(minimum)} 이상 ${String(maximum)} 이하의 정수여야 합니다`);
  }
  return value;
}

/** 과거 raw model event의 pending outbox와 JSON을 작은 batch로 retire하는 수명주기 worker입니다. */
export class RuntimeStreamRetirementService {
  private readonly batchSize: number;
  private readonly pauseMs: number;
  private readonly onFailure: ((reason: unknown) => void | Promise<void>) | undefined;
  private readonly onComplete: ((retired: number) => void | Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeBatch: Promise<number> | undefined;
  private completion: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private completed = false;
  private retired = 0;
  private failurePauseMs = 0;
  private cursor = "";

  public constructor(
    private readonly database: MassionDatabase,
    options: RuntimeStreamRetirementServiceOptions = {},
  ) {
    this.batchSize = validateInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE,
      "Runtime retirement batch size",
    );
    this.pauseMs = validateInteger(options.pauseMs ?? DEFAULT_PAUSE_MS, 0, MAX_PAUSE_MS, "Runtime retirement pause");
    this.onFailure = options.onFailure;
    this.onComplete = options.onComplete;
  }

  /** HTTP가 listen한 뒤 호출하며, 실제 query는 다음 tick에서 실행합니다. */
  public start(): void {
    if (this.started || this.closed || this.completed) return;
    this.started = true;
    this.schedule(0);
  }

  /** 한 번에 한 batch만 실행하며, direct 호출은 다음 batch를 자동 예약하지 않습니다. */
  public async retireNextBatch(): Promise<number> {
    if (this.closed || this.completed) return 0;
    if (this.activeBatch) return await this.activeBatch;
    const batch = this.runBatch();
    this.activeBatch = batch;
    try {
      return await batch;
    } finally {
      if (this.activeBatch === batch) this.activeBatch = undefined;
    }
  }

  /** 새 query 예약을 막고 이미 실행 중인 query가 끝날 때까지 기다립니다. */
  public async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeBatch?.catch(() => undefined);
    await this.completion?.catch(() => undefined);
  }

  private async runBatch(): Promise<number> {
    const batch = await this.database.transaction(async (transaction) => await this.retireBatch(transaction));
    if (batch.cursor !== undefined) this.cursor = batch.cursor;
    if (batch.count === 0) await this.complete();
    else this.retired += batch.count;
    return batch.count;
  }

  private async retireBatch(transaction: QueryExecutor): Promise<RetirementBatch> {
    const [events] = await transaction.query<[RawRuntimeEvent[]]>(RAW_EVENT_BATCH_QUERY, {
      cursor: this.cursor,
      limit: this.batchSize,
    });
    if (events.length === 0) return { count: 0 };
    await transaction.query(RECONCILE_AND_TOMBSTONE_BATCH_QUERY, {
      events,
      event_ids: events.map((event) => event.event_id),
    });
    const cursor = events.at(-1)?.event_id;
    return { count: events.length, ...(cursor === undefined ? {} : { cursor }) };
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.completed || !this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledBatch();
    }, delayMs);
    this.timer.unref();
  }

  private async runScheduledBatch(): Promise<void> {
    if (this.closed || this.completed) return;
    try {
      const retired = await this.retireNextBatch();
      this.failurePauseMs = 0;
      if (retired > 0 && this.shouldSchedule()) this.schedule(this.pauseMs);
    } catch (reason) {
      await this.reportFailure(reason);
      if (this.shouldSchedule()) this.schedule(this.nextFailurePauseMs());
    }
  }

  private async complete(): Promise<void> {
    if (this.completed || this.closed) return;
    this.completed = true;
    this.completion = Promise.resolve()
      .then(async () => await this.onComplete?.(this.retired))
      .catch(() => undefined);
    await this.completion;
  }

  private async reportFailure(reason: unknown): Promise<void> {
    try {
      await this.onFailure?.(reason);
    } catch {
      // 오류 보고 자체의 실패는 다음 retry 예약을 막지 않습니다.
    }
  }

  private shouldSchedule(): boolean {
    return !this.closed && !this.completed && this.started;
  }

  private nextFailurePauseMs(): number {
    this.failurePauseMs =
      this.failurePauseMs === 0
        ? Math.max(this.pauseMs, MINIMUM_FAILURE_PAUSE_MS)
        : Math.min(MAX_PAUSE_MS, this.failurePauseMs * 2);
    return this.failurePauseMs;
  }
}
