import type { DelegationBounds } from "@/lib/run-results/types";

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
import { writeDelegationBoundsIfChanged } from "@/lib/orchestrator/bounds-store";
import { promoteNextPending, tryStartRun } from "@/lib/scheduler";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

// ADR-165 AC-26 / AC-27 / AC-28 / AC-29, spec C-10 to C-12. The bounds SNAPSHOT
// and what admission does with it, against the real table and the real advisory
// lock. The ADR-163 admission suite is deliberately left untouched — a
// pre-3.7.0 tree must keep byte-identical env-only semantics, and that suite
// staying green unmodified is the proof.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;

// Two casings on purpose. `DECLARED_BUDGET` is what a MANIFEST carries and is
// the only shape `computeEffectiveDelegationBounds` accepts; `BUDGET` is the
// EFFECTIVE shape, used where a test seeds `delegation_bounds` directly.
const DECLARED_BUDGET = {
  max_tokens: 1_000,
  wall_clock_minutes: 60,
  max_child_runs: 5,
  consecutive_failures: 3,
};

// The advisory-lock namespace `admitDelegatedChild` uses ("dlgt").
const DELEGATION_LOCK_NAMESPACE = 0x646c6774;

const BUDGET = {
  maxTokens: 1_000,
  wallClockMinutes: 60,
  maxChildRuns: 5,
  consecutiveFailures: 3,
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "orch_bounds_test",
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
  delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
});

async function seedRun(args: {
  parentRunId?: string | null;
  rootRunId?: string | null;
  status?: string;
  bounds?: Partial<DelegationBounds> | null;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision",
       "parent_run_id", "root_run_id", "delegation_bounds")
     VALUES ($1, 'flow', $2, $3, 'v1', 'rev', $4, $5, $6::jsonb)`,
    [
      runId,
      projectId,
      args.status ?? "Running",
      args.parentRunId ?? null,
      args.rootRunId ?? args.parentRunId ?? null,
      args.bounds ? JSON.stringify(boundsOf(args.bounds)) : null,
    ],
  );

  return runId;
}

function boundsOf(over: Partial<DelegationBounds>): DelegationBounds {
  return {
    nodeId: "orchestrate",
    nodeAttemptId: randomUUID(),
    engineMin: "3.7.0",
    source: "node",
    maxDepth: 2,
    maxFanout: 6,
    maxActiveChildren: 3,
    budget: null,
    declared: null,
    instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
    ...over,
  };
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

async function boundsRow(runId: string): Promise<DelegationBounds | null> {
  const r = await pool.query(
    `SELECT "delegation_bounds" AS b FROM "runs" WHERE id = $1`,
    [runId],
  );

  return r.rows[0].b;
}

describe("the bounds snapshot (AC-26)", () => {
  it("writes at node start and RETAINS on a wake of the SAME attempt", async () => {
    const runId = await seedRun({});
    const attemptId = randomUUID();
    const args = {
      instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
      engineMin: "3.7.0",
      declared: { max_fanout: 4, budget: DECLARED_BUDGET },
      nodeId: "orchestrate",
      nodeAttemptId: attemptId,
    };

    await writeDelegationBoundsIfChanged(db, runId, args);
    const first = await boundsRow(runId);

    expect(first).toMatchObject({
      source: "node",
      maxDepth: 2,
      maxFanout: 4,
      maxActiveChildren: 3,
      nodeAttemptId: attemptId,
    });

    // A wake re-enters the same code path. The snapshot must NOT move — that is
    // what makes an env edit unable to change a tree already in flight.
    await writeDelegationBoundsIfChanged(db, runId, {
      ...args,
      instance: { maxDepth: 1, maxFanout: 1, flowPool: 1, agentPool: 1 },
    });

    expect(await boundsRow(runId)).toEqual(first);
  });

  it("REWRITES for a new node attempt (a second orchestrator node)", async () => {
    const runId = await seedRun({});
    const base = {
      instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
      engineMin: "3.7.0",
      declared: { max_fanout: 4, budget: DECLARED_BUDGET },
      nodeId: "orchestrate",
      nodeAttemptId: randomUUID(),
    };

    await writeDelegationBoundsIfChanged(db, runId, base);
    await writeDelegationBoundsIfChanged(db, runId, {
      ...base,
      nodeId: "reduce",
      nodeAttemptId: randomUUID(),
      declared: { max_fanout: 2, budget: DECLARED_BUDGET },
    });

    expect(await boundsRow(runId)).toMatchObject({
      nodeId: "reduce",
      maxFanout: 2,
    });
  });

  it("W5: a snapshot written before a session that never started is retained", async () => {
    const runId = await seedRun({});
    const attemptId = randomUUID();

    await writeDelegationBoundsIfChanged(db, runId, {
      instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
      engineMin: "3.7.0",
      declared: { budget: DECLARED_BUDGET },
      nodeId: "orchestrate",
      nodeAttemptId: attemptId,
    });

    // No session, no children — the row simply carries the snapshot, and the
    // next attempt rewrites it.
    expect((await boundsRow(runId))?.nodeAttemptId).toBe(attemptId);
  });

  it("below the floor the snapshot records env-only, ignoring the declaration", async () => {
    const runId = await seedRun({});

    await writeDelegationBoundsIfChanged(db, runId, {
      instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
      engineMin: "3.6.0",
      declared: { max_depth: 1, max_fanout: 1, budget: DECLARED_BUDGET },
      nodeId: "orchestrate",
      nodeAttemptId: randomUUID(),
    });

    expect(await boundsRow(runId)).toMatchObject({
      source: "env",
      maxDepth: 3,
      maxFanout: 16,
      maxActiveChildren: null,
      budget: null,
    });
  });
});

describe("admission reads the snapshot (AC-27)", () => {
  it("a node fan-out of 6 refuses the 7th live child, under a higher env ceiling", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";

    const parentRunId = await seedRun({ bounds: { maxFanout: 6 } });

    for (let i = 0; i < 6; i += 1) {
      await seedRun({ parentRunId, status: "Running" });
    }

    const message = await expectRefused(admit(parentRunId));

    expect(message).toContain("fan-out limit reached (6)");
  });

  it("a node depth of 2 refuses a grandchild's delegation", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "3";

    const root = await seedRun({ bounds: { maxDepth: 2 } });
    const child = await seedRun({ parentRunId: root, rootRunId: root });
    const grandchild = await seedRun({ parentRunId: child, rootRunId: root });

    // depth(child) = 1 < 2 → admitted.
    await expect(admit(child)).resolves.toBeUndefined();
    // depth(grandchild) = 2 = cap → refused.
    const message = await expectRefused(admit(grandchild));

    expect(message).toContain("depth limit reached (2)");
  });

  it("the ENV ceiling still wins when it is the tighter of the two", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    const parentRunId = await seedRun({ bounds: { maxFanout: 6 } });

    await seedRun({ parentRunId, status: "Running" });
    await seedRun({ parentRunId, status: "Running" });

    expect(await expectRefused(admit(parentRunId))).toContain(
      "fan-out limit reached (2)",
    );
  });

  it("a NULL snapshot keeps pure env semantics (a pre-3.7.0 tree)", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    const parentRunId = await seedRun({ bounds: null });

    await seedRun({ parentRunId, status: "Running" });
    await expect(admit(parentRunId)).resolves.toBeUndefined();

    await seedRun({ parentRunId, status: "Running" });
    expect(await expectRefused(admit(parentRunId))).toContain(
      "fan-out limit reached (2)",
    );
  });

  it("changing the env AFTER the snapshot changes no admission outcome", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";

    const parentRunId = await seedRun({ bounds: { maxFanout: 2 } });

    await seedRun({ parentRunId, status: "Running" });
    await seedRun({ parentRunId, status: "Running" });

    // Raising the env ceiling must NOT free the tree — the snapshot binds.
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "99";
    expect(await expectRefused(admit(parentRunId))).toContain(
      "fan-out limit reached (2)",
    );
  });
});

describe("the per-ancestor child-count budget (AC-28)", () => {
  // Every other case in this block seeds `delegation_bounds` directly, so all of
  // them would keep passing if the snapshot WRITER stopped producing a readable
  // budget. This one goes through the writer, from a manifest-shaped declaration
  // — the only path production uses, and the one where the snake_case
  // declaration has to become the camelCase budget admission reads.
  it("binds on a budget that came from a MANIFEST declaration, through the writer", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const parentRunId = await seedRun({});

    await writeDelegationBoundsIfChanged(db, parentRunId, {
      instance: { maxDepth: 5, maxFanout: 16, flowPool: 6, agentPool: 3 },
      engineMin: "3.7.0",
      declared: { budget: { ...DECLARED_BUDGET, max_child_runs: 2 } },
      nodeId: "orchestrate",
      nodeAttemptId: randomUUID(),
    });

    await seedRun({ parentRunId, status: "Done" });
    await seedRun({ parentRunId, status: "Running" });

    expect(await expectRefused(admit(parentRunId))).toContain(
      "max_child_runs 2",
    );
  });

  it("a NESTED orchestrator refuses before the root does", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const root = await seedRun({
      bounds: { maxDepth: 5, budget: { ...BUDGET, maxChildRuns: 5 } },
    });
    const nested = await seedRun({
      parentRunId: root,
      rootRunId: root,
      bounds: { maxDepth: 5, budget: { ...BUDGET, maxChildRuns: 2 } },
    });

    // Two descendants of `nested` (which are also descendants of `root`).
    await seedRun({ parentRunId: nested, rootRunId: root, status: "Done" });
    await seedRun({ parentRunId: nested, rootRunId: root, status: "Running" });

    // root's subtree = nested + 2 = 3, under its cap of 5.
    // nested's subtree = 2 = its cap of 2 → refused, naming the NESTED run.
    const message = await expectRefused(admit(nested));

    expect(message).toContain("child-run budget exhausted");
    expect(message).toContain(nested);
    expect(message).toContain("max_child_runs 2");

    // The root itself still admits — the nested cap is not the root's.
    await expect(admit(root)).resolves.toBeUndefined();
  });

  it("the ROOT budget binds on a descendant admitted through a budget-less parent", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const root = await seedRun({
      bounds: { maxDepth: 5, budget: { ...BUDGET, maxChildRuns: 3 } },
    });
    // A parent with bounds but NO budget of its own.
    const mid = await seedRun({
      parentRunId: root,
      rootRunId: root,
      bounds: { maxDepth: 5, budget: null },
    });

    await seedRun({ parentRunId: mid, rootRunId: root, status: "Running" });
    await seedRun({ parentRunId: mid, rootRunId: root, status: "Running" });

    // root's subtree = mid + 2 = 3 = its cap → the next one is refused even
    // though `mid` declares no budget at all.
    const message = await expectRefused(admit(mid));

    expect(message).toContain(root);
    expect(message).toContain("max_child_runs 3");
  });

  it("counts descendants in ANY status — a terminal child already spent its budget", async () => {
    const root = await seedRun({
      bounds: { budget: { ...BUDGET, maxChildRuns: 2 } },
    });

    await seedRun({ parentRunId: root, status: "Failed" });
    await seedRun({ parentRunId: root, status: "Abandoned" });

    expect(await expectRefused(admit(root))).toContain(
      "child-run budget exhausted",
    );
  });

  // The parent lock alone CANNOT protect this budget: its invariant is scoped to
  // an ANCESTOR's subtree, but two orchestrators in the same tree hash to
  // different lock keys and cannot see each other's uncommitted children. Both
  // would read the same pre-insert count and both admit, blowing the ancestor's
  // cap. Admission therefore serializes on the TREE ROOT before counting.
  it("CROSS-PARENT racers serialize on the tree root, so the ancestor cap holds", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    // The root allows 4 descendants and already has its two coordinators, so
    // exactly 2 remain — and each coordinator below asks for 2.
    const root = await seedRun({
      bounds: { maxDepth: 5, budget: { ...BUDGET, maxChildRuns: 4 } },
    });
    const c1 = await seedRun({
      parentRunId: root,
      rootRunId: root,
      bounds: { maxDepth: 5, budget: null },
    });
    const c2 = await seedRun({
      parentRunId: root,
      rootRunId: root,
      bounds: { maxDepth: 5, budget: null },
    });

    const holder = await pool.connect();
    let racerOutcome: "admitted" | "refused" | "pending" = "pending";

    try {
      await holder.query("BEGIN");
      // A winning admission under c1, in admission's own lock order: its parent
      // first, then the tree root, then its children — none yet committed.
      await holder.query(
        `SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)`,
        [DELEGATION_LOCK_NAMESPACE, c1],
      );
      await holder.query(
        `SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)`,
        [DELEGATION_LOCK_NAMESPACE, root],
      );
      for (let i = 0; i < 2; i += 1) {
        await holder.query(
          `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
           VALUES ($1, 'flow', $2, 'Pending', 'v1', 'rev', $3, $4)`,
          [randomUUID(), projectId, c1, root],
        );
      }

      const racer = admit(c2, 2)
        .then(() => {
          racerOutcome = "admitted";
        })
        .catch((err: unknown) => {
          racerOutcome = isMaisterError(err) ? "refused" : "pending";
          if (racerOutcome !== "refused") throw err;
        });

      await waitForRacerBlockedOnDelegationLock();
      // Parked on the ROOT's lock, under a DIFFERENT parent — without it the
      // racer would sail past on a stale subtree count.
      expect(racerOutcome).toBe("pending");

      await holder.query("COMMIT");
      await racer;
    } finally {
      holder.release();
    }

    expect(racerOutcome).toBe("refused");
    // 2 coordinators + the winner's 2 children = 4, exactly the root's cap.
    expect(
      (
        await pool.query(
          `WITH RECURSIVE t AS (
             SELECT id FROM runs WHERE parent_run_id = $1
             UNION ALL SELECT r.id FROM runs r JOIN t ON r.parent_run_id = t.id)
           SELECT count(*)::int AS n FROM t`,
          [root],
        )
      ).rows[0].n,
    ).toBe(4);
  }, 60_000);

  it("two racers at cap-1: exactly one wins, and no extra row lands", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";

    const root = await seedRun({
      bounds: { budget: { ...BUDGET, maxChildRuns: 2 } },
    });

    await seedRun({ parentRunId: root, status: "Running" });

    const holder = await pool.connect();
    let racerOutcome: "admitted" | "refused" | "pending" = "pending";

    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)`,
        [DELEGATION_LOCK_NAMESPACE, root],
      );
      // The winner's child, not yet visible to the racer.
      await holder.query(
        `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
         VALUES ($1, 'flow', $2, 'Pending', 'v1', 'rev', $3, $3)`,
        [randomUUID(), projectId, root],
      );

      const racer = admit(root)
        .then(() => {
          racerOutcome = "admitted";
        })
        .catch((err: unknown) => {
          racerOutcome = isMaisterError(err) ? "refused" : "pending";
          if (racerOutcome !== "refused") throw err;
        });

      await waitForRacerBlockedOnDelegationLock();
      // Parked on the lock — it has NOT read a stale subtree count.
      expect(racerOutcome).toBe("pending");

      await holder.query("COMMIT");
      await racer;
    } finally {
      holder.release();
    }

    expect(racerOutcome).toBe("refused");
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "runs" WHERE "parent_run_id" = $1`,
          [root],
        )
      ).rows[0].n,
    ).toBe(2);
  }, 60_000);
});

describe("the active-children cap is a QUEUE, not a refusal (AC-29)", () => {
  it("the 4th child of a cap-3 parent stays Pending, and a settling sibling frees it", async () => {
    const parent = await seedRun({
      status: "WaitingOnChildren",
      bounds: { maxActiveChildren: 3 },
    });
    const children: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      children.push(await seedRun({ parentRunId: parent, status: "Pending" }));
    }

    // Start three; the fourth must NOT start.
    for (const runId of children.slice(0, 3)) {
      await expect(tryStartRun(runId, { db })).resolves.toMatchObject({
        started: true,
      });
    }
    await expect(tryStartRun(children[3], { db })).resolves.toMatchObject({
      started: false,
    });
    expect(await statusOf(children[3])).toBe("Pending");

    // A sibling reaching Review frees a slot — Review is slot-FREED, so the
    // queued child is admissible on the next promote.
    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE id = $1`, [
      children[0],
    ]);
    await promoteNextPending({ db });

    expect(await statusOf(children[3])).toBe("Running");
  }, 60_000);

  // The existing cases only promote when a slot HAS freed, so they pass even if
  // the per-parent guard on this edge never runs. This is the case that needs
  // it: the parent stays saturated and an UNRELATED run frees the global slot.
  it("an unrelated run freeing a global slot does NOT promote past a saturated parent", async () => {
    const parent = await seedRun({
      status: "WaitingOnChildren",
      bounds: { maxActiveChildren: 2 },
    });
    const children: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      children.push(await seedRun({ parentRunId: parent, status: "Pending" }));
    }
    for (const runId of children.slice(0, 2)) {
      await expect(tryStartRun(runId, { db })).resolves.toMatchObject({
        started: true,
      });
    }
    await expect(tryStartRun(children[2], { db })).resolves.toMatchObject({
      started: false,
    });

    // An unrelated run (no parent) starts and then settles, freeing a slot in
    // the GLOBAL pool while the parent's own two children are still Running.
    const unrelated = await seedRun({});

    await tryStartRun(unrelated, { db });
    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE id = $1`, [
      unrelated,
    ]);

    await promoteNextPending({ db });

    expect(await statusOf(children[2])).toBe("Pending");

    // ...and once a SIBLING frees a slot, the same edge does promote it.
    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE id = $1`, [
      children[0],
    ]);
    await promoteNextPending({ db });

    expect(await statusOf(children[2])).toBe("Running");
  }, 60_000);

  it("a sibling reaching Done also frees the slot", async () => {
    const parent = await seedRun({
      status: "WaitingOnChildren",
      bounds: { maxActiveChildren: 1 },
    });
    const first = await seedRun({ parentRunId: parent, status: "Running" });
    const queued = await seedRun({ parentRunId: parent, status: "Pending" });

    await expect(tryStartRun(queued, { db })).resolves.toMatchObject({
      started: false,
    });

    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE id = $1`, [
      first,
    ]);
    await promoteNextPending({ db });

    expect(await statusOf(queued)).toBe("Running");
  }, 60_000);

  it("a NULL snapshot imposes no per-orchestrator cap at all", async () => {
    const parent = await seedRun({ status: "WaitingOnChildren", bounds: null });
    const children: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      children.push(await seedRun({ parentRunId: parent, status: "Pending" }));
    }
    for (const runId of children) {
      await expect(tryStartRun(runId, { db })).resolves.toMatchObject({
        started: true,
      });
    }
  }, 60_000);

  it("the GLOBAL pool cap still applies, and the lower of the two wins", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "2";

    // The parent is PARKED: `WaitingOnChildren` is slot-freed, so it does not
    // itself consume one of the two pool slots under test.
    const parent = await seedRun({
      status: "WaitingOnChildren",
      bounds: { maxActiveChildren: 3 },
    });
    const children: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      children.push(await seedRun({ parentRunId: parent, status: "Pending" }));
    }

    await expect(tryStartRun(children[0], { db })).resolves.toMatchObject({
      started: true,
    });
    await expect(tryStartRun(children[1], { db })).resolves.toMatchObject({
      started: true,
    });
    // Pool cap 2 < node cap 3 → the third queues on the POOL, not the node.
    await expect(tryStartRun(children[2], { db })).resolves.toMatchObject({
      started: false,
    });
  }, 60_000);
});

async function statusOf(runId: string): Promise<string> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE id = $1`, [
    runId,
  ]);

  return r.rows[0].status;
}

// Polls until a backend is blocked on OUR advisory lock class.
async function waitForRacerBlockedOnDelegationLock(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await pool.query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND classid = $1::int`,
      [DELEGATION_LOCK_NAMESPACE],
    );

    if (rows.length > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    "the second admission never blocked on the delegation advisory lock",
  );
}
