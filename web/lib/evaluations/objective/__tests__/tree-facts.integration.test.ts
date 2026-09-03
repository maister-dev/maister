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

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-165 AC-39 — the tree facts against a REAL seeded depth-2 tree, and the
// exact measures the protocol promises. The pure arms are table-tested in
// lib/evaluations/__tests__/objective-tree-providers.test.ts; this file exists
// because the recursive CTE is where a measure silently starts describing a
// different tree than its siblings.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => db };
});

let loadObjectiveTreeFacts: typeof import("@/lib/evaluations/objective/tree-source").loadObjectiveTreeFacts;
let evaluateObjectiveCheck: typeof import("@/lib/evaluations/objective/providers").evaluateObjectiveCheck;

async function seedRun(args: {
  id?: string;
  parentRunId?: string | null;
  rootRunId?: string | null;
  status?: string;
  startedAt?: Date;
  endedAt?: Date | null;
}): Promise<string> {
  const runId = args.id ?? randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision",
       "parent_run_id", "root_run_id", "started_at", "ended_at")
     VALUES ($1, 'flow', $2, $3, 'v1', 'rev', $4, $5, $6, $7)`,
    [
      runId,
      projectId,
      args.status ?? "Done",
      args.parentRunId ?? null,
      args.rootRunId ?? null,
      args.startedAt ?? new Date("2026-01-01T00:00:00Z"),
      args.endedAt === undefined
        ? new Date("2026-01-01T00:20:00Z")
        : args.endedAt,
    ],
  );

  return runId;
}

async function seedResult(args: {
  runId: string;
  validity: "valid" | "invalid" | "stale" | "superseded";
  collected?: boolean;
  invalidReason?: string;
  value?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO "run_results"
       ("id", "run_id", "revision", "validity", "schema_ref", "schema_version", "schema_sha256",
        "value", "value_bytes", "producer_kind", "producer_ref", "invalid_reason",
        "first_collected_at", "engine_version")
     VALUES ($1, $2, 1, $3, 'pkg@abcdef123456:research-result.v1', 1, $4,
             $5::jsonb, 10, 'flow_node', 'orchestrate', $6, $7, '3.7.0')`,
    [
      randomUUID(),
      args.runId,
      args.validity,
      "a".repeat(64),
      // The `run_results_value_shape_check` CHECK ties the two: a `valid` row
      // MUST carry a value, an `invalid` row must not.
      args.validity === "invalid"
        ? null
        : JSON.stringify(args.value ?? { summary: "a finding" }),
      args.invalidReason ?? null,
      args.collected ? new Date() : null,
    ],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "objective_tree_facts_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ loadObjectiveTreeFacts } = await import(
    "@/lib/evaluations/objective/tree-source"
  ));
  ({ evaluateObjectiveCheck } = await import(
    "@/lib/evaluations/objective/providers"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "run_results"`);
  await pool.query(`DELETE FROM "node_attempts"`);
  await pool.query(`DELETE FROM "run_cost_rollups"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
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
});

/**
 * The AC-39 tree, exactly as the acceptance criterion words it: one invalid
 * result, one crash, one rework, two of three valid results collected, and a
 * root whose `consumedChildRunIds` names ONE collected child plus a fabricated
 * id.
 */
async function seedAc39Tree(): Promise<{ rootId: string; validIds: string[] }> {
  // The self-FK on `parent_run_id` means the root row must exist first.
  const rootId = await seedRun({
    startedAt: new Date("2026-01-01T00:00:00Z"),
    endedAt: new Date("2026-01-01T00:30:00Z"),
  });
  const c1 = await seedRun({ parentRunId: rootId, rootRunId: rootId });
  const c2 = await seedRun({ parentRunId: rootId, rootRunId: rootId });
  const c3 = await seedRun({ parentRunId: rootId, rootRunId: rootId });
  const c4 = await seedRun({
    parentRunId: rootId,
    rootRunId: rootId,
    status: "Crashed",
  });

  // Two GRANDCHILDREN — the count is over the whole subtree, not one level.
  await seedRun({ parentRunId: c1, rootRunId: rootId });
  await seedRun({ parentRunId: c1, rootRunId: rootId });

  await seedResult({ runId: c1, validity: "valid", collected: true });
  await seedResult({ runId: c2, validity: "valid", collected: true });
  await seedResult({ runId: c3, validity: "valid", collected: false });
  await seedResult({
    runId: c4,
    validity: "invalid",
    invalidReason: "result_missing",
  });

  // One reworked node attempt somewhere in the tree.
  await pool.query(
    `INSERT INTO "node_attempts" ("id", "run_id", "node_id", "node_type", "attempt", "status")
     VALUES ($1, $2, 'implement', 'ai_coding', 1, 'Reworked')`,
    [randomUUID(), c2],
  );

  // The root's own result: names one COLLECTED child and one id that never was.
  await seedResult({
    runId: rootId,
    validity: "valid",
    value: { consumedChildRunIds: [c1, randomUUID()] },
  });

  await pool.query(
    `INSERT INTO "run_cost_rollups"
       ("run_id", "project_id", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens")
     VALUES ($1, $2, 100, 0, 0, 0), ($3, $2, 200, 0, 0, 0)`,
    [rootId, projectId, c1],
  );

  return { rootId, validIds: [c1, c2, c3] };
}

describe("loadObjectiveTreeFacts over the AC-39 tree", () => {
  it("reports every measure from ONE tree, with exact values", async () => {
    const { rootId, validIds } = await seedAc39Tree();
    const facts = await loadObjectiveTreeFacts(rootId, db as never);

    expect(facts).toBeTruthy();
    expect(facts!.childRunCount).toBe(6);
    expect(facts!.invalidResultCount).toBe(1);
    expect(facts!.crashCount).toBe(1);
    expect(facts!.reworkCount).toBe(1);
    expect([...facts!.validResultChildRunIds].sort()).toEqual(
      [...validIds].sort(),
    );
    expect(facts!.collectedChildRunIds).toHaveLength(2);
    // The root's OWN result row is not a child result — the ratios are over
    // children, and counting the root would make every tree look better.
    expect(facts!.validResultChildRunIds).not.toContain(rootId);
    // The root's tokens are included in the tree total (100 + 200).
    expect(facts!.treeTokens).toBe(300);
    expect(facts!.treeWallClockMinutes).toBeGreaterThanOrEqual(20);
  }, 60_000);

  it("yields 2/3 collected and 1/3 consumed — the fabricated id is excluded", async () => {
    const { rootId } = await seedAc39Tree();
    const tree = await loadObjectiveTreeFacts(rootId, db as never);
    const measure = (provider: string): Record<string, unknown> =>
      evaluateObjectiveCheck(
        { id: "c", provider: provider as never, policy: "metric" },
        { tree: tree! },
      ).metric!.value;

    expect(measure("collected_results_ratio@1")).toMatchObject({
      collected: 2,
      valid: 3,
    });
    expect(measure("consumed_results_ratio@1")).toMatchObject({
      consumed: 1,
      valid: 3,
    });
    expect(measure("child_run_count@1")).toEqual({ count: 6 });
    expect(measure("result_validation_failures@1")).toEqual({ count: 1 });
    expect(measure("crash_count@1")).toEqual({ count: 1 });
    expect(measure("rework_count@1")).toEqual({ count: 1 });
    expect(measure("tree_tokens@1")).toEqual({ tokens: 300 });
  }, 60_000);

  // A depth-2 tree: the root can only ever collect its DIRECT children, so a
  // grandchild's valid result must not sit in the ratio denominator. Counting it
  // would make the d2 arm structurally unable to score what the d1 arm scores —
  // in the very comparison the Lab protocol exists to run.
  it("scopes the ratio denominator to DIRECT children, not the whole subtree", async () => {
    const rootId = await seedRun({});
    const child = await seedRun({ parentRunId: rootId, rootRunId: rootId });
    const grandchild = await seedRun({ parentRunId: child, rootRunId: rootId });

    await seedResult({ runId: child, validity: "valid", collected: true });
    await seedResult({ runId: grandchild, validity: "valid", collected: true });
    await seedResult({
      runId: rootId,
      validity: "valid",
      value: { consumedChildRunIds: [child] },
    });

    const tree = await loadObjectiveTreeFacts(rootId, db as never);

    // The grandchild counts toward the SUBTREE size...
    expect(tree!.childRunCount).toBe(2);
    // ...but not toward what the root could have collected.
    expect(tree!.validResultChildRunIds).toEqual([child]);
    expect(tree!.collectedChildRunIds).toEqual([child]);

    const value = evaluateObjectiveCheck(
      { id: "c", provider: "consumed_results_ratio@1", policy: "metric" },
      { tree: tree! },
    ).metric!.value;

    // A perfect score: the root collected and consumed the one result it could.
    expect(value).toMatchObject({ consumed: 1, valid: 1, ratio: 1 });
  }, 60_000);

  it("returns null for a run that has a PARENT — a flat arm has no tree", async () => {
    const rootId = await seedRun({});
    const child = await seedRun({ parentRunId: rootId, rootRunId: rootId });

    expect(await loadObjectiveTreeFacts(child, db as never)).toBeNull();
  }, 60_000);

  it("a childless root still reports a tree, with zeroed counts and no ratios", async () => {
    const rootId = await seedRun({});
    const facts = await loadObjectiveTreeFacts(rootId, db as never);

    expect(facts).toMatchObject({
      childRunCount: 0,
      invalidResultCount: 0,
      validResultChildRunIds: [],
    });
    // No valid child results ⇒ the ratios are UNDEFINED, not zero.
    expect(
      evaluateObjectiveCheck(
        { id: "c", provider: "collected_results_ratio@1", policy: "metric" },
        { tree: facts! },
      ).status,
    ).toBe("unavailable");
  }, 60_000);

  it("a root whose result names NOTHING scores 0 consumed, not unavailable", async () => {
    const rootId = await seedRun({});
    const child = await seedRun({ parentRunId: rootId, rootRunId: rootId });

    await seedResult({ runId: child, validity: "valid", collected: true });
    await seedResult({
      runId: rootId,
      validity: "valid",
      value: { summary: "x" },
    });

    const tree = await loadObjectiveTreeFacts(rootId, db as never);

    expect(tree!.consumedChildRunIds).toEqual([]);
    expect(
      evaluateObjectiveCheck(
        { id: "c", provider: "consumed_results_ratio@1", policy: "metric" },
        { tree: tree! },
      ).metric!.value,
    ).toMatchObject({ consumed: 0, valid: 1 });
  }, 60_000);
});
