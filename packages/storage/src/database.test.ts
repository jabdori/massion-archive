import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it, vi } from "vitest";

import { createDatabase, MassionDatabase, serializeSurrealDateTime } from "./database.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SurrealDB 연결", () => {
  it("embedded memory DB에 연결하고 namespace와 database를 선택한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "test" });

    expect(await db.version()).toMatch(/^surrealdb-3\./);
    expect(await db.query<number[]>("RETURN 1 + 1;")).toEqual([2]);
  });

  it("허용하지 않은 protocol을 거부한다", async () => {
    await expect(
      createDatabase({ url: "file:///tmp/massion", namespace: "massion", database: "test" }),
    ).rejects.toThrow("지원하지 않는 SurrealDB URL: file:///tmp/massion");
  });

  it("transaction 실패 시 변경을 rollback한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "test" });
    await db.query("DEFINE TABLE rollback_probe SCHEMAFULL; DEFINE FIELD payload ON rollback_probe TYPE int;");

    await expect(
      db.transaction(async (tx) => {
        await tx.query("CREATE rollback_probe:one SET payload = 1;");
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");

    expect(await db.query<unknown[][]>("SELECT payload FROM rollback_probe;")).toEqual([[]]);
  });

  it("원격 rollback이 응답하지 않아도 원래 transaction 오류를 보존한다", async () => {
    const database = new MassionDatabase({
      beginTransaction: async () => ({ cancel: async () => await new Promise(() => {}) }),
    } as never);

    await expect(
      database.transaction(async () => {
        throw new Error("원래 transaction 오류");
      }),
    ).rejects.toThrow("원래 transaction 오류");
  });

  it("rollback 호출 자체가 실패해도 commit의 원래 오류를 보존한다", async () => {
    const commitError = new Error("원래 commit 오류");
    const database = new MassionDatabase({
      beginTransaction: async () => ({
        query: async () => [],
        commit: async () => {
          throw commitError;
        },
        cancel: () => {
          throw new Error("rollback 연결 오류");
        },
      }),
    } as never);

    await expect(database.transaction(async () => undefined)).rejects.toBe(commitError);
  });

  it("retry 가능한 conflict는 새 transaction으로 세 번만 재시도한다", async () => {
    const conflict = new Error("Transaction conflict: Write conflict can be retried");
    let attempts = 0;
    let cancellations = 0;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        attempts += 1;
        return {
          query: async () => [],
          commit: async () => {
            throw conflict;
          },
          cancel: async () => {
            cancellations += 1;
          },
        };
      },
    } as never);

    await expect(database.transaction(async () => undefined)).rejects.toBe(conflict);
    expect(attempts).toBe(4);
    expect(cancellations).toBe(4);
  });

  it("현재 서버의 conflict 재시도는 event loop를 양보해 경쟁 transaction이 끝날 시간을 준다", async () => {
    const conflict = new Error(
      "Transaction conflict: Write conflict, retry the transaction. This transaction can be retried",
    );
    let attempts = 0;
    let competingTransactionFinished = false;
    setTimeout(() => {
      competingTransactionFinished = true;
    }, 0);
    const database = new MassionDatabase({
      beginTransaction: async () => {
        attempts += 1;
        return {
          query: async () => [],
          commit: async () => {
            if (!competingTransactionFinished) throw conflict;
          },
          cancel: async () => undefined,
        };
      },
    } as never);

    await expect(database.transaction(async () => undefined)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("서버가 transaction을 잃어버리면 새 transaction으로 다시 시도한다", async () => {
    // WebSocket transactions map이 비면 진행 중이던 transaction이 통째로 사라집니다.
    // 아무것도 commit되지 않은 상태이므로 재시도가 안전합니다.
    const lost = new Error("Transaction 019fd3cd-9f78-7723-a5cb-b94e420b0fd0 not found");
    let attempts = 0;
    let cancellations = 0;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        attempts += 1;
        const failing = attempts === 1;
        return {
          query: async () => {
            if (failing) throw lost;
            return [];
          },
          commit: async () => undefined,
          cancel: async () => {
            cancellations += 1;
          },
        };
      },
    } as never);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("SELECT 1;");
        return "완료";
      }),
    ).resolves.toBe("완료");
    expect(attempts).toBe(2);
    expect(cancellations).toBe(0);
  });

  it("transaction은 응답을 막을 수 있는 별도 session 수명주기를 만들지 않는다", async () => {
    let committed = false;
    const database = new MassionDatabase({
      beginTransaction: async () => ({
        query: async () => [[1]],
        commit: async () => {
          committed = true;
        },
        cancel: async () => undefined,
      }),
      forkSession: async () => {
        throw new Error("별도 session을 만들면 안 됩니다");
      },
    } as never);

    await expect(database.transaction(async (transaction) => await transaction.query("RETURN 1;"))).resolves.toEqual([
      [1],
    ]);
    expect(committed).toBe(true);
  });

  it("동시 transaction을 서로 독립된 transaction ID로 commit한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "concurrent_transactions" });
    await db.query("DEFINE TABLE concurrent_probe SCHEMAFULL; DEFINE FIELD payload ON concurrent_probe TYPE int;");

    await Promise.all([
      db.transaction(async (tx) => tx.query("CREATE concurrent_probe:one SET payload = 1;")),
      db.transaction(async (tx) => tx.query("CREATE concurrent_probe:two SET payload = 2;")),
    ]);

    const [records] = await db.query<[{ payload: number }[]]>(
      "SELECT payload FROM concurrent_probe ORDER BY payload ASC;",
    );
    expect(records).toEqual([{ payload: 1 }, { payload: 2 }]);
  });

  it("동일 client의 interactive transaction을 호출 순서대로 하나씩 실행한다", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const entered = [deferred(), deferred(), deferred()];
    const log: string[] = [];
    let begins = 0;
    let active = 0;
    let maximumActive = 0;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        const transaction = ++begins;
        log.push(`begin:${String(transaction)}`);
        return {
          query: async () => [],
          commit: async () => {
            log.push(`commit:${String(transaction)}`);
          },
          cancel: async () => undefined,
        };
      },
    } as never);
    const operations = gates.map((gate, index) =>
      database.transaction(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        log.push(`operation:${String(index + 1)}`);
        entered[index]?.resolve();
        try {
          await gate.promise;
          return index + 1;
        } finally {
          active -= 1;
        }
      }),
    );

    await entered[0]?.promise;
    await nextTurn();
    expect(begins).toBe(1);
    expect(maximumActive).toBe(1);
    gates[0]?.resolve();
    await entered[1]?.promise;
    expect(log).toEqual(["begin:1", "operation:1", "commit:1", "begin:2", "operation:2"]);
    gates[1]?.resolve();
    await entered[2]?.promise;
    gates[2]?.resolve();

    await expect(Promise.all(operations)).resolves.toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);
    expect(log).toEqual([
      "begin:1",
      "operation:1",
      "commit:1",
      "begin:2",
      "operation:2",
      "commit:2",
      "begin:3",
      "operation:3",
      "commit:3",
    ]);
  });

  it("한 transaction의 bounded retry가 끝날 때까지 다음 FIFO caller를 들이지 않는다", async () => {
    const firstEntered = deferred();
    const allowConflict = deferred();
    const conflict = new Error("Transaction conflict: Write conflict can be retried");
    const log: string[] = [];
    let attempts = 0;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        const attempt = ++attempts;
        log.push(`begin:${String(attempt)}`);
        return {
          query: async () => [],
          commit: async () => {
            log.push(`commit:${String(attempt)}`);
            if (attempt === 1) throw conflict;
          },
          cancel: async () => {
            log.push(`cancel:${String(attempt)}`);
          },
        };
      },
    } as never);
    let firstOperationAttempts = 0;
    const first = database.transaction(async () => {
      firstOperationAttempts += 1;
      log.push("operation:first");
      if (firstOperationAttempts === 1) {
        firstEntered.resolve();
        await allowConflict.promise;
      }
      return "first";
    });
    await firstEntered.promise;
    const second = database.transaction(async () => {
      log.push("operation:second");
      return "second";
    });
    await nextTurn();
    expect(attempts).toBe(1);
    allowConflict.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(log).toEqual([
      "begin:1",
      "operation:first",
      "commit:1",
      "cancel:1",
      "begin:2",
      "operation:first",
      "commit:2",
      "begin:3",
      "operation:second",
      "commit:3",
    ]);
  });

  it.each(["begin", "operation", "commit"] as const)(
    "%s의 non-retryable 실패 뒤에도 다음 FIFO transaction을 실행한다",
    async (failurePoint) => {
      const failure = new Error(`${failurePoint} failed`);
      const log: string[] = [];
      let begins = 0;
      let operations = 0;
      const database = new MassionDatabase({
        beginTransaction: async () => {
          const begin = ++begins;
          log.push(`begin:${String(begin)}`);
          if (failurePoint === "begin" && begin === 1) throw failure;
          return {
            query: async () => [],
            commit: async () => {
              log.push(`commit:${String(begin)}`);
              if (failurePoint === "commit" && begin === 1) throw failure;
            },
            cancel: async () => {
              log.push(`cancel:${String(begin)}`);
            },
          };
        },
      } as never);
      const first = database.transaction(async () => {
        const operation = ++operations;
        log.push(`operation:${String(operation)}`);
        if (failurePoint === "operation" && operation === 1) throw failure;
        return "first";
      });
      const second = database.transaction(async () => {
        operations += 1;
        log.push("operation:second");
        return "second";
      });

      await expect(first).rejects.toBe(failure);
      await expect(second).resolves.toBe("second");
      expect(log.at(-2)).toBe("operation:second");
      expect(log.at(-1)).toBe(`commit:${String(begins)}`);
    },
  );

  it("같은 database transaction의 재귀 진입을 새 begin 전에 즉시 거부한다", async () => {
    let begins = 0;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        begins += 1;
        return { query: async () => [], commit: async () => undefined, cancel: async () => undefined };
      },
    } as never);

    await database.transaction(async () => {
      await expect(database.transaction(async () => undefined)).rejects.toMatchObject({
        name: "MassionDatabaseLifecycleError",
        code: "DATABASE_TRANSACTION_REENTRANT",
      });
    });
    expect(begins).toBe(1);
  });

  it("transaction에서 분리된 비동기 자식도 outer 완료 뒤 재진입할 수 없다", async () => {
    const childGate = deferred();
    let begins = 0;
    let child: Promise<void> | undefined;
    const database = new MassionDatabase({
      beginTransaction: async () => {
        begins += 1;
        return { query: async () => [], commit: async () => undefined, cancel: async () => undefined };
      },
    } as never);

    await database.transaction(async () => {
      child = (async () => {
        await childGate.promise;
        await database.transaction(async () => undefined);
      })();
    });
    childGate.resolve();

    await expect(child).rejects.toMatchObject({
      name: "MassionDatabaseLifecycleError",
      code: "DATABASE_TRANSACTION_REENTRANT",
    });
    expect(begins).toBe(1);
    await database.close();
  });

  it("close는 기존 transaction FIFO를 비운 뒤 client를 닫고 새 query와 transaction을 거부한다", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();
    let operation = 0;
    let closeCalls = 0;
    const client = {
      isConnected: true,
      query: async () => [[1]],
      beginTransaction: async () => ({
        query: async () => [],
        commit: async () => undefined,
        cancel: async () => undefined,
      }),
      close: async () => {
        closeCalls += 1;
        client.isConnected = false;
      },
    };
    const database = new MassionDatabase(client as never);
    const first = database.transaction(async () => {
      operation += 1;
      firstEntered.resolve();
      await firstGate.promise;
      return "first";
    });
    await firstEntered.promise;
    const second = database.transaction(async () => {
      operation += 1;
      secondEntered.resolve();
      await secondGate.promise;
      return "second";
    });
    const closing = database.close();
    const lateQuery = database.query("RETURN 1;").then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const lateTransaction = database
      .transaction(async () => "late")
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await nextTurn();
    const closeCallsBeforeRelease = closeCalls;
    firstGate.resolve();
    await secondEntered.promise;
    const closeCallsWhileQueuedRuns = closeCalls;
    secondGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await expect(closing).resolves.toBeUndefined();
    expect(operation).toBe(2);
    expect(closeCallsBeforeRelease).toBe(0);
    expect(closeCallsWhileQueuedRuns).toBe(0);
    expect(closeCalls).toBe(1);
    await expect(lateQuery).resolves.toMatchObject({
      status: "rejected",
      error: { name: "MassionDatabaseLifecycleError", code: "DATABASE_CLOSING" },
    });
    await expect(lateTransaction).resolves.toMatchObject({
      status: "rejected",
      error: { name: "MassionDatabaseLifecycleError", code: "DATABASE_CLOSING" },
    });
    await expect(database.query("RETURN 1;")).rejects.toMatchObject({ code: "DATABASE_CLOSED" });
  });

  it("close는 같은 turn에 접수된 client operation 전체를 비운 뒤 모든 entry point를 닫는다", async () => {
    const operationGate = deferred();
    const calls: string[] = [];
    let closeCalls = 0;
    const client = {
      isConnected: true,
      query: async () => {
        calls.push("query");
        await operationGate.promise;
        return [[1]];
      },
      version: async () => {
        calls.push("version");
        await operationGate.promise;
        return { version: "surrealdb-test" };
      },
      export: async () => {
        calls.push("export");
        await operationGate.promise;
        return "exported";
      },
      import: async () => {
        calls.push("import");
        await operationGate.promise;
      },
      close: async () => {
        closeCalls += 1;
        client.isConnected = false;
      },
    };
    const database = new MassionDatabase(client as never);
    const query = database.query("RETURN 1;");
    const version = database.version();
    const exported = database.exportSql();
    const imported = database.importSql("DEFINE TABLE probe;");
    const closing = database.close();
    await nextTurn();
    expect(calls).toEqual(["query", "version", "export", "import"]);
    expect(closeCalls).toBe(0);

    for (const operation of [
      () => database.query("RETURN 2;"),
      () => database.version(),
      () => database.exportSql(),
      () => database.importSql("secret-token-must-not-leak"),
    ]) {
      const pending = operation();
      await expect(pending).rejects.toMatchObject({
        name: "MassionDatabaseLifecycleError",
        code: "DATABASE_CLOSING",
      });
      await expect(pending).rejects.not.toThrow("secret-token-must-not-leak");
    }
    operationGate.resolve();

    await expect(query).resolves.toEqual([[1]]);
    await expect(version).resolves.toBe("surrealdb-test");
    await expect(exported).resolves.toBe("exported");
    await expect(imported).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);

    for (const operation of [
      () => database.query("RETURN 2;"),
      () => database.version(),
      () => database.exportSql(),
      () => database.importSql("DEFINE TABLE late;"),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "MassionDatabaseLifecycleError",
        code: "DATABASE_CLOSED",
      });
    }
  });

  it("underlying close 실패를 비밀 없이 한 번만 보고하고 database를 terminal closed로 만든다", async () => {
    const secret = "surreal://root:plain-text-secret@localhost";
    const disable = vi.spyOn(AsyncLocalStorage.prototype, "disable");
    let closeCalls = 0;
    const database = new MassionDatabase({
      isConnected: true,
      close: async () => {
        closeCalls += 1;
        throw new Error(secret);
      },
    } as never);

    const first = database.close();
    const concurrent = database.close();
    expect(concurrent).toBe(first);
    const results = await Promise.allSettled([first, concurrent]);

    expect(closeCalls).toBe(1);
    expect(disable).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          name: "MassionDatabaseLifecycleError",
          code: "DATABASE_CLOSE_FAILED",
        });
        expect(String(result.reason)).not.toContain(secret);
      }
    }
    await expect(database.query("RETURN 1;")).rejects.toMatchObject({ code: "DATABASE_CLOSED" });
    await expect(database.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
    disable.mockRestore();
  });

  it("transaction 안에서 close를 호출하면 자기 자신을 기다리지 않고 즉시 거부한다", async () => {
    let closeCalls = 0;
    const database = new MassionDatabase({
      isConnected: true,
      beginTransaction: async () => ({
        query: async () => [],
        commit: async () => undefined,
        cancel: async () => undefined,
      }),
      close: async () => {
        closeCalls += 1;
      },
    } as never);

    await database.transaction(async () => {
      await expect(database.close()).rejects.toMatchObject({
        name: "MassionDatabaseLifecycleError",
        code: "DATABASE_CLOSE_IN_TRANSACTION",
      });
    });
    expect(closeCalls).toBe(0);
    await database.close();
    expect(closeCalls).toBe(1);
  });

  it("SDK DateTime prototype private field로 genuine datetime만 직렬화한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "datetime_guard" });
    const canonical = "2026-07-11T06:00:00.000Z";
    const [genuine] = await db.query<[unknown]>("RETURN <datetime>$value;", { value: canonical });
    let fakeCalls = 0;
    class DateTimeMimic {
      public toCompact(): readonly [bigint, bigint] {
        fakeCalls += 1;
        return [0n, 0n];
      }

      public toISOString(): string {
        fakeCalls += 1;
        return canonical;
      }
    }
    const forged = new DateTimeMimic() as DateTimeMimic & Record<symbol, unknown>;
    forged[Symbol.for("surrealdb.Value")] = true;
    forged[Symbol.for("surrealdb.DateTime")] = true;
    const prototypeMimic = Object.create(genuine as object) as Record<string, unknown>;
    prototypeMimic.toCompact = () => {
      fakeCalls += 1;
      return [0n, 0n];
    };
    prototypeMimic.toISOString = () => {
      fakeCalls += 1;
      return canonical;
    };

    expect(serializeSurrealDateTime(genuine)).toBe(canonical);
    for (const fake of [
      { toISOString: () => canonical },
      new DateTimeMimic(),
      forged,
      prototypeMimic,
      canonical,
      new Date(canonical),
    ]) {
      expect(serializeSurrealDateTime(fake)).toBeUndefined();
    }
    expect(fakeCalls).toBe(0);
  });
});
