// B6 (ADR-177 amendment 2026-09-26), T4.2: the terminal cause is derived on
// read from the run's newest terminal event of the KIND its status names —
// never the newest terminal event of any kind — with a legacy synthesis for an
// event written before `cause` existed, and a scratch fallback for the
// project-less runs that emit no event at all.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  loadRunTerminalCause,
  loadScratchTerminalCause,
} from "@/lib/runs/terminal-cause";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "terminal_cause_read",
  });
  db = testDatabase.db;
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `read-${projectId.slice(0, 8)}`,
    name: "Read",
    taskKey: `R${projectId.slice(0, 7)}`.toUpperCase(),
    repoPath: `/tmp/read-${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedRun(status: string): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    flowVersion: "v1",
    status,
  });

  return runId;
}

async function event(
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  await db.insert(schema.domainEvents).values({
    kind,
    projectId,
    runId,
    payload,
    occurredAt,
  });
}

describe("loadRunTerminalCause (D-B3)", () => {
  it("reads the newest event of the kind the status names", async () => {
    const runId = await seedRun("Failed");

    await event(
      runId,
      "run.failed",
      { cause: { code: "CRASH", reason: "old", source: "graph" } },
      new Date("2026-09-26T10:00:00Z"),
    );
    await event(
      runId,
      "run.failed",
      {
        cause: {
          code: "BUDGET_EXCEEDED",
          reason: "budget_breach",
          source: "sweeper",
        },
      },
      new Date("2026-09-26T11:00:00Z"),
    );

    expect(await loadRunTerminalCause(db, runId, "Failed")).toEqual({
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "sweeper",
    });
  });

  it("a run that crashed, recovered and then failed reads its run.failed, never the older crash", async () => {
    const runId = await seedRun("Failed");

    await event(
      runId,
      "run.crashed",
      { cause: { code: "CRASH", reason: "turn_lost", source: "graph" } },
      new Date("2026-09-26T10:00:00Z"),
    );

    // The newest matching kind is absent: null, not the wrong cause.
    expect(await loadRunTerminalCause(db, runId, "Failed")).toBeNull();
    await event(
      runId,
      "run.failed",
      { cause: { code: "CONFIG", reason: "result_missing", source: "graph" } },
      new Date("2026-09-26T11:00:00Z"),
    );
    expect(await loadRunTerminalCause(db, runId, "Failed")).toEqual({
      code: "CONFIG",
      reason: "result_missing",
      source: "graph",
    });
  });

  it("synthesizes a legacy cause from a pre-change event's own keys", async () => {
    const runId = await seedRun("Failed");

    await event(
      runId,
      "run.failed",
      { reason: "HITL_TIMEOUT" },
      new Date("2026-09-26T10:00:00Z"),
    );

    expect(await loadRunTerminalCause(db, runId, "Failed")).toEqual({
      code: "HITL_TIMEOUT",
      source: "legacy",
    });
  });

  it("a legacy reason is read as a token, and prose never reaches the cause", async () => {
    const hyphenated = await seedRun("Crashed");
    const prose = await seedRun("Crashed");

    await event(
      hyphenated,
      "run.crashed",
      { reason: "worktree-gone", errorCode: "CRASH" },
      new Date("2026-09-26T10:00:00Z"),
    );
    await event(
      prose,
      "run.crashed",
      { reason: "reconcile: agent-session-gone (observer gave up)" },
      new Date("2026-09-26T10:00:00Z"),
    );

    expect(await loadRunTerminalCause(db, hyphenated, "Crashed")).toEqual({
      code: "CRASH",
      reason: "worktree_gone",
      source: "legacy",
    });
    expect(await loadRunTerminalCause(db, prose, "Crashed")).toEqual({
      code: null,
      source: "legacy",
    });
  });

  it("is null for a run that did not end Failed, Crashed or Abandoned", async () => {
    const runId = await seedRun("Done");

    await event(runId, "run.done", {}, new Date());
    expect(await loadRunTerminalCause(db, runId, "Done")).toBeNull();
  });

  it("the read is served by domain_events_run_terminal_idx (T4.0, migration 0181)", async () => {
    const runIds = await Promise.all(
      Array.from({ length: 20 }, () => seedRun("Failed")),
    );

    // 20 runs x 200 events of every kind: large enough that a scan loses.
    await testDatabase.pool.query(
      `INSERT INTO domain_events (kind, project_id, run_id, payload, occurred_at)
       SELECT (ARRAY['run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review'])[1 + n % 5],
              $1, r, '{}'::jsonb, now() - (n || ' seconds')::interval
       FROM unnest($2::text[]) AS r, generate_series(1, 200) AS n`,
      [projectId, runIds],
    );
    await testDatabase.pool.query("ANALYZE domain_events");
    const { rows } = await testDatabase.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT payload FROM domain_events
       WHERE run_id = $1 AND kind = 'run.failed'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [runIds[7]],
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");

    expect(plan).toContain("domain_events_run_terminal_idx");
    // The index serves the ORDER BY, so no sort step.
    expect(plan).not.toContain("Sort");
  });

  it("a project-less scratch run with no event falls back to the dialog's own code", async () => {
    const runId = await seedRun("Crashed");

    expect(
      await loadScratchTerminalCause(db, runId, "Crashed", "ACP_PROTOCOL"),
    ).toEqual({ code: "ACP_PROTOCOL", source: "scratch" });
    expect(
      await loadScratchTerminalCause(db, runId, "Running", "ACP_PROTOCOL"),
    ).toBeNull();
    // A stop after a retryable failure leaves its code on the dialog: the
    // abandon was the operator's, never that error.
    expect(
      await loadScratchTerminalCause(
        db,
        await seedRun("Abandoned"),
        "Abandoned",
        "EXECUTOR_UNAVAILABLE",
      ),
    ).toBeNull();
  });
});
