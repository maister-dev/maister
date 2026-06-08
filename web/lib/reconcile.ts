import "server-only";

import type { RunResumedSessionOptions } from "@/lib/runs/resume-driver";
import type { CrashReason } from "@/lib/runs/state-transitions";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import pino from "pino";

import { cleanupRunMaterializations } from "@/lib/capabilities/cleanup";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { resolveCurrentNodeContext } from "@/lib/flows/graph/current-node-kind";
import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import {
  reconcileGraceSeconds,
  reconcileSweepIntervalSeconds,
} from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";
import { scheduleResumedSessionDrive } from "@/lib/runs/resume-driver";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { promoteNextPending } from "@/lib/scheduler";
import { listSessions } from "@/lib/supervisor-client";
import { listWorktrees } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { assignments, nodeAttempts, projects, runs, workspaces } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "reconcile",
  level: process.env.LOG_LEVEL ?? "info",
});

const PER_TICK_LIMIT = 100;
const PER_PASS_CONCURRENCY = 4;

// --- T2.1: pure classifier ------------------------------------------------

export type ReconcileAction = "skip" | "reattach" | "redispatch" | "crash";

export type ReconcileReason =
  | "not-running"
  | "worktree-gone"
  | "live-session"
  | "gate-redispatch"
  | "linear-gate-orphan"
  | "cli-not-retry-safe"
  | "grace-window"
  | "agent-session-gone";

export interface ReconcileInput {
  runStatus: string;
  runKind: "flow" | "scratch";
  acpSessionId: string | null;
  currentStepId: string | null;
  currentNodeKind:
    | "ai_coding"
    | "cli"
    | "check"
    | "judge"
    | "guard"
    | "human"
    | "form"
    | null;
  worktreeExists: boolean;
  liveSession: boolean;
  resumeStartedAt: Date | null;
  latestAttemptStartedAt: Date | null;
  nowMs: number;
  graceSeconds: number;
  // M17 (ADR-056): true when the run executes a flat `steps[]` flow (vs a
  // graph `nodes[]` flow). A linear run has NO graph resume — bare `runFlow`
  // restarts from step 0 and re-runs prior side-effects — so a session-less
  // gate/human orphan (incl. the repark window-(c) state) must reconcile to
  // `crash` and recover via `resume_target_step_id`, NOT auto-redispatch.
  // Graph runs (false/omitted) keep the existing gate-redispatch path.
  isLinearFlow?: boolean;
}

export interface ReconcileDecision {
  action: ReconcileAction;
  reason: ReconcileReason;
}

// Pure (no db/clock): the §0.3 decision table, asserted in EXACT order. A
// scratch run carries no compiled graph node, so it ALWAYS takes the agent
// branch (kind forced to 'ai_coding') regardless of currentNodeKind.
export function classifyRunReconcile(
  input: ReconcileInput,
  runId?: string,
): ReconcileDecision {
  const decision = classifyInner(input);

  log.debug(
    { runId, action: decision.action, reason: decision.reason },
    "[reconcile.classify]",
  );

  return decision;
}

function classifyInner(input: ReconcileInput): ReconcileDecision {
  // 1. allow-list: reconcile only owns `Running` rows.
  if (input.runStatus !== "Running") {
    return { action: "skip", reason: "not-running" };
  }

  // 2. worktree gone: cannot continue regardless of session/node.
  if (!input.worktreeExists) {
    return { action: "crash", reason: "worktree-gone" };
  }

  // 3. live agent session with no attached runner → re-attach.
  if (input.liveSession) {
    return { action: "reattach", reason: "live-session" };
  }

  // 4. no live session — branch on node kind. Scratch carries no graph node;
  //    it always behaves as an agent node.
  const kind: ReconcileInput["currentNodeKind"] =
    input.runKind === "scratch" ? "ai_coding" : input.currentNodeKind;

  if (kind === "cli") {
    // A half-run cli node may have partial side effects — never re-run.
    return { action: "crash", reason: "cli-not-retry-safe" };
  }

  if (kind === "ai_coding") {
    // Anchor = the MORE RECENT non-null of resume/latest-attempt. Within grace
    // (strict <) → skip; past grace (incl. both null) → crash.
    const anchorMs = mostRecentMs(
      input.resumeStartedAt,
      input.latestAttemptStartedAt,
    );

    if (
      anchorMs !== null &&
      (input.nowMs - anchorMs) / 1000 < input.graceSeconds
    ) {
      return { action: "skip", reason: "grace-window" };
    }

    return { action: "crash", reason: "agent-session-gone" };
  }

  // check / judge / guard / human / form / null → retry-safe gate re-dispatch.
  // A linear (flat `steps[]`) run cannot resume mid-flow through `runFlow`
  // (no graph node-resume; bare re-entry restarts at step 0 and re-runs prior
  // side-effects). Crash it instead so `crashRunningRun` retains the node in
  // `resume_target_step_id` and operator Recover resumes from it via
  // `crashResume` (ADR-056 window-(c)). Graph runs keep gate-redispatch.
  if (input.isLinearFlow) {
    return { action: "crash", reason: "linear-gate-orphan" };
  }

  return { action: "redispatch", reason: "gate-redispatch" };
}

function mostRecentMs(a: Date | null, b: Date | null): number | null {
  const am = a?.getTime() ?? null;
  const bm = b?.getTime() ?? null;

  if (am === null) return bm;
  if (bm === null) return am;

  return Math.max(am, bm);
}

// --- T2.2: sweep ----------------------------------------------------------

export interface RunReconcileSweepOptions {
  db?: Db;
  listSessions?: () => Promise<SupervisorSessionRecord[]>;
  listWorktrees?: (repoPath: string) => Promise<WorktreeInfo[]>;
  runFlow?: (runId: string) => Promise<void> | void;
  scheduleResumedSessionDrive?: (opts: RunResumedSessionOptions) => string;
  now?: () => Date;
}

export interface ReconcileSweepSummary {
  candidates: number;
  crashed: number;
  redispatched: number;
  reattached: number;
  skipped: number;
}

const ZERO_SUMMARY: ReconcileSweepSummary = {
  candidates: 0,
  crashed: 0,
  redispatched: 0,
  reattached: 0,
  skipped: 0,
};
const TERMINAL_ASSIGNMENT_CLEANUP_STATUSES = [
  "Done",
  "Failed",
  "Abandoned",
  "Crashed",
] as const;

function mapReasonToCrashReason(reason: ReconcileReason): CrashReason {
  switch (reason) {
    case "worktree-gone":
      return "worktree-gone";
    case "agent-session-gone":
      return "agent-session-gone";
    case "cli-not-retry-safe":
      return "cli-not-retry-safe";
    case "linear-gate-orphan":
      return "linear-gate-orphan";
    default:
      // Defensive: only crash reasons reach a crash dispatch.
      return "agent-session-gone";
  }
}

type CandidateRow = {
  runId: string;
  runKind: "flow" | "scratch";
  status: string;
  acpSessionId: string | null;
  currentStepId: string | null;
  resumeStartedAt: Date | null;
  flowId: string | null;
  flowRevisionId: string | null;
  worktreePath: string;
  repoPath: string;
};

async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;

      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// Latest node_attempts.started_at for a run (the grace anchor alongside
// resume_started_at). ORDER BY started_at DESC LIMIT 1.
async function latestAttemptStartedAt(
  db: Db,
  runId: string,
): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: nodeAttempts.startedAt })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(desc(nodeAttempts.startedAt))
    .limit(1);

  return rows[0]?.startedAt ?? null;
}

// A run is the takeover-return sweep's candidate (NOT reconcile's) if it has a
// node_attempts row with ownerUserId + returnedDiff + endedAt all set. We keep
// the two sweeps disjoint by EXCLUDING any such run from reconcile.
async function isTakeoverReturnCandidate(
  db: Db,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        isNotNull(nodeAttempts.ownerUserId),
        isNotNull(nodeAttempts.returnedDiff),
        isNotNull(nodeAttempts.endedAt),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

async function loadCandidates(db: Db): Promise<CandidateRow[]> {
  const projectRows: Array<{ id: string; repoPath: string }> = await db
    .select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects);

  const all: CandidateRow[] = [];

  for (const project of projectRows) {
    const rows: Array<{
      runId: string;
      runKind: "flow" | "scratch";
      status: string;
      acpSessionId: string | null;
      currentStepId: string | null;
      resumeStartedAt: Date | null;
      flowId: string | null;
      flowRevisionId: string | null;
      worktreePath: string;
    }> = await db
      .select({
        runId: runs.id,
        runKind: runs.runKind,
        status: runs.status,
        acpSessionId: runs.acpSessionId,
        currentStepId: runs.currentStepId,
        resumeStartedAt: runs.resumeStartedAt,
        flowId: runs.flowId,
        flowRevisionId: runs.flowRevisionId,
        worktreePath: workspaces.worktreePath,
      })
      .from(runs)
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(and(eq(runs.projectId, project.id), eq(runs.status, "Running")))
      .orderBy(asc(runs.startedAt))
      .limit(PER_TICK_LIMIT);

    for (const row of rows) {
      // Exclude the takeover-return sweep's candidate set (disjoint sweeps).
      if (await isTakeoverReturnCandidate(db, row.runId)) continue;

      all.push({ ...row, repoPath: project.repoPath });
    }
  }

  return all;
}

async function closeTerminalRunAssignments(db: Db): Promise<number> {
  const rows: Array<{ runId: string }> = await db
    .select({ runId: assignments.runId })
    .from(assignments)
    .innerJoin(runs, eq(runs.id, assignments.runId))
    .where(
      and(
        inArray(assignments.status, ["open", "claimed"]),
        inArray(runs.status, [...TERMINAL_ASSIGNMENT_CLEANUP_STATUSES]),
      ),
    )
    .limit(PER_TICK_LIMIT);
  const runIds = [...new Set(rows.map((row) => row.runId))];

  for (const runId of runIds) {
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "terminal run reconciliation",
    });
  }

  if (runIds.length > 0) {
    log.info(
      { runCount: runIds.length },
      "[FIX:M13] terminal run assignments closed by reconcile",
    );
  }

  return runIds.length;
}

export async function runReconcileSweep(
  opts: RunReconcileSweepOptions = {},
): Promise<ReconcileSweepSummary> {
  const db = opts.db ?? getDb();
  const sessions = opts.listSessions ?? listSessions;
  const worktreesFor = opts.listWorktrees ?? listWorktrees;
  const runFlow =
    opts.runFlow ??
    (async (runId: string) => {
      const mod = await import("@/lib/flows/runner");

      await mod.runFlow(runId);
    });
  const driveResumed =
    opts.scheduleResumedSessionDrive ?? scheduleResumedSessionDrive;
  const now = opts.now ?? (() => new Date());
  const graceSeconds = reconcileGraceSeconds();

  await closeTerminalRunAssignments(db);

  // listSessions ONCE up front. On throw → skip the whole tick (never crash on
  // transient supervisor unavailability).
  let liveMap: Map<string, SupervisorSessionRecord>;

  try {
    const records = await sessions();

    liveMap = new Map();
    for (const rec of records) {
      if (rec.status === "live" && rec.acpSessionId) {
        liveMap.set(rec.acpSessionId, rec);
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "reconcile sweep: listSessions failed — skipping whole tick",
    );

    return { ...ZERO_SUMMARY };
  }

  const candidates = await loadCandidates(db);

  log.info({ candidates: candidates.length }, "reconcile sweep start");

  if (candidates.length === 0) {
    return { ...ZERO_SUMMARY };
  }

  // One listWorktrees call per distinct repoPath → Set of worktree paths.
  const worktreesByRepo = new Map<string, Set<string>>();

  for (const repoPath of new Set(candidates.map((c) => c.repoPath))) {
    const infos = await worktreesFor(repoPath);

    worktreesByRepo.set(repoPath, new Set(infos.map((w) => w.path)));
  }

  const nowMs = now().getTime();

  let crashed = 0;
  let redispatched = 0;
  let reattached = 0;
  let skipped = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (cand) => {
    const worktreeExists =
      worktreesByRepo.get(cand.repoPath)?.has(cand.worktreePath) ?? false;
    const live = cand.acpSessionId ? liveMap.get(cand.acpSessionId) : undefined;

    const { nodeKind: currentNodeKind, isLinear } =
      cand.runKind === "scratch"
        ? { nodeKind: null, isLinear: false }
        : await resolveCurrentNodeContext(db, {
            flowRevisionId: cand.flowRevisionId,
            flowId: cand.flowId,
            currentStepId: cand.currentStepId,
          });

    const attemptStartedAt = await latestAttemptStartedAt(db, cand.runId);

    const { action, reason } = classifyRunReconcile(
      {
        runStatus: cand.status,
        runKind: cand.runKind,
        acpSessionId: cand.acpSessionId,
        currentStepId: cand.currentStepId,
        currentNodeKind,
        worktreeExists,
        liveSession: Boolean(live),
        resumeStartedAt: cand.resumeStartedAt,
        latestAttemptStartedAt: attemptStartedAt,
        nowMs,
        graceSeconds,
        isLinearFlow: isLinear,
      },
      cand.runId,
    );

    switch (action) {
      case "crash": {
        if (cand.runKind === "scratch") {
          // Lazy import: the scratch service pulls in the authz/next-auth
          // chain, which must NOT load when the pure classifier is imported
          // standalone (the T2.1 unit test imports `@/lib/reconcile`).
          const { markScratchCrashed } = await import(
            "@/lib/scratch-runs/service"
          );

          await markScratchCrashed({
            db,
            runId: cand.runId,
            err: new MaisterError("CRASH", `reconcile: ${reason}`),
          });
        } else {
          await crashRunningRun(cand.runId, mapReasonToCrashReason(reason), {
            db,
          });
          await cleanupRunMaterializations({
            runId: cand.runId,
            worktreePath: cand.worktreePath,
            db,
          });
        }
        await systemCloseActiveAssignmentsForRun({
          db,
          runId: cand.runId,
          reason: `reconcile crashed run: ${reason}`,
        });
        await promoteNextPending({
          db,
          runFlow: (next: string) => void Promise.resolve(runFlow(next)),
        });
        crashed += 1;
        log.info({ runId: cand.runId, reason }, "reconcile: crashed");

        return;
      }
      case "redispatch": {
        await runFlow(cand.runId);
        redispatched += 1;
        log.info({ runId: cand.runId, reason }, "reconcile: redispatched");

        return;
      }
      case "reattach": {
        driveResumed({
          runId: cand.runId,
          supervisorSessionId: live!.sessionId,
          acpSessionId: live!.acpSessionId!,
          stepId: live!.stepId ?? cand.currentStepId ?? "",
          db,
        });
        reattached += 1;
        log.info({ runId: cand.runId, reason }, "reconcile: reattached");

        return;
      }
      case "skip": {
        skipped += 1;
        log.debug({ runId: cand.runId, reason }, "reconcile: skipped");

        return;
      }
    }
  });

  const summary: ReconcileSweepSummary = {
    candidates: candidates.length,
    crashed,
    redispatched,
    reattached,
    skipped,
  };

  log.info(summary, "reconcile sweep complete");

  return summary;
}

// --- T2.3: periodic sweeper singleton -------------------------------------

type GlobalReconcileState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
};

const RECONCILE_GLOBAL_KEY = Symbol.for("maister.reconcile-sweeper.v1");

function globalState(): GlobalReconcileState {
  const g = globalThis as unknown as Record<symbol, GlobalReconcileState>;

  if (!g[RECONCILE_GLOBAL_KEY]) {
    g[RECONCILE_GLOBAL_KEY] = { handle: null, intervalSeconds: 0 };
  }

  return g[RECONCILE_GLOBAL_KEY];
}

export function startReconcileSweeper(): void {
  const state = globalState();
  const intervalSeconds = reconcileSweepIntervalSeconds();

  if (state.handle) {
    if (state.intervalSeconds === intervalSeconds) {
      log.debug(
        { intervalSeconds },
        "startReconcileSweeper: already running with the same interval — no-op",
      );

      return;
    }
    log.info(
      { prevIntervalSeconds: state.intervalSeconds, intervalSeconds },
      "startReconcileSweeper: interval changed — restarting timer",
    );
    clearInterval(state.handle);
    state.handle = null;
  }

  state.intervalSeconds = intervalSeconds;
  state.handle = setInterval(() => {
    void runReconcileSweep().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "reconcile sweep tick threw — continuing on next interval",
      );
    });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();
  log.info({ intervalSeconds }, "reconcile-sweeper started");
}

export function stopReconcileSweeper(): void {
  const state = globalState();

  if (state.handle) {
    clearInterval(state.handle);
    state.handle = null;
    log.info({}, "reconcile-sweeper stopped");
  }
}
