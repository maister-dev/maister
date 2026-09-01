import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

// ADR-163 REQ-15: depth AND fan-out are enforced before any child record is
// created, on EVERY creation edge, and the check is not defeated by
// concurrency. The cap is SHARED across both child kinds (D3) — an orchestrator
// is bounded, not one call to one route.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

let projectId: string;
let executorId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "orch_admission_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "run_sessions"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
});

afterEach(() => {
  delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  delete process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH;
});

async function seedRun(args: {
  parentRunId?: string | null;
  runKind?: "flow" | "agent";
  status?: string;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
     VALUES ($1, $2, $3, $4, 'v1', 'rev', $5, $5)`,
    [
      runId,
      args.runKind ?? "agent",
      projectId,
      args.status ?? "Running",
      args.parentRunId ?? null,
    ],
  );

  return runId;
}

async function admit(parentRunId: string, incoming = 1): Promise<void> {
  await (db as any).transaction(async (tx: unknown) => {
    await admitDelegatedChild(tx, { parentRunId, incoming });
  });
}

async function expectRefused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CONFIG");

    return (err as { message: string }).message;
  }

  throw new Error("expected admitDelegatedChild to refuse, but it admitted");
}

describe("admitDelegatedChild (ADR-163 REQ-15)", () => {
  it("counts a MIXED set of live agent + flow children against ONE shared cap", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "3";

    const parentRunId = await seedRun({});

    await seedRun({ parentRunId, runKind: "agent", status: "Running" });
    await seedRun({ parentRunId, runKind: "flow", status: "Review" });
    await seedRun({ parentRunId, runKind: "flow", status: "Pending" });

    const runsBefore = (
      await pool.query(`SELECT count(*)::int AS n FROM "runs"`)
    ).rows[0].n;

    const message = await expectRefused(admit(parentRunId));

    expect(message).toContain("fan-out limit reached (3)");
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(runsBefore);
  });

  it("`Review` counts as LIVE for the cap even though it counts as SETTLED for the wake", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";

    const parentRunId = await seedRun({});

    await seedRun({ parentRunId, runKind: "flow", status: "Review" });

    await expectRefused(admit(parentRunId));
  });

  it("a TERMINAL child frees capacity", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";

    const parentRunId = await seedRun({});
    const childRunId = await seedRun({ parentRunId, status: "Running" });

    await expectRefused(admit(parentRunId));

    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      childRunId,
    ]);

    await expect(admit(parentRunId)).resolves.toBeUndefined();
  });

  it("refuses a batch whose SIZE would cross the cap, even when each child alone fits", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "3";

    const parentRunId = await seedRun({});

    await seedRun({ parentRunId, status: "Running" });

    // 1 live + 3 incoming = 4 > 3. The pre-ADR-163 `run_plan` bound compared
    // ONLY the batch length against the cap, so this batch was admitted.
    await expectRefused(admit(parentRunId, 3));

    // 1 live + 2 incoming = 3 fits exactly.
    await expect(admit(parentRunId, 2)).resolves.toBeUndefined();
  });

  it("refuses when the parent chain is already at the depth bound", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "2";

    const r0 = await seedRun({});
    const r1 = await seedRun({ parentRunId: r0 });
    const r2 = await seedRun({ parentRunId: r1 });

    const message = await expectRefused(admit(r2));

    expect(message).toContain("depth limit reached (2)");

    // One level up is still inside the bound.
    await expect(admit(r1)).resolves.toBeUndefined();
  });

  // A single-threaded "call it twice" proves nothing about a lock: it would
  // pass even with no lock at all, because the first call's transaction has
  // already committed. This holds an UNCOMMITTED admission open on a second
  // connection, waits until the racer is genuinely parked on that lock in
  // pg_stat_activity, and only then commits — so the second admission's count
  // provably runs AFTER the first one's insert.
  it("two concurrent admissions at cap-1: exactly one wins, the loser is refused", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    const parentRunId = await seedRun({});

    await seedRun({ parentRunId, status: "Running" }); // 1 live, cap 2

    const holder = await pool.connect();
    let racerOutcome: "admitted" | "refused" | "pending" = "pending";

    try {
      await holder.query("BEGIN");
      // The same lock the helper takes, on the same key.
      await holder.query(
        `SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)`,
        [0x646c6774, parentRunId],
      );
      // The winner's child, not yet visible to anyone else.
      await holder.query(
        `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
         VALUES ($1, 'flow', $2, 'Pending', 'v1', 'rev', $3, $3)`,
        [randomUUID(), projectId, parentRunId],
      );

      const racer = admit(parentRunId)
        .then(() => {
          racerOutcome = "admitted";
        })
        .catch((err: unknown) => {
          racerOutcome = isMaisterError(err) ? "refused" : "pending";
          if (racerOutcome !== "refused") throw err;
        });

      await waitForRacerBlockedOnDelegationLock();

      // Still parked — it has NOT read a stale count and sailed through.
      expect(racerOutcome).toBe("pending");

      await holder.query("COMMIT");
      await racer;
    } finally {
      holder.release();
    }

    // 1 pre-existing + 1 winner = 2 = cap ⇒ the racer must lose.
    expect(racerOutcome).toBe("refused");

    const live = (
      await pool.query(
        `SELECT count(*)::int AS n FROM "runs" WHERE "parent_run_id" = $1`,
        [parentRunId],
      )
    ).rows[0].n;

    expect(live).toBe(2);
  }, 60_000);
});

// Poll until a backend is blocked on OUR advisory lock. `pg_locks` names the
// advisory class explicitly, so this cannot be confused with an unrelated
// row-lock wait elsewhere in the suite.
async function waitForRacerBlockedOnDelegationLock(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await pool.query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND classid = $1::int`,
      [0x646c6774],
    );

    if (rows.length > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    "the second admission never blocked on the delegation advisory lock",
  );
}
