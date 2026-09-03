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

// ADR-165 — the run-detail public-result DTO. Its one job beyond projection is
// that the PAYLOAD is gated on the DERIVED status: a `valid` row can outlive the
// run's usability (a failure-terminal run, or rework that published nothing),
// and `run_collect` already nulls `result` for exactly those cases. Two surfaces
// of one plane must not disagree about whether an answer exists.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => db };
});

let loadRunPublicResult: typeof import("@/lib/runs/run-result-dto").loadRunPublicResult;

async function seedRun(status: string): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision")
     VALUES ($1, 'flow', $2, $3, 'v1', 'rev')`,
    [runId, projectId, status],
  );

  return runId;
}

async function seedResult(args: {
  runId: string;
  revision: number;
  validity: "valid" | "invalid" | "superseded" | "stale";
  value?: Record<string, unknown> | null;
  collected?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO "run_results"
       ("id", "run_id", "revision", "validity", "schema_ref", "schema_version",
        "schema_sha256", "value", "value_bytes", "producer_kind", "producer_ref",
        "invalid_reason", "first_collected_at", "engine_version")
     VALUES ($1, $2, $3, $4, 'pkg@abcdef123456:research-result.v1', 1, $5,
             $6::jsonb, 42, 'flow_node', 'orchestrate', $7, $8, '3.7.0')`,
    [
      randomUUID(),
      args.runId,
      args.revision,
      args.validity,
      "a".repeat(64),
      args.validity === "invalid"
        ? null
        : JSON.stringify(args.value ?? { summary: "an answer" }),
      args.validity === "invalid" ? "schema_mismatch" : null,
      args.collected ? new Date() : null,
    ],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_result_dto_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ loadRunPublicResult } = await import("@/lib/runs/run-result-dto"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "run_results"`);
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

describe("loadRunPublicResult gates the payload on the derived status", () => {
  it("serves the value for a Review run holding a valid result", async () => {
    const runId = await seedRun("Review");

    await seedResult({
      runId,
      revision: 1,
      validity: "valid",
      collected: true,
    });

    const dto = await loadRunPublicResult(db, runId);

    expect(dto?.resultStatus).toBe("valid");
    expect(dto?.value).toEqual({ summary: "an answer" });
    expect(dto?.valueBytes).toBe(42);
    expect(dto?.collectedAt).not.toBeNull();
  }, 60_000);

  it("a FAILED run with a surviving valid row reports unavailable and NO payload", async () => {
    const runId = await seedRun("Failed");

    await seedResult({
      runId,
      revision: 1,
      validity: "valid",
      value: { summary: "the answer nobody should read" },
      collected: true,
    });

    const dto = await loadRunPublicResult(db, runId);

    expect(dto?.resultStatus).toBe("unavailable");
    // The row is still in the ledger — the DTO simply must not serve it.
    expect(dto?.value).toBeNull();
    expect(dto?.valueBytes).toBeNull();
    expect(dto?.collectedAt).toBeNull();
    // The revision is still reported: "there was a result, it is not usable".
    expect(dto?.revision).toBe(1);
  }, 60_000);

  it("a still-RUNNING run reports pending and no payload", async () => {
    const runId = await seedRun("Running");

    await seedResult({ runId, revision: 1, validity: "valid" });

    const dto = await loadRunPublicResult(db, runId);

    expect(dto?.resultStatus).toBe("pending");
    expect(dto?.value).toBeNull();
  }, 60_000);

  it("renders nothing at all for a run with neither contract nor rows", async () => {
    expect(await loadRunPublicResult(db, await seedRun("Review"))).toBeNull();
  }, 60_000);
});
