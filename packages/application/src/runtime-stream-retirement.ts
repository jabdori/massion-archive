import type { MassionDatabase } from "@massion/storage";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PAUSE_MS = 50;
const MAX_BATCH_SIZE = 1_000;
const MAX_PAUSE_MS = 60_000;
const MINIMUM_FAILURE_PAUSE_MS = 1_000;

const RETIREMENT_QUERY = `
UPDATE (SELECT id FROM runtime_event
  WHERE string::starts_with(event_type, 'model_')
    AND (request_json != '{}' OR payload_json != '{}' OR result_json != '{}')
  LIMIT $limit)
SET request_json = '{}', payload_json = '{}', result_json = '{}'
RETURN VALUE event_id;
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

/** 과거 raw model event의 JSON만 작은 batch로 tombstone하는 수명주기 worker입니다. */
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
    const [eventIds] = await this.database.query<[unknown[]]>(RETIREMENT_QUERY, { limit: this.batchSize });
    const count = Array.isArray(eventIds) ? eventIds.length : 0;
    if (count === 0) await this.complete();
    else this.retired += count;
    return count;
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
