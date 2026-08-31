// ADR-159 rework claim — integration behaviour against a real Postgres
// testcontainer, real migrations, a real on-disk git worktree, and the real
// authz layer (only @/auth's session source is mocked).
//
// Owns test ids: T-A3 (concurrent claims), T-A4 (cap-full), T-A5 (orchestrator
// child refusal). Later tasks extend this file with the return/release ids.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  nodeAttempts,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

const REENTRY_NODE = "checks";
const REVIEW_NODE = "review";

// A graph whose LAST executed node is `review` (a human node offering
// `takeover`), so the re-entry chain resolves via `takeover_transition`.
const fixtureManifest = {
  schemaVersion: 1,
  name: "Rework Claim Fixture",
  compat: { engine_min: "3.0.0" },
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
      transitions: { success: REVIEW_NODE },
    },
    {
      id: REVIEW_NODE,
      type: "human",
      finish: {
        human: { role: "maintainer", decisions: ["approve", "takeover"] },
      },
      transitions: { approve: "done", takeover: REENTRY_NODE },
    },
  ],
};

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    auth: vi.fn(async () => sessionRef.value),
    signIn: vi.fn(),
    signOut: vi.fn(),
    handlers: {},
  })),
}));

// Routed through a mutable ref so the CAS-race test can swap in a gated proxy.
const dbRef: { value: any } = { value: null };

vi.mock("@/lib/db/client", () => ({ getDb: () => dbRef.value }));

// The return route resumes the runner via queueMicrotask. These cases assert
// the committed state, not a real traversal.
const runFlowSpy = vi.fn(async (_runId: string, _opts?: unknown) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (runId: string, opts?: unknown) => runFlowSpy(runId, opts),
}));

// Delays the Nth `db.transaction(...)` call until `hold` resolves, so two
// requests can be driven into a REAL CAS collision instead of the accidental
// interleaving a bare Promise.all produces (a late request's pre-check would
// simply observe HumanWorking and refuse PRECONDITION, never reaching the CAS).
function gatedDb(base: any, gate: () => Promise<void> | null): any {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return async (...args: any[]) => {
          const hold = gate();

          if (hold) await hold;

          return (target as any).transaction(...args);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

let claimPOST: typeof import("../claim/route").POST;
let returnPOST: typeof import("../return/route").POST;
let releasePOST: typeof import("../release/route").POST;
let secondTxResolver: () => void = () => {};

async function provisionWorktree(slug: string): Promise<{
  parentRepo: string;
  worktreePath: string;
  branch: string;
  mainBranch: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), `rwc-${slug}-`));
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

type Seed = {
  runId: string;
  projectId: string;
  ownerId: string;
  worktreePath: string;
  parentRepo: string;
  branch: string;
  cleanup: () => Promise<void>;
};

async function seed(opts: {
  runStatus?: string;
  parentRunId?: string | null;
  ledgerNodes?: string[];
  extraLiveRuns?: number;
} = {}): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  const ownerId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `rwc-${tag}`;
  const wt = await provisionWorktree(slug);

  await db.insert(users).values({
    id: ownerId,
    email: `owner-${tag}@maister.local`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
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
    flowRefId: "rework-claim-fixture",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${flowId}`,
    manifest: fixtureManifest,
    schemaVersion: 1,
  });
  await db.insert(tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    status: opts.runStatus ?? "Review",
    // Review writes a NULL cursor — the anchor and re-entry are ledger-derived.
    currentStepId: null,
    parentRunId: opts.parentRunId ?? null,
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    parentRepoPath: wt.parentRepo,
  });

  // A finished graph's ledger: implement -> checks -> review.
  const ledgerNodes = opts.ledgerNodes ?? ["implement", REENTRY_NODE, REVIEW_NODE];
  // Strictly in the PAST: the claim row that follows takes the column default
  // (now()), and `hasPendingTakeoverResume` treats any re-entry attempt started
  // AFTER the takeover row as "the resume already progressed".
  let t = Date.now() - 600_000;

  for (const nodeId of ledgerNodes) {
    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId,
      nodeType: nodeId === REVIEW_NODE ? "human" : "check",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date(t),
      endedAt: new Date(t + 1000),
    });
    t += 5000;
  }

  // Saturate the flow pool with unrelated live runs when the test needs it.
  for (let i = 0; i < (opts.extraLiveRuns ?? 0); i += 1) {
    await db.insert(runs).values({
      id: randomUUID(),
      taskId,
      projectId,
      flowId,
      status: "Running",
      flowVersion: "v1.0.0",
      startedAt: new Date(),
    });
  }

  sessionRef.value = { user: { id: ownerId, role: "member" } };

  return {
    runId,
    projectId,
    ownerId,
    worktreePath: wt.worktreePath,
    parentRepo: wt.parentRepo,
    branch: wt.branch,
    cleanup: async () => {
      await rm(path.dirname(wt.parentRepo), { recursive: true, force: true });
    },
  };
}

function claimReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/rework-claim/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

async function claimRows(runId: string): Promise<any[]> {
  return db
    .select()
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), isNotNull(nodeAttempts.ownerUserId)),
    );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "rework_claim_test",
  });
  db = testDatabase.db;
  dbRef.value = db;
  ({ POST: claimPOST } = await import("../claim/route"));
  ({ POST: returnPOST } = await import("../return/route"));
  ({ POST: releasePOST } = await import("../release/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

// The concurrency cap is GLOBAL, so runs a test leaves live would starve every
// later test in this file (the claim would refuse CONFLICT before reaching the
// behaviour under test). Terminalize the pool after each case — assertions have
// already run by then, so this frees slots without masking anything.
afterEach(async () => {
  await db
    .update(runs)
    .set({ status: "Done" })
    .where(inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]));
});

describe("ADR-159 rework claim (integration)", () => {
  it("claims a Review run and resolves re-entry from the ledger takeover transition", async () => {
    const s = await seed();

    const res = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.reentryNodeId).toBe(REENTRY_NODE);
    expect(body.reentrySource).toBe("takeover_transition");
    expect(body.ownerUserId).toBe(s.ownerId);
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    // The claim row anchors on the LAST EXECUTED node, not the re-entry node.
    const rows = await claimRows(s.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe(REVIEW_NODE);
    expect(rows[0].decision).toBe("review_rework_claim");
    expect(rows[0].endedAt).toBeNull();

    await s.cleanup();
  });

  // T-A3 (AC-A3): a REAL two-racer collision, not a Promise.all interleave.
  // Both requests complete their pre-check while the run is still `Review`;
  // a barrier then holds the FIRST transaction until the SECOND has committed,
  // so the first one's CAS re-evaluates `WHERE status='Review'` against the
  // committed HumanWorking row, matches 0 rows, and is refused at the CAS door.
  // That is the path that must yield CONFLICT rather than a raw Postgres 23505
  // surfacing as a 500 — which is exactly why the CAS precedes the
  // UNIQUE(run_id, node_id, attempt) insert.
  it("T-A3 — concurrent claims yield exactly one winner and no second attempt row", async () => {
    const s = await seed();

    let firstTxSeen = false;
    let releaseFirstTx: () => void = () => {};
    const firstTxHold = new Promise<void>((resolve) => {
      releaseFirstTx = resolve;
    });
    const secondTxEntered = new Promise<void>((resolve) => {
      // Resolved when a transaction other than the held one starts.
      secondTxResolver = resolve;
    });

    dbRef.value = gatedDb(db, () => {
      if (!firstTxSeen) {
        firstTxSeen = true;

        return firstTxHold;
      }
      secondTxResolver();

      return null;
    });

    try {
      const a = claimPOST(claimReq(s.runId), {
        params: Promise.resolve({ runId: s.runId }),
      });
      const b = claimPOST(claimReq(s.runId), {
        params: Promise.resolve({ runId: s.runId }),
      });

      // B's transaction runs and commits while A is held at its own tx
      // boundary — A has already passed its pre-check by then.
      await secondTxEntered;
      await b;
      releaseFirstTx();

      const [resA, resB] = await Promise.all([a, b]);
      const statuses = [resA.status, resB.status].sort();

      expect(statuses).toEqual([200, 409]);

      const loser = resA.status === 409 ? resA : resB;

      expect((await loser.json()).code).toBe("CONFLICT");
    } finally {
      dbRef.value = db;
    }

    // Exactly one claim row — the loser was refused at the CAS and never
    // reached the unique-constrained insert.
    expect(await claimRows(s.runId)).toHaveLength(1);
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    await s.cleanup();
  });

  // T-A4 (AC-A4): Review is slot-free and HumanWorking is not, so the claim
  // ACQUIRES a slot. A full cap refuses — it must NEVER queue the run Pending,
  // because the scheduler cannot "start" a human.
  it("T-A4 — a cap-full claim returns CONFLICT and creates no Pending row", async () => {
    const cap = Number(process.env.MAISTER_MAX_CONCURRENT_RUNS ?? "6");
    const s = await seed({ extraLiveRuns: cap });

    const res = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");

    const run = await readRun(s.runId);

    // Unchanged — not HumanWorking, and emphatically not Pending.
    expect(run.status).toBe("Review");
    expect(await claimRows(s.runId)).toHaveLength(0);

    await s.cleanup();
  });

  // T-A5 (AC-A5): SETTLED_RUN_STATUSES includes Review, so claiming a delegated
  // child would un-settle an orchestrator parent that may already have
  // completed. parent_run_id IS NULL is what prevents it.
  it("T-A5 — an orchestrator child refuses, protecting SETTLED_RUN_STATUSES", async () => {
    const parent = await seed();
    const child = await seed({ parentRunId: parent.runId });

    // seed() re-points the session at the child's owner; re-assert it.
    sessionRef.value = { user: { id: child.ownerId, role: "member" } };

    const res = await claimPOST(claimReq(child.runId), {
      params: Promise.resolve({ runId: child.runId }),
    });

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe("PRECONDITION");
    expect(body.message.toLowerCase()).toContain("orchestrator");
    expect((await readRun(child.runId)).status).toBe("Review");

    await child.cleanup();
    await parent.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Return + release (T-A9, T-A10, T-A11, T-A12, T-A15, T-A17)
// ---------------------------------------------------------------------------

function returnReq(runId: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/rework-claim/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function releaseReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/rework-claim/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
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

// Gives the run's branch an upstream on a real bare remote, so the ingest has
// something to fetch. Returns the remote's path.
async function attachRemote(s: {
  parentRepo: string;
  worktreePath: string;
  branch: string;
}): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), "rwc-remote-"));

  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["-C", s.parentRepo, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", s.worktreePath, "push", "-u", "origin", s.branch]);

  return remote;
}

async function claimAs(s: Seed): Promise<void> {
  sessionRef.value = { user: { id: s.ownerId, role: "member" } };
  const res = await claimPOST(claimReq(s.runId), {
    params: Promise.resolve({ runId: s.runId }),
  });

  expect(res.status).toBe(200);
}

describe("ADR-159 rework return + release (integration)", () => {
  // T-A10 (AC-A10): the purely-local loop must still work. No remote configured
  // at all ⇒ the ingest is a no-op SUCCESS, not a failure.
  it("T-A10 — a missing remote is a no-op success", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "local fix\n", "fix");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.fastForwarded).toBe(false);
    expect(body.returnedCommitCount).toBe(1);
    expect((await readRun(s.runId)).status).toBe("Running");

    await s.cleanup();
  });

  // T-A9 (AC-A9): divergence refuses with the failing command and both SHAs,
  // and leaves branch, ledger, and status byte-identical.
  it("T-A9 — non-fast-forward divergence refuses and mutates nothing", async () => {
    const s = await seed();

    await claimAs(s);

    const remote = await attachRemote(s);

    // Remote advances independently of the local branch...
    const clone = await mkdtemp(path.join(tmpdir(), "rwc-clone-"));

    await execFileAsync("git", ["clone", "-b", s.branch, remote, clone]);
    await execFileAsync("git", ["-C", clone, "config", "user.email", "t@t.dev"]);
    await execFileAsync("git", ["-C", clone, "config", "user.name", "T"]);
    await writeFile(path.join(clone, "remote.txt"), "remote work\n");
    await execFileAsync("git", ["-C", clone, "add", "."]);
    await execFileAsync("git", ["-C", clone, "commit", "-m", "remote"]);
    await execFileAsync("git", ["-C", clone, "push"]);

    // ...while the local worktree commits something else → true divergence.
    await commitInWorktree(s.worktreePath, "local.txt", "local work\n", "local");

    const headBefore = (
      await execFileAsync("git", ["-C", s.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();

    const res = await returnPOST(returnReq(s.runId, { remote: "origin" }), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe("PRECONDITION");
    expect(body.details.command).toContain("merge --ff-only");
    expect(body.details.localSha).toBeTruthy();
    expect(body.details.remoteSha).toBeTruthy();
    expect(body.details.localSha).not.toBe(body.details.remoteSha);
    expect(Array.isArray(body.details.instructions)).toBe(true);
    expect(body.details.instructions.length).toBeGreaterThan(0);

    // Byte-identical: branch head, run status, and the still-open claim.
    const headAfter = (
      await execFileAsync("git", ["-C", s.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();

    expect(headAfter).toBe(headBefore);
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    expect((await claimRows(s.runId))[0].endedAt).toBeNull();

    await rm(clone, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await s.cleanup();
  });

  // The ingest's reason for existing: work pushed from ANOTHER machine is
  // fast-forwarded in and returned.
  it("fast-forwards commits pushed from elsewhere and returns them", async () => {
    const s = await seed();

    await claimAs(s);

    const remote = await attachRemote(s);
    const clone = await mkdtemp(path.join(tmpdir(), "rwc-clone-"));

    await execFileAsync("git", ["clone", "-b", s.branch, remote, clone]);
    await execFileAsync("git", ["-C", clone, "config", "user.email", "t@t.dev"]);
    await execFileAsync("git", ["-C", clone, "config", "user.name", "T"]);
    await writeFile(path.join(clone, "elsewhere.txt"), "pushed from elsewhere\n");
    await execFileAsync("git", ["-C", clone, "add", "."]);
    await execFileAsync("git", ["-C", clone, "commit", "-m", "elsewhere"]);
    await execFileAsync("git", ["-C", clone, "push"]);

    const res = await returnPOST(returnReq(s.runId, { remote: "origin" }), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.fastForwarded).toBe(true);
    expect(body.returnedCommitCount).toBeGreaterThanOrEqual(1);
    expect((await readRun(s.runId)).status).toBe("Running");

    await rm(clone, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await s.cleanup();
  });

  it("refuses an unknown remote against the server-derived allow-list", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "x\n", "fix");

    const res = await returnPOST(returnReq(s.runId, { remote: "not-a-remote" }), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    await s.cleanup();
  });

  // T-A11 (AC-A11): a dirty worktree and a zero-commit return each refuse
  // CONFLICT with NO ledger write.
  it("T-A11 — a dirty worktree refuses CONFLICT with no ledger write", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "committed\n", "fix");
    await writeFile(path.join(s.worktreePath, "dirty.txt"), "uncommitted\n");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    expect((await claimRows(s.runId))[0].endedAt).toBeNull();

    await s.cleanup();
  });

  it("T-A11 — a zero-commit return refuses CONFLICT with no ledger write", async () => {
    const s = await seed();

    await claimAs(s);

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    expect((await claimRows(s.runId))[0].endedAt).toBeNull();

    await s.cleanup();
  });

  it("refuses a non-owner return with UNAUTHORIZED", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "x\n", "fix");

    const otherId = randomUUID();

    await db.insert(users).values({
      id: otherId,
      email: `other-${otherId.slice(0, 8)}@maister.local`,
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
    expect((await res.json()).code).toBe("UNAUTHORIZED");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    await s.cleanup();
  });

  // T-A15 (AC-A15): release returns the run to Review — NOT NeedsInput, because
  // this provenance has no review HITL to re-open — and closes the claim row.
  it("T-A15 — release returns the run to Review and closes the claim", async () => {
    const s = await seed();

    await claimAs(s);

    const res = await releasePOST(releaseReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).runStatus).toBe("Review");

    const run = await readRun(s.runId);

    expect(run.status).toBe("Review");

    const rows = await claimRows(s.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].endedAt).not.toBeNull();

    await s.cleanup();
  });

  it("refuses a second release after the first won", async () => {
    const s = await seed();

    await claimAs(s);

    const first = await releasePOST(releaseReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(first.status).toBe(200);

    const second = await releasePOST(releaseReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(second.status).toBe(409);
    expect((await readRun(s.runId)).status).toBe("Review");

    await s.cleanup();
  });

  // The return route is for the ADR-159 provenance only; an ADR-030 takeover
  // must keep using /takeover/return, whose re-entry comes from the parked
  // node's transitions.takeover rather than the ADR-159 chain.
  it("refuses to return an ADR-030 takeover claim", async () => {
    const s = await seed();

    // A takeover-shaped claim row: owner set, but no `decision` marker.
    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId: s.runId,
      nodeId: REVIEW_NODE,
      nodeType: "human",
      attempt: 99,
      status: "NeedsInput",
      ownerUserId: s.ownerId,
      startedAt: new Date(),
      endedAt: null,
    });
    await db
      .update(runs)
      .set({ status: "HumanWorking" })
      .where(eq(runs.id, s.runId));

    sessionRef.value = { user: { id: s.ownerId, role: "member" } };

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("/takeover/return");

    await s.cleanup();
  });

  // T-A17 (AC-A17): a return committed with no runner dispatch must be reachable
  // by the EXISTING runTakeoverReturnRecoverySweep — no new sweep (CA3).
  it("T-A17 — a committed return with no dispatch is reachable by the existing recovery sweep", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "x\n", "fix");

    runFlowSpy.mockClear();

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    // Exactly the durable state a process death before dispatch would leave.
    const run = await readRun(s.runId);

    expect(run.status).toBe("Running");
    expect(run.currentStepId).toBe(REENTRY_NODE);

    const { hasPendingTakeoverResume } = await import(
      "@/lib/flows/graph/ledger"
    );

    // The sweep's own predicate — agnostic to the takeover row's node, which is
    // what lets it reach this provenance unchanged.
    expect(await hasPendingTakeoverResume(s.runId, REENTRY_NODE, db)).toBe(true);

    await s.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Domain events (T-A16) — ADR-159 D11 / REQ-A10
// ---------------------------------------------------------------------------

async function domainEventsFor(runId: string): Promise<any[]> {
  return db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId));
}

describe("T-A16 ADR-159 — claim/return domain events", () => {
  it("writes exactly one run.rework_claimed with a user actor and the right payload", async () => {
    const s = await seed();

    await claimAs(s);

    const events = await domainEventsFor(s.runId);
    const claimed = events.filter((e) => e.kind === "run.rework_claimed");

    expect(claimed).toHaveLength(1);
    expect(claimed[0].actorType).toBe("user");
    expect(claimed[0].actorId).toBe(s.ownerId);
    expect(claimed[0].payload.reentryNodeId).toBe(REENTRY_NODE);
    expect(claimed[0].payload.reentrySource).toBe("takeover_transition");
    expect(claimed[0].payload.ownerUserId).toBe(s.ownerId);

    await s.cleanup();
  });

  it("writes exactly one run.rework_returned on return", async () => {
    const s = await seed();

    await claimAs(s);
    await commitInWorktree(s.worktreePath, "fix.txt", "x\n", "fix");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const returned = (await domainEventsFor(s.runId)).filter(
      (e) => e.kind === "run.rework_returned",
    );

    expect(returned).toHaveLength(1);
    expect(returned[0].actorType).toBe("user");
    expect(returned[0].payload.returnedCommitCount).toBe(1);
    expect(returned[0].payload.fastForwarded).toBe(false);

    await s.cleanup();
  });

  // Same transaction as the domain write (ADR-086 exactly-once): a refused claim
  // rolls the whole thing back, so NO event survives.
  it("writes no event when the claim is refused", async () => {
    const parent = await seed();
    const child = await seed({ parentRunId: parent.runId });

    sessionRef.value = { user: { id: child.ownerId, role: "member" } };

    const res = await claimPOST(claimReq(child.runId), {
      params: Promise.resolve({ runId: child.runId }),
    });

    expect(res.status).toBe(409);
    expect(await domainEventsFor(child.runId)).toHaveLength(0);

    await child.cleanup();
    await parent.cleanup();
  });

  // The CHECK is real, not decorative — it is why migration 0125 exists.
  it("the domain_events_kind_check rejects an unknown kind", async () => {
    const s = await seed();

    await expect(
      db.insert(schema.domainEvents).values({
        kind: "run.not_a_real_kind",
        projectId: s.projectId,
        runId: s.runId,
        actorType: "user",
        actorId: s.ownerId,
        payload: {},
      }),
    ).rejects.toThrow();

    await s.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Consumer fanout (T-A18) — the Feature-A column of the fanout table
// ---------------------------------------------------------------------------

describe("T-A18 ADR-159 — promote/sync fences and abandon, both directions", () => {
  // A7: promoteRun and assertSyncEligible each require status==='Review', so
  // HumanWorking is ALREADY fenced against both — no new fence code. Assert it
  // rather than assuming it.
  it("promote refuses while the run is HumanWorking", async () => {
    const s = await seed();

    await claimAs(s);

    const { promoteRun } = await import("@/lib/runs/promote");

    // Driven through the real service seam so the refusal REASON is asserted,
    // not merely that something threw.
    await expect(
      promoteRun(
        s.runId,
        {},
        {
          sessionUser: { id: s.ownerId },
          authorize: async () => undefined,
        },
        db,
      ),
    ).rejects.toThrow(/must be Review/);

    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    await s.cleanup();
  });

  it("sync refuses while the run is HumanWorking", async () => {
    const s = await seed();

    await claimAs(s);

    const { assertSyncEligible } = await import("@/lib/runs/sync-target");

    expect(() =>
      assertSyncEligible(
        {
          status: "HumanWorking",
          runKind: "flow",
          parentRunId: null,
          workspaceMode: null,
          isLaunchedLineage: false,
        },
        { removedAt: null },
      ),
    ).toThrowError(/Review/);

    await s.cleanup();
  });

  // The other direction: once promote or sync has taken the run out of Review,
  // a claim is refused by its own allow-list.
  it.each([["Running"], ["Done"]])(
    "a claim refuses once the run has left Review (status %s)",
    async (status) => {
      const s = await seed();

      await db.update(runs).set({ status }).where(eq(runs.id, s.runId));
      sessionRef.value = { user: { id: s.ownerId, role: "member" } };

      const res = await claimPOST(claimReq(s.runId), {
        params: Promise.resolve({ runId: s.runId }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("PRECONDITION");

      await s.cleanup();
    },
  );

  // abandonRun's releaseHumanWorking path flips HumanWorking -> NeedsInput and
  // then Abandoned inside ONE transaction, so the intermediate status is never
  // observable and the terminal outcome is identical for both provenances. The
  // claim row must still be closed.
  it("abandon terminalizes a Review-provenance claim and closes the claim row", async () => {
    const s = await seed();

    await claimAs(s);

    const abandonPOST = (await import("../../abandon/route")).POST;
    const res = await abandonPOST(
      new NextRequest(
        new Request(`http://localhost/api/runs/${s.runId}/abandon`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
      ),
      { params: Promise.resolve({ runId: s.runId }) },
    );

    expect(res.status).toBe(200);
    expect((await readRun(s.runId)).status).toBe("Abandoned");

    const rows = await claimRows(s.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].endedAt).not.toBeNull();

    await s.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Server-owned continuation availability (extends T-A8) — ADR-159 / REQ-A4, A5
// ---------------------------------------------------------------------------

describe("ADR-159 — run-detail continuation block is server-owned", () => {
  async function continuationFor(runId: string) {
    const { getRunDetail } = await import("@/lib/queries/run");
    const detail = await getRunDetail(runId);

    return detail?.continuation;
  }

  it("offers the claim on an eligible Review run, with the resolved re-entry", async () => {
    const s = await seed();
    const c = await continuationFor(s.runId);

    expect(c?.reworkClaimAvailable).toBe(true);
    expect(c?.disabledReason).toBeNull();
    expect(c?.reentryNodeId).toBe(REENTRY_NODE);
    expect(c?.reentrySource).toBe("takeover_transition");
    expect(c?.claim).toBeNull();

    await s.cleanup();
  });

  it("carries the open claim (anchored on the LAST EXECUTED node) once claimed", async () => {
    const s = await seed();

    await claimAs(s);

    const c = await continuationFor(s.runId);

    expect(c?.claim).not.toBeNull();
    expect(c?.claim?.ownerUserId).toBe(s.ownerId);
    // The anchor is the last executed node, NOT the re-entry node.
    expect(c?.claim?.anchorNodeId).toBe(REVIEW_NODE);
    expect(c?.reworkClaimAvailable).toBe(false);
    expect(c?.disabledReason).toBe("already claimed for rework");

    await s.cleanup();
  });

  it("carries a typed reason instead of availability for an ineligible run", async () => {
    const parent = await seed();
    const child = await seed({ parentRunId: parent.runId });
    const c = await continuationFor(child.runId);

    expect(c?.reworkClaimAvailable).toBe(false);
    expect(c?.disabledReason?.toLowerCase()).toContain("orchestrator");
    expect(c?.reentryNodeId).toBeNull();

    await child.cleanup();
    await parent.cleanup();
  });

  // The pointer the UI turns into "launch a new run from this branch".
  it("names the relaunch escape hatch when no re-entry can be resolved", async () => {
    const s = await seed();

    // Drop the human node's takeover transition from the pinned manifest.
    const noTakeover = {
      ...fixtureManifest,
      nodes: fixtureManifest.nodes.map((n: any) =>
        n.id === REVIEW_NODE
          ? { ...n, transitions: { approve: "done" } }
          : n,
      ),
    };

    await db
      .update(flows)
      .set({ manifest: noTakeover })
      .where(eq(flows.projectId, s.projectId));

    const c = await continuationFor(s.runId);

    expect(c?.reworkClaimAvailable).toBe(false);
    expect(c?.disabledReason?.toLowerCase()).toContain("launch a new run");
    expect(c?.reentryNodeId).toBeNull();

    await s.cleanup();
  });
});
