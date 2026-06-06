// M11b Phase 3.3 (RED → GREEN) — the CRITICAL resume-gate test. Drives the
// REAL graph runner (no runFlow mock) so we prove the returned `Running` run
// resumes at runs.current_step_id (the transitions.takeover re-entry = checks),
// NOT at graph.entry. Owns matrix row:
//   resume-reruns-staled-gates (AC-4 / V4)
// plus the concurrent-double-dispatch CAS guard.
//
// Asserts after return + resume:
//   (a) the staled re-entry gate reruns → a FRESH passed gate verdict appears;
//   (b) a FRESH human_review HITL is produced (run back to NeedsInput at review);
//   (c) `implement` (the upstream ai_coding node) is NOT re-executed (no new
//       implement node_attempt) — the no-clobber property;
//   (d) a concurrent double-dispatch (return microtask + F3 sweep) does NOT
//       double-run (CAS holds — one wins, the other no-ops).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
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

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  gateResults,
  nodeAttempts,
  hitlRequests,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

const REENTRY_NODE = "checks";
const TAKEOVER_NODE = "review";

// implement (ai_coding, never re-run on resume) -> checks (check w/ a passing
// command_check gate) -> review (human, takeover -> checks).
const resumeManifest = {
  schemaVersion: 1,
  name: "Resume Fixture",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/impl" },
      transitions: { success: REENTRY_NODE },
    },
    {
      id: REENTRY_NODE,
      type: "check",
      action: { command: "true" },
      pre_finish: {
        gates: [
          {
            id: "lint",
            kind: "command_check",
            mode: "blocking",
            command: "true",
          },
        ],
      },
      transitions: { success: TAKEOVER_NODE },
    },
    {
      id: TAKEOVER_NODE,
      type: "human",
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework", "takeover"],
        },
      },
      transitions: {
        approve: "done",
        rework: "implement",
        takeover: REENTRY_NODE,
      },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    },
  ],
};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let runtimeRoot: string;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let returnPOST: typeof import("../return/route").POST;

async function provisionWorktree(slug: string) {
  const root = await mkdtemp(path.join(tmpdir(), `m11b-res-${slug}-`));
  const parentRepo = path.join(root, "repo");
  const worktreePath = path.join(root, "wt");
  const branch = `maister/${slug}`;

  await execFileAsync("git", ["init", "-b", "main", parentRepo]);
  await execFileAsync("git", [
    "-C",
    parentRepo,
    "config",
    "user.email",
    "t@t.dev",
  ]);
  await execFileAsync("git", ["-C", parentRepo, "config", "user.name", "T"]);
  await writeFile(path.join(parentRepo, "README.md"), "base\n");
  await execFileAsync("git", ["-C", parentRepo, "add", "."]);
  await execFileAsync("git", ["-C", parentRepo, "commit", "-m", "base"]);
  await execFileAsync("git", [
    "-C",
    parentRepo,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);

  return { root, parentRepo, worktreePath, branch };
}

type Seed = {
  runId: string;
  projectId: string;
  ownerId: string;
  worktreePath: string;
  checksAttemptId: string;
  passedGateId: string;
  cleanup: () => Promise<void>;
};

// Seeds a run that is ALREADY HumanWorking (post-claim) parked at `review`,
// with a prior SUCCEEDED `checks` attempt + a PASSED gate (validated the
// pre-takeover code) and an active takeover node_attempts row. The return
// route then runs for real and the runner resumes.
async function seedReadyForReturn(): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  const slug = `res-${tag}`;
  const projectId = randomUUID();
  const ownerId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  const wt = await provisionWorktree(slug);

  await db.insert(users).values({
    id: ownerId,
    email: `owner-${tag}@maister.local`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: wt.parentRepo,
    mainBranch: "main",
    maisterYamlPath: `${wt.parentRepo}/maister.yaml`,
  });
  await db.insert(projectMembers).values({
    id: randomUUID(),
    projectId,
    userId: ownerId,
    role: "member",
  });
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "resume-fixture",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${flowId}`,
    manifest: resumeManifest,
    schemaVersion: 1,
  });
  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "HumanWorking",
    currentStepId: TAKEOVER_NODE,
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    parentRepoPath: wt.parentRepo,
  });

  // History: implement succeeded, checks succeeded (+passed gate), review
  // claimed for takeover.
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    endedAt: new Date(),
  });
  const checksAttemptId = randomUUID();

  await db.insert(nodeAttempts).values({
    id: checksAttemptId,
    runId,
    nodeId: REENTRY_NODE,
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    endedAt: new Date(),
  });
  const passedGateId = randomUUID();

  await db.insert(gateResults).values({
    id: passedGateId,
    runId,
    nodeAttemptId: checksAttemptId,
    gateId: "lint",
    kind: "command_check",
    mode: "blocking",
    status: "passed",
    endedAt: new Date(),
  });
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: TAKEOVER_NODE,
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    ownerUserId: ownerId,
  });

  // Simulate the human's local commit.
  await writeFile(path.join(wt.worktreePath, "human.txt"), "edited\n");
  await execFileAsync("git", ["-C", wt.worktreePath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    wt.worktreePath,
    "commit",
    "-m",
    "human edit",
  ]);

  sessionRef.value = { user: { id: ownerId, role: "member" } };

  return {
    runId,
    projectId,
    ownerId,
    worktreePath: wt.worktreePath,
    checksAttemptId,
    passedGateId,
    cleanup: async () => {
      await rm(wt.root, { recursive: true, force: true });
    },
  };
}

function returnReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

async function attemptsFor(runId: string, nodeId: string): Promise<any[]> {
  return db
    .select()
    .from(nodeAttempts)
    .where(and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, nodeId)));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("takeover_resume_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  runtimeRoot = await mkdtemp(path.join(tmpdir(), "m11b-res-rt-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  // Make the runner's FOR-UPDATE takeover-resume claim use the Postgres row
  // lock (isPostgres() reads DB_URL; getDb() itself is mocked to `db`).
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  ({ POST: returnPOST } = await import("../return/route"));
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// Wait until the async runner (queueMicrotask) has driven the run back to a
// fresh NeedsInput review (or a terminal). Polls the DB.
async function waitForResume(runId: string, timeoutMs = 20_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];

    if (row.status === "NeedsInput" && row.currentStepId === TAKEOVER_NODE) {
      return row;
    }
    if (["Failed", "Crashed", "Review", "Done"].includes(row.status)) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return (await db.select().from(runs).where(eq(runs.id, runId)))[0];
}

describe("takeover return → runner resume (CRITICAL)", () => {
  it("resume-reruns-staled-gates: reruns checks, fresh review HITL, implement NOT re-run", async () => {
    const s = await seedReadyForReturn();

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    // The prior passed gate flipped stale at return time (BEFORE the rerun).
    // After the resume, a FRESH gate verdict exists too.
    const finalRun = await waitForResume(s.runId);

    // (b) fresh human_review HITL: run is back at NeedsInput on `review`.
    expect(finalRun.status).toBe("NeedsInput");
    expect(finalRun.currentStepId).toBe(TAKEOVER_NODE);

    const hitls = await db
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, s.runId),
          eq(hitlRequests.stepId, TAKEOVER_NODE),
        ),
      );

    expect(hitls.length).toBeGreaterThanOrEqual(1);

    // (a) checks reran: a FRESH checks attempt exists (attempt 2) and a fresh
    // passed gate for it.
    const checksAttempts = await attemptsFor(s.runId, REENTRY_NODE);

    expect(checksAttempts.length).toBeGreaterThanOrEqual(2);

    const freshGates = await db
      .select()
      .from(gateResults)
      .where(
        and(
          eq(gateResults.runId, s.runId),
          eq(gateResults.gateId, "lint"),
          eq(gateResults.status, "passed"),
        ),
      );

    // The original passed gate went stale; a fresh `passed` gate exists from
    // the rerun.
    expect(freshGates.length).toBeGreaterThanOrEqual(1);
    const stalePriorGate = (
      await db
        .select()
        .from(gateResults)
        .where(eq(gateResults.id, s.passedGateId))
    )[0];

    expect(stalePriorGate.status).toBe("stale");

    // (c) NO-CLOBBER: implement was NOT re-executed — still exactly one
    // implement attempt.
    const implementAttempts = await attemptsFor(s.runId, "implement");

    expect(implementAttempts.length).toBe(1);

    await s.cleanup();
  }, 60_000);

  it("concurrent double-dispatch (return microtask + F3 sweep) does NOT double-run", async () => {
    const s = await seedReadyForReturn();

    // Record the return (records git, stales gates, flips Running) WITHOUT
    // the route's own queueMicrotask racing — we drive both dispatches by hand.
    // First do the two-phase return via the route to reach Running.
    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    // Let the route's own microtask + an explicit F3-style re-dispatch race.
    const { runFlow } = await import("@/lib/flows/runner");
    const { runTakeoverReturnRecoverySweep } = await import(
      "@/lib/runs/resume-recovery"
    );

    await Promise.all([
      runFlow(s.runId, { db } as never).catch(() => {}),
      runTakeoverReturnRecoverySweep({ db } as never).catch(() => {}),
    ]);

    const finalRun = await waitForResume(s.runId);

    // Exactly ONE fresh checks attempt from the resume (attempt 2) — the CAS
    // prevented a second parallel traversal from appending attempt 3.
    const checksAttempts = await attemptsFor(s.runId, REENTRY_NODE);

    expect(checksAttempts.length).toBe(2);

    // implement still never re-run.
    const implementAttempts = await attemptsFor(s.runId, "implement");

    expect(implementAttempts.length).toBe(1);

    expect(finalRun.status).toBe("NeedsInput");

    await s.cleanup();
  }, 60_000);
});
