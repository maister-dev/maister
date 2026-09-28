import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { submitOwnerMessage } from "@/lib/librarian/admission";
import { resetLibrarianConfigForTests } from "@/lib/librarian/config";
import {
  applyLibrarianPark,
  claimLibrarianResumeInTransaction,
} from "@/lib/librarian/park";
import { countLiveRuns } from "@/lib/scheduler";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-185 D3 (T2.9): the librarian's own park and resume primitives. Park
// frees the slot and releases the assignment as `parked`; the claim takes a
// slot and places the run, and is refused on a run that is not parked.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

async function runAndTurn(ownerId: string) {
  const result = await submitOwnerMessage(
    ownerId,
    { clientMessageId: randomUUID(), body: "hi", subject: null },
    { db: db as unknown as Db, start: async () => {} },
  );
  const [run] = rows<{ id: string; status: string }>(
    await db.execute(sql`
      SELECT r.id, r.status FROM runs r
      JOIN librarian_conversations c ON c.run_id = r.id
      WHERE c.user_id = ${ownerId}
    `),
  );

  return { runId: run.id, turnId: result.turn!.id };
}

async function completeTurn(turnId: string) {
  await db.execute(sql`
    UPDATE librarian_turns SET status = 'completed', ended_at = now()
    WHERE id = ${turnId}
  `);
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "librarian_park" });
  db = database.db as unknown as NodePgDatabase;
  await fakeExecutionHosts(db);
  await seedLibrarianPlatform(db);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

afterEach(() => {
  delete process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS;
  resetLibrarianConfigForTests();
});

describe("IT-LCV-05 part 2: park frees the slot; the claim takes it back", () => {
  it("parks a running run: NeedsInputIdle, assignment released `parked`, slot freed", async () => {
    const ownerId = await seedActiveUser(db);
    const { runId, turnId } = await runAndTurn(ownerId);
    const before = await countLiveRuns(db as unknown as Db, "librarian");

    await completeTurn(turnId);
    const parked = await db.transaction((tx) =>
      applyLibrarianPark(tx as unknown as Db, runId),
    );

    expect(parked.parked).toBe(true);
    const [assignment] = rows<{ state: string; released_reason: string }>(
      await db.execute(sql`
        SELECT state, released_reason FROM execution_assignments
        WHERE run_id = ${runId} ORDER BY epoch DESC LIMIT 1
      `),
    );

    expect(assignment).toEqual({
      state: "released",
      released_reason: "parked",
    });
    expect(await countLiveRuns(db as unknown as Db, "librarian")).toBe(
      before - 1,
    );
    // Parking twice is a no-op, never an error.
    expect(
      (
        await db.transaction((tx) =>
          applyLibrarianPark(tx as unknown as Db, runId),
        )
      ).parked,
    ).toBe(false);
  });

  it("refuses a resume claim on a run that is still Running", async () => {
    const ownerId = await seedActiveUser(db);
    const { runId, turnId } = await runAndTurn(ownerId);
    const claim = await db.transaction((tx) =>
      claimLibrarianResumeInTransaction(tx as unknown as Db, { runId, turnId }),
    );

    expect(claim).toEqual({ claimed: false, reason: "not_claimable" });
  });

  it("leaves the run parked and the turn admitted under a full pool", async () => {
    const ownerId = await seedActiveUser(db);
    const { runId, turnId } = await runAndTurn(ownerId);

    await completeTurn(turnId);
    await db.transaction((tx) =>
      applyLibrarianPark(tx as unknown as Db, runId),
    );
    const nextTurn = randomUUID();

    await db.execute(sql`
      INSERT INTO librarian_turns (id, conversation_id, segment_id, variant, status, admitted_at)
      SELECT ${nextTurn}, c.id, c.current_segment_id, 'owner_message', 'admitted', now()
      FROM librarian_conversations c WHERE c.user_id = ${ownerId}
    `);
    const live = await countLiveRuns(db as unknown as Db, "librarian");

    process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS = String(
      Math.max(1, live),
    );
    resetLibrarianConfigForTests();
    if (live === 0) {
      // Fill the only slot with another conversation's running run.
      await runAndTurn(await seedActiveUser(db));
    }
    const claim = await db.transaction((tx) =>
      claimLibrarianResumeInTransaction(tx as unknown as Db, {
        runId,
        turnId: nextTurn,
      }),
    );

    expect(claim).toEqual({ claimed: false, reason: "pool_full" });
    const [state] = rows<{ run: string; turn: string }>(
      await db.execute(sql`
        SELECT r.status AS run, t.status AS turn FROM runs r, librarian_turns t
        WHERE r.id = ${runId} AND t.id = ${nextTurn}
      `),
    );

    expect(state).toEqual({ run: "NeedsInputIdle", turn: "admitted" });
  });
});
