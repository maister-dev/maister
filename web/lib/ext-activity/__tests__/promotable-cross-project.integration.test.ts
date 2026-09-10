// T2.3 — cross-project promotable candidates in ONE bulk readiness pass.
//
// `listProjectPromotable` already batches readiness per project. Calling it
// once per project would restore the per-project N that the cross-project
// decision queue must not have, so the split is candidate-loader + classifier
// with a single `computeReadinessByRun` invocation for the whole set.
//
// The invocation COUNT is the assertion. A test that only checked the returned
// items would pass just as happily against a per-project loop.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// A counting passthrough, not a stub: the real classifier still runs, so the
// count means "how many bulk passes", not "how many times a fake was poked".
const readiness = { calls: 0, runIdBatches: [] as string[][] };

vi.mock("@/lib/queries/readiness-batch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/readiness-batch")>();

  return {
    ...actual,
    computeReadinessByRun: async (
      client: Parameters<typeof actual.computeReadinessByRun>[0],
      runIds: string[],
    ) => {
      readiness.calls += 1;
      readiness.runIdBatches.push([...runIds]);

      return actual.computeReadinessByRun(client, runIds);
    },
  };
});

import {
  listProjectPromotable,
  listPromotableForProjects,
} from "@/lib/ext-activity/promotable";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const fx = {
  projectA: randomUUID(),
  projectB: randomUUID(),
  runA1: randomUUID(),
  runA2: randomUUID(),
  runB1: randomUUID(),
  // Held by an operator — Layer 2 must still drop it.
  runHeld: randomUUID(),
};

async function seedProject(
  projectId: string,
  slug: string,
  key: string,
): Promise<void> {
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
    [projectId, slug, `/tmp/${slug}`, key],
  );
}

async function seedReviewRun(
  runId: string,
  projectId: string,
  opts: { hold?: boolean } = {},
): Promise<void> {
  await pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision, promotion_hold)
     values ($1, $2, 'flow', 'Review', 'v1', 'manual', $3)`,
    [
      runId,
      projectId,
      opts.hold === true
        ? JSON.stringify({
            reason: "operator hold",
            heldAt: new Date().toISOString(),
          })
        : null,
    ],
  );
  // Two workspace rows for one run: `workspaces.run_id` has no UNIQUE
  // constraint, so the left join is one-to-many and the de-dup must survive.
  for (const path of [`/tmp/ws-${runId}-a`, `/tmp/ws-${runId}-b`]) {
    await pool.query(
      `insert into workspaces
         (id, run_id, project_id, worktree_path, parent_repo_path, branch, target_branch)
       values ($1, $2, $3, $4, '/tmp/parent-repo', $5, 'main')`,
      [randomUUID(), runId, projectId, path, `b/${runId}`],
    );
  }
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "promotable_cross_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  await seedProject(fx.projectA, "promo-a", "PMA");
  await seedProject(fx.projectB, "promo-b", "PMB");
  await seedReviewRun(fx.runA1, fx.projectA);
  await seedReviewRun(fx.runA2, fx.projectA);
  await seedReviewRun(fx.runB1, fx.projectB);
  await seedReviewRun(fx.runHeld, fx.projectA, { hold: true });
});

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(() => {
  readiness.calls = 0;
  readiness.runIdBatches = [];
});

describe("listPromotableForProjects runs ONE readiness pass", () => {
  it("invokes computeReadinessByRun exactly once for a two-project set", async () => {
    await listPromotableForProjects([fx.projectA, fx.projectB]);

    expect(readiness.calls).toBe(1);
  });

  it("passes every project's candidates in that single batch", async () => {
    await listPromotableForProjects([fx.projectA, fx.projectB]);

    const batch = readiness.runIdBatches[0] ?? [];

    expect(batch).toContain(fx.runA1);
    expect(batch).toContain(fx.runA2);
    expect(batch).toContain(fx.runB1);
  });

  it("de-duplicates a run carrying two workspace rows", async () => {
    await listPromotableForProjects([fx.projectA, fx.projectB]);

    const batch = readiness.runIdBatches[0] ?? [];

    expect(new Set(batch).size).toBe(batch.length);
  });

  it("issues no readiness pass at all for an empty project set", async () => {
    const items = await listPromotableForProjects([]);

    expect(items).toEqual([]);
    expect(readiness.calls).toBe(0);
  });

  it("never surfaces an operator-held run (Layer 2 survives the split)", async () => {
    const items = await listPromotableForProjects([fx.projectA, fx.projectB]);

    expect(items.map((item) => item.runId)).not.toContain(fx.runHeld);
  });

  it("carries the owning project on each item, for a cross-project queue", async () => {
    await listPromotableForProjects([fx.projectA, fx.projectB]);

    const batch = readiness.runIdBatches[0] ?? [];

    // Candidates from BOTH projects reached one pass, which is the property a
    // per-project loop cannot have.
    expect(batch.length).toBeGreaterThanOrEqual(3);
  });
});

describe("listProjectPromotable stays a thin wrapper", () => {
  it("still batches readiness once for a single project", async () => {
    await listProjectPromotable(fx.projectA);

    expect(readiness.calls).toBe(1);
  });

  it("returns only the requested project's candidates", async () => {
    await listProjectPromotable(fx.projectB);

    const batch = readiness.runIdBatches[0] ?? [];

    expect(batch).toContain(fx.runB1);
    expect(batch).not.toContain(fx.runA1);
  });

  it("projects exactly the public item shape, with no project id leaking in", async () => {
    await listProjectPromotable(fx.projectA);
    const items = await listProjectPromotable(fx.projectA);

    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "inReviewSince",
          "readiness",
          "runId",
          "targetBranch",
          "taskId",
          "taskKey",
          "taskTitle",
        ].sort(),
      );
    }
  });
});
