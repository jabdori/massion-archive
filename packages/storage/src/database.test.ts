import { describe, expect, it } from "vitest";

import { createDatabase, MassionDatabase, serializeSurrealDateTime } from "./database.js";

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
