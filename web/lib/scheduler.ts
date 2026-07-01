import "server-only";

import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { markResumed } from "@/lib/runs/state-transitions";
import {
  clearC2Claim,
  countLiveAutoFlowRuns,
  countOutstandingC2Claims,
  evaluateC2Candidate,
  giveUpC2Task,
  isTerminalLaunchRefusal,
  loadC2CandidateRows,
  type C2CandidateRow,
} from "@/lib/scheduler/c2-eligibility";
import {
  orderAdmissions,
  priorityWeightSql,
  projectShareAllowsC2,
  reserveAllowsC2,
  type AdmissionCandidate,
} from "@/lib/tasks/admission-selector";
import { type TaskPriority } from "@/lib/tasks/criticality";
import {
  resolveAutoReserve,
  resolveEdgeDrain,
  resolveMaxInFlightAuto,
  type TaskQueueSettings,
} from "@/lib/tasks/queue-settings";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// ADR-121 (T13): the gate evaluates at most this many highest-criticality fresh
// Backlog tasks per slot-free call before falling back to the poll backstop —
// bounds the per-candidate eligibility work done under the scheduler lock. A
// deeper backlog drains via the 60s `auto-launch-triaged` tick.
const GATE_C2_SCAN_LIMIT = 50;

const log = pino({
  name: "scheduler",
  level: process.env.LOG_LEVEL ?? "info",
});

// M34: owner-requested default bump 3 → 6 (env semantics unchanged).
const DEFAULT_CAP = 6;
// M34 (ADR-089): separate budget for platform-agent runs (run_kind='agent').
const DEFAULT_AGENT_CAP = 3;
// Studio local-package AI assistant runs (run_kind='scratch', project_id NULL,
// local_package_id set) get their own dev-time budget so they never compete with
// delivery + user scratch runs for the flow pool. Discriminator: local_package_id.
const DEFAULT_ASSISTANT_CAP = 5;

export type SchedulerPool = "flow" | "agent";

// The flow pool covers delivery + scratch runs; agent runs never consume it.
const POOL_RUN_KINDS: Record<SchedulerPool, string[]> = {
  flow: ["flow", "scratch"],
  agent: ["agent"],
};

export function poolForRunKind(runKind: string): SchedulerPool {
  return runKind === "agent" ? "agent" : "flow";
}

// Fixed pg_advisory_xact_lock key for the global scheduler. Both
// tryStartRun and promoteNextPending take this lock at the start of
// their transactions so the count-then-update pattern is serialized
// across concurrent launches. Postgres releases it automatically when
// the transaction ends (commit or rollback). On sqlite the lock call
// is silently skipped — sqlite already serializes writes via a single
// writer lock so the count+update is safe there too.
const SCHEDULER_LOCK_KEY = 0x6d61_6973;

function isPostgresDb(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export async function takeSchedulerLock(tx: Db): Promise<void> {
  if (!isPostgresDb()) return;

  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCHEDULER_LOCK_KEY})`);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "advisory-lock-failed (continuing without serialization)",
    );
  }
}

function parseCapEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return parsed;
}

function capFromEnv(): number {
  return parseCapEnv(process.env.MAISTER_MAX_CONCURRENT_RUNS, DEFAULT_CAP);
}

function agentCapFromEnv(): number {
  return parseCapEnv(
    process.env.MAISTER_MAX_CONCURRENT_AGENTS,
    DEFAULT_AGENT_CAP,
  );
}

function assistantCapFromEnv(): number {
  return parseCapEnv(
    process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS,
    DEFAULT_ASSISTANT_CAP,
  );
}

export function maxConcurrentRunsCap(): number {
  return capFromEnv();
}

export function maxConcurrentAgentRunsCap(): number {
  return agentCapFromEnv();
}

export function maxConcurrentAssistantRunsCap(): number {
  return assistantCapFromEnv();
}

export function capForPool(pool: SchedulerPool): number {
  return pool === "agent" ? agentCapFromEnv() : capFromEnv();
}

// The one cap predicate: a run holds a scheduler slot while it is in any of
// these statuses. Counted per pool (M34): flow/scratch and agent runs hold
// independent budgets. Takes the caller's db/tx handle so tryStartRun /
// promoteNextPending keep counting INSIDE their advisory-lock transactions.
export async function countLiveRuns(
  dbOrTx: Db,
  pool: SchedulerPool = "flow",
): Promise<number> {
  const liveRows: Array<{ count: number }> = await dbOrTx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        // M37 (ADR-098 §3): WaitingOnChildren is intentionally EXCLUDED — a
        // parked orchestrator is checkpointed (its agent-pool slot already
        // released via releaseSlotOnIdle), so like NeedsInputIdle it must NOT
        // count against the concurrency cap. Adding it would starve the pool.
        inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]),
        inArray(runs.runKind, POOL_RUN_KINDS[pool]),
        // Studio AI assistant runs (local_package_id set) hold the SEPARATE
        // assistant budget (assertAssistantCapacity*), never the flow/agent
        // pool — exclude them so a dev-time assistant never starves delivery.
        isNull(runs.localPackageId),
      ),
    );

  return Number(liveRows[0]?.count ?? 0);
}

// M37 Phase 10 (ADR-099): one active WRITER per shared worktree. A shared-mode
// sibling holds the writer slot while it could be writing — the same
// Running/NeedsInput/HumanWorking set countLiveRuns uses (a parked / idle /
// WaitingOnChildren sibling has yielded). Excludes the candidate itself. Called
// only from inside promoteNextPending's advisory-locked tx.
async function sharedWriterSiblingActive(
  tx: Db,
  rootRunId: string,
  excludeRunId: string,
): Promise<boolean> {
  const rows: Array<{ count: number }> = await tx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        eq(runs.rootRunId, rootRunId),
        eq(runs.workspaceMode, "shared"),
        ne(runs.id, excludeRunId),
        inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]),
      ),
    );

  return Number(rows[0]?.count ?? 0) > 0;
}

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TryStartRunResult =
  | { started: true }
  | { started: false; queuePosition: number };

export type ScratchCapacityDecision = {
  allowed: boolean;
  cap: number;
  liveCount: number;
};

export function scratchCapacityDecision(
  liveCount: number,
  cap: number,
): ScratchCapacityDecision {
  return {
    allowed: liveCount < cap,
    cap,
    liveCount,
  };
}

export async function assertScratchCapacityAvailable(
  opts: { db?: Db } = {},
): Promise<ScratchCapacityDecision> {
  const db = opts.db ?? getDb();

  return db.transaction(async (tx: Db) =>
    assertScratchCapacityAvailableInTransaction(tx),
  );
}

export async function assertScratchCapacityAvailableInTransaction(
  tx: Db,
): Promise<ScratchCapacityDecision> {
  const cap = capFromEnv();

  await takeSchedulerLock(tx);

  const liveRows: Array<{ count: number }> = await tx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["Running", "NeedsInput"]),
        inArray(runs.runKind, POOL_RUN_KINDS.flow),
        // Assistant runs are on their own budget — keep them out of the
        // flow/scratch capacity so they cannot exhaust delivery slots.
        isNull(runs.localPackageId),
      ),
    );

  const liveCount = Number(liveRows[0]?.count ?? 0);
  const decision = scratchCapacityDecision(liveCount, cap);

  log.debug(
    { liveCount: decision.liveCount, cap: decision.cap },
    "scratch capacity cap-check",
  );

  if (!decision.allowed) {
    throw new MaisterError(
      "CONFLICT",
      `scratch run capacity is full: liveCount=${liveCount}, cap=${cap}`,
    );
  }

  return decision;
}

// The Studio AI assistant pool: project-less local-package assistant runs
// (local_package_id set) counted against MAISTER_MAX_CONCURRENT_ASSISTANTS,
// independent of the flow/scratch and agent budgets. Mirrors the scratch
// cap-check shape; assistant runs never queue (a full pool throws CONFLICT at
// launch — there is no Pending/promote path for them).
export async function assertAssistantCapacityAvailable(
  opts: { db?: Db } = {},
): Promise<ScratchCapacityDecision> {
  const db = opts.db ?? getDb();

  return db.transaction(async (tx: Db) =>
    assertAssistantCapacityAvailableInTransaction(tx),
  );
}

export async function assertAssistantCapacityAvailableInTransaction(
  tx: Db,
): Promise<ScratchCapacityDecision> {
  const cap = assistantCapFromEnv();

  await takeSchedulerLock(tx);

  const liveRows: Array<{ count: number }> = await tx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["Running", "NeedsInput"]),
        isNotNull(runs.localPackageId),
      ),
    );

  const liveCount = Number(liveRows[0]?.count ?? 0);
  const decision = scratchCapacityDecision(liveCount, cap);

  log.debug(
    { liveCount: decision.liveCount, cap: decision.cap },
    "assistant capacity cap-check",
  );

  if (!decision.allowed) {
    throw new MaisterError(
      "CONFLICT",
      `assistant run capacity is full: liveCount=${liveCount}, cap=${cap}`,
    );
  }

  return decision;
}

export async function tryStartRun(
  runId: string,
  opts: { db?: Db } = {},
): Promise<TryStartRunResult> {
  const db = opts.db ?? getDb();

  return db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    const targetRows: Array<{
      runKind: string;
      startedAt: Date;
      workspaceMode: string | null;
      rootRunId: string | null;
    }> = await tx
      .select({
        runKind: runs.runKind,
        startedAt: runs.startedAt,
        workspaceMode: runs.workspaceMode,
        rootRunId: runs.rootRunId,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    const pool = poolForRunKind(targetRows[0]?.runKind ?? "flow");
    const cap = capForPool(pool);

    // M37 Phase 10 (ADR-099): a shared-mode child must NOT flip to Running while
    // a writer sibling in its run-tree is active — one active writer per shared
    // tree, else concurrent turns corrupt the single worktree. This is the same
    // guard promoteNextPending applies; it MUST also gate the direct launch path
    // (launchAgentRun → tryStartRun), which is how a delegated shared child first
    // starts. The check rides the same advisory lock, so the sibling-active read
    // is consistent. A blocked shared child stays Pending and is admitted by
    // promoteNextPending once the active sibling parks or terminates.
    const sharedBlocked =
      targetRows[0]?.workspaceMode === "shared" &&
      !!targetRows[0]?.rootRunId &&
      (await sharedWriterSiblingActive(tx, targetRows[0].rootRunId, runId));

    const liveCount = await countLiveRuns(tx, pool);

    log.debug(
      { runId, pool, liveCount, cap, sharedBlocked },
      "tryStartRun cap-check",
    );

    if (!sharedBlocked && liveCount < cap) {
      const startedRows: Array<{ projectId: string }> = await tx
        .update(runs)
        .set({ status: "Running", startedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, "Pending")))
        .returning({ projectId: runs.projectId });

      if (startedRows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.started",
          projectId: startedRows[0].projectId,
          runId,
          data: { trigger: "direct" },
        });
      }

      log.info({ runId, pool, liveCount, cap }, "tryStartRun → started");

      return { started: true } satisfies TryStartRunResult;
    }

    const targetStartedAt = targetRows[0]?.startedAt ?? new Date();

    // Queue position is computed within the run's own pool — agent runs
    // never queue behind flow runs and vice versa.
    const aheadRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(
          eq(runs.status, "Pending"),
          inArray(runs.runKind, POOL_RUN_KINDS[pool]),
          lt(runs.startedAt, targetStartedAt),
        ),
      );

    const queuePosition = Number(aheadRows[0]?.count ?? 0) + 1;

    log.info(
      { runId, pool, liveCount, cap, queuePosition },
      "tryStartRun → queued",
    );

    return { started: false, queuePosition } satisfies TryStartRunResult;
  });
}

export type PromoteNextPendingOptions = {
  db?: Db;
  runFlow?: (runId: string) => void;
  resumeRun?: (runId: string) => void;
  // M34: which budget pool to promote within (default flow — every
  // pre-existing caller frees a flow/scratch slot).
  pool?: SchedulerPool;
  startAgentRun?: (runId: string) => void;
  // ADR-121 (T13, C2): the heavy fresh-Backlog-task launcher, dispatched OUTSIDE
  // the scheduler lock (worktree-first). Injectable for tests; defaults to the
  // real launchRun via dynamic import (services/runs imports this module — a
  // static import would cycle).
  launchRun?: (taskId: string) => Promise<{ runId: string; status: string }>;
};

// M8 D2: NeedsInputIdle does NOT count toward the cap. When the keep-alive
// sweeper checkpoints a NeedsInput row into NeedsInputIdle the slot is
// freed; this helper logs the transition AND drives promoteNextPending so
// any queued Pending row can move into the freed slot.
export type ReleaseSlotOnIdleOptions = {
  runId: string;
  db?: Db;
  runFlow?: (runId: string) => void;
};

export async function releaseSlotOnIdle(
  opts: ReleaseSlotOnIdleOptions,
): Promise<{ promotedRunId: string | null }> {
  log.debug(
    { runId: opts.runId },
    "releaseSlotOnIdle — NeedsInputIdle transition freed scheduler slot",
  );

  // The freed slot belongs to the idled run's own pool (M34).
  const db = opts.db ?? getDb();
  const rows: Array<{ runKind: string }> = await db
    .select({ runKind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, opts.runId));
  const pool = poolForRunKind(rows[0]?.runKind ?? "flow");

  return promoteNextPending({ db: opts.db, runFlow: opts.runFlow, pool });
}

// ADR-121 §4.4: the unified priority-ordered admission gate (a.k.a.
// `admitOnFreeSlot`). On a freed slot it admits the single most-critical eligible
// unit of work across THREE sources, strictly ordered by (criticality weight DESC,
// classRank, FIFO):
//   C1 — Pending runs in the pool (queued / queued-resume).
//   C3 — answered-idle resumables (NeedsInputIdle + resume_requested_at, not paused)
//        — closes the D2 over-cap bypass (G4): resume is now cap-safe.
//   C2 — eligible fresh Backlog tasks (FLOW pool only), behind edgeDrain + the
//        reserve (INV-8) and per-project maxInFlightAuto (INV-9) guards, via a
//        two-phase task-level claim (F1). The 60s poll is the BACKSTOP, not the
//        sole driver. Both share `@/lib/scheduler/c2-eligibility`.
// One admission per call (every freed-slot caller invokes this once per slot), so
// the cap is honored: the chosen unit consumes exactly one slot. `name` kept as
// `promoteNextPending` because all 17 freed-slot call-sites already call it (G3
// needs no new event wiring).
export async function promoteNextPending(
  opts: PromoteNextPendingOptions = {},
): Promise<{ promotedRunId: string | null }> {
  const db = opts.db ?? getDb();

  const pool: SchedulerPool = opts.pool ?? "flow";
  const cap = capForPool(pool);

  // M19 Phase 3: lazy dispatch defaults so the queued-resume loop closes for
  // ALL callers (e.g. the discard route) without per-caller wiring. Dynamic
  // imports break the runner/recover import cycle (scheduler is imported by
  // both). Explicit opts.runFlow/opts.resumeRun (tests, abandon route) still win.
  const runFlowFn =
    opts.runFlow ??
    ((id: string) => {
      void import("@/lib/flows/runner")
        .then((m) => m.runFlow(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default runFlow dispatch threw",
          );
        });
    });
  const resumeFn =
    opts.resumeRun ??
    ((id: string) => {
      void import("@/lib/runs/recover")
        .then((m) => m.driveResume(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default resumeRun dispatch threw",
          );
        });
    });
  // M34: agent-pool promotions dispatch the agent session starter — it
  // resumes via acpSessionId itself, so one dispatch fn covers both paths.
  const startAgentFn =
    opts.startAgentRun ??
    ((id: string) => {
      void import("@/lib/agents/launch")
        .then((m) => m.startAgentSession(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default startAgentRun dispatch threw",
          );
        });
    });
  // ADR-121 (T13, C2): the heavy fresh-Backlog-task launcher, dispatched OUTSIDE
  // the lock. Default uses the real launchRun via dynamic import (services/runs
  // imports this module — a static import would cycle).
  const launchC2Fn =
    opts.launchRun ??
    (async (taskId: string) => {
      const m = await import("@/lib/services/runs");

      return m.launchRun(
        { taskId, queueAdmitted: true },
        { authorize: async () => {}, actorUserId: null },
        db,
      );
    });

  const decision = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    // Recheck cap under the lock — a Running/NeedsInput/HumanWorking run could
    // have started between this terminal transition and the promote call, so the
    // cap is respected globally. One admission per call keeps liveCount ≤ cap.
    const liveCount = await countLiveRuns(tx, pool);

    if (liveCount >= cap) {
      log.debug(
        { pool, liveCount, cap },
        "promoteNextPending → cap reached, leaving work queued",
      );

      return null;
    }

    // C1 — Pending runs in the pool. LEFT JOIN tasks for the LIVE priority (a run
    // with no task → normal weight). workspace_mode + root_run_id feed the
    // one-writer-per-shared-tree skip (ADR-099). FOR UPDATE OF runs SKIP LOCKED so
    // the tasks join does not lock task rows.
    const c1rows: Array<{
      id: string;
      runKind: string;
      workspaceMode: string | null;
      rootRunId: string | null;
      priority: string | null;
      startedAt: Date | null;
    }> = await tx
      .select({
        id: runs.id,
        runKind: runs.runKind,
        workspaceMode: runs.workspaceMode,
        rootRunId: runs.rootRunId,
        priority: tasks.priority,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .leftJoin(tasks, eq(runs.taskId, tasks.id))
      .where(
        and(
          eq(runs.status, "Pending"),
          inArray(runs.runKind, POOL_RUN_KINDS[pool]),
        ),
      )
      .orderBy(
        sql`${priorityWeightSql(tasks.priority)} desc`,
        asc(runs.startedAt),
      )
      .limit(cap)
      .for("update", { of: runs, skipLocked: true } as never);

    // C3 — answered-idle resumables: NeedsInputIdle + resume_requested_at set, the
    // backing task NOT paused (INV-10). The FIFO key is resume_requested_at.
    const c3rows: Array<{
      id: string;
      runKind: string;
      workspaceMode: string | null;
      rootRunId: string | null;
      priority: string | null;
      resumeRequestedAt: Date | null;
    }> = await tx
      .select({
        id: runs.id,
        runKind: runs.runKind,
        workspaceMode: runs.workspaceMode,
        rootRunId: runs.rootRunId,
        priority: tasks.priority,
        resumeRequestedAt: runs.resumeRequestedAt,
      })
      .from(runs)
      .leftJoin(tasks, eq(runs.taskId, tasks.id))
      .where(
        and(
          eq(runs.status, "NeedsInputIdle"),
          isNotNull(runs.resumeRequestedAt),
          inArray(runs.runKind, POOL_RUN_KINDS[pool]),
          sql`(${tasks.id} IS NULL OR ${tasks.queuePaused} = false)`,
        ),
      )
      .orderBy(
        sql`${priorityWeightSql(tasks.priority)} desc`,
        asc(runs.resumeRequestedAt),
      )
      .limit(cap)
      .for("update", { of: runs, skipLocked: true } as never);

    // C2 — eligible fresh Backlog tasks, FLOW pool only. Cheap candidate rows are
    // fetched up front (ordered by weight); per-candidate eligibility + capacity
    // guards are resolved lazily during the claim loop (only for candidates that
    // out-rank the best run candidate), bounded by GATE_C2_SCAN_LIMIT.
    const c2rows: C2CandidateRow[] =
      pool === "flow"
        ? (await loadC2CandidateRows(tx)).slice(0, GATE_C2_SCAN_LIMIT)
        : [];

    if (c1rows.length === 0 && c3rows.length === 0 && c2rows.length === 0) {
      return null;
    }

    const candidates: AdmissionCandidate[] = [
      ...c1rows.map((r) => ({
        cls: "C1" as const,
        priority: r.priority as TaskPriority | null,
        fifoMs: r.startedAt?.getTime() ?? 0,
        ref: {
          runId: r.id,
          runKind: r.runKind,
          workspaceMode: r.workspaceMode,
          rootRunId: r.rootRunId,
        },
      })),
      ...c3rows.map((r) => ({
        cls: "C3" as const,
        priority: r.priority as TaskPriority | null,
        fifoMs: r.resumeRequestedAt?.getTime() ?? 0,
        ref: {
          runId: r.id,
          runKind: r.runKind,
          workspaceMode: r.workspaceMode,
          rootRunId: r.rootRunId,
        },
      })),
      ...c2rows.map((r) => ({
        cls: "C2" as const,
        priority: r.priority as TaskPriority | null,
        fifoMs: r.createdAt?.getTime() ?? 0,
        ref: { taskId: r.taskId, candidate: r },
      })),
    ];

    const ordered = orderAdmissions(candidates);

    // C2 capacity-guard context (resolved live). The reserve guard (INV-8) counts
    // live flow runs PLUS outstanding C2 claims (Codex-2): a claim reserves a slot
    // before its run row exists, so concurrent lock-serialized gate calls each see
    // the prior call's committed claim and cannot over-admit past flowCap − reserve.
    const reserve = resolveAutoReserve();
    const outstandingClaims = await countOutstandingC2Claims(tx);
    const settingsByProject = new Map<string, TaskQueueSettings | null>();

    async function settingsFor(
      projectId: string,
    ): Promise<{ taskQueueSettings: TaskQueueSettings | null }> {
      if (!settingsByProject.has(projectId)) {
        const rows: Array<{ taskQueueSettings: TaskQueueSettings | null }> =
          await tx
            .select({ taskQueueSettings: projects.taskQueueSettings })
            .from(projects)
            .where(eq(projects.id, projectId));

        settingsByProject.set(projectId, rows[0]?.taskQueueSettings ?? null);
      }

      return { taskQueueSettings: settingsByProject.get(projectId) ?? null };
    }

    const nowMs = Date.now();
    const now = new Date();

    for (const cand of ordered) {
      const ref = cand.ref as Record<string, unknown>;

      if (cand.cls === "C1" || cand.cls === "C3") {
        const runId = ref.runId as string;
        const runKind = ref.runKind as string;

        // One writer per shared tree (ADR-099): skip a shared-mode candidate while
        // a writer sibling is active — applies to both queued and resuming runs.
        if (
          ref.workspaceMode === "shared" &&
          ref.rootRunId &&
          (await sharedWriterSiblingActive(tx, ref.rootRunId as string, runId))
        ) {
          log.debug(
            { runId, rootRunId: ref.rootRunId, cls: cand.cls },
            "promoteNextPending → shared-tree writer busy, skipping candidate",
          );
          continue;
        }

        const isAgent = runKind === "agent";

        if (cand.cls === "C1") {
          // M19/M42: a checkpointed Pending run (acp session on its active session)
          // resumes via session/resume rather than re-running from step 0.
          const targetAcpSessionId = isAgent
            ? null
            : ((await loadActiveRunSession(tx, runId))?.acpSessionId ?? null);
          const isResume = !isAgent && targetAcpSessionId != null;

          const flipped: Array<{ projectId: string }> = await tx
            .update(runs)
            .set(
              isResume
                ? { status: "Running", startedAt: now, resumeStartedAt: now }
                : { status: "Running", startedAt: now },
            )
            .where(and(eq(runs.id, runId), eq(runs.status, "Pending")))
            .returning({ projectId: runs.projectId });

          if (flipped.length === 0) continue;

          await emitWebhookEvent({
            db: tx,
            type: "run.started",
            projectId: flipped[0].projectId,
            runId,
            data: { trigger: "queue_promote" },
          });

          return { kind: "run" as const, id: runId, isResume, isAgent };
        }

        // C3 — answered-idle resume (cap-safe, the D2 reversal). The claim
        // transition DIFFERS by run kind (Codex-1):
        //   - agent → NeedsInputIdle → Running + startAgentSession (matches the
        //     existing agent idle-resume; agent transitions handle Running).
        //   - flow  → NeedsInputIdle → NeedsInput via markResumed (fresh keepalive,
        //     checkpoint cleared) — NOT Running. The flow resume driver's completion
        //     transitions (completeResumedStepAndHandoff, failResumedRun, rollback)
        //     are status-guarded on NeedsInput; flipping to Running would make them
        //     miss and strand the run Running forever. driveResume re-issues the
        //     session + delivers the stored intent while the run stays NeedsInput,
        //     exactly like the immediate (uncapped) HITL resume path.
        let claimedProjectId: string | null = null;

        if (isAgent) {
          const flipped: Array<{ projectId: string }> = await tx
            .update(runs)
            .set({
              status: "Running",
              resumeRequestedAt: null,
              keepaliveUntil: null,
              checkpointAt: null,
            })
            .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
            .returning({ projectId: runs.projectId });

          if (flipped.length === 0) continue;
          claimedProjectId = flipped[0].projectId;
        } else {
          const resumed = await markResumed(runId, { db: tx });

          if (!resumed.ok) continue;
          const flipped: Array<{ projectId: string }> = await tx
            .update(runs)
            .set({ resumeRequestedAt: null })
            .where(eq(runs.id, runId))
            .returning({ projectId: runs.projectId });

          claimedProjectId = flipped[0]?.projectId ?? null;
        }

        await emitWebhookEvent({
          db: tx,
          type: "run.started",
          projectId: claimedProjectId as string,
          runId,
          data: { trigger: "queue_resume" },
        });

        return { kind: "run" as const, id: runId, isResume: true, isAgent };
      }

      // C2 — fresh Backlog task. Apply the capacity guards + per-candidate
      // eligibility, then CAS-claim queue_claimed_at (the two-phase claim, F1).
      const candidate = ref.candidate as C2CandidateRow;
      const settings = await settingsFor(candidate.projectId);

      if (!resolveEdgeDrain(settings)) continue; // INV-7
      if (!reserveAllowsC2(liveCount + outstandingClaims, cap, reserve)) {
        continue; // INV-8 (live runs + in-flight claims)
      }

      const liveAuto = await countLiveAutoFlowRuns(tx, candidate.projectId);

      if (!projectShareAllowsC2(liveAuto, resolveMaxInFlightAuto(settings))) {
        continue; // INV-9
      }

      const eligibility = await evaluateC2Candidate(tx, candidate, nowMs);

      if (eligibility.kind !== "eligible") continue;

      const claimed: Array<{ id: string }> = await tx
        .update(tasks)
        .set({ queueClaimedAt: now })
        .where(
          and(eq(tasks.id, candidate.taskId), isNull(tasks.queueClaimedAt)),
        )
        .returning({ id: tasks.id });

      if (claimed.length === 0) continue; // concurrent admission claimed it first

      log.info(
        { taskId: candidate.taskId, projectId: candidate.projectId },
        "promoteNextPending → C2 claimed fresh Backlog task",
      );

      return { kind: "c2" as const, candidate };
    }

    return null;
  });

  if (!decision) {
    log.debug({ pool }, "promoteNextPending → nothing to promote");

    return { promotedRunId: null };
  }

  if (decision.kind === "c2") {
    const candidate = decision.candidate;
    const doLaunch = async (): Promise<string | null> => {
      try {
        const res = await launchC2Fn(candidate.taskId);

        await clearC2Claim(db, candidate.taskId);
        log.info(
          { taskId: candidate.taskId, runId: res.runId, status: res.status },
          "promoteNextPending → C2 launched fresh Backlog run",
        );

        return res.runId;
      } catch (err) {
        await clearC2Claim(db, candidate.taskId);

        if (isTerminalLaunchRefusal(err)) {
          await giveUpC2Task(db, candidate, {
            reason: "auto_launch_stale_flow",
            detail: err instanceof Error ? err.message : String(err),
          });
        } else {
          log.warn(
            {
              taskId: candidate.taskId,
              err: err instanceof Error ? err.message : String(err),
            },
            "promoteNextPending → C2 launch refused (transient) — claim cleared, re-eligible next tick",
          );
        }

        return null;
      }
    };

    // Injected launcher (tests / controlled callers) → await for determinism;
    // the default fire-and-forgets so a request-path freed-slot caller is not
    // blocked on a git/worktree launch.
    if (opts.launchRun) {
      const runId = await doLaunch();

      return { promotedRunId: runId };
    }

    queueMicrotask(() => {
      void doLaunch();
    });

    return { promotedRunId: null };
  }

  // decision.kind === "run" (C1 or C3): dispatch outside the lock.
  if (decision.isAgent) {
    log.info({ runId: decision.id }, "[scheduler] promoting queued agent run");
    queueMicrotask(() => {
      try {
        startAgentFn(decision.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: decision.id },
          "promoteNextPending startAgentRun dispatch failed",
        );
      }
    });
  } else if (decision.isResume) {
    log.info({ runId: decision.id }, "[scheduler] promoting queued resume");
    queueMicrotask(() => {
      try {
        resumeFn(decision.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: decision.id },
          "promoteNextPending resumeRun dispatch failed",
        );
      }
    });
  } else {
    log.info({ promotedRunId: decision.id }, "promoteNextPending → promoting");
    queueMicrotask(() => {
      try {
        runFlowFn(decision.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: decision.id },
          "promoteNextPending runFlow dispatch failed",
        );
      }
    });
  }

  return { promotedRunId: decision.id };
}

// Helper exported so tests can compute cap without env mocking.
export function _maxConcurrentRunsFromEnv(): number {
  return capFromEnv();
}

// Reserved drizzle sql helper kept exported so the runner can build
// custom queries without a second import line. Currently unused
// externally — keep for follow-up M5+ work where the scheduler grows
// the cap into a per-project policy.
export const _sqlBuilder = sql;
