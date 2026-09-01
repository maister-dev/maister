// ADR-141: branch-sync crash-window recovery — reconcile arms (W2/W3),
// the system-sweep W1/W4 orphan-op + W5 active-time duration cap, and the
// in-process driver registry (the skip-vs-abort discriminant). The supervisor
// boundary is injected via opts (deleteSession/listSessions); no live agent.

import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

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

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// promoteNextPending is the slot-release contract; stub it (no spawn side effects).
vi.mock("@/lib/scheduler", async (orig) => {
  const actual = await orig<typeof import("@/lib/scheduler")>();

  return { ...actual, promoteNextPending: vi.fn(async () => undefined) };
});
// The git seam. Only the three calls the recovery arms make decisions on are
// stubbed — `restoreWorktreeToCommit` is the DESTRUCTIVE one these tests must be
// able to prove was NOT called, and headCommit/remoteBranchHead are the origin
// question the `pushing` arm settles forward on. Everything else stays real.
vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    headCommit: vi.fn(async () => {
      throw new Error("no worktree");
    }),
    remoteBranchHead: vi.fn(async () => {
      throw new Error("no remote");
    }),
    restoreWorktreeToCommit: vi.fn(async () => undefined),
    abortSyncOperation: vi.fn(async () => undefined),
    // W3 reads the target head and the branch's published-ness before deciding.
    localBranchHead: vi.fn(async () => "7".repeat(40)),
    branchHasUpstream: vi.fn(async () => false),
  };
});

// The two things sync-recovery borrows from the live path. Stubbing them is what
// makes the W3 arm reachable at all: it re-runs the REAL verify gate against a
// worktree that does not exist here, and its push is a network call.
vi.mock("@/lib/runs/sync-target", async (orig) => {
  const actual = await orig<typeof import("@/lib/runs/sync-target")>();

  return {
    ...actual,
    verifySyncGate: vi.fn(async () => ({ ok: true }) as const),
    pushWithLease: vi.fn(async () => ({ pushed: true }) as const),
  };
});

const {
  recoverSyncAttemptOnReconcile,
  runSyncRecoverySweep,
  SYNC_ATTEMPT_MAX_MINUTES,
} = await import("@/lib/runs/sync-recovery");
const { verifySyncGate, pushWithLease } = await import(
  "@/lib/runs/sync-target"
);
const { registerSyncDriver, unregisterSyncDriver, hasSyncDriver } =
  await import("@/lib/runs/sync-driver-registry");
const {
  headCommit,
  remoteBranchHead,
  restoreWorktreeToCommit,
  localBranchHead,
  branchHasUpstream,
} = await import("@/lib/worktree");

let testDatabase: StartedPostgresTestDb;
let pool: Pool;

function newId(): string {
  return randomUUID();
}

async function seedGraph(): Promise<{
  projectId: string;
  flowId: string;
  taskId: string;
}> {
  const projectId = newId();
  const flowId = newId();
  const taskId = newId();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `rec-${short}`,
      `Rec ${short}`,
      `/tmp/rec-${short}`,
      `T${short.toUpperCase()}`,
    ],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1.0.0', '/tmp/flows/bugfix', '{"schemaVersion":1,"name":"B","nodes":[]}', 1)`,
    [flowId, projectId],
  );
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id)
     values ($1, $2, 1, 'Rec task', 'x', $3)`,
    [taskId, projectId, flowId],
  );

  return { projectId, flowId, taskId };
}

async function seedRunAttempt(opts: {
  status: string;
  mode: "mechanical" | "agent";
  phase: string;
  agentRunningSince?: Date | null;
  headShaBefore?: string | null;
}): Promise<{
  runId: string;
  workspaceId: string;
  attemptId: string;
  lifecycleAttemptId: string;
}> {
  const { projectId, taskId } = await seedGraph();
  const runId = newId();
  const workspaceId = newId();
  const attemptId = newId();
  // The claim's fence token. `syncRunTarget` ALWAYS mints one alongside the
  // claim, so a seed without it is a state production cannot produce — and it
  // would silently exempt these rows from the fenced release under test.
  const lifecycleAttemptId = newId();

  await pool.query(
    `insert into runs (id, project_id, task_id, run_kind, status, flow_version, flow_revision, started_at)
     values ($1, $2, $3, 'flow', $4, 'v1', 'manual', now())`,
    [runId, projectId, taskId, opts.status],
  );
  // `workspaces_lifecycle_claim_shape_check` requires ALL of attempt id, name,
  // expected run status, and lease to be present for state 'claiming' — and
  // `syncRunTarget` writes exactly that set (expected status = the run's status
  // at claim time, plus a lease). Omitting the last two is a state production
  // cannot produce, and the CHECK rejects the insert outright.
  await pool.query(
    `insert into workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path,
        lifecycle_operation_name, lifecycle_operation_state, lifecycle_operation_attempt_id,
        lifecycle_operation_expected_run_status, lifecycle_operation_claimed_at,
        lifecycle_operation_lease_expires_at)
     values ($1, $2, $3, 'maister/rec', $4, '/tmp/repo', 'sync', 'claiming', $5, $6, now(), now() + interval '10 minutes')`,
    [
      workspaceId,
      runId,
      projectId,
      `/tmp/wt-${workspaceId.slice(0, 8)}`,
      lifecycleAttemptId,
      opts.status,
    ],
  );
  await pool.query(
    `insert into run_sync_attempts (id, run_id, workspace_id, attempt, strategy, mode, phase, agent_running_since, head_sha_before)
     values ($1, $2, $3, 1, 'rebase', $4, $5, $6, $7)`,
    [
      attemptId,
      runId,
      workspaceId,
      opts.mode,
      opts.phase,
      opts.agentRunningSince ?? null,
      opts.headShaBefore ?? null,
    ],
  );

  return { runId, workspaceId, attemptId, lifecycleAttemptId };
}

// A SECOND attempt on an existing run — the shape `loadActiveAttempt`'s
// `orderBy(desc(attempt))` exists for, which a single-attempt seed can never
// distinguish from "pick the only row".
async function seedExtraAttempt(opts: {
  runId: string;
  workspaceId: string;
  attempt: number;
  phase: string;
  mode?: "mechanical" | "agent";
}): Promise<string> {
  const attemptId = newId();

  await pool.query(
    `insert into run_sync_attempts (id, run_id, workspace_id, attempt, strategy, mode, phase)
     values ($1, $2, $3, $4, 'rebase', $5, $6)`,
    [
      attemptId,
      opts.runId,
      opts.workspaceId,
      opts.attempt,
      opts.mode ?? "agent",
      opts.phase,
    ],
  );

  return attemptId;
}

async function readRunStatus(runId: string): Promise<string> {
  const r = await pool.query(`select status from runs where id = $1`, [runId]);

  return r.rows[0].status;
}

async function readAttemptPhase(id: string): Promise<string> {
  const r = await pool.query(
    `select phase from run_sync_attempts where id = $1`,
    [id],
  );

  return r.rows[0].phase;
}

async function readAttempt(id: string): Promise<{
  phase: string;
  pushed: boolean | null;
  headShaAfter: string | null;
}> {
  const r = await pool.query(
    `select phase, pushed, head_sha_after from run_sync_attempts where id = $1`,
    [id],
  );

  return {
    phase: r.rows[0].phase,
    pushed: r.rows[0].pushed,
    headShaAfter: r.rows[0].head_sha_after,
  };
}

// The lifecycle slot this sync attempt holds. Releasing it is the whole point of
// the orphan arms: a stranded `claiming` refuses promote AND all six lifecycle
// ops forever, with no exit but DB surgery.
async function readClaim(
  workspaceId: string,
): Promise<{ state: string | null; name: string | null }> {
  const r = await pool.query(
    `select lifecycle_operation_state, lifecycle_operation_name
       from workspaces where id = $1`,
    [workspaceId],
  );

  return {
    state: r.rows[0].lifecycle_operation_state,
    name: r.rows[0].lifecycle_operation_name,
  };
}

const noSessions = async (): Promise<SupervisorSessionRecord[]> => [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "sync_recovery_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const id of [...hasSyncDriverIds()]) unregisterSyncDriver(id);
  // `runSyncRecoverySweep` scans EVERY non-terminal attempt in the database, so
  // a row seeded by a previous test is a candidate for the next test's sweep —
  // and the driver clear above turns the skipped-because-driven row into an
  // orphan. Without this the summary counters are shared state and each test's
  // expectation silently depends on file order.
  await pool.query(`delete from run_sync_attempts`);
  vi.mocked(restoreWorktreeToCommit).mockClear();
  vi.mocked(headCommit).mockReset().mockRejectedValue(new Error("no worktree"));
  vi.mocked(remoteBranchHead)
    .mockReset()
    .mockRejectedValue(new Error("no remote"));
  vi.mocked(localBranchHead).mockReset().mockResolvedValue("7".repeat(40));
  vi.mocked(branchHasUpstream).mockReset().mockResolvedValue(false);
  vi.mocked(verifySyncGate).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(pushWithLease).mockReset().mockResolvedValue({ pushed: true });
});

// Track registered ids so beforeEach can clear the module-level registry.
const registered = new Set<string>();

function register(runId: string): void {
  registered.add(runId);
  registerSyncDriver(runId);
}

function hasSyncDriverIds(): string[] {
  return [...registered];
}

describe("sync-driver registry", () => {
  it("tracks membership and clears on unregister", () => {
    const runId = newId();

    expect(hasSyncDriver(runId)).toBe(false);
    registerSyncDriver(runId);
    expect(hasSyncDriver(runId)).toBe(true);
    unregisterSyncDriver(runId);
    expect(hasSyncDriver(runId)).toBe(false);
  });
});

describe("runSyncRecoverySweep — W5 active-time duration cap", () => {
  it("kills a Running agent_running attempt past the cap and returns the run to Review", async () => {
    const past = new Date(Date.now() - (SYNC_ATTEMPT_MAX_MINUTES + 1) * 60_000);
    const { runId, attemptId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: past,
    });
    const deleteSession = vi.fn(async () => undefined);

    const summary = await runSyncRecoverySweep({
      db,
      deleteSession,
      listSessions: noSessions,
    });

    expect(summary.durationCapKilled).toBe(1);
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });

  it("does NOT kill a recently-active resolver (within the cap)", async () => {
    const recent = new Date(Date.now() - 5 * 60_000);
    const { runId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: recent,
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.durationCapKilled).toBe(0);
    expect(await readRunStatus(runId)).toBe("Running");
  });

  it("does NOT kill a resolver paused in NeedsInput (human-wait time never counts)", async () => {
    const past = new Date(
      Date.now() - (SYNC_ATTEMPT_MAX_MINUTES + 10) * 60_000,
    );
    const { runId } = await seedRunAttempt({
      status: "NeedsInput",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: past,
    });

    // A LIVE paused resolver — which is what this contract is about — still has
    // its in-process driver registered (it is held for the WHOLE backgrounded
    // resolve). Without it the row is indistinguishable from a post-restart
    // orphan, which the W7 arm is now REQUIRED to sweep.
    registerSyncDriver(runId);

    try {
      const summary = await runSyncRecoverySweep({
        db,
        listSessions: noSessions,
      });

      expect(summary.durationCapKilled).toBe(0);
      expect(await readRunStatus(runId)).toBe("NeedsInput");
    } finally {
      unregisterSyncDriver(runId);
    }
  });

  // Multi-attempt: a run may accrue several `run_sync_attempts` rows over its
  // life, so the sweep must act on the LIVE one and leave a settled older one
  // alone. With only ever one row seeded, `notInArray(phase, TERMINAL)` +
  // `orderBy(desc(attempt))` is indistinguishable from "take the only row".
  it("acts on the NEWER live attempt and leaves an older terminal one untouched", async () => {
    const {
      runId,
      workspaceId,
      attemptId: older,
    } = await seedRunAttempt({
      status: "NeedsInput",
      mode: "agent",
      // Already settled — the sweep must not rewrite this.
      phase: "succeeded",
    });
    const newer = await seedExtraAttempt({
      runId,
      workspaceId,
      attempt: 2,
      phase: "agent_running",
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttemptPhase(newer)).toBe("failed");
    expect(await readAttemptPhase(older)).toBe("succeeded");
    expect(await readRunStatus(runId)).toBe("Review");
  });

  // W7 (ADR-141): the resolver parks in NeedsInput BY DESIGN — an ACP
  // `requestPermission` puts it there — so after a restart the prompt has nobody
  // to answer it: W5 is Running-only, reconcile owns only Running, and W1/W4 is
  // mechanical-only. Unswept, the run holds a pool slot AND the sync claim
  // forever, which also refuses promote and every other lifecycle op.
  it("W7: aborts an agent resolver orphaned while parked on HITL, and releases the claim", async () => {
    for (const status of ["NeedsInput", "NeedsInputIdle"] as const) {
      const { runId, workspaceId, attemptId } = await seedRunAttempt({
        status,
        mode: "agent",
        phase: "agent_running",
        agentRunningSince: new Date(),
      });

      const summary = await runSyncRecoverySweep({
        db,
        listSessions: noSessions,
      });

      expect(summary.orphanOperationsAborted).toBeGreaterThan(0);
      expect(await readRunStatus(runId)).toBe("Review");
      expect(await readAttemptPhase(attemptId)).toBe("failed");
      expect(await readClaim(workspaceId)).toEqual({
        state: "none",
        name: null,
      });
    }
  });

  // W5 deliberately does not consult `hasSyncDriver` — the cap MUST be able to
  // kill a live in-process resolver — so it genuinely races that resolver's own
  // finalize off a lock-free pre-read. The race is driven for real here: the
  // sweep reads its candidates BEFORE `listSessions()`, so advancing the row from
  // that seam lands a concurrent write in the exact window, on a second
  // connection. A single-threaded stub would not be evidence for this contract.
  it("SKIPS the cap kill when the resolver advances past agent_running between the pre-read and the CAS", async () => {
    const past = new Date(Date.now() - (SYNC_ATTEMPT_MAX_MINUTES + 1) * 60_000);
    const { runId, workspaceId, attemptId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: past,
      headShaBefore: "d".repeat(40),
    });
    const deleteSession = vi.fn(async () => undefined);

    const summary = await runSyncRecoverySweep({
      db,
      deleteSession,
      listSessions: async () => {
        await pool.query(
          `update run_sync_attempts set phase = 'pushing' where id = $1`,
          [attemptId],
        );

        return [];
      },
    });

    expect(summary.durationCapKilled).toBe(0);
    // The CAS predicates on the EXACT observed phase, so it matches no row and
    // NO side effect may run: tearing the session down mid-push, or restoring
    // after the push LANDED, is precisely the divergence this guards.
    expect(await readAttemptPhase(attemptId)).toBe("pushing");
    expect(deleteSession).not.toHaveBeenCalled();
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
    expect(await readRunStatus(runId)).toBe("Running");
    expect(await readClaim(workspaceId)).toEqual({
      state: "claiming",
      name: "sync",
    });
  });
});

describe("runSyncRecoverySweep — W1/W4 orphan + skip-vs-abort discriminant", () => {
  it("aborts an orphaned mechanical rebasing attempt with NO in-proc driver", async () => {
    const { attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "rebasing",
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });

  it("SKIPS a mechanical starting attempt when an in-proc driver owns it (periodic sweep)", async () => {
    const { runId, attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "starting",
    });

    register(runId);

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(0);
    expect(await readAttemptPhase(attemptId)).toBe("starting");
  });

  // The arm gated on starting|rebasing while the mechanical driver writes FOUR
  // non-terminal phases. `verifying` and `pushing` therefore had no recovery arm
  // at all: the claim below is the one that stranded forever.
  it("recovers an orphaned mechanical attempt at `verifying` and RELEASES the lifecycle claim", async () => {
    const { workspaceId, attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "verifying",
      headShaBefore: "a".repeat(40),
    });

    expect(await readClaim(workspaceId)).toEqual({
      state: "claiming",
      name: "sync",
    });

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttemptPhase(attemptId)).toBe("failed");
    // The claim release is the fix — terminalizing the ledger alone would still
    // leave promote and all six lifecycle ops refused forever.
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    // `verifying` is local-only (below the point of no return) → safe to restore.
    expect(restoreWorktreeToCommit).toHaveBeenCalledWith(
      expect.any(String),
      "a".repeat(40),
    );
  });

  it("fails an orphaned mechanical `pushing` attempt whose push did NOT land, and never restores it", async () => {
    const { workspaceId, attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "pushing",
      headShaBefore: "b".repeat(40),
    });

    // Origin cannot be read (default mock rejects) — an UNPROVEN push. That is
    // not proof the push missed, so the local rebase must be KEPT.
    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttemptPhase(attemptId)).toBe("failed");
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    // Restoring out of `pushing` would reintroduce the divergence the
    // `pushCommitted` flag exists to forbid.
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
  });

  it("settles an orphaned mechanical `pushing` attempt FORWARD when origin proves the push landed", async () => {
    const landed = "c".repeat(40);
    const { workspaceId, attemptId } = await seedRunAttempt({
      status: "Review",
      mode: "mechanical",
      phase: "pushing",
      headShaBefore: "b".repeat(40),
    });

    // origin/<branch> == worktree HEAD ⇒ the force-push LANDED before the crash.
    vi.mocked(headCommit).mockResolvedValue(landed);
    vi.mocked(remoteBranchHead).mockResolvedValue(landed.toUpperCase());

    const summary = await runSyncRecoverySweep({
      db,
      listSessions: noSessions,
    });

    expect(summary.orphanOperationsAborted).toBe(1);
    expect(await readAttempt(attemptId)).toEqual({
      phase: "succeeded",
      pushed: true,
      headShaAfter: landed,
    });
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    // A landed push is a point of no return: the remote and its PR already carry
    // the rebased commit, so resetting the worktree would manufacture divergence.
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
  });
});

// #C4: `recoverSyncAttemptOnReconcile` was invoked exactly once in the whole suite,
// always with `liveSessionId: "sess-orphan"` — i.e. always W2. The W3 arm (no live
// session → idempotently re-verify → gate → push → finalize) had ZERO coverage,
// including the branch that decides whether a crashed resolver's work survives.
describe("recoverSyncAttemptOnReconcile — W3 no live session", () => {
  async function seedW3(prUrl: string | null = null) {
    const seeded = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: new Date(),
      headShaBefore: "b".repeat(40),
    });

    if (prUrl) {
      await pool.query(`update workspaces set pr_url = $1 where id = $2`, [
        prUrl,
        seeded.workspaceId,
      ]);
    }

    return seeded;
  }

  it("gate FAILS → the crashed resolver's work is discarded: restore, fail, Review", async () => {
    const { runId, workspaceId, attemptId } = await seedW3();

    vi.mocked(verifySyncGate).mockResolvedValue({
      ok: false,
      reason: "the worktree is not clean",
    });

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: null,
      db,
    });

    expect(result).toEqual({ window: "w3", outcome: "aborted" });
    expect(await readAttemptPhase(attemptId)).toBe("failed");
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    expect(restoreWorktreeToCommit).toHaveBeenCalledWith(
      expect.any(String),
      "b".repeat(40),
    );
  });

  it("gate PASSES on an unpublished branch → finalize with no push", async () => {
    const landed = "e".repeat(40);
    const { runId, workspaceId, attemptId } = await seedW3();

    vi.mocked(headCommit).mockResolvedValue(landed);

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: null,
      db,
    });

    expect(result).toEqual({ window: "w3", outcome: "finalized" });
    expect(await readAttempt(attemptId)).toEqual({
      phase: "succeeded",
      pushed: false,
      headShaAfter: landed,
    });
    expect(pushWithLease).not.toHaveBeenCalled();
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    // The resolve completed before the crash — its work is KEPT, never restored.
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
  });

  it("gate PASSES on a published branch → pushes and finalizes", async () => {
    const landed = "f".repeat(40);
    const { runId, attemptId } = await seedW3("https://github.com/x/y/pull/7");

    vi.mocked(headCommit).mockResolvedValue(landed);

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: null,
      db,
    });

    expect(result).toEqual({ window: "w3", outcome: "finalized" });
    expect(pushWithLease).toHaveBeenCalled();
    expect(await readAttempt(attemptId)).toMatchObject({
      phase: "succeeded",
      pushed: true,
    });
    expect(await readRunStatus(runId)).toBe("Review");
  });

  it("lease rejected but origin ALREADY equals the local head → the push landed before the crash, treat as pushed", async () => {
    const landed = "a".repeat(40);
    const { runId, attemptId } = await seedW3("https://github.com/x/y/pull/7");

    vi.mocked(headCommit).mockResolvedValue(landed);
    vi.mocked(pushWithLease).mockResolvedValue({
      pushed: false,
      leaseFailed: true,
    });
    // Case-insensitively equal — the recovery compares lowercased.
    vi.mocked(remoteBranchHead).mockResolvedValue(landed.toUpperCase());

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: null,
      db,
    });

    // A re-push of an already-landed commit fails the lease; that is not a
    // conflict, and recording `failed` here would contradict a remote that
    // demonstrably carries the resolved commit.
    expect(result).toEqual({ window: "w3", outcome: "finalized" });
    expect(await readAttempt(attemptId)).toMatchObject({
      phase: "succeeded",
      pushed: true,
    });
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
  });

  it("lease rejected and origin genuinely MOVED → CONFLICT, local result kept (no restore)", async () => {
    const { runId, workspaceId, attemptId } = await seedW3(
      "https://github.com/x/y/pull/7",
    );

    vi.mocked(headCommit).mockResolvedValue("a".repeat(40));
    vi.mocked(pushWithLease).mockResolvedValue({
      pushed: false,
      leaseFailed: true,
    });
    vi.mocked(remoteBranchHead).mockResolvedValue("9".repeat(40));

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: null,
      db,
    });

    expect(result).toEqual({ window: "w3", outcome: "aborted" });
    expect(await readAttemptPhase(attemptId)).toBe("failed");
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readClaim(workspaceId)).toEqual({ state: "none", name: null });
    // The local rebase is KEPT so a retry has something to push — mirroring the
    // live path's lease-rejected branch.
    expect(restoreWorktreeToCommit).not.toHaveBeenCalled();
  });

  it("is idempotent — a concurrent in-process finalize leaves nothing to do", async () => {
    const { runId, attemptId } = await seedW3();

    await pool.query(
      `update run_sync_attempts set phase = 'succeeded' where id = $1`,
      [attemptId],
    );

    expect(
      await recoverSyncAttemptOnReconcile({ runId, liveSessionId: null, db }),
    ).toEqual({ window: "w3", outcome: "noop" });
  });
});

describe("recoverSyncAttemptOnReconcile — W2 orphaned live session", () => {
  it("deletes the orphaned session, fails the attempt, and CASes the run to Review", async () => {
    const { runId, attemptId } = await seedRunAttempt({
      status: "Running",
      mode: "agent",
      phase: "agent_running",
      agentRunningSince: new Date(),
    });
    const deleteSession = vi.fn(async () => undefined);

    const result = await recoverSyncAttemptOnReconcile({
      runId,
      liveSessionId: "sess-orphan",
      db,
      deleteSession,
    });

    expect(result.window).toBe("w2");
    expect(deleteSession).toHaveBeenCalledWith("sess-orphan");
    expect(await readRunStatus(runId)).toBe("Review");
    expect(await readAttemptPhase(attemptId)).toBe("failed");
  });
});
