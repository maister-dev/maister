import type { Run } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { RunResultContract, RunResultRow } from "@/lib/run-results/types";

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-165 AC-15 / AC-16 / AC-17, spec C-8 and C-9. The terminal gate's three
// exits, driven through the REAL `runFlow`. The clean probe runs against an
// actual git worktree — a mocked probe would prove nothing about the predicate
// the production path uses.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");
const OPEN = "```json maister:output";
const CLOSE = "```";
const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const CONTRACT: RunResultContract = {
  kind: "flow_export",
  schemaRef: "m26@abcdef123456:result",
  schemaVersion: 1,
  sha256: "e".repeat(64),
  required: true,
  producerNodeIds: ["plan"],
  schema: {
    schemaVersion: 1,
    fields: [{ name: "verdict", type: "string", required: true }],
  },
  flowRevisionId: "rev-fixture",
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_result_terminal_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

/**
 * A real git repo standing in for the run's worktree, on `feature/test`, with
 * one commit. Returns the path and that commit's SHA — the branch point every
 * committed-diff comparison is measured from.
 */
async function makeWorktree(): Promise<{ path: string; baseCommit: string }> {
  const dir = await mkdtemp(join(tmpdir(), "maister-rr-terminal-"));

  await execFileAsync("git", ["-C", dir, "init", "-q", "-b", "feature/test"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  const { stdout } = await execFileAsync("git", [
    "-C",
    dir,
    "rev-parse",
    "HEAD",
  ]);

  return { path: dir, baseCommit: stdout.trim() };
}

async function commitInto(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), "changed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", name]);
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "m26-output",
    compat: { engine_min: "3.7.0" },
    nodes: [
      {
        id: "plan",
        type: "ai_coding",
        action: { prompt: "plan {{ task.prompt }}" },
        output: { result: { schema: "./schemas/result.json" } },
        transitions: { success: "done" },
      },
    ],
  };
}

async function seedRun(args: {
  contract: RunResultContract | null;
  baseCommit?: string | null;
  worktreePath?: string;
  parentRunId?: string | null;
}): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest(), {
    flowRefId: "m26",
    installedPath: FIXTURE_PATH,
    flowRevision: true,
    run: {
      resultContract: args.contract,
      ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    },
    workspace: {
      branch: "feature/test",
      ...(args.worktreePath ? { worktreePath: args.worktreePath } : {}),
      ...(args.baseCommit !== undefined ? { baseCommit: args.baseCommit } : {}),
    },
  });
}

// ADR-166: the execution seam is a fake host scripted to stream `text` as one
// agent_message_chunk, then a clean end-turn.
async function supervisor(
  runId: string,
  text: string,
): Promise<ExecutionHosts> {
  return (await fakeGraphHosts(db, runId, { text })).hosts;
}

const VALID_BLOCK = `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`;

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getResults(runId: string): Promise<RunResultRow[]> {
  return (await db
    .select()
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, runId))
    .orderBy(asc(schema.runResults.revision))) as unknown as RunResultRow[];
}

async function getWorkspace(runId: string): Promise<Record<string, unknown>> {
  const rows = (await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.runId, runId))) as Record<string, unknown>[];

  return rows[0];
}

async function getDomainEvents(
  runId: string,
): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  return (await db
    .select({
      kind: schema.domainEvents.kind,
      payload: schema.domainEvents.payload,
    })
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId))) as {
    kind: string;
    payload: Record<string, unknown>;
  }[];
}

describe("terminal gate — required export with no result (AC-15)", () => {
  it("fails the run, records an invalid row, and emits run.failed{result_missing}", async () => {
    const wt = await makeWorktree();
    // The agent emits NO sentinel block, so an OPTIONAL declaration lets the
    // node succeed and the run reaches the terminal gate with nothing published.
    const seeded = await seedRun({
      contract: { ...CONTRACT, required: true },
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await supervisor(seeded.runId, "no block here"),
    });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("Failed");

    const rows = await getResults(seeded.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      validity: "invalid",
      invalidReason: "result_missing",
      value: null,
    });

    const events = await getDomainEvents(seeded.runId);
    const failed = events.find((e) => e.kind === "run.failed");

    // `runs` carries no error_code column — the taxonomy code travels on the
    // event payloads, which is where a coordinator and a webhook consumer read
    // it. The domain payload is the contract half that matters here.
    expect(failed?.payload).toMatchObject({
      reason: "result_missing",
      resultStatus: "missing",
    });
    // The invalid row and the flip that emits the wake are ONE transaction, so
    // a woken parent can never see the settle without the reason.
    expect(events.some((e) => e.kind === "run.review")).toBe(false);
  }, 60_000);

  it("an OPTIONAL export with no result reaches Review as `absent`", async () => {
    const wt = await makeWorktree();
    const seeded = await seedRun({
      contract: { ...CONTRACT, required: false },
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await supervisor(seeded.runId, "no block here"),
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(await getResults(seeded.runId)).toHaveLength(0);
  }, 60_000);
});

// AC-16, table-driven: ONE of the three preconditions is removed per row, and
// every row must land in Review. A single happy-path test would pass against an
// implementation that ignored the clean check entirely.
describe("terminal gate — result-only completion (AC-16)", () => {
  it("valid result + clean workspace → Done, with the full write list", async () => {
    const wt = await makeWorktree();
    const seeded = await seedRun({
      contract: CONTRACT,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await supervisor(seeded.runId, VALID_BLOCK),
    });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("Done");
    expect(run.endedAt).toBeTruthy();
    expect(run.currentStepId).toBeNull();
    expect(run.diffStat).toEqual({ files: 0, additions: 0, deletions: 0 });
    // Nothing was promoted — these must stay NULL, or a reader would report a
    // merge that never happened.
    expect(run.promotedHeadSha).toBeNull();
    expect(run.mergeCommitSha).toBeNull();

    const ws = await getWorkspace(seeded.runId);

    expect(ws.promotionState).toBe("none");
    expect(ws.promotedAt ?? null).toBeNull();
    expect(ws.scheduledRemovalAt).toBeTruthy();

    const events = await getDomainEvents(seeded.runId);
    const done = events.find((e) => e.kind === "run.done");

    expect(done?.payload).toMatchObject({
      completion: "result_only",
      resultStatus: "valid",
    });
    expect(events.some((e) => e.kind === "run.review")).toBe(false);
    expect(events.some((e) => e.kind === "run.promoted")).toBe(false);
  }, 60_000);

  const REVIEW_CASES: Array<{
    name: string;
    setup: (wt: { path: string; baseCommit: string }) => Promise<{
      contract: RunResultContract | null;
      baseCommit?: string | null;
    }>;
    block?: string;
  }> = [
    {
      name: "a COMMITTED diff on the branch",
      setup: async (wt) => {
        await commitInto(wt.path, "changed.txt");

        return { contract: CONTRACT, baseCommit: wt.baseCommit };
      },
    },
    {
      name: "a DIRTY working tree only",
      setup: async (wt) => {
        await writeFile(join(wt.path, "scratch.txt"), "dirty\n", "utf8");

        return { contract: CONTRACT, baseCommit: wt.baseCommit };
      },
    },
    {
      name: "a NULL base_commit (no branch point to measure from)",
      setup: async () => ({ contract: CONTRACT, baseCommit: null }),
    },
    {
      name: "NO export contract at all",
      setup: async (wt) => ({ contract: null, baseCommit: wt.baseCommit }),
    },
  ];

  it.each(REVIEW_CASES)(
    "$name → Review",
    async ({ setup, block }) => {
      const wt = await makeWorktree();
      const { contract, baseCommit } = await setup(wt);
      const seeded = await seedRun({
        contract,
        worktreePath: wt.path,
        baseCommit,
      });

      await runFlow(seeded.runId, {
        db,
        runtimeRoot: seeded.runtimeRoot,
        executionHosts: await supervisor(seeded.runId, block ?? VALID_BLOCK),
      });

      const run = await getRun(seeded.runId);

      expect(run.status).toBe("Review");
      // The Review exit is byte-identical to today: the auto-promotion grace
      // anchor is stamped and no result-only fields are written.
      expect(run.reviewEnteredAt).toBeTruthy();
      expect((await getWorkspace(seeded.runId)).promotionState).toBe("none");
    },
    60_000,
  );

  it("a DELEGATED child's result-only Done carries parentRunId, so the parent wakes", async () => {
    const parent = await seedRun({ contract: null });
    const wt = await makeWorktree();
    const seeded = await seedRun({
      contract: CONTRACT,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      parentRunId: parent.runId,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await supervisor(seeded.runId, VALID_BLOCK),
    });

    expect((await getRun(seeded.runId)).status).toBe("Done");

    // `parentRunId` is folded INTO the payload by `emitDomainEvent` — it is not
    // a column — and that is exactly what `orchestrator_resume` routes on.
    const done = (await getDomainEvents(seeded.runId)).find(
      (e) => e.kind === "run.done",
    );

    expect(done?.payload).toMatchObject({
      parentRunId: parent.runId,
      completion: "result_only",
    });
  }, 60_000);
});

describe("terminal gate — Review carries the honest resultStatus (AC-17)", () => {
  it("a delegated child's run.review reports the result state rather than inventing one", async () => {
    const parent = await seedRun({ contract: null });
    const wt = await makeWorktree();

    // A committed diff forces the Review exit even though the result is valid.
    await commitInto(wt.path, "changed.txt");

    const seeded = await seedRun({
      contract: CONTRACT,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      parentRunId: parent.runId,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await supervisor(seeded.runId, VALID_BLOCK),
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const review = (await getDomainEvents(seeded.runId)).find(
      (e) => e.kind === "run.review",
    );

    expect(review?.payload).toMatchObject({
      cause: "graph_completed",
      resultStatus: "valid",
    });
  }, 60_000);
});
