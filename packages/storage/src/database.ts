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

class TransactionExecutor implements QueryExecutor {
  public constructor(private readonly transaction: SurrealTransaction) {}

  public async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    return (await this.transaction.query(surql, bindings)) as R;
  }
}

export class MassionDatabase implements QueryExecutor, AsyncDisposable {
  public constructor(private readonly client: Surreal) {}

  public async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    return (await this.client.query(surql, bindings)) as R;
  }

  public async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const transaction = await this.client.beginTransaction();
      try {
        const result = await operation(new TransactionExecutor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        // 서버가 이미 버린 transaction을 다시 cancel하면 같은 not-found 경고만 한 번 더 만듭니다.
        if (!isLostTransaction(error)) await cancelBestEffort(transaction);
        if (!isCompatibleRetryableConflict(error) || attempt >= 3) throw error;
        // 즉시 재시도하면 경쟁 상대의 다음 transaction과 계속 같은 시점에 충돌할 수 있습니다.
        await delay(2 ** attempt);
      }
    }
  }

  public async version(): Promise<string> {
    return (await this.client.version()).version;
  }

  public async exportSql(): Promise<string> {
    return await this.client.export();
  }

  public async importSql(sql: string): Promise<void> {
    await this.client.import(sql);
  }

  public async close(): Promise<void> {
    if (this.client.isConnected) await this.client.close();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
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
