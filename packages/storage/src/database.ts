import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, DateTime, isRetryableConflict, Surreal, type SurrealTransaction } from "surrealdb";

const SUPPORTED_PROTOCOLS = new Set(["mem:", "rocksdb:", "http:", "https:", "ws:", "wss:"]);
const LEGACY_CONFLICT_PREFIX = "Transaction conflict: Write conflict";
const ROLLBACK_TIMEOUT_MS = 1_000;

async function cancelBestEffort(transaction: SurrealTransaction): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(async () => {
        await transaction.cancel();
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ROLLBACK_TIMEOUT_MS);
        timer.unref();
      }),
    ]).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 서버의 WebSocket transactions map에서 transaction이 사라진 경우입니다. 그 시점에
 * commit된 것은 없으므로 새 transaction으로 다시 시도하는 것이 안전합니다. 재시도하지
 * 않으면 사용자에게는 아무 조작이나 무작위로 실패하는 것으로 보입니다.
 */
function isLostTransaction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^transaction(?:\s+[0-9a-fA-F-]+)?\s+not found/iu.test(message.trim());
}

function isCompatibleRetryableConflict(error: unknown): boolean {
  return (
    isRetryableConflict(error) ||
    isLostTransaction(error) ||
    (error instanceof Error &&
      error.message.startsWith(LEGACY_CONFLICT_PREFIX) &&
      error.message.endsWith("can be retried"))
  );
}

export function serializeSurrealDateTime(value: unknown): string | undefined {
  try {
    return DateTime.prototype.toISOString.call(value);
  } catch {
    return undefined;
  }
}

export interface DatabaseConfig {
  readonly url: string;
  readonly namespace: string;
  readonly database: string;
  readonly authentication?: {
    readonly username: string;
    readonly password: string;
    readonly scope?: "root" | "database";
  };
}

export interface QueryExecutor {
  query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R>;
}

export type MassionDatabaseLifecycleErrorCode =
  | "DATABASE_CLOSING"
  | "DATABASE_CLOSED"
  | "DATABASE_CLOSE_FAILED"
  | "DATABASE_TRANSACTION_REENTRANT"
  | "DATABASE_CLOSE_IN_TRANSACTION"
  | "DATABASE_TRANSACTION_SEALED";

export class MassionDatabaseLifecycleError extends Error {
  public override readonly name = "MassionDatabaseLifecycleError";

  public constructor(
    public readonly code: MassionDatabaseLifecycleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

class TransactionExecutor implements QueryExecutor {
  private tail: Promise<void> = Promise.resolve();
  private sealed = false;
  private failed = false;
  private failure: unknown;

  public constructor(private readonly transaction: SurrealTransaction) {}

  public query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    if (this.sealed) {
      return Promise.reject(
        new MassionDatabaseLifecycleError(
          "DATABASE_TRANSACTION_SEALED",
          "종료된 MassionDatabase transaction에는 query를 추가할 수 없습니다",
        ),
      );
    }
    const task = this.tail.then(async () => {
      if (this.failed) throw this.failure;
      try {
        return (await this.transaction.query(surql, bindings)) as R;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  public seal(): void {
    this.sealed = true;
  }

  public abort(error: unknown): void {
    this.sealed = true;
    this.fail(error);
  }

  public async drain(): Promise<void> {
    await this.tail;
    if (this.failed) throw this.failure;
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
  }
}

export class MassionDatabase implements QueryExecutor, AsyncDisposable {
  private readonly transactionScope = new AsyncLocalStorage<true>();
  private readonly activeClientOperations = new Set<Promise<unknown>>();
  private transactionTail: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly client: Surreal) {}

  public async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    return await this.runClientOperation(async () => (await this.client.query(surql, bindings)) as R);
  }

  public async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    if (this.transactionScope.getStore()) {
      throw new MassionDatabaseLifecycleError(
        "DATABASE_TRANSACTION_REENTRANT",
        "같은 MassionDatabase transaction에는 재귀적으로 진입할 수 없습니다",
      );
    }
    this.assertOpen();
    const previous = this.transactionTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.transactionTail = tail;
    await previous.catch(() => undefined);
    try {
      return await this.transactionScope.run(true, async () => await this.executeTransaction(operation));
    } finally {
      release();
      if (this.transactionTail === tail) this.transactionTail = Promise.resolve();
    }
  }

  private async executeTransaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const transaction = await this.client.beginTransaction();
      const executor = new TransactionExecutor(transaction);
      try {
        const result = await operation(executor);
        executor.seal();
        await executor.drain();
        await transaction.commit();
        return result;
      } catch (error) {
        executor.abort(error);
        // 서버가 이미 버린 transaction을 다시 cancel하면 같은 not-found 경고만 한 번 더 만듭니다.
        if (!isLostTransaction(error)) await cancelBestEffort(transaction);
        if (!isCompatibleRetryableConflict(error) || attempt >= 3) throw error;
        // 즉시 재시도하면 경쟁 상대의 다음 transaction과 계속 같은 시점에 충돌할 수 있습니다.
        await delay(2 ** attempt);
      }
    }
  }

  public async version(): Promise<string> {
    return await this.runClientOperation(async () => (await this.client.version()).version);
  }

  public async exportSql(): Promise<string> {
    return await this.runClientOperation(async () => await this.client.export());
  }

  public async importSql(sql: string): Promise<void> {
    await this.runClientOperation(async () => {
      await this.client.import(sql);
    });
  }

  public close(): Promise<void> {
    if (this.transactionScope.getStore()) {
      return Promise.reject(
        new MassionDatabaseLifecycleError(
          "DATABASE_CLOSE_IN_TRANSACTION",
          "활성 MassionDatabase transaction 안에서는 database를 닫을 수 없습니다",
        ),
      );
    }
    if (this.state === "closed") return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    const transactionDrain = this.transactionTail;
    const clientOperations = [...this.activeClientOperations];
    this.closePromise = this.closeAfterDrain(transactionDrain, clientOperations);
    return this.closePromise;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.state === "open") return;
    if (this.state === "closing") {
      throw new MassionDatabaseLifecycleError("DATABASE_CLOSING", "MassionDatabase가 종료 중입니다");
    }
    throw new MassionDatabaseLifecycleError("DATABASE_CLOSED", "MassionDatabase가 종료되었습니다");
  }

  private async runClientOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const task = Promise.resolve().then(operation);
    this.activeClientOperations.add(task);
    try {
      return await task;
    } finally {
      this.activeClientOperations.delete(task);
    }
  }

  private async closeAfterDrain(
    transactionDrain: Promise<void>,
    clientOperations: readonly Promise<unknown>[],
  ): Promise<void> {
    try {
      await Promise.all([transactionDrain, Promise.allSettled(clientOperations)]);
      try {
        if (this.client.isConnected) await this.client.close();
      } catch {
        throw new MassionDatabaseLifecycleError("DATABASE_CLOSE_FAILED", "MassionDatabase 종료에 실패했습니다");
      }
    } finally {
      this.state = "closed";
      this.closePromise = undefined;
      this.transactionScope.disable();
    }
  }
}

export async function createDatabase(config: DatabaseConfig): Promise<MassionDatabase> {
  const url = new URL(config.url);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`지원하지 않는 SurrealDB URL: ${config.url}`);
  }

  const client = new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines({ strict: true }),
    },
  });

  try {
    const authentication = config.authentication
      ? config.authentication.scope === "database"
        ? {
            namespace: config.namespace,
            database: config.database,
            username: config.authentication.username,
            password: config.authentication.password,
          }
        : { username: config.authentication.username, password: config.authentication.password }
      : undefined;
    await client.connect(config.url, {
      namespace: config.namespace,
      database: config.database,
      ...(authentication ? { authentication } : {}),
      versionCheck: true,
    });
    return new MassionDatabase(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
