import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  currentRunResult,
  markRunResultCollected,
  markRunResultStale,
  newestRunResult,
  publishRunResult,
  recordInvalidRunResult,
  resolvePublicResult,
} from "@/lib/run-results/ledger";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: any;
let runId: string;

const CONTRACT: RunResultContract = {
  kind: "flow_export",
  schemaRef: "pkg@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "a".repeat(64),
  required: true,
  producerNodeIds: ["orchestrate"],
  schema: { schemaVersion: 1, fields: [] },
  flowRevisionId: "rev-1",
};

async function seedRun(): Promise<string> {
  const projectId = randomUUID();
  const id = randomUUID();

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
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision")
     VALUES ($1, 'agent', $2, 'Running', 'agent', 'manual')`,
    [id, projectId],
  );

  return id;
}

function publish(value: Record<string, unknown>, producerRef = "orchestrate") {
  return publishRunResult(db, {
    runId,
    value,
    valueBytes: JSON.stringify(value).length,
    contract: CONTRACT,
    producerKind: "flow_node",
    producerRef,
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_results_ledger_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "run_results"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
  runId = await seedRun();
});

// ADR-165 AC-08 / spec C-2, C-3. The ledger's invariants are DATABASE facts as
// much as code ones, so each case exercises the real table — including the
// constraints that must reject a bypass of the publish helper.

describe("publishRunResult (ADR-165)", () => {
  it("assigns revision 1 and marks it valid", async () => {
    const row = await publish({ summary: "one" });

    expect(row.revision).toBe(1);
    expect(row.validity).toBe("valid");
    expect(row.value).toEqual({ summary: "one" });
    expect(row.engineVersion).toBe("3.7.0");
    expect(row.supersededById).toBeNull();
    expect(row.firstCollectedAt).toBeNull();
  });

  it("supersedes the prior revision, linking it to the new one", async () => {
    const first = await publish({ summary: "one" });
    const second = await publish({ summary: "two" });

    expect(second.revision).toBe(2);

    const rows = await pool.query(
      `SELECT id, revision, validity, superseded_by_id, superseded_at
         FROM "run_results" WHERE run_id = $1 ORDER BY revision`,
      [runId],
    );

    expect(rows.rows[0]).toMatchObject({
      id: first.id,
      validity: "superseded",
      superseded_by_id: second.id,
    });
    expect(rows.rows[0].superseded_at).not.toBeNull();
    expect(rows.rows[1]).toMatchObject({ id: second.id, validity: "valid" });
  });

  it("supersedes a STALE row too, so a rework then a re-publish leaves one valid", async () => {
    await publish({ summary: "one" });
    await markRunResultStale(db, runId, ["orchestrate"]);
    await publish({ summary: "two" });

    const rows = await pool.query(
      `SELECT revision, validity FROM "run_results" WHERE run_id = $1 ORDER BY revision`,
      [runId],
    );

    expect(rows.rows.map((r) => r.validity)).toEqual(["superseded", "valid"]);
  });

  it("preserves undeclared nested keys EXACTLY (open JSON)", async () => {
    const value = {
      summary: "s",
      nested: { undeclared: [1, { deep: true }], zero: 0, empty: "" },
    };
    const row = await publish(value);

    expect(row.value).toEqual(value);
  });
});

describe("the database constraints (not just the helper)", () => {
  it("rejects a SECOND valid row inserted around the helper", async () => {
    await publish({ summary: "one" });

    await expect(
      pool.query(
        `INSERT INTO "run_results"
           ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
            "schema_version", "producer_kind", "producer_ref", "value", "value_bytes", "engine_version")
         VALUES ($1, $2, 99, 'valid', 'r', 's', 1, 'flow_node', 'x', '{}'::jsonb, 2, '3.7.0')`,
        [randomUUID(), runId],
      ),
    ).rejects.toThrow(/run_results_one_valid_per_run_uq/);
  });

  it("rejects a duplicate (run_id, revision)", async () => {
    await publish({ summary: "one" });

    await expect(
      pool.query(
        `INSERT INTO "run_results"
           ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
            "schema_version", "producer_kind", "producer_ref", "value", "value_bytes", "engine_version")
         VALUES ($1, $2, 1, 'superseded', 'r', 's', 1, 'flow_node', 'x', '{}'::jsonb, 2, '3.7.0')`,
        [randomUUID(), runId],
      ),
    ).rejects.toThrow(/run_results_run_revision_uq/);
  });

  it("rejects an invalid row carrying a value", async () => {
    await expect(
      pool.query(
        `INSERT INTO "run_results"
           ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
            "schema_version", "producer_kind", "producer_ref", "value", "value_bytes",
            "invalid_reason", "engine_version")
         VALUES ($1, $2, 1, 'invalid', 'r', 's', 1, 'flow_node', 'x', '{}'::jsonb, 2, 'oversize', '3.7.0')`,
        [randomUUID(), runId],
      ),
    ).rejects.toThrow(/run_results_value_shape_check/);
  });

  it("rejects a valid row with NO value, and an invalid row with no reason", async () => {
    await expect(
      pool.query(
        `INSERT INTO "run_results"
           ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
            "schema_version", "producer_kind", "producer_ref", "value", "value_bytes", "engine_version")
         VALUES ($1, $2, 1, 'valid', 'r', 's', 1, 'flow_node', 'x', NULL, 0, '3.7.0')`,
        [randomUUID(), runId],
      ),
    ).rejects.toThrow(/run_results_value_shape_check/);

    await expect(
      pool.query(
        `INSERT INTO "run_results"
           ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
            "schema_version", "producer_kind", "producer_ref", "value", "value_bytes", "engine_version")
         VALUES ($1, $2, 2, 'invalid', 'r', 's', 1, 'flow_node', 'x', NULL, 0, '3.7.0')`,
        [randomUUID(), runId],
      ),
    ).rejects.toThrow(/run_results_invalid_reason_check/);
  });

  it("rejects an unknown validity and an unknown producer kind", async () => {
    for (const [validity, kind, constraint] of [
      ["quarantined", "flow_node", "run_results_validity_check"],
      ["valid", "human", "run_results_producer_kind_check"],
    ] as const) {
      await expect(
        pool.query(
          `INSERT INTO "run_results"
             ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
              "schema_version", "producer_kind", "producer_ref", "value", "value_bytes", "engine_version")
           VALUES ($1, $2, $3, $4, 'r', 's', 1, $5, 'x', '{}'::jsonb, 2, '3.7.0')`,
          [
            randomUUID(),
            runId,
            Math.floor(Math.random() * 1e6),
            validity,
            kind,
          ],
        ),
      ).rejects.toThrow(new RegExp(constraint));
    }
  });

  it("CASCADEs rows when the run is deleted", async () => {
    await publish({ summary: "one" });
    await pool.query(`DELETE FROM "runs" WHERE id = $1`, [runId]);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM "run_results" WHERE run_id = $1`,
      [runId],
    );

    expect(rows.rows[0].n).toBe(0);
  });
});

describe("recordInvalidRunResult", () => {
  it("stores a reason and NO value, and takes the next revision", async () => {
    await publish({ summary: "one" });

    const row = await recordInvalidRunResult(db, {
      runId,
      contract: CONTRACT,
      reason: "schema_mismatch",
      producerKind: "agent_session",
      producerRef: "session:default",
      valueBytes: 42,
    });

    expect(row).toMatchObject({
      revision: 2,
      validity: "invalid",
      value: null,
      invalidReason: "schema_mismatch",
      valueBytes: 42,
    });
    // It does NOT supersede the prior valid row — an invalid publish attempt
    // does not retract an answer the run already gave.
    expect((await currentRunResult(db, runId))?.revision).toBe(1);
    expect((await newestRunResult(db, runId))?.revision).toBe(2);
  });
});

describe("markRunResultStale", () => {
  it("stales the current result only when its OWN producer was staled", async () => {
    await publish({ summary: "one" }, "orchestrate");

    expect(await markRunResultStale(db, runId, ["writer"])).toBe(false);
    expect((await currentRunResult(db, runId))?.validity).toBe("valid");

    expect(await markRunResultStale(db, runId, ["writer", "orchestrate"])).toBe(
      true,
    );
    expect(await currentRunResult(db, runId)).toBeNull();
    expect((await newestRunResult(db, runId))?.validity).toBe("stale");
  });

  it("is a no-op on an empty node list and on a run with no result", async () => {
    expect(await markRunResultStale(db, runId, [])).toBe(false);
    expect(await markRunResultStale(db, runId, ["orchestrate"])).toBe(false);
  });

  it("never stales an AGENT result (it has no node producer)", async () => {
    await publishRunResult(db, {
      runId,
      value: { summary: "s" },
      valueBytes: 16,
      contract: CONTRACT,
      producerKind: "agent_session",
      producerRef: "session:default",
    });

    expect(await markRunResultStale(db, runId, ["session:default"])).toBe(
      false,
    );
    expect((await currentRunResult(db, runId))?.validity).toBe("valid");
  });
});

describe("markRunResultCollected", () => {
  it("is write-once — a second collect never moves the stamp", async () => {
    await publish({ summary: "one" });

    const early = new Date("2026-01-01T00:00:00.000Z");
    const served = (await currentRunResult(db, runId))!;

    expect(await markRunResultCollected(db, runId, served.id, early)).toBe(
      true,
    );
    expect((await currentRunResult(db, runId))?.firstCollectedAt).toEqual(
      early,
    );

    expect(
      await markRunResultCollected(
        db,
        runId,
        served.id,
        new Date("2026-06-01T00:00:00Z"),
      ),
    ).toBe(false);
    expect((await currentRunResult(db, runId))?.firstCollectedAt).toEqual(
      early,
    );
  });

  it("does nothing when the run has no valid result", async () => {
    expect(await markRunResultCollected(db, runId, randomUUID())).toBe(false);
  });

  // The marker is the Lab's ground truth for "the engine served this revision".
  // Keyed on the run alone it would stamp whatever is valid at WRITE time, so a
  // rework landing between the read and the write would credit a revision the
  // caller never received.
  it("does NOT stamp a revision that superseded the one served", async () => {
    await publish({ summary: "one" });
    const servedFirst = (await currentRunResult(db, runId))!;

    // Rework republishes: revision 1 is superseded, revision 2 is now current.
    await publish({ summary: "two" });
    const current = (await currentRunResult(db, runId))!;

    expect(current.id).not.toBe(servedFirst.id);
    expect(await markRunResultCollected(db, runId, servedFirst.id)).toBe(false);
    expect(current.firstCollectedAt).toBeNull();
    expect((await currentRunResult(db, runId))?.firstCollectedAt).toBeNull();
  });
});

describe("resolvePublicResult", () => {
  it("returns the newest row and the valid row, which need not be the same", async () => {
    await publish({ summary: "one" });
    await recordInvalidRunResult(db, {
      runId,
      contract: CONTRACT,
      reason: "oversize",
      producerKind: "flow_node",
      producerRef: "orchestrate",
    });

    const { newest, valid } = await resolvePublicResult(db, runId);

    expect(newest?.revision).toBe(2);
    expect(newest?.validity).toBe("invalid");
    expect(valid?.revision).toBe(1);
  });

  it("returns nulls for a run with no rows", async () => {
    expect(await resolvePublicResult(db, runId)).toEqual({
      newest: null,
      valid: null,
    });
  });
});
