import type { SupervisorEvent } from "@/lib/execution-host";
import type { RunResultContract, RunResultRow } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { asc, eq } from "drizzle-orm";
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
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { fakeAgentExecution } from "@/test-support/fake-execution-host";
import {
  operationalContractFixture,
  operationalSuccessFixture,
  operationalBlockedFixture,
} from "@/test-support/operational-agent";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "@/lib/agents/operational-integrity";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let runnerId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let consumeAgentSession: typeof import("@/lib/agents/launch").consumeAgentSession;

const OPEN = "```json maister:output";
const CLOSE = "```";

const CONTRACT: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "rah@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "f".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [
      { name: "summary", type: "string", required: true },
      {
        name: "outcome",
        type: "enum",
        required: true,
        options: ["completed", "blocked"],
      },
      { name: "payload", type: "json" },
    ],
  },
  sourceFlowRevisionId: "rev-1",
};

/**
 * A scripted supervisor stream. `events` are yielded in order, so a test can
 * drive a permission round-trip (which RESETS the per-turn buffer) as well as a
 * plain single-turn exit.
 */
// ADR-166: the consumer's execution seam is a DB-less fake host whose stream
// yields `events` in order (a permission round-trip included).
function scriptedApi(events: unknown[]) {
  return fakeAgentExecution({ events: events as SupervisorEvent[] });
}

function chunk(text: string): unknown {
  return {
    type: "session.update",
    sessionId: "sup-1",
    monotonicId: 1,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function exited(exitCode = 0): unknown {
  return {
    type: "session.exited",
    sessionId: "sup-1",
    monotonicId: 9,
    exitCode,
  };
}

async function seedAgentRun(args: {
  contract: RunResultContract | null;
  parentRunId?: string | null;
  kind?: "operational";
  workspace?: "none" | "worktree";
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision",
       "result_contract", "parent_run_id", "root_run_id", "agent_workspace", "agent_kind")
     VALUES ($1, 'agent', $2, 'Running', 'agent', 'manual', $3::jsonb, $4, $4, $5, $6)`,
    [
      runId,
      projectId,
      args.contract ? JSON.stringify(args.contract) : null,
      args.parentRunId ?? null,
      args.workspace ?? "none",
      args.kind ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_snapshot", "runner_id")
     VALUES ($1, $2, 'default', '{"capabilityAgent":"claude"}'::jsonb, $3)`,
    [randomUUID(), runId, runnerId],
  );

  return runId;
}

async function getStatus(runId: string): Promise<string> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE id = $1`, [
    runId,
  ]);

  return r.rows[0].status;
}

async function getResults(runId: string): Promise<RunResultRow[]> {
  return (await db
    .select()
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, runId))
    .orderBy(asc(schema.runResults.revision))) as unknown as RunResultRow[];
}

async function getEvents(
  runId: string,
): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  const r = await pool.query(
    `SELECT "kind", "payload" FROM "domain_events" WHERE "run_id" = $1`,
    [runId],
  );

  return r.rows;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_run_result_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ consumeAgentSession } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "domain_events",
    "webhook_events",
    "execution_commands",
    "runs",
    "run_results",
    "run_sessions",
    "projects",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }
  projectId = randomUUID();
  runnerId = randomUUID();
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
    .values(testPlatformRunnerRow(runnerId, "claude"));
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function seedOperationalRun(): Promise<{ runId: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "operational-result-"));

  temporaryRoots.push(root);
  const repo = join(root, "repo");
  const cwd = join(root, "worktree");

  await mkdir(repo);
  const exec = promisify(execFile);
  const git = async (...args: string[]): Promise<void> => {
    await exec("git", ["-C", repo, ...args]);
  };

  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "source.ts"), "export const value = 1;\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Operation",
    "-c",
    "user.email=operation@example.test",
    "commit",
    "-qm",
    "initial",
  );
  const runId = await seedAgentRun({
    contract: operationalContractFixture(),
    kind: "operational",
    workspace: "worktree",
  });

  await git("worktree", "add", "-q", "-b", `operation-${runId}`, cwd);
  const baseline = await captureOperationalGeneration(
    cwd,
    await captureOperationalBaseline(cwd, "worktree"),
    [],
  );

  await pool.query("UPDATE projects SET repo_path = $2 WHERE id = $1", [
    projectId,
    repo,
  ]);
  await pool.query(
    "UPDATE runs SET operational_integrity_baseline = $2::jsonb WHERE id = $1",
    [runId, JSON.stringify(baseline)],
  );
  await pool.query(
    "INSERT INTO workspaces(id,run_id,project_id,branch,worktree_path,parent_repo_path,base_commit) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      runId,
      projectId,
      `operation-${runId}`,
      cwd,
      repo,
      baseline.head,
    ],
  );

  return { runId, cwd };
}

async function finishOperational(runId: string, text: string): Promise<void> {
  await consumeAgentSession({
    db,
    execution: scriptedApi([chunk(text), exited(0)]),
    runId,
    sessionId: "sup-1",
  });
}

describe("operational result contract", () => {
  it.each([0, 1])(
    "IT-OPR-01 completes a worktree operation with %i created tasks as Done without delivery",
    async (created) => {
      const { runId } = await seedOperationalRun();
      const value = {
        ...operationalSuccessFixture(),
        counts: {
          scanned: created,
          attempted: created,
          completed: created,
          failed: 0,
          skipped: 0,
          created,
        },
        references: created
          ? [{ kind: "task", id: "task-1", state: "confirmed" }]
          : [],
      };

      await finishOperational(
        runId,
        `${OPEN}\n${JSON.stringify(value)}\n${CLOSE}`,
      );
      const row = (
        await pool.query(
          "SELECT status, operational_terminal, operational_cleanup, promoted_head_sha, merge_commit_sha FROM runs WHERE id=$1",
          [runId],
        )
      ).rows[0];

      expect(row).toMatchObject({
        status: "Done",
        promoted_head_sha: null,
        merge_commit_sha: null,
        operational_terminal: {
          effectiveOutcome: "success",
          successful: true,
          validation: "valid",
          integrity: "clean",
          resultRevision: 1,
        },
        operational_cleanup: { state: "armed", attempts: 0 },
      });
      expect(
        (await getEvents(runId)).filter((event) => event.kind === "run.done"),
      ).toHaveLength(1);
      expect(
        (await getEvents(runId)).some((event) => event.kind === "run.review"),
      ).toBe(false);
    },
  );

  it("IT-OPR-02 IT-EDGE-OPR-01 preserves partial confirmed creation and HTTP 403 as structured failures", async () => {
    const partial = {
      ...operationalBlockedFixture(),
      outcome: "partial",
      coverage: { state: "incomplete", remainingKnown: null },
      counts: {
        scanned: 1,
        attempted: 1,
        completed: 0,
        failed: 1,
        skipped: 0,
        created: 1,
      },
      references: [
        { kind: "task", id: "confirmed-task", state: "confirmed" },
        { kind: "operation_receipt", id: "pending-write", state: "unresolved" },
      ],
    };

    for (const value of [
      partial,
      operationalBlockedFixture(),
      { ...operationalBlockedFixture(), outcome: "failed" },
    ]) {
      const { runId } = await seedOperationalRun();

      await finishOperational(
        runId,
        `${OPEN}\n${JSON.stringify(value)}\n${CLOSE}`,
      );
      expect(await getStatus(runId)).toBe("Failed");
      const receipt = (
        await pool.query("SELECT operational_terminal FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0].operational_terminal;

      expect(receipt).toMatchObject({
        effectiveOutcome: value.outcome,
        successful: false,
        validation: "valid",
        resultRevision: 1,
      });
      expect((await getResults(runId))[0].value).toEqual(value);
      expect(
        (await getEvents(runId)).some(
          (event) => event.kind === "run.done" || event.kind === "run.review",
        ),
      ).toBe(false);
    }
  });

  it("IT-EDGE-OPR-02 IT-EDGE-OPR-03 rejects absent, malformed and contradictory results", async () => {
    const base = operationalSuccessFixture();

    for (const value of [
      null,
      "{broken",
      { ...base, counts: { ...base.counts, scanned: -1 } },
      { ...base, coverage: { state: "complete", remainingKnown: null } },
      {
        ...base,
        references: [
          {
            kind: "other",
            id: "x",
            state: "confirmed",
            url: "javascript:alert(1)",
          },
        ],
      },
      { ...base, unknown: true },
    ]) {
      const { runId } = await seedOperationalRun();

      await finishOperational(
        runId,
        value === null
          ? "Finished successfully."
          : `${OPEN}\n${typeof value === "string" ? value : JSON.stringify(value)}\n${CLOSE}`,
      );
      expect(await getStatus(runId)).toBe("Failed");
      expect((await getResults(runId))[0]).toMatchObject({
        validity: "invalid",
        value: null,
      });
      expect(
        (
          await pool.query(
            "SELECT operational_terminal FROM runs WHERE id=$1",
            [runId],
          )
        ).rows[0].operational_terminal,
      ).toMatchObject({
        successful: false,
        effectiveOutcome: "failed",
        validation: "invalid",
      });
    }
  });

  it("IT-OPR-03 records cancellation and crash once, atomically with the cleanup intent", async () => {
    const { prepareAgentRunFinalization } =
      await import("@/lib/agents/finalization");

    for (const status of ["Abandoned", "Crashed"] as const) {
      const { runId } = await seedOperationalRun();
      const prepared = await prepareAgentRunFinalization(runId, status, { db });

      await expect(
        db.transaction(async (tx) => {
          expect((await prepared.apply(tx)).finalized).toBe(true);
          throw new Error("test rollback");
        }),
      ).rejects.toThrow("test rollback");
      expect(await getStatus(runId)).toBe("Running");
      expect(await getResults(runId)).toEqual([]);
      const results = await Promise.all([
        db.transaction((tx) => prepared.apply(tx)),
        db.transaction((tx) => prepared.apply(tx)),
      ]);

      expect(results.filter((result) => result.finalized)).toHaveLength(1);
      const row = (
        await pool.query(
          "SELECT status, operational_terminal, operational_cleanup FROM runs WHERE id=$1",
          [runId],
        )
      ).rows[0];

      expect(row).toMatchObject({
        status,
        operational_terminal: {
          status,
          successful: false,
          resultRevision: null,
        },
        operational_cleanup: {
          state: status === "Crashed" ? "retained" : "armed",
        },
      });
      expect(await getResults(runId)).toHaveLength(0);
      expect(
        (await getEvents(runId)).filter(
          (event) =>
            event.kind ===
            (status === "Crashed" ? "run.crashed" : "run.abandoned"),
        ),
      ).toHaveLength(1);
    }
  });

  it("IT-OPR-04 keeps reported success as evidence while a source violation becomes effective failure", async () => {
    const { runId, cwd } = await seedOperationalRun();

    await writeFile(join(cwd, "unexpected.ts"), "unexpected source");
    await finishOperational(
      runId,
      `${OPEN}\n${JSON.stringify(operationalSuccessFixture())}\n${CLOSE}`,
    );
    expect(await getStatus(runId)).toBe("Failed");
    expect(
      (
        await pool.query("SELECT operational_terminal FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0].operational_terminal,
    ).toMatchObject({
      effectiveOutcome: "failed",
      successful: false,
      validation: "valid",
      integrity: "changed",
    });
    expect((await getResults(runId))[0].value).toMatchObject({
      outcome: "success",
    });
  });
});

// ADR-165 AC-23 / spec C-5.7, C-8. Driven through the REAL `consumeAgentSession`
// with a scripted stream, so the per-turn buffering, the finalize transaction,
// the status decision and the emit are all the production ones.

const VALID_VALUE = {
  summary: "auth uses a shared verifier",
  outcome: "completed",
  payload: { entrypoints: ["lib/auth/verify.ts"], depth: { nested: true } },
};

describe("agent public result — the happy path", () => {
  it("a valid sentinel publishes a valid row and settles Done", async () => {
    const runId = await seedAgentRun({ contract: CONTRACT });

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        chunk(
          `Working...\n${OPEN}\n${JSON.stringify(VALID_VALUE)}\n${CLOSE}\n`,
        ),
        exited(0),
      ]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Done");

    const rows = await getResults(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      validity: "valid",
      producerKind: "agent_session",
      producerRef: "session:default",
      schemaRef: CONTRACT.schemaRef,
    });
    // Undeclared nesting inside a `json` field survives exactly.
    expect(rows[0].value).toEqual(VALID_VALUE);

    const done = (await getEvents(runId)).find((e) => e.kind === "run.done");

    expect(done?.payload).toMatchObject({ resultStatus: "valid" });
  }, 60_000);

  it("a delegated child's run.review carries the result status alongside its cause", async () => {
    const parentRunId = await seedAgentRun({ contract: null });
    const runId = await seedAgentRun({ contract: CONTRACT, parentRunId });

    // A workspaces row is what makes a clean agent exit land in Review.
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path")
       VALUES ($1, $2, $3, 'feature/x', $4, '/repos/x')`,
      [randomUUID(), runId, projectId, `/tmp/wt-${runId}`],
    );

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        chunk(`${OPEN}\n${JSON.stringify(VALID_VALUE)}\n${CLOSE}\n`),
        exited(0),
      ]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Review");

    const review = (await getEvents(runId)).find(
      (e) => e.kind === "run.review",
    );

    expect(review?.payload).toMatchObject({
      cause: "agent_exit",
      resultStatus: "valid",
    });
  }, 60_000);
});

describe("agent public result — the D10 failure table", () => {
  it("an ABSENT result on a required contract fails the run with result_missing", async () => {
    const parentRunId = await seedAgentRun({ contract: null });
    const runId = await seedAgentRun({ contract: CONTRACT, parentRunId });

    await consumeAgentSession({
      db,
      execution: scriptedApi([chunk("I finished, no block."), exited(0)]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Failed");

    const rows = await getResults(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      validity: "invalid",
      invalidReason: "result_missing",
      value: null,
    });

    // The parent must be woken by a FAILURE, not by a `run.done` that would
    // read as success.
    const events = await getEvents(runId);

    expect(events.some((e) => e.kind === "run.done")).toBe(false);
    expect(events.find((e) => e.kind === "run.failed")?.payload).toMatchObject({
      reason: "result_missing",
      resultStatus: "unavailable",
      cause: { code: "CONFIG", reason: "result_missing", source: "agent" },
    });
  }, 60_000);

  const INVALID_CASES: Array<{
    name: string;
    block: string;
    reason: string;
  }> = [
    {
      name: "a schema mismatch (wrong enum member)",
      block: JSON.stringify({ summary: "s", outcome: "nope" }),
      reason: "schema_mismatch",
    },
    {
      name: "a missing required field",
      block: JSON.stringify({ outcome: "completed" }),
      reason: "schema_mismatch",
    },
    {
      name: "an unsafe key",
      block: '{"summary":"s","outcome":"completed","__proto__":{"x":1}}',
      reason: "unsafe_key",
    },
    {
      name: "malformed JSON",
      block: "{ not json at all",
      reason: "malformed_json",
    },
    {
      name: "a non-object payload",
      block: '"just a string"',
      reason: "schema_mismatch",
    },
  ];

  it.each(INVALID_CASES)(
    "$name records an invalid row with reason $reason and fails the run",
    async ({ block, reason }) => {
      const runId = await seedAgentRun({ contract: CONTRACT });

      await consumeAgentSession({
        db,
        execution: scriptedApi([
          chunk(`${OPEN}\n${block}\n${CLOSE}\n`),
          exited(0),
        ]),
        runId,
        sessionId: "sup-1",
      });

      expect(await getStatus(runId)).toBe("Failed");

      const rows = await getResults(runId);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        validity: "invalid",
        invalidReason: reason,
        value: null,
      });
      expect(
        (await getEvents(runId)).find((e) => e.kind === "run.failed")?.payload,
      ).toMatchObject({
        reason: "result_invalid",
        cause: { code: "CONFIG", reason: "result_invalid", source: "agent" },
      });
    },
    60_000,
  );

  it("a NON-clean exit never publishes, even with a valid block in the buffer", async () => {
    const runId = await seedAgentRun({ contract: CONTRACT });

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        chunk(`${OPEN}\n${JSON.stringify(VALID_VALUE)}\n${CLOSE}\n`),
        exited(1),
      ]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Failed");
    expect(await getResults(runId)).toHaveLength(0);
  }, 60_000);

  it("a NULL contract parses nothing at all", async () => {
    const runId = await seedAgentRun({ contract: null });

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        chunk(`${OPEN}\n{"anything":true}\n${CLOSE}\n`),
        exited(0),
      ]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Done");
    expect(await getResults(runId)).toHaveLength(0);
  }, 60_000);
});

describe("agent public result — per-turn buffering", () => {
  // The contract is "the block that ends the COMPLETING turn". A block from an
  // earlier turn, before a permission round-trip, must not be mistaken for it.
  it("resets the buffer when a new prompt turn begins after a permission answer", async () => {
    const runId = await seedAgentRun({ contract: CONTRACT });
    const stale = JSON.stringify({ summary: "STALE", outcome: "blocked" });
    const fresh = JSON.stringify({ summary: "FRESH", outcome: "completed" });

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        chunk(`${OPEN}\n${stale}\n${CLOSE}\n`),
        {
          type: "session.permission_request",
          sessionId: "sup-1",
          monotonicId: 2,
          requestId: "req-1",
          toolCall: { name: "Bash" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        // The next update ends the permission wait AND starts a new turn.
        chunk(`${OPEN}\n${fresh}\n${CLOSE}\n`),
        exited(0),
      ]),
      runId,
      sessionId: "sup-1",
    });

    const rows = await getResults(runId);

    expect(rows).toHaveLength(1);
    expect((rows[0].value as { summary: string }).summary).toBe("FRESH");
  }, 60_000);
});

// ADR-165 AC-24 / crash window W4: a child that dies mid-turn never publishes.
// The collect side of the same window — `unavailable` with a NULL
// `resultFailure` — is owned by collect-v2.integration.test.ts.
describe("W4 — death before the finalize transaction", () => {
  it("a supervisor-reported crash finalizes Crashed and publishes NOTHING", async () => {
    const parentRunId = await seedAgentRun({ contract: null });
    const runId = await seedAgentRun({ contract: CONTRACT, parentRunId });

    await consumeAgentSession({
      db,
      execution: scriptedApi([
        // A valid block was already buffered — it still must not be published:
        // the run did not finish, so what it emitted is not an answer.
        chunk(`${OPEN}\n${JSON.stringify(VALID_VALUE)}\n${CLOSE}\n`),
        { type: "session.crashed", sessionId: "sup-1", monotonicId: 5 },
      ]),
      runId,
      sessionId: "sup-1",
    });

    expect(await getStatus(runId)).toBe("Crashed");
    expect(await getResults(runId)).toHaveLength(0);

    // The parent is still woken — by a CRASH, which it must handle as a failure
    // rather than waiting forever.
    const events = await getEvents(runId);

    // B6: the prose reason ("supervisor reported session crash") stays on
    // the payload and never reaches the cause.
    expect(events.find((e) => e.kind === "run.crashed")?.payload.cause).toEqual(
      { code: "CRASH", source: "agent" },
    );
    expect(events.some((e) => e.kind === "run.done")).toBe(false);
  }, 60_000);

  it("a run whose process simply died leaves no rows at all (nothing ran)", async () => {
    const runId = await seedAgentRun({ contract: CONTRACT });

    // No consumer, no events — the shape reconcile later classifies as Crashed.
    expect(await getResults(runId)).toHaveLength(0);
    expect(await getStatus(runId)).toBe("Running");
  }, 60_000);
});
