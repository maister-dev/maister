import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  assertScratchCapacityAvailable,
  scratchCapacityDecision,
} from "@/lib/scheduler";

type CountRow = { count: number };

type MockTx = {
  readonly updateCalls: number;
  select(fields: unknown): {
    from(table: unknown): {
      where(predicate: unknown): Promise<CountRow[]>;
    };
  };
  update(table: unknown): never;
};

type MockDb = {
  readonly tx: MockTx;
  transaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T>;
};

let originalCap: string | undefined;
let originalDbUrl: string | undefined;

beforeEach(() => {
  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  originalDbUrl = process.env.DB_URL;
  delete process.env.DB_URL;
});

afterEach(() => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }

  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
});

function mockDb(liveCount: number): MockDb {
  let updateCalls = 0;
  const tx: MockTx = {
    get updateCalls() {
      return updateCalls;
    },
    select() {
      return {
        from() {
          return {
            async where() {
              return [{ count: liveCount }];
            },
          };
        },
      };
    },
    update(): never {
      updateCalls += 1;
      throw new Error("scratch capacity check must not mutate runs");
    },
  };

  return {
    tx,
    async transaction<T>(fn: (transactionTx: MockTx) => Promise<T>) {
      return fn(tx);
    },
  };
}

describe("scheduler scratch capacity gate", () => {
  it("allows scratch launch below the global live-session cap", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
    const db = mockDb(2);

    const decision = await assertScratchCapacityAvailable({ db });

    expect(decision).toEqual({ allowed: true, cap: 3, liveCount: 2 });
    expect(db.tx.updateCalls).toBe(0);
  });

  it("rejects scratch launch at the cap without queueing or mutation", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
    const db = mockDb(3);

    let caught: unknown;

    try {
      await assertScratchCapacityAvailable({ db });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(isMaisterError(caught) ? caught.code : undefined).toBe("CONFLICT");
    expect(isMaisterError(caught) ? caught.message : "").toContain(
      "liveCount=3, cap=3",
    );
    expect(db.tx.updateCalls).toBe(0);
  });

  it("treats terminal and review states as free capacity through the live count", () => {
    expect(scratchCapacityDecision(1, 3)).toEqual({
      allowed: true,
      cap: 3,
      liveCount: 1,
    });
    expect(scratchCapacityDecision(3, 3)).toEqual({
      allowed: false,
      cap: 3,
      liveCount: 3,
    });
  });
});
