// M30 (ADR-080): auto-retry on retryable failures, observable on the ledger.
// runGraph drives a real DB (testcontainers) + a real git worktree; ONLY the
// agent action is scripted (vi.mock of runner-agent). Asserts:
//   - an on-list failure auto-schedules attempts up to `attempts`, then the
//     run proceeds normally on success;
//   - each retry is a NEW ledger row with auto_retry=true and a FRESH
//     session (mode new-session on every dispatch);
//   - the workspace policy applies via the Feature-4 engine BEFORE the retry
//     (attempt commits discarded between attempts);
//   - gates are NOT bypassed on the succeeding attempt;
//   - exhaustion → normal failure (run Failed, no extra attempts);
//   - an off-list code never retries.

import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

// Scripted agent action — per-test queue of results; every call is recorded
// with its step config so fresh-session can be asserted.
const agentCalls: Array<{ mode: string; stepId: string }> = [];
let agentScript: Array<
  | { ok: true }
  | { ok: false; errorCode: string }
  | { commitFile: string; thenFail: string }
> = [];

vi.mock("@/lib/flows/runner-agent", () => ({
  runAgentStep: vi.fn(
    async (
      step: { id: string; mode: string },
      ctx: { worktreePath: string },
    ) => {
      agentCalls.push({ mode: step.mode, stepId: step.id });
      const next = agentScript.shift() ?? { ok: true as const };

      if ("commitFile" in next) {
        // Simulate agent work that COMMITS, then fails retryably — the
        // workspace policy must discard this commit before the retry.
        await writeFile(join(ctx.worktreePath, next.commitFile), "agent\n");
        await execFileAsync("git", ["-C", ctx.worktreePath, "add", "-A"]);
        await execFileAsync("git", [
          "-C",
          ctx.worktreePath,
          "commit",
          "-q",
          "-m",
          "agent work",
        ]);

        return {
          ok: false,
          stdout: "",
          vars: {},
          durationMs: 1,
          needsInput: false,
          errorCode: next.thenFail,
        };
      }

      if (!next.ok) {
        return {
          ok: false,
          stdout: "",
          vars: {},
          durationMs: 1,
          needsInput: false,
          errorCode: next.errorCode,
        };
      }

      return {
        ok: true,
        stdout: "done",
        vars: {},
        durationMs: 1,
        needsInput: false,
      };
    },
  ),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_retry")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(() => {
  agentCalls.splice(0);
  agentScript = [];
});

function retryManifest(
  retryPolicy: Record<string, unknown> | undefined,
  opts: {
    gate?: boolean;
    retrySafe?: boolean;
  } = {},
) {
  return {
    schemaVersion: 1,
    name: "Retry",
    compat: { engine_min: "1.4.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/impl" },
        transitions: { success: "done" },
        ...(opts.retrySafe ? { retry_safe: true } : {}),
        ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
        ...(opts.gate
          ? {
              pre_finish: {
                gates: [
                  {
                    id: "smoke",
                    kind: "command_check",
                    command: "true",
                    mode: "blocking",
                  },
                ],
              },
            }
          : {}),
      },
    ],
  };
}

async function seedRun(
  manifest: Record<string, unknown>,
  opts: { executionPolicy?: ExecutionPolicy } = {},
): Promise<{
  loaded: Record<string, unknown>;
  runId: string;
  worktree: string;
  runtimeRoot: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  const repo = await mkdtemp(join(tmpdir(), "maister-retry-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-retry-wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-retry-rt-"));

  createdPaths.push(repo, wtRoot, runtimeRoot);

  const worktree = join(wtRoot, runId);
  const branch = `maister/${runId.slice(0, 8)}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: repo,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "retry",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/retry",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(crypto.randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
    ...(opts.executionPolicy ? { executionPolicy: opts.executionPolicy } : {}),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch,
    worktreePath: worktree,
    parentRepoPath: repo,
    baseBranch: "main",
  });

  const loaded = {
    run: {
      id: runId,
      projectId,
      status: "Running",
      currentStepId: null,
      acpSessionId: null,
      flowId,
      taskId,
      runKind: "flow",
      ...(opts.executionPolicy
        ? { executionPolicy: opts.executionPolicy }
        : {}),
    },
    task: { id: taskId, title: "t", prompt: "p" },
    flow: { id: flowId },
    executor: {
      id: executorId,
      executorRefId: executorId,
      agent: "claude",
      model: "m",
      env: null,
      router: null,
    },
    manifest,
    runner: testRunnerSnapshot(executorId),
    workspace: {
      id: "ws",
      runId,
      branch,
      worktreePath: worktree,
      parentRepoPath: repo,
      baseBranch: "main",
      baseCommit: null,
      removedAt: null,
    },
    projectSlug: `proj-${projectId.slice(0, 8)}`,
    flowInstallPath: "/tmp/flows/retry",
    execTrust: "trusted",
  };

  return { loaded, runId, worktree, runtimeRoot };
}

async function attemptsFor(runId: string) {
  const r = await pool.query(
    `SELECT attempt, status, error_code, auto_retry, checkpoint_ref
       FROM node_attempts WHERE run_id = $1 ORDER BY attempt`,
    [runId],
  );

  return r.rows as Array<{
    attempt: number;
    status: string;
    error_code: string | null;
    auto_retry: boolean;
    checkpoint_ref: string | null;
  }>;
}

async function runStatus(runId: string): Promise<string> {
  const r = await pool.query(`SELECT status FROM runs WHERE id = $1`, [runId]);

  return r.rows[0].status as string;
}

describe("retry_policy auto-retry (ADR-080)", () => {
  it("retries an on-list failure with fresh sessions, applies the workspace policy, then succeeds", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest(
      { attempts: 3, on_errors: ["SPAWN"] },
      { gate: true },
    );
    const { loaded, runId, worktree, runtimeRoot } = await seedRun(manifest);
    const tipBefore = (await git(worktree, "rev-parse", "HEAD")).trim();

    // Attempt 1 commits junk then fails SPAWN; attempt 2 fails SPAWN plainly;
    // attempt 3 succeeds.
    agentScript = [
      { commitFile: "junk.txt", thenFail: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
      { ok: true },
    ];

    await runGraph(loaded as never, { db, runtimeRoot });

    const attempts = await attemptsFor(runId);

    expect(attempts).toHaveLength(3);
    expect(attempts[0].status).toBe("Failed");
    expect(attempts[0].error_code).toBe("SPAWN");
    expect(attempts[0].auto_retry).toBe(false);
    expect(attempts[1].status).toBe("Failed");
    expect(attempts[1].auto_retry).toBe(true);
    expect(attempts[2].status).toBe("Succeeded");
    expect(attempts[2].auto_retry).toBe(true);

    // Fresh session on every dispatch (hard-coded new-session today; the
    // retry path must not introduce reuse).
    expect(agentCalls).toHaveLength(3);
    expect(agentCalls.every((c) => c.mode === "new-session")).toBe(true);

    // Workspace policy applied between attempts: attempt 1's commit was
    // discarded — the branch tip is back at the pre-attempt tip and the
    // committed file is gone from history.
    expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(tipBefore);

    const log = await git(worktree, "log", "--format=%s");

    expect(log).not.toContain("agent work");

    // Gates were NOT bypassed: the succeeding attempt ran its command_check.
    const gates = await pool.query(
      `SELECT gr.status FROM gate_results gr
        JOIN node_attempts na ON na.id = gr.node_attempt_id
       WHERE na.run_id = $1 AND na.attempt = 3`,
      [runId],
    );

    expect(gates.rows.length).toBeGreaterThanOrEqual(1);
    expect(gates.rows[0].status).toBe("passed");

    // The run completed normally after the retries.
    expect(await runStatus(runId)).toBe("Review");
  }, 120_000);

  it("exhaustion: attempts bound reached → normal failure, distinct from a non-retryable", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest({ attempts: 2, on_errors: ["SPAWN"] });
    const { loaded, runId } = await seedRun(manifest);

    agentScript = [
      { ok: false, errorCode: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
    ];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    const attempts = await attemptsFor(runId);

    expect(attempts).toHaveLength(2);
    expect(attempts[1].auto_retry).toBe(true);
    expect(attempts[1].status).toBe("Failed");
    expect(agentCalls).toHaveLength(2);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);

  it("an off-list error code never retries", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest({ attempts: 3, on_errors: ["SPAWN"] });
    const { loaded, runId } = await seedRun(manifest);

    // PRECONDITION is off the retryable allow-list (and terminally maps to
    // Failed, unlike CRASH → Crashed).
    agentScript = [{ ok: false, errorCode: "PRECONDITION" }];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    const attempts = await attemptsFor(runId);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].auto_retry).toBe(false);
    expect(agentCalls).toHaveLength(1);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);

  it("no retry_policy declared → single attempt on retryable failure (opt-in)", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest(undefined);
    const { loaded, runId } = await seedRun(manifest);

    agentScript = [{ ok: false, errorCode: "SPAWN" }];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    expect(await attemptsFor(runId)).toHaveLength(1);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);
});

// Execution-policy axis A2 (crashRetry=auto_retry): the run policy synthesizes
// an ADR-080 retry for a retry_safe node lacking an explicit retry_policy.
const AUTO_RETRY: ExecutionPolicy = {
  preset: "supervised",
  overrides: { crashRetry: "auto_retry" },
};

describe("execution-policy crashRetry=auto_retry (A2 in-run re-dispatch)", () => {
  it("retries a retry_safe node (no retry_policy) on a transient failure, then succeeds", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    // No per-node retry_policy; retry_safe + the run's auto_retry policy drives
    // the re-dispatch, bounded by MAISTER_AUTO_RETRY_MAX_ATTEMPTS (default 3).
    const manifest = retryManifest(undefined, { retrySafe: true });
    const { loaded, runId } = await seedRun(manifest, {
      executionPolicy: AUTO_RETRY,
    });

    agentScript = [
      { ok: false, errorCode: "EXECUTOR_UNAVAILABLE" },
      { ok: false, errorCode: "EXECUTOR_UNAVAILABLE" },
      { ok: true },
    ];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    const attempts = await attemptsFor(runId);

    expect(attempts).toHaveLength(3);
    expect(attempts[0].auto_retry).toBe(false);
    expect(attempts[1].auto_retry).toBe(true);
    expect(attempts[2].auto_retry).toBe(true);
    expect(attempts[2].status).toBe("Succeeded");
    expect(agentCalls).toHaveLength(3);
    expect(await runStatus(runId)).toBe("Review");
  }, 120_000);

  it("does NOT retry a NON-retry_safe node even under auto_retry (opt-in gate)", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest(undefined, { retrySafe: false });
    const { loaded, runId } = await seedRun(manifest, {
      executionPolicy: AUTO_RETRY,
    });

    agentScript = [{ ok: false, errorCode: "SPAWN" }];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    expect(await attemptsFor(runId)).toHaveLength(1);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);

  it("does NOT retry a deterministic (off-list) code under auto_retry", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest(undefined, { retrySafe: true });
    const { loaded, runId } = await seedRun(manifest, {
      executionPolicy: AUTO_RETRY,
    });

    // PRECONDITION is off the transient allow-list → no retry even under policy.
    agentScript = [{ ok: false, errorCode: "PRECONDITION" }];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    expect(await attemptsFor(runId)).toHaveLength(1);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);

  it("an explicit per-node retry_policy WINS over the policy default (author authoritative)", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    // Author cap = 2 (< the env default 3); on_errors = SPAWN only. retry_safe +
    // auto_retry are also set, but the author policy must govern the bound.
    const manifest = retryManifest(
      { attempts: 2, on_errors: ["SPAWN"] },
      { retrySafe: true },
    );
    const { loaded, runId } = await seedRun(manifest, {
      executionPolicy: AUTO_RETRY,
    });

    agentScript = [
      { ok: false, errorCode: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
    ];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    // Exactly 2 attempts (author cap), NOT 3 (policy default) → author won.
    expect(await attemptsFor(runId)).toHaveLength(2);
    expect(agentCalls).toHaveLength(2);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);

  it("exhaustion at the policy cap → run Failed", async () => {
    const { runGraph } = await import("@/lib/flows/graph/runner-graph");
    const manifest = retryManifest(undefined, { retrySafe: true });
    const { loaded, runId } = await seedRun(manifest, {
      executionPolicy: AUTO_RETRY,
    });

    // Three transient failures = the default cap; no fresh attempt after.
    agentScript = [
      { ok: false, errorCode: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
      { ok: false, errorCode: "SPAWN" },
    ];

    await runGraph(loaded as never, { db, runtimeRoot: createdPaths[0] });

    const attempts = await attemptsFor(runId);

    expect(attempts).toHaveLength(3);
    expect(attempts[2].auto_retry).toBe(true);
    expect(attempts[2].status).toBe("Failed");
    expect(agentCalls).toHaveLength(3);
    expect(await runStatus(runId)).toBe("Failed");
  }, 120_000);
});
