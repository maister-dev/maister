import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  admitNextLibrarianTurn,
  submitOwnerMessage,
} from "@/lib/librarian/admission";
import { resetLibrarianConfigForTests } from "@/lib/librarian/config";
import {
  advanceReadCursor,
  withdrawMessage,
} from "@/lib/librarian/conversation";
import { applyLibrarianPark } from "@/lib/librarian/park";
import { promoteNextLibrarianTurn } from "@/lib/librarian/pool";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-183 (T2.4, T2.5): the durable conversation and its admission. Sends are
// deduplicated, queued behind the one active turn, capped per day, refused
// before any write when the librarian is unavailable, and admitted FIFO into a
// dedicated pool. The turn start is stubbed: these suites prove the ledger.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const start = vi.fn(async (turnId: string) => {
  void turnId;
});

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

async function send(
  ownerId: string,
  body: string,
  extra: { clientMessageId?: string; subject?: { projectSlug: string } } = {},
) {
  return submitOwnerMessage(
    ownerId,
    {
      clientMessageId: extra.clientMessageId ?? randomUUID(),
      body,
      subject: extra.subject ?? null,
    },
    { db: db as unknown as Db, start },
  );
}

async function turnsOf(ownerId: string) {
  return rows<{ status: string; message_id: string | null }>(
    await db.execute(sql`
      SELECT t.status, t.message_id FROM librarian_turns t
      JOIN librarian_conversations c ON c.id = t.conversation_id
      WHERE c.user_id = ${ownerId} ORDER BY t.created_at
    `),
  );
}

async function runOf(ownerId: string) {
  return rows<{ id: string; status: string }>(
    await db.execute(sql`
      SELECT r.id, r.status FROM runs r
      JOIN librarian_conversations c ON c.run_id = r.id
      WHERE c.user_id = ${ownerId}
    `),
  )[0];
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_admission",
  });
  db = database.db as unknown as NodePgDatabase;
  await fakeExecutionHosts(db);
  await seedLibrarianPlatform(db);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(() => {
  start.mockClear();
});

afterEach(() => {
  delete process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS;
  delete process.env.MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER;
  resetLibrarianConfigForTests();
});

describe("IT-LCV-02 / IT-EDGE-LCV-01: a client message id is stored once", () => {
  it("answers two concurrent sends of one client id with one message", async () => {
    const ownerId = await seedActiveUser(db);
    const clientMessageId = randomUUID();
    const [a, b] = await Promise.all([
      send(ownerId, "hello", { clientMessageId }),
      send(ownerId, "hello", { clientMessageId }),
    ]);
    const stored = rows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM librarian_messages m
        JOIN librarian_conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ${ownerId}
      `),
    );

    expect(stored[0].n).toBe(1);
    expect(a.message.id).toBe(b.message.id);
    expect([a.deduped, b.deduped].sort()).toEqual([false, true]);
    expect(a.turn?.id).toBe(b.turn?.id);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("IT-LUI-04: the subject is captured at send", () => {
  it("keeps a queued message's subject when a later send names another", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "first", { subject: { projectSlug: "alpha" } });
    const queued = await send(ownerId, "second", {
      subject: { projectSlug: "beta" },
    });

    await send(ownerId, "third", { subject: { projectSlug: "gamma" } });
    const [row] = rows<{ subject: { projectSlug: string } }>(
      await db.execute(sql`
        SELECT subject FROM librarian_messages WHERE id = ${queued.message.id}
      `),
    );

    expect(row.subject).toEqual({ projectSlug: "beta" });
  });
});

describe("IT-LCV-03 part 2 / IT-EDGE-LCV-02: a send during a turn queues", () => {
  it("queues the second message behind the active turn, never refuses it", async () => {
    const ownerId = await seedActiveUser(db);
    const first = await send(ownerId, "first");
    const second = await send(ownerId, "second");

    expect(first.turn).toMatchObject({ status: "admitted" });
    expect(first.message.deliveryState).toBe("accepted");
    expect(second.turn).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(second.message.deliveryState).toBe("queued");
    expect((await turnsOf(ownerId)).map((t) => t.status)).toEqual([
      "admitted",
      "queued",
    ]);
  });

  it("D15 two tabs: two different concurrent messages both store, one turn is active", async () => {
    const ownerId = await seedActiveUser(db);
    const results = await Promise.all([
      send(ownerId, "tab one"),
      send(ownerId, "tab two"),
    ]);
    const seqs = results.map((r) => r.message.seq.toString()).sort();

    expect(new Set(seqs).size).toBe(2);
    expect((await turnsOf(ownerId)).map((t) => t.status).sort()).toEqual([
      "admitted",
      "queued",
    ]);
  });
});

describe("IT-LCV-05: the librarian pool queues, never refuses", () => {
  it("admits a second user's turn when the first parks; a parked run holds no slot", async () => {
    process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS = "1";
    resetLibrarianConfigForTests();
    // Earlier cases leave turns admitted and runs claimed; they would fill
    // the pool and stand ahead of this case in its queue.
    await db.execute(sql`
      UPDATE librarian_turns SET status = 'completed', ended_at = now()
      WHERE status IN ('admitted', 'running')
    `);
    await db.execute(sql`
      UPDATE runs SET status = 'NeedsInputIdle'
      WHERE run_kind = 'librarian' AND status IN ('Running', 'Pending')
    `);
    const alice = await seedActiveUser(db);
    const bob = await seedActiveUser(db);

    await send(alice, "alice asks");
    const bobSend = await send(bob, "bob asks");

    expect((await runOf(alice)).status).toBe("Running");
    expect((await runOf(bob)).status).toBe("Pending");
    expect(bobSend.turn).toMatchObject({
      status: "admitted",
      queuePosition: 1,
    });
    expect(start).toHaveBeenCalledTimes(1);

    const aliceRun = await runOf(alice);

    await db.execute(sql`
      UPDATE librarian_turns SET status = 'completed', ended_at = now()
      WHERE status = 'admitted' AND conversation_id =
        (SELECT id FROM librarian_conversations WHERE user_id = ${alice})
    `);
    await db.transaction((tx) =>
      applyLibrarianPark(tx as unknown as Db, aliceRun.id),
    );
    expect((await runOf(alice)).status).toBe("NeedsInputIdle");

    const promoted = await promoteNextLibrarianTurn({
      db: db as unknown as Db,
      start,
    });

    expect(promoted.promotedRunId).toBe((await runOf(bob)).id);
    expect((await runOf(bob)).status).toBe("Running");
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("IT-LCV-10: the per-user daily turn cap", () => {
  it("refuses the send past the cap with BUDGET_EXCEEDED and writes nothing", async () => {
    process.env.MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER = "2";
    resetLibrarianConfigForTests();
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "one");
    await send(ownerId, "two");
    await expect(send(ownerId, "three")).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { reason: "librarian_daily_cap" },
    });
    expect(await turnsOf(ownerId)).toHaveLength(2);
  });
});

describe("IT-LCV-11 part 1 / IT-EDGE-LCV-03: an unavailable librarian refuses before writing", () => {
  it("refuses a disabled librarian with CONFIG and a not-ready runner with EXECUTOR_UNAVAILABLE", async () => {
    const ownerId = await seedActiveUser(db);

    await seedLibrarianPlatform(db, { enabled: false });
    await expect(send(ownerId, "hi")).rejects.toMatchObject({
      code: "CONFIG",
    });
    await seedLibrarianPlatform(db, {
      ready: false,
      runnerId: "lib-not-ready",
    });
    await expect(send(ownerId, "hi")).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
    expect(await turnsOf(ownerId)).toHaveLength(0);
    await seedLibrarianPlatform(db);
  });
});

describe("IT-LAU-10 part 3: a deactivated owner's queued turn is not admitted", () => {
  it("leaves the queued turn queued when its owner is disabled", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "first");
    await send(ownerId, "second");
    await db.execute(
      sql`UPDATE users SET account_status = 'disabled' WHERE id = ${ownerId}`,
    );
    const [conversation] = rows<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM librarian_conversations WHERE user_id = ${ownerId}
      `),
    );

    await db.execute(sql`
      UPDATE librarian_turns SET status = 'completed', ended_at = now()
      WHERE conversation_id = ${conversation.id} AND status = 'admitted'
    `);
    expect(
      await admitNextLibrarianTurn(conversation.id, {
        db: db as unknown as Db,
        start,
      }),
    ).toBeNull();
    expect((await turnsOf(ownerId)).map((t) => t.status)).toEqual([
      "completed",
      "queued",
    ]);
  });
});

describe("LCV-03: withdrawing a queued message", () => {
  it("withdraws a queued message and refuses one already accepted", async () => {
    const ownerId = await seedActiveUser(db);
    const accepted = await send(ownerId, "running one");
    const queued = await send(ownerId, "queued one");

    await withdrawMessage(ownerId, queued.message.id, db);
    expect((await turnsOf(ownerId)).map((t) => t.status)).toEqual([
      "admitted",
      "withdrawn",
    ]);
    await expect(
      withdrawMessage(ownerId, accepted.message.id, db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const other = await seedActiveUser(db);

    await expect(
      withdrawMessage(other, accepted.message.id, db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("LUI-01: the read cursor only moves forward", () => {
  it("keeps the greater value and clamps past the latest seq", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "one");
    await send(ownerId, "two");
    expect(await advanceReadCursor(ownerId, 2n, db)).toBe(2n);
    expect(await advanceReadCursor(ownerId, 1n, db)).toBe(2n);
    expect(await advanceReadCursor(ownerId, 99n, db)).toBe(2n);
  });
});
