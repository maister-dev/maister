// ADR-166 T1.2 — execution assignments (A1–A6): the mint, its serialization
// on the run row, release, admission, and the D9 lazy placement.

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino, { type Logger } from "pino";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  getActiveAssignment,
  isAdmissible,
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { ensureAssignment } from "@/lib/execution-host/placement";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { COMMAND_KINDS } from "@/lib/execution-host/types";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  createFakeExecutionHost,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let hostId: string;
// The registered local host as a fake transport (same key + boot id), for
// the lazy placement that resolves the host itself.
let fake: FakeExecutionHost;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_assignments_test",
  });
  db = testDatabase.db as unknown as Db;
  projectId = await seedProject(testDatabase.db);
  const bootId = randomUUID();
  const seeded = await seedLocalHost(testDatabase.db, { bootId });

  hostId = seeded.id;
  fake = createFakeExecutionHost({ hostKey: seeded.hostKey, bootId });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function assignmentsFor(runId: string) {
  return (await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId))
    .orderBy(schema.executionAssignments.epoch)) as unknown as Array<{
    id: string;
    epoch: number;
    state: string;
    supersededById: string | null;
    endedAt: Date | null;
    releasedReason: string | null;
    executionWorkspaceId: string | null;
  }>;
}

async function runRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Array<{
    executionAssignmentId: string | null;
  }>;

  return rows[0];
}

describe("mintAssignment", () => {
  it("A1: first mint → epoch 1, active, runs.execution_assignment_id set", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });

    const minted = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    expect(minted.epoch).toBe(1);
    expect(minted.state).toBe("active");
    expect(minted.placementReason).toBe("launch");
    expect(minted.endedAt).toBeNull();
    expect((await runRow(runId)).executionAssignmentId).toBe(minted.id);
  });

  it("A2: second mint → epoch 2, previous superseded with pointer + ended_at, exactly one active", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });
    const first = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    await db
      .update(schema.executionAssignments)
      .set({ executionWorkspaceId: "ws_" + "a".repeat(32) })
      .where(eq(schema.executionAssignments.id, first.id));

    const second = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "resume" }),
    );

    const rows = await assignmentsFor(runId);

    expect(rows.map((r) => r.epoch)).toEqual([1, 2]);
    expect(rows[0].state).toBe("superseded");
    expect(rows[0].supersededById).toBe(second.id);
    expect(rows[0].endedAt).not.toBeNull();
    expect(rows[1].state).toBe("active");
    expect(rows.filter((r) => r.state === "active")).toHaveLength(1);
    // Same host → the adopted handle carries forward.
    expect(rows[1].executionWorkspaceId).toBe("ws_" + "a".repeat(32));
    expect((await runRow(runId)).executionAssignmentId).toBe(second.id);
  });

  it("A3: two concurrent mints serialize on the run row — the first racer holds the lock, the second waits", async () => {
    // Mutation proof: with the run-row `FOR UPDATE` removed from
    // mintAssignment, both transactions read max(epoch)=1 and both insert
    // epoch 2 → the loser dies 23505 → CONFLICT, and this case goes red.
    const runId = await seedRun(testDatabase.db, { projectId });

    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    const holder = await testDatabase.pool.connect();
    const waiter = await testDatabase.pool.connect();

    try {
      await holder.query("BEGIN");
      const held = await mintAssignment(drizzle(holder) as unknown as Db, {
        runId,
        hostId,
        reason: "resume",
      });

      await waiter.query("BEGIN");
      const waiting = mintAssignment(drizzle(waiter) as unknown as Db, {
        runId,
        hostId,
        reason: "recover",
      });

      await waitForLockWait('%from "runs"%for update%');
      await holder.query("COMMIT");
      const late = await waiting;

      await waiter.query("COMMIT");

      expect(held.epoch).toBe(2);
      expect(late.epoch).toBe(3);
      await expectSerialized(runId, late.id);
    } finally {
      holder.release();
      waiter.release();
    }
  });

  it("A3 (second ordering): the racer that opened its transaction FIRST is held before its FOR UPDATE, so the SECOND racer commits first and the first mints the next epoch", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });

    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    const first = await testDatabase.pool.connect();
    const second = await testDatabase.pool.connect();

    try {
      await first.query("BEGIN");
      let releaseFirst!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      // The first racer's transaction is open but it has not taken the run
      // lock yet: its mint (and the FOR UPDATE inside) starts after the barrier.
      const firstMint = barrier.then(() =>
        mintAssignment(drizzle(first) as unknown as Db, {
          runId,
          hostId,
          reason: "resume",
        }),
      );

      await second.query("BEGIN");
      const committedFirst = await mintAssignment(
        drizzle(second) as unknown as Db,
        { runId, hostId, reason: "recover" },
      );

      await second.query("COMMIT");

      releaseFirst();
      const late = await firstMint;

      await first.query("COMMIT");

      expect(committedFirst.epoch).toBe(2);
      expect(late.epoch).toBe(3);
      await expectSerialized(runId, late.id);
    } finally {
      first.release();
      second.release();
    }
  });

  it("A3b: a unique violation inside the mint surfaces as CONFLICT, never a raw 23505", async () => {
    // A live epoch race cannot be staged against the run-row lock: a rogue
    // INSERT referencing the run takes FOR KEY SHARE on the run row, so the
    // mint's FOR UPDATE serializes behind it and computes the next free epoch
    // (the lock is stronger than the (run_id, epoch) backstop needs). The
    // mapping is therefore exercised through the other unique constraint the
    // INSERT can hit — the primary key — by re-minting with a taken id.
    const runId = await seedRun(testDatabase.db, { projectId });
    const first = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );
    let caught: unknown;

    try {
      await db.transaction((tx) =>
        mintAssignment(tx as unknown as Db, {
          runId,
          hostId,
          reason: "resume",
          id: first.id,
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(isMaisterError(caught) && caught.code).toBe("CONFLICT");
    expect(isMaisterError(caught) && caught.details?.reason).toBe(
      "assignment_mint_race",
    );
    // The failed mint rolled back: the first assignment is still the active one.
    const rows = await assignmentsFor(runId);

    expect(rows.map((r) => [r.epoch, r.state])).toEqual([[1, "active"]]);
  });
});

describe("releaseAssignmentForRun", () => {
  it("A4: releases the active row with reason + ended_at; a repeat is a no-op", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });

    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    const released = await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "checkpoint"),
    );

    expect(released?.state).toBe("released");
    expect(released?.releasedReason).toBe("checkpoint");
    expect(released?.endedAt).not.toBeNull();

    const again = await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "sweep"),
    );

    expect(again).toBeNull();

    const rows = await assignmentsFor(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].releasedReason).toBe("checkpoint");
  });
});

describe("ensureAssignment (D9 lazy placement)", () => {
  function captureLogger(): {
    logger: Logger;
    lines: Array<Record<string, unknown>>;
  } {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "debug" },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );

    return { logger, lines };
  }

  it("A6a: a placed run whose active row was released is REFUSED assignment_missing — a re-entry must mint inside its own claim", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });
    const placed = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );

    await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "checkpointed"),
    );
    resetResolverForTests();
    resetRegistrarStateForTests();

    await expect(
      ensureAssignment(db, runId, "legacy_backfill", {
        transport: fake.transport,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        err.details?.reason === "assignment_missing" &&
        err.details?.assignmentId === placed.id &&
        err.details?.assignmentState === "released",
    );
    expect(
      (await assignmentsFor(runId)).map((r) => [r.epoch, r.state]),
    ).toEqual([[1, "released"]]);
  });

  it("A6b: a never-placed run mints epoch 1 legacy_backfill lazily with WARN legacy-run-assigned-lazily", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });
    const { logger, lines } = captureLogger();

    resetResolverForTests();
    resetRegistrarStateForTests();
    const minted = await ensureAssignment(db, runId, "legacy_backfill", {
      transport: fake.transport,
      logger,
    });

    expect(minted).toMatchObject({
      epoch: 1,
      state: "active",
      placementReason: "legacy_backfill",
      executionHostId: hostId,
    });
    expect((await runRow(runId)).executionAssignmentId).toBe(minted.id);
    expect(
      lines.filter((l) => l.msg === "legacy-run-assigned-lazily"),
    ).toMatchObject([{ runId, reason: "legacy_backfill" }]);

    // Idempotent: the active row is reused, nothing is minted twice.
    const again = await ensureAssignment(db, runId, "legacy_backfill", {
      transport: fake.transport,
      logger,
    });

    expect(again.id).toBe(minted.id);
    expect(await assignmentsFor(runId)).toHaveLength(1);
  });

  it("A6c: two concurrent lazy mints serialize on the run row — one row, both callers get the same id", async () => {
    const runId = await seedRun(testDatabase.db, { projectId });

    resetResolverForTests();
    resetRegistrarStateForTests();
    const [a, b] = await Promise.all([
      ensureAssignment(db, runId, "legacy_backfill", {
        transport: fake.transport,
      }),
      ensureAssignment(db, runId, "legacy_backfill", {
        transport: fake.transport,
      }),
    ]);

    expect(a.id).toBe(b.id);
    expect(a.epoch).toBe(1);
    expect(await assignmentsFor(runId)).toHaveLength(1);
    expect((await getActiveAssignment(db, runId))?.id).toBe(a.id);
    expect((await runRow(runId)).executionAssignmentId).toBe(a.id);
  });
});

describe("isAdmissible", () => {
  it("A5: active admits every kind; released admits teardown only; superseded admits nothing", () => {
    for (const kind of COMMAND_KINDS) {
      expect(isAdmissible(kind, "active", { inputAction: "select" })).toBe(
        true,
      );
      expect(isAdmissible(kind, "superseded", { inputAction: "cancel" })).toBe(
        false,
      );
    }

    expect(isAdmissible("session.checkpoint", "released")).toBe(true);
    expect(isAdmissible("session.delete", "released")).toBe(true);
    expect(isAdmissible("session.cancel", "released")).toBe(true);
    expect(isAdmissible("workspace.release", "released")).toBe(true);
    expect(
      isAdmissible("session.input", "released", { inputAction: "cancel" }),
    ).toBe(true);
    expect(
      isAdmissible("session.input", "released", { inputAction: "select" }),
    ).toBe(false);
    expect(isAdmissible("session.create", "released")).toBe(false);
    expect(isAdmissible("session.prompt", "released")).toBe(false);
    expect(isAdmissible("workspace.adopt", "released")).toBe(false);
  });
});

// Three generations, one active, the middle one pointing at the winner.
async function expectSerialized(runId: string, lastId: string): Promise<void> {
  const rows = await assignmentsFor(runId);

  expect(rows.map((r) => [r.epoch, r.state])).toEqual([
    [1, "superseded"],
    [2, "superseded"],
    [3, "active"],
  ]);
  expect(rows[1].supersededById).toBe(lastId);
  expect((await runRow(runId)).executionAssignmentId).toBe(lastId);
}

// Poll until a backend is parked on a lock inside the statement matching
// `queryPattern` (drizzle binds values as parameters, so ids never appear in
// pg_stat_activity.query — match on the statement shape only).
async function waitForLockWait(queryPattern: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await testDatabase.pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [queryPattern],
    );

    if (rows.length > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const { rows } = await testDatabase.pool.query(
    `SELECT pid, state, wait_event_type, left(query, 160) AS query
       FROM pg_stat_activity
      WHERE datname = current_database() AND state <> 'idle'`,
  );

  throw new Error(
    `no backend parked on a lock for ${queryPattern} in time; activity: ${JSON.stringify(rows)}`,
  );
}
