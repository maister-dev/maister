// M11b Phase 3.0b (RED → GREEN): integration behaviour + failure-classification
// table for the takeover claim + two-phase return routes. Real Postgres
// testcontainer + real migrations + real on-disk git worktree (the return
// route's git ops run against it). Real authz layer (mock only @/auth's session
// source). One test per matrix row.
//
// Owns matrix rows:
//   claim-from-NeedsInput-returns-200-context, claim-wrong-state-409,
//   concurrent-claim-409, claim-unauthorized-401-403,
//   return-records-commits-and-diff, return-stales-reentry-and-downstream,
//   resume-reruns-staled-gates, return-not-HumanWorking-409, non-owner-return-403,
//   git-failure-no-statechange, ledger-throw-503-stays-humanworking,
//   return-flips-Running-after-sideeffects, return-ignores-body-refs-uses-server-state.

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
import { and, eq, isNotNull } from "drizzle-orm";
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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  gateResults,
  nodeAttempts,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

const TAKEOVER_NODE = "review";
const REENTRY_NODE = "checks";

const fixtureManifest = {
  schemaVersion: 1,
  name: "Takeover Fixture",
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
      action: { command: "echo ok" },
      transitions: { success: "judge" },
    },
    {
      id: "judge",
      type: "judge",
      action: { prompt: "judge" },
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

// Controllable session — the REAL authz runs against the test DB.
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// The return route resumes the runner asynchronously via queueMicrotask. In the
// failure-table cases we never want a real graph traversal; the resume-rerun
// case drives the runner explicitly. Mock runFlow to a controllable spy.
const runFlowSpy = vi.fn(async (_runId: string, _opts?: unknown) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (runId: string, opts?: unknown) => runFlowSpy(runId, opts),
}));

let claimPOST: typeof import("../claim/route").POST;
let returnPOST: typeof import("../return/route").POST;

// Per-test parent repo + worktree on disk so resolveBaseRef/logRange/diffRange
// operate on real git state. Returns the worktree path + branch + main branch.
async function provisionWorktree(slug: string): Promise<{
  parentRepo: string;
  worktreePath: string;
  branch: string;
  mainBranch: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), `m11b-${slug}-`));
  const parentRepo = path.join(root, "repo");
  const worktreePath = path.join(root, "wt");
  const branch = `maister/${slug}`;
  const mainBranch = "main";

  await execFileAsync("git", ["init", "-b", mainBranch, parentRepo]);
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

  return { parentRepo, worktreePath, branch, mainBranch };
}

async function commitInWorktree(
  worktreePath: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(path.join(worktreePath, file), content);
  await execFileAsync("git", ["-C", worktreePath, "add", "."]);
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", message]);
}

type Seed = {
  runId: string;
  projectId: string;
  ownerId: string;
  worktreePath: string;
  branch: string;
  parentRepo: string;
  cleanup: () => Promise<void>;
};

// Unique fixture per test (patch 14.34 isolation): real flows row + non-null
// flowId + real users row (owner FK) + real on-disk worktree.
async function seed(opts: {
  runStatus: string;
  ownerEmail?: string;
  withTakeoverAttempt?: boolean;
  takeoverEnded?: boolean;
  currentStepId?: string;
}): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  const ownerId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const slug = `tk-${tag}`;

  const wt = await provisionWorktree(slug);

  await db.insert(users).values({
    id: ownerId,
    email: opts.ownerEmail ?? `owner-${tag}@maister.local`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  await db.insert(projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: wt.parentRepo,
    mainBranch: wt.mainBranch,
    maisterYamlPath: `${wt.parentRepo}/maister.yaml`,
  });

  await db.insert(projectMembers).values({
    id: randomUUID(),
    projectId,
    userId: ownerId,
    role: "member",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "takeover-fixture",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${flowId}`,
    manifest: fixtureManifest,
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
    status: opts.runStatus,
    currentStepId: opts.currentStepId ?? TAKEOVER_NODE,
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    parentRepoPath: wt.parentRepo,
  });

  if (opts.withTakeoverAttempt) {
    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: TAKEOVER_NODE,
      nodeType: "human",
      attempt: 1,
      status: "NeedsInput",
      ownerUserId: ownerId,
      endedAt: opts.takeoverEnded ? new Date() : null,
    });
  }

  sessionRef.value = { user: { id: ownerId, role: "member" } };

  return {
    runId,
    projectId,
    ownerId,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    parentRepo: wt.parentRepo,
    cleanup: async () => {
      await rm(path.dirname(wt.parentRepo), { recursive: true, force: true });
    },
  };
}

function claimReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

function returnReq(runId: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

async function activeTakeoverRow(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), isNotNull(nodeAttempts.ownerUserId)),
    );

  return rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("takeover_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ POST: claimPOST } = await import("../claim/route"));
  ({ POST: returnPOST } = await import("../return/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  runFlowSpy.mockReset();
  runFlowSpy.mockResolvedValue(undefined);
});

describe("takeover claim (integration)", () => {
  it("claim-from-NeedsInput-returns-200-context", async () => {
    const s = await seed({ runStatus: "NeedsInput" });

    const res = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.worktreePath).toBe(s.worktreePath);
    expect(body.branch).toBe(s.branch);
    expect(body.ownerUserId).toBe(s.ownerId);

    const run = await readRun(s.runId);

    expect(run.status).toBe("HumanWorking");

    // A takeover node_attempts row was appended with the owner.
    const ta = await activeTakeoverRow(s.runId);

    expect(ta.ownerUserId).toBe(s.ownerId);
    expect(ta.nodeId).toBe(TAKEOVER_NODE);

    await s.cleanup();
  }, 60_000);

  it("claim-wrong-state-409: not NeedsInput → 409 PRECONDITION, run unchanged", async () => {
    const s = await seed({ runStatus: "Running" });

    const res = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
    expect((await readRun(s.runId)).status).toBe("Running");

    await s.cleanup();
  }, 60_000);

  it("concurrent-claim-409: two simultaneous claims, loser is a documented 409 — NEVER 500", async () => {
    // FIX #2: with claimTakeover (the unique-violating node_attempts INSERT)
    // BEFORE the markHumanWorking CAS, two racing claims compute the same
    // attempt=max+1 and BOTH insert → the loser's INSERT raises a raw Postgres
    // duplicate-key (23505), which is NOT a MaisterError → 500. With the CAS
    // ordered FIRST, only the winner reaches claimTakeover; the loser is caught
    // by a typed MaisterError and returns a documented 409 — either CONFLICT
    // (both passed the pre-tx status snapshot, loser lost the CAS) or
    // PRECONDITION (the winner committed before the loser's pre-tx loadRun
    // snapshot, so it sees HumanWorking and short-circuits). Both are correct;
    // the regression guard is that the loser is NEVER 500. Run the race several
    // times so a raw-23505 leak cannot pass by luck.
    for (let i = 0; i < 5; i++) {
      const s = await seed({ runStatus: "NeedsInput" });

      const [a, b] = await Promise.all([
        claimPOST(claimReq(s.runId), {
          params: Promise.resolve({ runId: s.runId }),
        }),
        claimPOST(claimReq(s.runId), {
          params: Promise.resolve({ runId: s.runId }),
        }),
      ]);

      const statuses = [a.status, b.status].sort();

      expect(statuses).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;

      // The bug surfaced as a raw 500 from the duplicate-key INSERT; the fix
      // makes the loser a typed 409 in {CONFLICT, PRECONDITION} — explicitly
      // NOT 500.
      const loserCode = (await loser.json()).code;

      expect(loser.status).toBe(409);
      expect(["CONFLICT", "PRECONDITION"]).toContain(loserCode);
      expect((await readRun(s.runId)).status).toBe("HumanWorking");

      // Exactly one takeover owner row exists (the loser never reached the
      // unique-violating INSERT, so there is no orphan and no rolled-back row).
      const owners = await db
        .select()
        .from(nodeAttempts)
        .where(
          and(
            eq(nodeAttempts.runId, s.runId),
            isNotNull(nodeAttempts.ownerUserId),
          ),
        );

      expect(owners).toHaveLength(1);

      await s.cleanup();
    }
  }, 120_000);

  it("claim-unauthorized-401-403: anon 401, non-member 403", async () => {
    const s = await seed({ runStatus: "NeedsInput" });

    sessionRef.value = null;
    const anon = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(anon.status).toBe(401);

    // A different, non-member user.
    const strangerId = randomUUID();

    await db.insert(users).values({
      id: strangerId,
      email: `stranger-${strangerId.slice(0, 6)}@maister.local`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });
    sessionRef.value = { user: { id: strangerId, role: "member" } };

    const nonMember = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(nonMember.status).toBe(403);
    expect((await readRun(s.runId)).status).toBe("NeedsInput");

    await s.cleanup();
  }, 60_000);
});

describe("takeover return — two-phase + failure table (integration)", () => {
  it("return-records-commits-and-diff: returned_commits/diff/base_ref on the takeover row", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    await commitInWorktree(s.worktreePath, "feature.txt", "hello\n", "feat: x");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const ta = await activeTakeoverRow(s.runId);

    expect(ta.baseRef).toBeTruthy();
    expect(ta.returnedCommits).toContain("feat: x");
    expect(ta.returnedDiff).toContain("feature.txt");
    expect(ta.endedAt).not.toBeNull();

    await s.cleanup();
  }, 60_000);

  it("return-flips-Running-after-sideeffects: status Running only after ledger writes", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    await commitInWorktree(s.worktreePath, "f.txt", "x\n", "c1");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.runStatus).toBe("Running");

    const run = await readRun(s.runId);

    expect(run.status).toBe("Running");
    // The cursor is parked at the re-entry node (REENTRY_NODE) in the SAME
    // committed state as status='Running' — there is no observable
    // Running-with-old-cursor window (FIX #1: cursor write folded into the
    // Phase-2b tx). If the cursor write were still outside the tx, this could
    // momentarily read the REVIEW node here; the integration assertion pins the
    // post-commit invariant.
    expect(run.currentStepId).toBe(REENTRY_NODE);
    // The recorded return (AFTER-side marker side) is present.
    const ta = await activeTakeoverRow(s.runId);

    expect(ta.returnedDiff).not.toBeNull();
    expect(ta.endedAt).not.toBeNull();

    await s.cleanup();
  }, 60_000);

  it("return-is-atomic-status-and-cursor: a failure at the cursor-write step rolls the WHOLE return back; clean retry succeeds", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Seed a prior SUCCEEDED checks attempt with a PASSED gate so we can prove
    // the staling is rolled back too.
    const checksAttemptId = randomUUID();

    await db.insert(nodeAttempts).values({
      id: checksAttemptId,
      runId: s.runId,
      nodeId: REENTRY_NODE,
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      endedAt: new Date(),
    });
    const gateId = randomUUID();

    await db.insert(gateResults).values({
      id: gateId,
      runId: s.runId,
      nodeAttemptId: checksAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
      endedAt: new Date(),
    });

    await commitInWorktree(s.worktreePath, "f.txt", "x\n", "c1");

    // Force a failure AT the cursor-write step: the real markReturnedToRunning
    // runs (flips HumanWorking → Running INSIDE the Phase-2b tx) and THEN throws
    // a non-MaisterError — simulating the cursor `update` blowing up after the
    // CAS. If all four writes are atomic, the throw rolls back the Running flip,
    // the ended takeover row, and the gate staling together → 503 + unchanged
    // state. If the CAS/cursor writes were outside the tx (the bug), the run
    // would be left Running with a stale cursor/gates and a stranded ledger.
    const stateTransitions = await import("@/lib/runs/state-transitions");
    const realFlip = stateTransitions.markReturnedToRunning;
    const flipSpy = vi
      .spyOn(stateTransitions, "markReturnedToRunning")
      .mockImplementationOnce(async (runId, opts) => {
        await realFlip(runId, opts);
        throw new Error("simulated cursor-write failure");
      });

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    // Non-MaisterError inside the tx → 503 EXECUTOR_UNAVAILABLE, retryable.
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");

    // WHOLE return rolled back: run stays HumanWorking, cursor unchanged.
    const run = await readRun(s.runId);

    expect(run.status).toBe("HumanWorking");
    expect(run.currentStepId).toBe(TAKEOVER_NODE);

    // Takeover row NOT ended, no diff recorded.
    const ta = await activeTakeoverRow(s.runId);

    expect(ta.endedAt).toBeNull();
    expect(ta.returnedDiff).toBeNull();

    // Gates NOT staled.
    const gate = (
      await db.select().from(gateResults).where(eq(gateResults.id, gateId))
    )[0];

    expect(gate.status).toBe("passed");

    // The runner must NOT have been queued on the failed (rolled-back) attempt.
    expect(runFlowSpy).not.toHaveBeenCalled();

    // Clean retry replays to success: 200, Running, cursor at the re-entry.
    flipSpy.mockRestore();

    const retry = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(retry.status).toBe(200);
    expect((await retry.json()).runStatus).toBe("Running");
    const afterRetry = await readRun(s.runId);

    expect(afterRetry.status).toBe("Running");
    expect(afterRetry.currentStepId).toBe(REENTRY_NODE);
    const taRetry = await activeTakeoverRow(s.runId);

    expect(taRetry.endedAt).not.toBeNull();
    expect(taRetry.returnedDiff).not.toBeNull();
    const gateRetry = (
      await db.select().from(gateResults).where(eq(gateResults.id, gateId))
    )[0];

    expect(gateRetry.status).toBe("stale");

    await s.cleanup();
  }, 60_000);

  it("return-stales-reentry-and-downstream: re-entry node's prior gate flips stale", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Seed a prior SUCCEEDED checks attempt with a PASSED gate (validated
    // pre-takeover code). On return it MUST flip stale.
    const checksAttemptId = randomUUID();

    await db.insert(nodeAttempts).values({
      id: checksAttemptId,
      runId: s.runId,
      nodeId: REENTRY_NODE,
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      endedAt: new Date(),
    });
    const gateId = randomUUID();

    await db.insert(gateResults).values({
      id: gateId,
      runId: s.runId,
      nodeAttemptId: checksAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
      endedAt: new Date(),
    });

    await commitInWorktree(s.worktreePath, "f.txt", "x\n", "c1");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    // The re-entry's prior passed gate is now stale (BEFORE any rerun).
    const gate = (
      await db.select().from(gateResults).where(eq(gateResults.id, gateId))
    )[0];

    expect(gate.status).toBe("stale");

    // The re-entry node attempt itself flipped Stale.
    const checks = (
      await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.id, checksAttemptId))
    )[0];

    expect(checks.status).toBe("Stale");

    await s.cleanup();
  }, 60_000);

  it("return-not-HumanWorking-409: already returned (Running) → 409 PRECONDITION, no re-import", async () => {
    const s = await seed({
      runStatus: "Running",
      withTakeoverAttempt: true,
      takeoverEnded: true,
    });

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");

    await s.cleanup();
  }, 60_000);

  it("non-owner-return-403: session user != owner_user_id", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // A different project member tries to return.
    const otherId = randomUUID();

    await db.insert(users).values({
      id: otherId,
      email: `other-${otherId.slice(0, 6)}@maister.local`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });
    await db.insert(projectMembers).values({
      id: randomUUID(),
      projectId: s.projectId,
      userId: otherId,
      role: "member",
    });
    sessionRef.value = { user: { id: otherId, role: "member" } };

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(403);
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    await s.cleanup();
  }, 60_000);

  it("git-failure-no-statechange: git op fails → 409, run stays HumanWorking, returned_diff null, no stale", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Seed a prior passed checks gate — it must NOT flip stale when the git
    // op fails before markDownstreamStale.
    const checksAttemptId = randomUUID();

    await db.insert(nodeAttempts).values({
      id: checksAttemptId,
      runId: s.runId,
      nodeId: REENTRY_NODE,
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      endedAt: new Date(),
    });
    const gateId = randomUUID();

    await db.insert(gateResults).values({
      id: gateId,
      runId: s.runId,
      nodeAttemptId: checksAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
      endedAt: new Date(),
    });

    // Remove the worktree so resolveBaseRef/logRange/diffRange fail.
    await rm(s.worktreePath, { recursive: true, force: true });

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");

    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    const ta = await activeTakeoverRow(s.runId);

    expect(ta.returnedDiff).toBeNull();
    expect(ta.endedAt).toBeNull();
    const gate = (
      await db.select().from(gateResults).where(eq(gateResults.id, gateId))
    )[0];

    expect(gate.status).toBe("passed");

    await s.cleanup();
  }, 60_000);

  it("ledger-throw-503-stays-humanworking: markDownstreamStale throws mid-side-effect → 503, stays HumanWorking", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    await commitInWorktree(s.worktreePath, "f.txt", "x\n", "c1");

    const ledger = await import("@/lib/flows/graph/ledger");
    const spy = vi
      .spyOn(ledger, "markDownstreamStale")
      .mockRejectedValueOnce(
        new (await import("@/lib/errors")).MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "db down",
        ),
      );

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    // B1: no PARTIAL write after the 503. recordTakeoverReturn and
    // markDownstreamStale must commit atomically — the takeover row must NOT
    // have been ended (endedAt null) and returnedDiff must be null. If
    // recordTakeoverReturn auto-committed before markDownstreamStale threw, the
    // row would be ended and Phase 1's getActiveTakeover (filters endedAt===null)
    // would return null on retry → the run is permanently un-returnable.
    const after503 = await activeTakeoverRow(s.runId);

    expect(after503.endedAt).toBeNull();
    expect(after503.returnedDiff).toBeNull();
    expect(after503.baseRef).toBeNull();

    // The 503 is retryable: the FOR UPDATE re-read still finds HumanWorking and
    // the un-ended takeover row, so a clean retry replays to success.
    spy.mockRestore();

    const retry = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(retry.status).toBe(200);
    expect((await retry.json()).runStatus).toBe("Running");
    expect((await readRun(s.runId)).status).toBe("Running");
    const afterRetry = await activeTakeoverRow(s.runId);

    expect(afterRetry.endedAt).not.toBeNull();
    expect(afterRetry.returnedDiff).not.toBeNull();

    await s.cleanup();
  }, 60_000);

  it("return-ignores-body-refs-uses-server-state: body refs are ignored; server-state used", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    await commitInWorktree(s.worktreePath, "f.txt", "x\n", "c1");

    // A malicious body naming foreign paths/branches/refs must be IGNORED.
    const res = await returnPOST(
      returnReq(s.runId, {
        worktreePath: "/etc",
        branch: "evil",
        baseRef: "HEAD~99",
        ownerUserId: "attacker",
      }),
      { params: Promise.resolve({ runId: s.runId }) },
    );

    expect(res.status).toBe(200);
    const ta = await activeTakeoverRow(s.runId);

    // The recorded diff came from the SERVER-state worktree, not /etc.
    expect(ta.returnedDiff).toContain("f.txt");

    await s.cleanup();
  }, 60_000);
});
