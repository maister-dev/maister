import "server-only";

import type { RunResumedSessionOptions } from "@/lib/runs/resume-driver";
import type { CrashReason } from "@/lib/runs/state-transitions";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
} from "drizzle-orm";
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
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";
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

// Server-owned liveness key: a session's (runId, stepId). Used to detect a live
// agent session whose acp_session_id is not yet persisted on the run row.
function runStepKey(runId: string, stepId: string | null): string {
  return `${runId}\u0000${stepId ?? ""}`;
}

// --- T2.1: pure classifier ------------------------------------------------

export type ReconcileAction = "skip" | "reattach" | "redispatch" | "crash";

export type ReconcileReason =
  | "not-running"
  | "worktree-gone"
  | "live-session"
  | "live-session-by-step"
  | "live-scratch-session"
  | "gate-redispatch"
  | "linear-gate-orphan"
  | "cli-not-retry-safe"
  | "grace-window"
  | "agent-session-gone"
  // M36 (ADR-095) T7.1: a Running child whose coordinator parent is gone
  // (Crashed/Abandoned/missing) can no longer be coordinated → crash it.
  | "orphaned-child"
  // M36 (ADR-095) T7.1: a parked orchestrator whose session died, with no
  // pending children left and past the grace window → genuinely stuck → crash.
  | "orchestrator-stuck"
  // M36 (ADR-095) T7.1: a parked orchestrator that is still waiting on
  // non-terminal children (or whose session is live) → leave it parked.
  | "orchestrator-waiting";

export interface ReconcileInput {
  runStatus: string;
  runKind: "flow" | "scratch" | "agent";
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
    | "orchestrator"
    | null;
  worktreeExists: boolean;
  liveSession: boolean;
  // True when the supervisor reports a LIVE session for this run's
  // (runId, currentStepId) but it did NOT match by acp_session_id — i.e. the
  // run row's acp_session_id is still null because the agent node's prompt is
  // in-flight (it is persisted only AFTER the prompt returns). The node is
  // genuinely running; reconcile must NOT crash it. Default false/omitted.
  liveRunStepSession?: boolean;
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
  // M36 (ADR-095) T7.1: the run's delegator (null for a top-level run). When
  // set, the sweep also loads `parentStatus` so an orphaned child (parent
  // Crashed/Abandoned/missing) is caught regardless of session liveness.
  parentRunId?: string | null;
  // The parent run's status, loaded by the sweep when `parentRunId` is set;
  // null when the parent row is missing (a hard orphan) OR there is no parent.
  // The pure classifier reads it ONLY when `parentRunId` is non-null.
  parentStatus?: string | null;
  // M36 (ADR-095) T7.1: meaningful only for the WaitingOnChildren pass — true
  // when the parked orchestrator still has at least one non-terminal child, so
  // it must stay parked (a later child-terminal event wakes it). Default false.
  hasPendingChildren?: boolean;
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
  // 0. M36 (ADR-095) T7.1: a parked orchestrator (WaitingOnChildren). It is
  //    woken by a child-terminal event (orchestrator_resume) or a manual resume,
  //    so it is NOT crashed while it can still be woken. Crash it ONLY when it is
  //    genuinely stuck: no live session, no non-terminal children remain, AND
  //    past the grace window. A live session (came back) or remaining pending
  //    children → leave it parked.
  if (input.runStatus === "WaitingOnChildren") {
    if (input.liveSession) {
      return { action: "skip", reason: "orchestrator-waiting" };
    }
    if (input.hasPendingChildren) {
      return { action: "skip", reason: "orchestrator-waiting" };
    }

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

    return { action: "crash", reason: "orchestrator-stuck" };
  }

  // 1. allow-list: reconcile only owns `Running` rows.
  if (input.runStatus !== "Running") {
    return { action: "skip", reason: "not-running" };
  }

  // 2. worktree gone: cannot continue regardless of session/node.
  if (!input.worktreeExists) {
    return { action: "crash", reason: "worktree-gone" };
  }

  // 2.5. M36 (ADR-095) T7.1: an orphaned child — a Running run whose delegator
  //      parent is gone (Crashed/Abandoned/missing). The coordinator can no
  //      longer drive it, so crash it. Checked BEFORE the session/grace checks
  //      so an orphan is caught even while its own session still looks live.
  if (
    input.parentRunId != null &&
    (input.parentStatus == null ||
      input.parentStatus === "Crashed" ||
      input.parentStatus === "Abandoned")
  ) {
    return { action: "crash", reason: "orphaned-child" };
  }

  // 3. live agent session with no attached runner → re-attach.
  //
  // The resume driver (runResumedSession) is ONLY correct for a flow run
  // recovering a live supervisor session after an HITL checkpoint: it sends a
  // continuation prompt and replays the cancelled permission. A scratch run is
  // a plain conversational dialog — after a turn ends (`end_turn`) its session
  // stays live waiting for the NEXT user message; it has no prior tool call and
  // no stored HITL intent. Reattaching such a run drives a continuation prompt
  // it can never satisfy and the watchdog crashes it (`resume-prompt-no-
  // permission`). A live `Running` scratch dialog is healthy → skip it; the
  // next user message resumes it through the scratch message path, not here.
  if (input.liveSession) {
    if (input.runKind === "scratch") {
      return { action: "skip", reason: "live-scratch-session" };
    }

    return { action: "reattach", reason: "live-session" };
  }

  // 3.5. The supervisor has a LIVE session for this (runId, stepId) but it did
  // not match by acp_session_id — the run row's acp_session_id is null because
  // the agent node's prompt is still in-flight (persisted only AFTER it
  // returns). The node is genuinely running: do NOT crash it (the bug this
  // guards), and do NOT reattach (that would double-drive an actively-running
  // node). Skip; a later sweep handles a real orphan once the session resolves.
  if (input.liveRunStepSession) {
    return { action: "skip", reason: "live-session-by-step" };
  }

  // 4. no live session — branch on node kind. Scratch and platform-agent
  //    runs carry no compiled graph node; both behave as an agent node.
  const kind: ReconcileInput["currentNodeKind"] =
    input.runKind === "scratch" || input.runKind === "agent"
      ? "ai_coding"
      : input.currentNodeKind;

  if (kind === "cli") {
    // A half-run cli node may have partial side effects — never re-run.
    return { action: "crash", reason: "cli-not-retry-safe" };
  }

  if (kind === "ai_coding" || kind === "orchestrator") {
    // M36 (ADR-095): an orchestrator node is a live agent session — same
    // grace-window-then-crash treatment as ai_coding.
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
    case "orphaned-child":
      return "orphaned-child";
    case "orchestrator-stuck":
      return "orchestrator-stuck";
    default:
      // Defensive: only crash reasons reach a crash dispatch.
      return "agent-session-gone";
  }
}

type CandidateRow = {
  runId: string;
  runKind: "flow" | "scratch" | "agent";
  status: string;
  acpSessionId: string | null;
  currentStepId: string | null;
  resumeStartedAt: Date | null;
  runStartedAt: Date | null;
  flowId: string | null;
  flowRevisionId: string | null;
  // M36 (ADR-095) T7.1: the delegator (null for a top-level run). Drives
  // orphan detection (Running children) and routes the cascade (WaitingOnChildren).
  parentRunId: string | null;
  taskId: string | null;
  // null = no workspaces row (M34 agent runs with workspace none/repo_read).
  worktreePath: string | null;
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

// M36 (ADR-095 T7.1 / ADR-097): the SETTLED child statuses an orchestrator no
// longer actively waits on — terminal OR Review (a diff awaiting promote/rework).
// A parked orchestrator with only settled children is woken by run.review/
// run.done; if that wake genuinely failed (no live session past the grace
// window), the classifier crashes it as orchestrator-stuck rather than hanging.

// The parent run's status for orphan detection. null = the parent row is gone
// (a hard orphan) — the classifier treats a missing parent as coordinator-dead.
async function parentStatusOf(
  db: Db,
  parentRunId: string,
): Promise<string | null> {
  const rows: Array<{ status: string }> = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, parentRunId))
    .limit(1);

  return rows[0]?.status ?? null;
}

// True when a parked orchestrator still has at least one non-SETTLED child.
async function hasPendingChildren(
  db: Db,
  parentRunId: string,
): Promise<boolean> {
  const rows: Array<{ id: string }> = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, parentRunId),
        notInArray(runs.status, [...SETTLED_RUN_STATUSES]),
      ),
    )
    .limit(1);

  return rows.length > 0;
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
      runKind: "flow" | "scratch" | "agent";
      status: string;
      acpSessionId: string | null;
      currentStepId: string | null;
      resumeStartedAt: Date | null;
      runStartedAt: Date | null;
      flowId: string | null;
      flowRevisionId: string | null;
      parentRunId: string | null;
      taskId: string | null;
      worktreePath: string | null;
    }> = await db
      .select({
        runId: runs.id,
        runKind: runs.runKind,
        status: runs.status,
        acpSessionId: runs.acpSessionId,
        currentStepId: runs.currentStepId,
        resumeStartedAt: runs.resumeStartedAt,
        runStartedAt: runs.startedAt,
        flowId: runs.flowId,
        flowRevisionId: runs.flowRevisionId,
        parentRunId: runs.parentRunId,
        taskId: runs.taskId,
        worktreePath: workspaces.worktreePath,
      })
      .from(runs)
      // M34: agent runs with workspace=none/repo_read have no workspaces row —
      // a left join keeps them in the sweep's candidate set.
      .leftJoin(workspaces, eq(workspaces.runId, runs.id))
      // M36 (ADR-095) T7.1: the sweep ALSO owns parked orchestrators
      // (WaitingOnChildren) so a stuck coordinator reconciles to Crashed.
      .where(
        and(
          eq(runs.projectId, project.id),
          inArray(runs.status, ["Running", "WaitingOnChildren"]),
        ),
      )
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

// F3 (ADR-102): recover ORPHAN shared trees. A crash between addWorktree (git,
// outside the runs+workspaces tx) and the workspaces insert can leave a shared
// tree (root_run_id with shared writable children) carrying NO workspaces row,
// while the deterministic path is on disk. Such a tree is unresolvable for
// promote/diff/GC. Per project, find each shared tree with no row whose
// `sharedAgentWorktreePath` exists on disk and insert a synthetic row owned by
// the EARLIEST shared child (started_at, then created_at), base_commit=null
// (the true base is lost; promote/diff tolerate null). Idempotent: a tree that
// already has a row, or whose path is gone, is skipped. The insert is
// onConflictDoNothing on worktree_path so it cannot race a concurrent claimer
// into a 23505.
export async function recoverOrphanSharedTrees(
  opts: {
    db?: Db;
    listWorktrees?: (repoPath: string) => Promise<WorktreeInfo[]>;
  } = {},
): Promise<number> {
  const db = opts.db ?? getDb();
  const worktreesFor = opts.listWorktrees ?? listWorktrees;
  const { sharedAgentWorktreePath } = await import("@/lib/agents/launch");

  const projectRows: Array<{
    id: string;
    repoPath: string;
    slug: string;
    branchPrefix: string;
    mainBranch: string;
  }> = await db
    .select({
      id: projects.id,
      repoPath: projects.repoPath,
      slug: projects.slug,
      branchPrefix: projects.branchPrefix,
      mainBranch: projects.mainBranch,
    })
    .from(projects);

  let recovered = 0;

  for (const project of projectRows) {
    // The distinct tree roots with shared writable children in this project.
    const rootRows: Array<{ rootRunId: string }> = await db
      .selectDistinct({ rootRunId: runs.rootRunId })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, project.id),
          eq(runs.workspaceMode, "shared"),
          eq(runs.agentWorkspace, "worktree"),
          isNotNull(runs.rootRunId),
        ),
      );

    if (rootRows.length === 0) continue;

    // One listWorktrees call per project; absent path → nothing to recover.
    const onDisk = new Set(
      (await worktreesFor(project.repoPath)).map((w) => w.path),
    );

    for (const { rootRunId } of rootRows) {
      // Already has a row → resolvable, skip (idempotent).
      if (await findSharedTreeWorkspace(db, rootRunId)) continue;

      const worktreePath = sharedAgentWorktreePath(project.slug, rootRunId);

      if (!onDisk.has(worktreePath)) continue;

      // The earliest shared child of the tree owns the synthetic row (by
      // started_at; the allocator child always started, so it sorts first).
      const earliestRows: Array<{ id: string }> = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.rootRunId, rootRunId),
            eq(runs.workspaceMode, "shared"),
            eq(runs.agentWorkspace, "worktree"),
          ),
        )
        .orderBy(asc(runs.startedAt))
        .limit(1);
      const earliest = earliestRows[0];

      if (!earliest) continue;

      await db
        .insert(workspaces)
        .values({
          id: randomUUID(),
          runId: earliest.id,
          projectId: project.id,
          branch: `${project.branchPrefix ?? "maister/"}agents/${rootRunId}`,
          worktreePath,
          parentRepoPath: project.repoPath,
          baseBranch: project.mainBranch,
          baseCommit: null,
          targetBranch: project.mainBranch,
        })
        .onConflictDoNothing({ target: workspaces.worktreePath });

      recovered += 1;
      log.warn(
        { rootRunId, worktreePath, ownerRunId: earliest.id },
        "reconcile: orphan shared tree recovered — synthetic workspaces row created",
      );
    }
  }

  if (recovered > 0) {
    log.info({ recovered }, "reconcile: orphan shared trees recovered");
  }

  return recovered;
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

  // F3 (ADR-102): recover any orphan shared tree (path on disk, no workspaces
  // row) BEFORE classifying — a recovered row makes the tree resolvable for the
  // rest of the sweep + later promote/diff/GC. Best-effort: a failure here must
  // not abort the whole tick.
  try {
    await recoverOrphanSharedTrees({ db, listWorktrees: worktreesFor });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "reconcile: orphan shared-tree recovery threw — continuing sweep",
    );
  }

  // listSessions ONCE up front. On throw → skip the whole tick (never crash on
  // transient supervisor unavailability).
  let liveMap: Map<string, SupervisorSessionRecord>;
  let liveByRunStep: Map<string, SupervisorSessionRecord>;

  try {
    const records = await sessions();

    liveMap = new Map();
    liveByRunStep = new Map();
    for (const rec of records) {
      if (rec.status !== "live") continue;
      if (rec.acpSessionId) liveMap.set(rec.acpSessionId, rec);
      // Server-owned identity index → lets reconcile recognize an in-flight
      // agent node whose run row has not yet persisted acp_session_id (prevents
      // the false "agent-session-gone" crash of a live, long-running node).
      liveByRunStep.set(runStepKey(rec.runId, rec.stepId), rec);
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
    // M34: a null worktreePath is the no-workspace agent shape (none/
    // repo_read) — there is no worktree to lose. Flow/scratch runs always
    // carry a workspace row; a null there still reads as gone.
    const worktreeExists =
      cand.worktreePath == null
        ? cand.runKind === "agent"
        : (worktreesByRepo.get(cand.repoPath)?.has(cand.worktreePath) ?? false);
    const live = cand.acpSessionId ? liveMap.get(cand.acpSessionId) : undefined;
    // acp_session_id unmatched but a live session exists for (runId, stepId) →
    // the agent's prompt is still in-flight (acp_session_id not yet persisted).
    const liveRunStep =
      !live && cand.currentStepId
        ? liveByRunStep.get(runStepKey(cand.runId, cand.currentStepId))
        : undefined;

    // A parked orchestrator (WaitingOnChildren) is classified by the §0
    // branch which reads neither node-kind nor isLinear — skip the resolve.
    const { nodeKind: currentNodeKind, isLinear } =
      cand.runKind === "scratch" ||
      cand.runKind === "agent" ||
      cand.status === "WaitingOnChildren"
        ? { nodeKind: null, isLinear: false }
        : await resolveCurrentNodeContext(db, {
            flowRevisionId: cand.flowRevisionId,
            flowId: cand.flowId,
            currentStepId: cand.currentStepId,
          });

    // Agent runs have no node_attempts ledger — anchor the grace window on
    // the run's own startedAt so a just-spawned session is never crashed.
    const attemptStartedAt =
      cand.runKind === "agent"
        ? cand.runStartedAt
        : await latestAttemptStartedAt(db, cand.runId);

    // M36 (ADR-095) T7.1: orphan detection needs the parent's status; the
    // parked-orchestrator pass needs to know if any child is still pending.
    const parentStatus =
      cand.parentRunId != null
        ? await parentStatusOf(db, cand.parentRunId)
        : null;
    const pendingChildren =
      cand.status === "WaitingOnChildren"
        ? await hasPendingChildren(db, cand.runId)
        : false;

    const { action, reason } = classifyRunReconcile(
      {
        runStatus: cand.status,
        runKind: cand.runKind,
        acpSessionId: cand.acpSessionId,
        currentStepId: cand.currentStepId,
        currentNodeKind,
        worktreeExists,
        liveSession: Boolean(live),
        liveRunStepSession: Boolean(liveRunStep),
        resumeStartedAt: cand.resumeStartedAt,
        latestAttemptStartedAt: attemptStartedAt,
        nowMs,
        graceSeconds,
        isLinearFlow: isLinear,
        parentRunId: cand.parentRunId,
        parentStatus,
        hasPendingChildren: pendingChildren,
      },
      cand.runId,
    );

    switch (action) {
      case "crash": {
        if (reason === "orchestrator-stuck") {
          // M36 (ADR-095) T7.1: a stuck parked orchestrator. Cascade-abandon any
          // leftover children FIRST (children-first), THEN crash the coordinator
          // via the WaitingOnChildren-guarded transition. The cascade owns its
          // own per-pool promote; crashWaitingOnChildren is status-guarded so a
          // concurrent wake that already moved it to Running loses.
          const { cascadeAbandonRunTree } = await import(
            "@/lib/orchestrator/cascade"
          );
          const { crashWaitingOnChildren } = await import(
            "@/lib/runs/state-transitions"
          );

          await cascadeAbandonRunTree(
            cand.runId,
            cand.taskId,
            "orchestrator-stuck",
            { db },
          );
          const crashResult = await crashWaitingOnChildren(
            cand.runId,
            "orchestrator-stuck",
            { db },
          );

          if (!crashResult.ok) {
            // A concurrent wake won the CAS — the run is Running again; nothing
            // to crash. Count as skipped, not crashed.
            skipped += 1;
            log.info(
              { runId: cand.runId, reason },
              "reconcile: orchestrator wake won — skipped crash",
            );

            return;
          }

          if (cand.worktreePath) {
            await cleanupRunMaterializations({
              runId: cand.runId,
              worktreePath: cand.worktreePath,
              db,
            });
          }
          await systemCloseActiveAssignmentsForRun({
            db,
            runId: cand.runId,
            reason: `reconcile crashed orchestrator: ${reason}`,
          });
          await promoteNextPending({
            db,
            runFlow: (next: string) => void Promise.resolve(runFlow(next)),
          });
          crashed += 1;
          log.info(
            { runId: cand.runId, reason },
            "reconcile: crashed stuck orchestrator",
          );

          return;
        }
        if (cand.runKind === "agent") {
          // M34: finalizeAgentRun owns the agent terminal choke point —
          // token revoke + emits + agent-pool promote. Lazy import keeps the
          // pure classifier importable standalone.
          const { finalizeAgentRun } = await import("@/lib/agents/launch");

          await finalizeAgentRun(cand.runId, "Crashed", {
            db,
            reason: `reconcile: ${reason}`,
          });
          await systemCloseActiveAssignmentsForRun({
            db,
            runId: cand.runId,
            reason: `reconcile crashed run: ${reason}`,
          });
          crashed += 1;
          log.info({ runId: cand.runId, reason }, "reconcile: crashed agent");

          return;
        }
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
          if (cand.worktreePath) {
            await cleanupRunMaterializations({
              runId: cand.runId,
              worktreePath: cand.worktreePath,
              db,
            });
          }
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
        // Defense-in-depth: the resume driver's continuation-prompt +
        // permission-replay contract is only valid for flow runs recovering a
        // checkpointed HITL session. A scratch (or agent) run must NEVER be
        // routed here, even if a future classifier regression returns
        // `reattach` for it — driving a continuation prompt on a live scratch
        // dialog falsely crashes it (`resume-prompt-no-permission`).
        if (cand.runKind !== "flow") {
          skipped += 1;
          log.warn(
            { runId: cand.runId, runKind: cand.runKind, reason },
            "[FIX] reconcile: refusing reattach for non-flow run — skipping",
          );

          return;
        }
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
