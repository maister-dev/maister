// M30 (ADR-081): rework session_policy threading, end-to-end through the
// real rework loop (runGraph #1 pauses at the review gate; the operator's
// rework decision artifact re-enters the target). ONLY the agent action is
// scripted. Asserts:
//   - the engine DEFAULT is resume: the rework re-dispatch of the target
//     carries the prior attempt's acp_session_id as resumeSessionId;
//   - rework.session_policy "new_session" suppresses the resume handle;
//   - precedence: rework-transition wins over a node-level policy;
//   - the effective policy is snapshotted on the new attempt row, and a
//     resume fallback (gone session) records session_fallback=true.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Scripted agent — records the resume handle each dispatch carried.
const agentCalls: Array<{
  stepId: string;
  mode: string;
  resumeSessionId: string | undefined;
}> = [];
let agentScript: Array<{ acpSessionId?: string; sessionFallback?: boolean }> =
  [];

vi.mock("@/lib/flows/runner-agent", () => ({
  runAgentStep: vi.fn(
    async (
      step: { id: string; mode: string },
      ctx: { resumeSessionId?: string },
    ) => {
      agentCalls.push({
        stepId: step.id,
        mode: step.mode,
        resumeSessionId: ctx.resumeSessionId,
      });
      const next = agentScript.shift() ?? {};

      return {
        ok: true,
        stdout: "done",
        vars: {},
        durationMs: 1,
        needsInput: false,
        acpSessionId: next.acpSessionId,
        sessionFallback: next.sessionFallback,
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
    .withDatabase("maister_test_session_policy")
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

function reworkManifest(
  opts: {
    reworkSessionPolicy?: string;
    nodeSessionPolicy?: string;
  } = {},
) {
  return {
    schemaVersion: 1,
    name: "SessionPolicy",
    compat: { engine_min: "1.4.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/impl" },
        transitions: { success: "review" },
        ...(opts.nodeSessionPolicy
          ? { session_policy: opts.nodeSessionPolicy }
          : {}),
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "rework"] } },
        transitions: { approve: "done", rework: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
          ...(opts.reworkSessionPolicy
            ? { session_policy: opts.reworkSessionPolicy }
            : {}),
        },
      },
    ],
  };
}

async function seedRun(manifest: Record<string, unknown>): Promise<{
  loaded: Record<string, unknown>;
  runId: string;
  projectSlug: string;
  runtimeRoot: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const projectSlug = `proj-${projectId.slice(0, 8)}`;

  const repo = await mkdtemp(join(tmpdir(), "maister-sp-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-sp-wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-sp-rt-"));

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
    id: projectId,
    slug: projectSlug,
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
    flowRefId: "sp",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/sp",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
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
    projectSlug,
    flowInstallPath: "/tmp/flows/sp",
    execTrust: "trusted",
  };

  return { loaded, runId, projectSlug, runtimeRoot };
}

// Drive: run #1 (implement succeeds with a session id, review pauses), then
// write the operator's rework artifact and run #2 (review consumes → rework →
// implement re-dispatch). Returns the re-dispatch call.
async function driveReworkLoop(args: {
  manifest: Record<string, unknown>;
  // null = attempt 1 returns NO session id (vs undefined = default "sess-1").
  attempt1SessionId?: string | null;
  attempt2Script?: { acpSessionId?: string; sessionFallback?: boolean };
}): Promise<{
  runId: string;
  redispatch: (typeof agentCalls)[number] | undefined;
}> {
  const { runGraph } = await import("@/lib/flows/graph/runner-graph");
  const { loaded, runId, projectSlug, runtimeRoot } = await seedRun(
    args.manifest,
  );

  agentScript = [
    {
      acpSessionId:
        args.attempt1SessionId === null
          ? undefined
          : (args.attempt1SessionId ?? "sess-1"),
    },
    args.attempt2Script ?? { acpSessionId: "sess-2" },
  ];

  await runGraph(loaded as never, { db, runtimeRoot });

  const statusAfter1 = (
    await pool.query(`SELECT status FROM runs WHERE id = $1`, [runId])
  ).rows[0].status;

  expect(statusAfter1).toBe("NeedsInput");

  // The operator's rework decision (delivery channel: input artifact).
  const dir = join(runtimeRoot, ".maister", projectSlug, "runs", runId);

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "input-review.json"),
    JSON.stringify({ decision: "rework", workspacePolicy: "keep" }),
  );

  const loaded2 = {
    ...(loaded as Record<string, unknown>),
    run: {
      ...(loaded as { run: Record<string, unknown> }).run,
      status: "NeedsInput",
      currentStepId: "review",
    },
  };

  await runGraph(loaded2 as never, { db, runtimeRoot });

  const redispatch = agentCalls.find(
    (c, i) => c.stepId === "implement" && i > 0,
  );

  return { runId, redispatch };
}

async function attemptRow(runId: string, nodeId: string, attempt: number) {
  const r = await pool.query(
    `SELECT session_policy, session_fallback, acp_session_id
       FROM node_attempts WHERE run_id = $1 AND node_id = $2 AND attempt = $3`,
    [runId, nodeId, attempt],
  );

  return r.rows[0] as
    | {
        session_policy: string | null;
        session_fallback: boolean;
        acp_session_id: string | null;
      }
    | undefined;
}

describe("session_policy rework threading (ADR-081)", () => {
  it("engine default = resume: the rework re-dispatch carries the prior attempt's session id", async () => {
    const { runId, redispatch } = await driveReworkLoop({
      manifest: reworkManifest(),
    });

    expect(redispatch).toBeDefined();
    expect(redispatch?.resumeSessionId).toBe("sess-1");

    const row = await attemptRow(runId, "implement", 2);

    expect(row?.session_policy).toBe("resume");
    expect(row?.session_fallback).toBe(false);
  }, 120_000);

  it("rework.session_policy new_session suppresses the resume handle", async () => {
    const { runId, redispatch } = await driveReworkLoop({
      manifest: reworkManifest({ reworkSessionPolicy: "new_session" }),
    });

    expect(redispatch).toBeDefined();
    expect(redispatch?.resumeSessionId).toBeUndefined();

    const row = await attemptRow(runId, "implement", 2);

    expect(row?.session_policy).toBe("new_session");
  }, 120_000);

  it("precedence: rework-transition resume wins over node-level new_session", async () => {
    const { redispatch } = await driveReworkLoop({
      manifest: reworkManifest({
        nodeSessionPolicy: "new_session",
        reworkSessionPolicy: "resume",
      }),
    });

    expect(redispatch?.resumeSessionId).toBe("sess-1");
  }, 120_000);

  it("resume fallback (gone session) records session_fallback=true on the new attempt", async () => {
    const { runId } = await driveReworkLoop({
      manifest: reworkManifest(),
      attempt2Script: { acpSessionId: "sess-2", sessionFallback: true },
    });

    const row = await attemptRow(runId, "implement", 2);

    expect(row?.session_policy).toBe("resume");
    expect(row?.session_fallback).toBe(true);
  }, 120_000);

  it("a prior attempt WITHOUT a session id degrades resume to a fresh dispatch (no handle)", async () => {
    const { runId, redispatch } = await driveReworkLoop({
      manifest: reworkManifest(),
      attempt1SessionId: null,
    });

    expect(redispatch).toBeDefined();
    expect(redispatch?.resumeSessionId).toBeUndefined();

    const row = await attemptRow(runId, "implement", 2);

    // The effective policy stays `resume`; the missing handle is the
    // observable fallback.
    expect(row?.session_policy).toBe("resume");
    expect(row?.session_fallback).toBe(true);
  }, 120_000);
});
