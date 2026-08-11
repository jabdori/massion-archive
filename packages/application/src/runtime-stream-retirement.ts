import type { MassionDatabase, QueryExecutor } from "@massion/storage";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PAUSE_MS = 1_000;
const MAX_BATCH_SIZE = 1_000;
const MAX_PAUSE_MS = 60_000;
const MINIMUM_FAILURE_PAUSE_MS = 1_000;

interface RawRuntimeEvent {
  readonly organization_id: string;
  readonly event_id: string;
}

interface RuntimeEventRecord extends RawRuntimeEvent {
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
}

interface PendingRuntimeOutbox {
  readonly organization_id: string;
  readonly source_id: string;
  readonly state: string;
}

interface RepairCursor {
  readonly organizationAfter: string;
  readonly organizationId?: string;
  readonly sourceAfter: string;
}

interface RetirementStateRecord {
  readonly raw_cursor: string;
  readonly phase: "raw" | "repair";
  readonly repair_organization_after: string;
  readonly repair_organization_id?: string;
  readonly repair_source_after: string;
  readonly completed_at?: unknown;
}

interface RetirementBatch {
  /** 이번 batch가 cursor를 전진시키며 검사한 event 수입니다. */
  readonly processed: number;
  /** 이번 batch에서 raw payload를 tombstone하거나 stale raw outbox를 정리한 수입니다. */
  readonly retired: number;
  /** 다음 batch가 필요한지 나타냅니다. */
  readonly more: boolean;
  readonly cursor?: string;
  readonly rawPhaseCompleted?: true;
  readonly repairCursor?: RepairCursor;
}

const RAW_EVENT_BATCH_QUERY = `
SELECT organization_id, event_id, event_type, request_json, payload_json, result_json
FROM runtime_event WITH INDEX runtime_event_id
WHERE event_id > $cursor
ORDER BY event_id ASC
LIMIT $limit;
`;

const NEXT_ORGANIZATION_QUERY = `
SELECT organization_id FROM organization WITH INDEX organization_id
WHERE organization_id > $organization_after
ORDER BY organization_id ASC
LIMIT 1;
`;

const PENDING_RUNTIME_OUTBOX_PAGE_QUERY = `
SELECT organization_id, source_id, state FROM application_outbox WITH INDEX application_outbox_source
WHERE organization_id = $organization_id
  AND source_kind = 'runtime-event'
  AND source_id > $source_after
ORDER BY source_id ASC
LIMIT $limit;
`;

const RETIREMENT_STATE_QUERY = `
SELECT raw_cursor, phase, repair_organization_after, repair_organization_id, repair_source_after, completed_at
FROM application_runtime_stream_retirement_state:volatile_model_stream_v1;
`;

const RETIREMENT_PROGRESS_QUERY = `
UPSERT application_runtime_stream_retirement_state:volatile_model_stream_v1
SET raw_cursor = $raw_cursor,
    phase = $phase,
    repair_organization_after = $repair_organization_after,
    repair_organization_id = $repair_organization_id,
    repair_source_after = $repair_source_after,
    completed_at = NONE
RETURN NONE;
`;

const COMPLETE_RETIREMENT_QUERY = `
UPSERT application_runtime_stream_retirement_state:volatile_model_stream_v1
SET raw_cursor = $raw_cursor,
    phase = $phase,
    repair_organization_after = $repair_organization_after,
    repair_organization_id = $repair_organization_id,
    repair_source_after = $repair_source_after,
    completed_at = time::now()
RETURN NONE;
`;

const RUNTIME_EVENT_DETAILS_QUERY = `
SELECT organization_id, event_id, event_type, request_json, payload_json, result_json
FROM runtime_event WITH INDEX runtime_event_id
WHERE event_id IN $event_ids;
`;

const TOMBSTONE_BATCH_QUERY = `
UPDATE (SELECT id FROM runtime_event
  WITH INDEX runtime_event_id
  WHERE event_id IN $event_ids
    AND (request_json != '{}' OR payload_json != '{}' OR result_json != '{}'))
SET request_json = '{}', payload_json = '{}', result_json = '{}'
RETURN NONE;
`;

function pendingRawOutboxQuery(events: readonly RawRuntimeEvent[]): {
  readonly query: string;
  readonly bindings: Record<string, string>;
} {
  if (events.length === 0) throw new Error("Runtime stream retirement batch가 비어 있습니다");
  const bindings: Record<string, string> = {};
  const sources = events.map((event, index) => {
    const organization = `organization_${String(index)}`;
    const source = `source_id_${String(index)}`;
    bindings[organization] = event.organization_id;
    bindings[source] = event.event_id;
    return `(organization_id = $${organization} AND source_kind = 'runtime-event' AND source_id = $${source})`;
  });
  return {
    query: `
LET $pending = SELECT organization_id, source_id FROM application_outbox WITH INDEX application_outbox_source
  WHERE (${sources.join(" OR ")})
    AND state = 'pending';
FOR $raw IN $pending {
  LET $public_events = SELECT event_id FROM application_event WITH INDEX application_event_source
    WHERE organization_id = $raw.organization_id
      AND source_kind = 'runtime-event'
      AND source_id = $raw.source_id
    LIMIT 1;
  IF array::len($public_events) = 1 {
    UPDATE (SELECT id FROM application_outbox WITH INDEX application_outbox_source
      WHERE organization_id = $raw.organization_id
        AND source_kind = 'runtime-event'
        AND source_id = $raw.source_id
        AND state = 'pending'
      LIMIT 1)
    SET state = 'projected', public_event_id = $public_events[0].event_id, updated_at = time::now()
    RETURN NONE;
  } ELSE {
    DELETE (SELECT id FROM application_outbox WITH INDEX application_outbox_source
      WHERE organization_id = $raw.organization_id
        AND source_kind = 'runtime-event'
        AND source_id = $raw.source_id
        AND state = 'pending'
      LIMIT 1)
    RETURN NONE;
  };
};
`,
    bindings,
  };
}

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
  private activeBatch: Promise<RetirementBatch> | undefined;
  private completion: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private completed = false;
  private retired = 0;
  private failurePauseMs = 0;
  private cursor = "";
  private repairCursor: RepairCursor = { organizationAfter: "", sourceAfter: "" };
  private rawPhaseComplete = false;
  private stateLoaded = false;

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
    return (await this.executeNextBatch()).retired;
  }

  private async executeNextBatch(): Promise<RetirementBatch> {
    if (this.closed || this.completed) return { processed: 0, retired: 0, more: false };
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

  private async runBatch(): Promise<RetirementBatch> {
    if (!this.stateLoaded) {
      const [states] = await this.database.query<[RetirementStateRecord[]]>(RETIREMENT_STATE_QUERY);
      const state = states[0];
      this.stateLoaded = true;
      if (state?.completed_at !== undefined && state.completed_at !== null) {
        await this.complete();
        return { processed: 0, retired: 0, more: false };
      }
      if (state !== undefined) {
        this.cursor = state.raw_cursor;
        this.rawPhaseComplete = state.phase === "repair";
        this.repairCursor = {
          organizationAfter: state.repair_organization_after,
          ...(state.repair_organization_id === undefined ? {} : { organizationId: state.repair_organization_id }),
          sourceAfter: state.repair_source_after,
        };
      }
    }
    const batch = await this.database.transaction(async (transaction) => {
      const batch = await this.retireBatch(transaction);
      await this.persistCheckpoint(transaction, batch);
      return batch;
    });
    if (batch.cursor !== undefined) this.cursor = batch.cursor;
    if (batch.repairCursor !== undefined) this.repairCursor = batch.repairCursor;
    if (batch.rawPhaseCompleted) this.rawPhaseComplete = true;
    if (!batch.more) await this.complete();
    else this.retired += batch.retired;
    return batch;
  }

  private async retireBatch(transaction: QueryExecutor): Promise<RetirementBatch> {
    if (!this.rawPhaseComplete) {
      const [events] = await transaction.query<[RuntimeEventRecord[]]>(RAW_EVENT_BATCH_QUERY, {
        cursor: this.cursor,
        limit: this.batchSize,
      });
      if (events.length === 0) return { processed: 0, retired: 0, more: true, rawPhaseCompleted: true };
      const rawEvents = events.filter(
        (event) =>
          event.event_type.startsWith("model_") &&
          (event.request_json !== "{}" || event.payload_json !== "{}" || event.result_json !== "{}"),
      );
      if (rawEvents.length > 0) {
        const reconciliation = pendingRawOutboxQuery(rawEvents);
        await transaction.query(reconciliation.query, reconciliation.bindings);
        await transaction.query(TOMBSTONE_BATCH_QUERY, { event_ids: rawEvents.map((event) => event.event_id) });
      }
      const cursor = events.at(-1)?.event_id;
      return {
        processed: events.length,
        retired: rawEvents.length,
        more: true,
        ...(cursor === undefined ? {} : { cursor }),
        ...(events.length < this.batchSize ? { rawPhaseCompleted: true as const } : {}),
      };
    }
    return await this.reconcileTombstonedPendingOutboxes(transaction, this.repairCursor);
  }

  private async persistCheckpoint(transaction: QueryExecutor, batch: RetirementBatch): Promise<void> {
    const rawCursor = batch.cursor ?? this.cursor;
    const phase = batch.rawPhaseCompleted || this.rawPhaseComplete ? "repair" : "raw";
    const repairCursor = batch.repairCursor ?? this.repairCursor;
    await transaction.query(batch.more ? RETIREMENT_PROGRESS_QUERY : COMPLETE_RETIREMENT_QUERY, {
      raw_cursor: rawCursor,
      phase,
      repair_organization_after: repairCursor.organizationAfter,
      repair_organization_id: repairCursor.organizationId,
      repair_source_after: repairCursor.sourceAfter,
    });
  }

  private async reconcileTombstonedPendingOutboxes(
    transaction: QueryExecutor,
    cursor: RepairCursor,
  ): Promise<RetirementBatch> {
    let organizationId = cursor.organizationId;
    if (organizationId === undefined) {
      const [organizations] = await transaction.query<[{ readonly organization_id: string }[]]>(
        NEXT_ORGANIZATION_QUERY,
        {
          organization_after: cursor.organizationAfter,
        },
      );
      const organization = organizations[0];
      if (organization === undefined) return { processed: 0, retired: 0, more: false };
      organizationId = organization.organization_id;
    }
    const [outboxes] = await transaction.query<[PendingRuntimeOutbox[]]>(PENDING_RUNTIME_OUTBOX_PAGE_QUERY, {
      organization_id: organizationId,
      source_after: organizationId === cursor.organizationId ? cursor.sourceAfter : "",
      limit: this.batchSize,
    });
    if (outboxes.length === 0) {
      const [organizations] = await transaction.query<[{ readonly organization_id: string }[]]>(
        NEXT_ORGANIZATION_QUERY,
        {
          organization_after: organizationId,
        },
      );
      const nextOrganization = organizations[0];
      if (nextOrganization === undefined) return { processed: 0, retired: 0, more: false };
      return {
        processed: 1,
        retired: 0,
        more: true,
        repairCursor: {
          organizationAfter: organizationId,
          organizationId: nextOrganization.organization_id,
          sourceAfter: "",
        },
      };
    }
    const pendingOutboxes = outboxes.filter((outbox) => outbox.state === "pending");
    const [runtimeEvents] = await transaction.query<[RuntimeEventRecord[]]>(RUNTIME_EVENT_DETAILS_QUERY, {
      event_ids: pendingOutboxes.map((outbox) => outbox.source_id),
    });
    const rawEvents = runtimeEvents.filter(
      (event) =>
        event.organization_id === organizationId &&
        event.event_type.startsWith("model_") &&
        event.request_json === "{}" &&
        event.payload_json === "{}" &&
        event.result_json === "{}",
    );
    if (rawEvents.length > 0) {
      const reconciliation = pendingRawOutboxQuery(rawEvents);
      await transaction.query(reconciliation.query, reconciliation.bindings);
    }
    const sourceAfter = outboxes.at(-1)?.source_id;
    const repairCursor =
      sourceAfter === undefined || outboxes.length < this.batchSize
        ? { organizationAfter: organizationId, sourceAfter: "" }
        : { organizationAfter: cursor.organizationAfter, organizationId, sourceAfter };
    return {
      processed: outboxes.length,
      retired: rawEvents.length,
      more: true,
      repairCursor,
    };
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
      const batch = await this.executeNextBatch();
      this.failurePauseMs = 0;
      if (batch.more && this.shouldSchedule()) this.schedule(this.pauseMs);
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
