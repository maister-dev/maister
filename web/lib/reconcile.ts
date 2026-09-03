import "server-only";

import type { RunResumedSessionOptions } from "@/lib/runs/resume-driver";
import type { CrashReason } from "@/lib/runs/state-transitions";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type {
  ExecutionHosts,
  SupervisorSessionRecord,
} from "@/lib/execution-host";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { cleanupRunMaterializations } from "@/lib/capabilities/cleanup";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES } from "@/lib/db/schema";
import { resolveCurrentNodeContext } from "@/lib/flows/graph/current-node-kind";
import { listGraphOnlyCutoverRunIds } from "@/lib/queries/run-cutover";
import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import {
  reconcileGraceSeconds,
  reconcileSweepIntervalSeconds,
} from "@/lib/instance-config";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { loadActiveRunSessionsByRunId } from "@/lib/runs/active-run-session";
import { scheduleResumedSessionDrive } from "@/lib/runs/resume-driver";
import {
  isTerminalRunStatus,
  SETTLED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "@/lib/runs/run-status-sets";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { hasSyncDriver } from "@/lib/runs/sync-driver-registry";
import { promoteNextPending } from "@/lib/scheduler";
import { createExecutionHosts, isFencedError } from "@/lib/execution-host";
import { listWorktrees } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  assignments,
  executionAssignments,
  hitlRequests,
  nodeAttempts,
  projects,
  runs,
  runSyncAttempts,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

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

export type ReconcileAction =
  | "skip"
  | "reattach"
  | "redispatch"
  | "crash"
  // ADR-141: a `Running` run with a non-terminal `run_sync_attempts`
  // row is routed to the branch-sync recovery executor, NEVER the flow
  // reattach/redispatch arms.
  | "sync-recover"
  // An orphaned `Pending` child: it never started, so there is nothing to
  // recover — abandon it rather than surface a "Crashed" run that has no
  // session to resume, and stop the scheduler starting it under a dead
  // coordinator later.
  | "abandon";

export type ReconcileReason =
  | "not-running"
  | "worktree-gone"
  | "live-session"
  | "live-session-by-step"
  | "live-scratch-session"
  | "gate-redispatch"
  | "cli-not-retry-safe"
  | "grace-window"
  | "agent-session-gone"
  // ADR-141 branch-sync recovery discriminants.
  | "sync-driver-live"
  | "sync-orphaned-live"
  | "sync-orphaned-idle"
  // M36 (ADR-095) T7.1: a Running child whose coordinator parent is gone
  // (terminal/missing) can no longer be coordinated → crash it. Also
  // the reason for a Pending/NeedsInput/NeedsInputIdle/Review orphan: the
  // action differs by status (abandon vs crash), the cause is the same.
  | "orphaned-child"
  // A parked sub-orchestrator whose OWN parent is gone. Routed through the
  // stuck path so its children are cascaded first — crashing it directly would
  // recreate the orphan problem one level down.
  | "orphaned-orchestrator"
  // A HumanWorking child of a dead coordinator: a human holds the worktree, so
  // reconcile MUST NOT terminalize it. Skipped, but at WARN — it needs a person.
  | "orphaned-human-working"
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
    | "consensus"
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
  // M36 (ADR-095) T7.1: the run's delegator (null for a top-level run). When
  // set, the sweep also loads `parentStatus` so an orphaned child (parent
  // terminal/missing) is caught regardless of session liveness.
  parentRunId?: string | null;
  // The parent run's status, loaded by the sweep when `parentRunId` is set;
  // null when the parent row is missing (a hard orphan) OR there is no parent.
  // The pure classifier reads it ONLY when `parentRunId` is non-null.
  parentStatus?: string | null;
  // M36 (ADR-095) T7.1: meaningful only for the WaitingOnChildren pass — true
  // when the parked orchestrator still has at least one non-terminal child, so
  // it must stay parked (a later child-terminal event wakes it). Default false.
  hasPendingChildren?: boolean;
  // ADR-141: true when this run has a non-terminal `run_sync_attempts`
  // row (an in-flight branch sync). Routes the run to branch-sync recovery BEFORE
  // the flow reattach/redispatch arms so a sync row is never mis-driven as a
  // graph session. Default false.
  activeSyncAttempt?: boolean;
  // ADR-141: true when an in-process sync driver owns this run in THIS
  // process (registry membership). The skip-vs-abort discriminant for a live
  // resolver session: WITH a driver → healthy (skip); WITHOUT one (post-restart)
  // → orphaned (W2 recover). Default false.
  syncDriverActive?: boolean;
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

// The delegator can no longer drive this run: its parent row is in ANY
// terminal status, or missing. The single predicate every orphan arm keys on.
// Keyed on TERMINAL_RUN_STATUSES, not on the two statuses a cascade writes:
// a `Running` orchestrator that trips its own run-scope budget or fails at a
// node goes `Failed` WITHOUT cascading, and a `Done` coordinator can leave a
// child behind too — both stranded their children while only Crashed/Abandoned
// counted as death. The candidate loader below MUST use the same set.
function coordinatorGone(input: ReconcileInput): boolean {
  return (
    input.parentRunId != null &&
    (input.parentStatus == null || isTerminalRunStatus(input.parentStatus))
  );
}

// Non-Running statuses a child can be stranded in under a dead coordinator.
// The candidate loader fetches these ONLY when the parent is gone, so the
// orphan arm is the sole thing that can fire for them; a healthy-parent run in
// any of these statuses is never a candidate and would `not-running` anyway.
const ORPHANABLE_PAUSED_STATUSES: ReadonlySet<string> = new Set([
  "NeedsInput",
  "NeedsInputIdle",
  "Review",
]);

function classifyInner(input: ReconcileInput): ReconcileDecision {
  // 0. M36 (ADR-095) T7.1: a parked orchestrator (WaitingOnChildren). It is
  //    woken by a child-terminal event (orchestrator_resume) or a manual resume,
  //    so it is NOT crashed while it can still be woken. Crash it ONLY when it is
  //    genuinely stuck: no live session, no non-terminal children remain, AND
  //    past the grace window. A live session (came back) or remaining pending
  //    children → leave it parked.
  if (input.runStatus === "WaitingOnChildren") {
    // A sub-orchestrator whose own coordinator is gone can never be woken by
    // it — checked BEFORE liveness/pending/grace, which only describe whether
    // it could still be resumed by a parent that no longer exists.
    if (coordinatorGone(input)) {
      return { action: "crash", reason: "orphaned-orchestrator" };
    }
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

  // 0.5. Orphans in a NON-Running status. The Running-only allow-list below
  //      used to hide these forever: a Running orchestrator that crashes via
  //      worktree-gone / heartbeat does not cascade, so its children were left
  //      in whatever status they held — a Pending child kept its queue place
  //      and promoteNextPending would start it under a dead coordinator; a
  //      paused or reviewing child waited on a resume that could never come.
  if (coordinatorGone(input)) {
    if (input.runStatus === "Pending") {
      return { action: "abandon", reason: "orphaned-child" };
    }
    if (ORPHANABLE_PAUSED_STATUSES.has(input.runStatus)) {
      return { action: "crash", reason: "orphaned-child" };
    }
    if (input.runStatus === "HumanWorking") {
      return { action: "skip", reason: "orphaned-human-working" };
    }
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
  //      parent is gone (terminal/missing). The coordinator can no
  //      longer drive it, so crash it. Checked BEFORE the session/grace checks
  //      so an orphan is caught even while its own session still looks live.
  if (coordinatorGone(input)) {
    return { action: "crash", reason: "orphaned-child" };
  }

  // 2.75. ADR-141: a `Running` run with an in-flight branch sync
  //       (a non-terminal `run_sync_attempts` row). This is the AGENT resolver
  //       path (mechanical sync never leaves `Review`). It is checked BEFORE the
  //       live-session/node-kind arms so a sync row NEVER enters
  //       `runResumedSession`/`redispatch` — those would mis-drive it as a graph
  //       session. The skip-vs-abort discriminant is the in-proc driver registry:
  //         - live session WITH a driver → healthy, skip (a periodic sweep during
  //           an active in-process resolver);
  //         - live session WITHOUT a driver → orphaned session (post-restart, when
  //           the registry is empty) → W2 recover (tear down + abort);
  //         - no live session → W2/W3 recover (idempotent re-verify → finalize or
  //           abort).
  if (input.activeSyncAttempt) {
    // The REGISTRY is the discriminant, and it must be consulted FIRST — it is
    // the only signal that means "a driver in THIS process owns this run".
    // `liveSession` cannot gate it: that answers "does a supervisor session
    // exist", which is a different question, and nesting this skip under it once
    // made the skip unreachable — every live resolver classified as an orphan,
    // and the sweep hard-reset the worktree under the running agent and released
    // its claim.
    if (input.syncDriverActive) {
      return { action: "skip", reason: "sync-driver-live" };
    }

    // No driver here → a post-restart orphan. `liveSession` only distinguishes
    // W2 (a supervisor session still up → tear it down) from W3 (already gone).
    if (input.liveSession) {
      return { action: "sync-recover", reason: "sync-orphaned-live" };
    }

    return { action: "sync-recover", reason: "sync-orphaned-idle" };
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

  // check / judge / guard / human / form / null → retry-safe graph re-dispatch.
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
  executionHosts?: ExecutionHosts;
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
  // M43: D2 clears persisted ACP handles, so a surviving old supervisor
  // process is stopped by run identity before normal Running-only reconcile.
  cutoverSessionsStopped: number;
  // ADR-121 (T15, F1): stale C2 admission claims (tasks.queue_claimed_at set, no
  // run minted, past the grace window — a crash between claim and launchRun) cleared
  // this tick so the task becomes re-eligible.
  staleClaimsCleared: number;
  // ADR-141: `Running` runs with an in-flight branch sync recovered this
  // tick via the branch-sync recovery executor (W2/W3). A driver-owned live sync is
  // counted in `skipped`, not here.
  syncRecovered: number;
  // Codex review F2 (ADR-163): live supervisor sessions found under an
  // `Abandoned` run row and stopped this tick — the recovery path for a
  // cascade whose best-effort session teardown did not complete.
  orphanSessionsReaped: number;
  // ADR-166 D7/D8: ACTIVE assignments whose adopted workspace handle the host
  // no longer knows (WARN `workspace-handle-lost`; the next create re-adopts).
  handlesLost: number;
  // Orphaned `Pending` children abandoned this tick (never started under a
  // coordinator that is now gone) — distinct from `crashed`, which is a
  // recoverable outcome; these have nothing to recover.
  abandoned: number;
}

const ZERO_SUMMARY: ReconcileSweepSummary = {
  candidates: 0,
  crashed: 0,
  abandoned: 0,
  redispatched: 0,
  reattached: 0,
  skipped: 0,
  cutoverSessionsStopped: 0,
  staleClaimsCleared: 0,
  syncRecovered: 0,
  orphanSessionsReaped: 0,
  handlesLost: 0,
};

// ADR-121 (T15): a C2 admission claim (tasks.queue_claimed_at) is held only across
// the worktree-first launchRun window; the gate clears it on run-exists or failure.
// A claim older than this grace window means the claimer crashed between the CAS and
// launchRun — the sweep clears it so the task re-enters the funnel. Generous so it
// never races a slow-but-live launch (git clone + capability materialize).
const STALE_QUEUE_CLAIM_GRACE_MS = 10 * 60 * 1000;
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
    case "orphaned-child":
    case "orphaned-orchestrator":
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
  // null = a project-less run (the Studio local-package AI assistant). Such a
  // run has no parent repo, so there is no worktree to lose either.
  projectId: string | null;
  repoPath: string | null;
  // ADR-141: the run has a non-terminal `run_sync_attempts` row.
  activeSyncAttempt: boolean;
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

// ADR-166 D7/D8: a read-only handle check for ACTIVE assignments — a host
// that forgot a handle it adopted (state dir wiped) → WARN
// `workspace-handle-lost`; the next create self-heals by re-adopting. Never
// throws: a host outage or a refused lookup is logged once and the tick goes
// on.
async function checkWorkspaceHandles(args: {
  db: Db;
  hosts: ExecutionHosts;
}): Promise<number> {
  let lost = 0;

  try {
    const rows = (await args.db
      .select({
        id: executionAssignments.id,
        runId: executionAssignments.runId,
        executionWorkspaceId: executionAssignments.executionWorkspaceId,
      })
      .from(executionAssignments)
      .where(
        and(
          eq(executionAssignments.state, "active"),
          isNotNull(executionAssignments.executionWorkspaceId),
        ),
      )
      .limit(500)) as Array<{
      id: string;
      runId: string;
      executionWorkspaceId: string;
    }>;

    for (const row of rows) {
      const record = await args.hosts
        .local()
        .getWorkspace(row.executionWorkspaceId);

      if (record === null) {
        lost += 1;
        log.warn(
          {
            runId: row.runId,
            assignmentId: row.id,
            executionWorkspaceId: row.executionWorkspaceId,
          },
          "workspace-handle-lost",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "reconcile sweep: workspace handle check skipped",
    );
  }

  return lost;
}

async function stopGraphOnlyCutoverSessions(args: {
  db: Db;
  records: readonly SupervisorSessionRecord[];
  hosts: ExecutionHosts;
}): Promise<number> {
  let cutoverRunIds: Set<string>;

  try {
    cutoverRunIds = await listGraphOnlyCutoverRunIds(args.db);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[FIX:M43] reconcile could not load D2 cut-over runs — leaving supervisor sessions untouched",
    );

    return 0;
  }

  const candidates = args.records.filter(
    (record) => record.status === "live" && cutoverRunIds.has(record.runId),
  );
  let stopped = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (record) => {
    try {
      await (
        await args.hosts.forRun(record.runId, { teardown: true })
      ).deleteSession(record.sessionId);
      stopped += 1;
      log.warn(
        { runId: record.runId, sessionId: record.sessionId },
        "[FIX:M43] stopped stale supervisor session for D2 cut-over run",
      );
    } catch (err) {
      log.warn(
        {
          runId: record.runId,
          sessionId: record.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[FIX:M43] failed to stop stale supervisor session for D2 cut-over run",
      );
    }
  });

  return stopped;
}

// Codex review F2 (ADR-163): a live supervisor session under an `Abandoned`
// row is an orphan. The cascade flips a descendant's row BEFORE its session
// teardown runs and that teardown is best-effort, so a web crash or a
// supervisor hiccup between the two leaves an agent spending under a terminal
// row the Running-only candidate query never revisits. Allow-list exactly
// `Abandoned` — the one status the cascade writes.
async function reapAbandonedRunSessions(args: {
  db: Db;
  records: readonly SupervisorSessionRecord[];
  // ADR-166: the stop rides the run's own teardown-bound client (fenced +
  // ledgered), so the reaper hands over the whole record, not a bare id.
  stopSession: (record: SupervisorSessionRecord) => Promise<void>;
}): Promise<number> {
  const live = args.records.filter((record) => record.status === "live");
  const liveRunIds = [...new Set(live.map((record) => record.runId))];

  if (liveRunIds.length === 0) return 0;

  let abandonedRunIds: Set<string>;

  try {
    const rows: Array<{ id: string }> = await args.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.id, liveRunIds), eq(runs.status, "Abandoned")));

    abandonedRunIds = new Set(rows.map((row) => row.id));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[reconcile.reap] could not load Abandoned runs — leaving live sessions untouched",
    );

    return 0;
  }

  const candidates = live.filter((record) => abandonedRunIds.has(record.runId));
  let reaped = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (record) => {
    try {
      await args.stopSession(record);
      reaped += 1;
      log.warn(
        { runId: record.runId, sessionId: record.sessionId },
        "[reconcile.reap] stopped a live session under an Abandoned run",
      );
    } catch (err) {
      log.warn(
        {
          runId: record.runId,
          sessionId: record.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[reconcile.reap] failed to stop a live session under an Abandoned run — next tick",
      );
    }
  });

  return reaped;
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

    // Orphans in a non-Running status. Deliberately NOT folded into the status
    // list above: that would pull every paused, queued and reviewing run in the
    // project through the sweep each tick and let them starve real candidates
    // under PER_TICK_LIMIT. This loads only children whose coordinator is
    // gone — no row for the parent exists that is still alive — which is small
    // by construction. Same shape as the main query so the mapping below is
    // shared.
    const orphanRows: typeof rows = await db
      .select({
        runId: runs.id,
        runKind: runs.runKind,
        status: runs.status,
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
      .leftJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          eq(runs.projectId, project.id),
          inArray(runs.status, [
            "Pending",
            "NeedsInput",
            "NeedsInputIdle",
            "Review",
            "HumanWorking",
          ]),
          isNotNull(runs.parentRunId),
          // The SQL twin of `coordinatorGone`: derived from the same set so the
          // loader can never hide an orphan the classifier would recover.
          sql`NOT EXISTS (
            SELECT 1 FROM runs AS parent
            WHERE parent.id = ${runs.parentRunId}
              AND parent.status NOT IN (${sql.join(
                TERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
                sql`, `,
              )})
          )`,
        ),
      )
      .orderBy(asc(runs.startedAt))
      .limit(PER_TICK_LIMIT);

    rows.push(...orphanRows);

    // M42 (ADR-114): the resume handle now lives on `run_sessions`, not the run
    // row. Classification keys on the run's ACTIVE session's acp_session_id.
    const activeByRun = await loadActiveRunSessionsByRunId(
      db,
      rows.map((row: { runId: string }) => row.runId),
    );

    for (const row of rows) {
      // Exclude the takeover-return sweep's candidate set (disjoint sweeps).
      if (await isTakeoverReturnCandidate(db, row.runId)) continue;

      all.push({
        ...row,
        acpSessionId: activeByRun.get(row.runId)?.acpSessionId ?? null,
        projectId: project.id,
        repoPath: project.repoPath,
        activeSyncAttempt: false,
      });
    }
  }

  // Project-less runs (the Studio local-package AI assistant: run_kind='scratch',
  // project_id NULL, no workspace) are invisible to the per-project loop above —
  // no project row references them. Without this pass a dead assistant session
  // stays `Running` forever and leaks its concurrency slot: keep-alive/resume
  // sweeps only act on NeedsInput*, and reconcile never saw it. repo_path is null
  // (no parent repo) and there is no worktree to reconcile against.
  const projectlessRows: Array<{
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
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(
      and(
        isNull(runs.projectId),
        inArray(runs.status, ["Running", "WaitingOnChildren"]),
      ),
    )
    .orderBy(asc(runs.startedAt))
    .limit(PER_TICK_LIMIT);

  const activeProjectless = await loadActiveRunSessionsByRunId(
    db,
    projectlessRows.map((row: { runId: string }) => row.runId),
  );

  for (const row of projectlessRows) {
    if (await isTakeoverReturnCandidate(db, row.runId)) continue;

    all.push({
      ...row,
      acpSessionId: activeProjectless.get(row.runId)?.acpSessionId ?? null,
      projectId: null,
      repoPath: null,
      activeSyncAttempt: false,
    });
  }

  // ADR-141: mark candidates carrying a non-terminal `run_sync_attempts`
  // row so the classifier routes them to branch-sync recovery (never the flow
  // reattach/redispatch arms). One batched query over all candidate run ids.
  const syncActive = await loadActiveSyncAttemptRunIds(
    db,
    all.map((c) => c.runId),
  );

  for (const cand of all) {
    if (syncActive.has(cand.runId)) cand.activeSyncAttempt = true;
  }

  return all;
}

// ADR-141: the set of run ids with a non-terminal `run_sync_attempts`
// row (phase not in succeeded/failed/aborted) — an in-flight branch sync.
async function loadActiveSyncAttemptRunIds(
  db: Db,
  runIds: string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows: Array<{ runId: string }> = await db
    .selectDistinct({ runId: runSyncAttempts.runId })
    .from(runSyncAttempts)
    .where(
      and(
        inArray(runSyncAttempts.runId, runIds),
        notInArray(runSyncAttempts.phase, [...RUN_SYNC_TERMINAL_PHASES]),
      ),
    );

  return new Set(rows.map((r) => r.runId));
}

async function closeTerminalRunAssignments(db: Db): Promise<number> {
  const rows: Array<{ runId: string }> = await db
    .select({ runId: assignments.runId })
    .from(assignments)
    .innerJoin(runs, eq(runs.id, assignments.runId))
    .leftJoin(hitlRequests, eq(hitlRequests.id, assignments.hitlRequestId))
    .where(
      and(
        inArray(assignments.status, ["open", "claimed"]),
        inArray(runs.status, [...TERMINAL_ASSIGNMENT_CLEANUP_STATUSES]),
        // ADR-136: agent questions deliberately outlive their terminal source
        // run. Every other terminal-run assignment remains cleanup-eligible.
        or(
          ne(assignments.actionKind, "agent_question"),
          isNull(hitlRequests.id),
          ne(hitlRequests.activationState, "active"),
          isNotNull(hitlRequests.respondedAt),
          isNotNull(hitlRequests.supersededAt),
        ),
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

// ADR-121 (T15, F1): clear STALE C2 admission claims. The gate CAS-sets
// tasks.queue_claimed_at before the worktree-first launchRun and clears it on
// run-exists or launch failure; a claim still set past STALE_QUEUE_CLAIM_GRACE_MS
// means the claimer crashed between the CAS and run-insert. Clearing it returns the
// task to the funnel (the per-task live-flow-run guard prevents a double-mint if a
// run WAS actually created before the crash). Idempotent; runs every tick
// independent of the run-candidate set.
async function sweepStaleQueueClaims(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_QUEUE_CLAIM_GRACE_MS);
  const cleared: Array<{ id: string }> = await db
    .update(tasks)
    .set({ queueClaimedAt: null })
    .where(
      and(isNotNull(tasks.queueClaimedAt), lt(tasks.queueClaimedAt, cutoff)),
    )
    .returning({ id: tasks.id });

  if (cleared.length > 0) {
    log.warn(
      { count: cleared.length },
      "reconcile: cleared stale C2 admission claims (claimer crashed before launch)",
    );
  }

  return cleared.length;
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
  const hosts =
    opts.executionHosts ??
    createExecutionHosts({ db: db as unknown as ExecutionDb });
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

  try {
    const { reconcilePlanReviewDecisionHandoffs } = await import(
      "@/lib/services/hitl"
    );
    const resumed = await reconcilePlanReviewDecisionHandoffs({ db });

    if (resumed > 0) {
      log.info(
        { resumed },
        "reconcile: recovered plan-review decision handoffs",
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "reconcile: plan-review handoff recovery failed — continuing sweep",
    );
  }

  await closeTerminalRunAssignments(db);

  // ADR-121 (T15): clear stale C2 admission claims first — independent of the run
  // candidate set, so a no-candidates tick still recovers a crashed claimer.
  const staleClaimsCleared = await sweepStaleQueueClaims(db, now());

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
  let cutoverSessionsStopped = 0;
  let orphanSessionsReaped = 0;
  let handlesLost = 0;

  try {
    const records = await hosts.local().listSessions();

    const { recoverPendingAgentQuestions } = await import(
      "@/lib/services/agent-question"
    );

    await recoverPendingAgentQuestions({
      db,
      sessions: records,
      executionHosts: hosts,
    });

    try {
      const { recoverExpiredGateChatTurns } = await import(
        "@/lib/services/gate-chat"
      );
      const recovered = await recoverExpiredGateChatTurns({
        db,
        sessions: records,
        executionHosts: hosts,
      });

      if (recovered > 0) {
        log.warn(
          { recovered },
          "[FIX:gate-chat-recovery] reconcile restored expired gate-chat turns",
        );
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[FIX:gate-chat-recovery] reconcile could not recover expired turns; continuing sweep",
      );
    }

    cutoverSessionsStopped = await stopGraphOnlyCutoverSessions({
      db,
      records,
      hosts,
    });
    orphanSessionsReaped = await reapAbandonedRunSessions({
      db,
      records,
      stopSession: async (record) => {
        const client = await hosts.forRun(record.runId, { teardown: true });

        await client.deleteSession(record.sessionId);
      },
    });
    handlesLost = await checkWorkspaceHandles({ db, hosts });

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

    return {
      ...ZERO_SUMMARY,
      staleClaimsCleared,
      cutoverSessionsStopped,
      orphanSessionsReaped,
      handlesLost,
    };
  }

  const candidates = await loadCandidates(db);

  log.info({ candidates: candidates.length }, "reconcile sweep start");

  if (candidates.length === 0) {
    return {
      ...ZERO_SUMMARY,
      staleClaimsCleared,
      cutoverSessionsStopped,
      orphanSessionsReaped,
      handlesLost,
    };
  }

  // One listWorktrees call per distinct repoPath → Set of worktree paths.
  const worktreesByRepo = new Map<string, Set<string>>();

  for (const repoPath of new Set(candidates.map((c) => c.repoPath))) {
    // Project-less candidates carry a null repoPath (no parent repo) — there is
    // no worktree list to fetch for them.
    if (repoPath == null) continue;
    const infos = await worktreesFor(repoPath);

    worktreesByRepo.set(repoPath, new Set(infos.map((w) => w.path)));
  }

  const nowMs = now().getTime();

  let crashed = 0;
  let abandoned = 0;
  let redispatched = 0;
  let reattached = 0;
  let skipped = 0;
  let syncRecovered = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (cand) => {
    // M34: a null worktreePath is the no-workspace agent shape (none/
    // repo_read) — there is no worktree to lose. A project-less assistant run
    // (project_id NULL) likewise has no managed worktree by design, so its null
    // path must NOT read as `worktree-gone` (which would crash even a LIVE chat,
    // since that check precedes the live-session skip). Project-BOUND flow/scratch
    // runs always carry a workspace row; a null there still reads as gone.
    const worktreeExists =
      cand.worktreePath == null
        ? cand.runKind === "agent" || cand.projectId == null
        : cand.repoPath != null &&
          (worktreesByRepo.get(cand.repoPath)?.has(cand.worktreePath) ?? false);
    const live = cand.acpSessionId ? liveMap.get(cand.acpSessionId) : undefined;
    // acp_session_id unmatched but a live session exists for (runId, stepId) →
    // the agent's prompt is still in-flight (acp_session_id not yet persisted).
    const liveRunStep =
      !live && cand.currentStepId
        ? liveByRunStep.get(runStepKey(cand.runId, cand.currentStepId))
        : undefined;

    // A parked orchestrator (WaitingOnChildren) is classified by the §0
    // branch which reads no node-kind — skip the resolve.
    const { nodeKind: currentNodeKind } =
      cand.runKind === "scratch" ||
      cand.runKind === "agent" ||
      cand.status === "WaitingOnChildren"
        ? { nodeKind: null }
        : await resolveCurrentNodeContext(db, {
            flowRevisionId: cand.flowRevisionId,
            flowId: cand.flowId,
            currentStepId: cand.currentStepId,
          });

    // Agent runs (and project-less assistant scratch runs) have no node_attempts
    // ledger — anchor the grace window on the run's own startedAt so a
    // just-spawned session is never crashed before it registers.
    const attemptStartedAt =
      cand.runKind === "agent" || cand.projectId == null
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
        parentRunId: cand.parentRunId,
        parentStatus,
        hasPendingChildren: pendingChildren,
        activeSyncAttempt: cand.activeSyncAttempt,
        syncDriverActive: cand.activeSyncAttempt
          ? hasSyncDriver(cand.runId)
          : false,
      },
      cand.runId,
    );

    switch (action) {
      case "crash": {
        if (
          reason === "orchestrator-stuck" ||
          reason === "orphaned-orchestrator"
        ) {
          // M36 (ADR-095) T7.1: a stuck parked orchestrator. Cascade-abandon any
          // leftover children FIRST (children-first), THEN crash the coordinator
          // via the WaitingOnChildren-guarded transition. The cascade owns its
          // own per-pool promote; crashWaitingOnChildren is status-guarded so a
          // concurrent wake that already moved it to Running loses.
          const { cascadeAbandonRunTreeAndStopSessions } = await import(
            "@/lib/orchestrator/cascade"
          );
          const { crashWaitingOnChildren } = await import(
            "@/lib/runs/state-transitions"
          );

          // Stop the coordinator's OWN live session(s) FIRST (E5 discipline,
          // as the budget tree arm does). `orphaned-orchestrator` is the one
          // crash reason that can carry a live session — coordinator death is
          // checked before liveness — and the cascade tears down DESCENDANT
          // sessions only, while nothing reaps a live session under a Crashed
          // row. A supervisor 5xx means "cannot confirm it stopped": leave the
          // whole sub-tree for the next tick rather than cascade under a
          // coordinator that is still spending. A terminal (non-5xx) failure
          // means the session is already gone; proceed.
          const ownSessions = [...liveByRunStep.values()].filter(
            (record) => record.runId === cand.runId,
          );

          for (const record of ownSessions) {
            try {
              const client = await hosts.forRun(cand.runId, { teardown: true });

              await client.deleteSession(record.sessionId);
            } catch (err) {
              if (
                (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") ||
                isFencedError(err)
              ) {
                skipped += 1;
                log.warn(
                  {
                    runId: cand.runId,
                    reason,
                    sessionId: record.sessionId,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "reconcile: could not confirm the orchestrator's own session stopped — leaving its sub-tree for the next tick",
                );

                return;
              }
              log.warn(
                {
                  runId: cand.runId,
                  reason,
                  sessionId: record.sessionId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "reconcile: orchestrator session teardown failed terminally — proceeding",
              );
            }
          }

          await cascadeAbandonRunTreeAndStopSessions(
            cand.runId,
            cand.taskId,
            "orchestrator-stuck",
            {
              db,
              executionHosts: hosts,
              records: [...liveByRunStep.values()],
              logLabel: "[reconcile] orchestrator-stuck",
            },
          );
          const crashResult = await crashWaitingOnChildren(
            cand.runId,
            mapReasonToCrashReason(reason),
            { db },
          );

          if (!crashResult.ok) {
            // A concurrent wake won the CAS — the run is Running again; nothing
            // to crash. Count as skipped, not crashed.
            //
            // "Skipped" understates it: the cascade above ALREADY committed, so
            // this coordinator is now Running again with its whole sub-tree
            // Abandoned under it, and nothing un-abandons them. WARN, and say so
            // — an operator reading "skipped crash" would reasonably assume the
            // tick was a no-op. (The cascade's own `run.abandoned` events are
            // what wake a parked parent, but they reach the consumer on the
            // dispatcher clock, so this stays a narrow window rather than a
            // chain this code sets off itself.)
            skipped += 1;
            log.warn(
              { runId: cand.runId, reason },
              "reconcile: orchestrator wake won — crash skipped, but its sub-tree was already cascade-abandoned",
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

          // closeOpenHitl: an orphan paused on a permission request must not
          // keep counting toward "Needs you" under a Crashed row — the flow
          // crash transition closes its open hitl_requests in-tx for the same
          // reason. `finalized: false` means NO row was touched (a concurrent
          // transition won the CAS, or the finalize is deferred to a pending
          // human-ask activation): nothing was crashed, so nothing downstream
          // may pretend it was.
          const result = await finalizeAgentRun(cand.runId, "Crashed", {
            db,
            reason: `reconcile: ${reason}`,
            closeOpenHitl: true,
          });

          if (!result.finalized) {
            skipped += 1;
            log.warn(
              { runId: cand.runId, reason },
              "reconcile: agent crash not finalized — a concurrent transition or a pending human-ask activation owns the run; left alone",
            );

            return;
          }
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
          // Guard on the status this candidate was CLASSIFIED in — for every
          // pre-existing reason that is `Running`, unchanged; for a paused or
          // reviewing orphan it is the status the orphan arm saw. A run that
          // moved in between loses the CAS instead of being clobbered.
          const crashResult = await crashRunningRun(
            cand.runId,
            mapReasonToCrashReason(reason),
            { db, fromStatuses: [cand.status] },
          );

          if (!crashResult.ok) {
            // A concurrent transition moved the run after it was loaded — the
            // CAS is the only thing that says "this crash landed". Nothing
            // below (materialization cleanup, assignment close, slot promote,
            // the crashed count) may run against a row that is still alive.
            skipped += 1;
            log.warn(
              {
                runId: cand.runId,
                reason,
                from: cand.status,
                cause: crashResult.reason,
              },
              "reconcile: crash CAS lost — a concurrent transition moved the run; left alone",
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
      case "abandon": {
        // An orphaned Pending child. markAbandoned's guard admits Pending; it
        // emits run.abandoned, stamps the workspace for GC and releases context
        // mounts. No promote: a queued run never held a slot.
        const { markAbandoned } = await import("@/lib/runs/state-transitions");
        const result = await markAbandoned(cand.runId, { db });

        if (!result.ok) {
          skipped += 1;
          log.info(
            { runId: cand.runId, reason },
            "reconcile: orphan abandon lost the status guard — skipped",
          );

          return;
        }
        await systemCloseActiveAssignmentsForRun({
          db,
          runId: cand.runId,
          reason: `reconcile abandoned orphan: ${reason}`,
        });
        abandoned += 1;
        log.warn(
          { runId: cand.runId, parentRunId: cand.parentRunId, reason },
          "reconcile: abandoned a queued child of a dead coordinator",
        );

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
            "reconcile: refusing reattach for non-flow run — skipping",
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
      case "sync-recover": {
        // ADR-141: a Running run with an in-flight branch sync whose
        // in-proc driver is gone. `live` present ⇒ W2 (orphaned live resolver
        // session to tear down); absent ⇒ W2/W3 (idempotent re-verify → finalize
        // or abort). A concurrent in-process finalize that already terminalized
        // the attempt returns `noop`.
        const { recoverSyncAttemptOnReconcile } = await import(
          "@/lib/runs/sync-recovery"
        );
        const result = await recoverSyncAttemptOnReconcile({
          db,
          runId: cand.runId,
          liveSessionId: live?.sessionId ?? null,
          executionHosts: hosts,
          now,
        });

        if (result.outcome === "noop") {
          skipped += 1;
        } else {
          syncRecovered += 1;
        }
        log.info(
          {
            runId: cand.runId,
            reason,
            window: result.window,
            outcome: result.outcome,
          },
          "reconcile: sync recovery",
        );

        return;
      }
      case "skip": {
        skipped += 1;
        if (reason === "orphaned-human-working") {
          // Deliberately untouched — a person holds the worktree — but this
          // run now has no coordinator and only a human can settle it.
          log.warn(
            { runId: cand.runId, parentRunId: cand.parentRunId },
            "reconcile: HumanWorking child of a dead coordinator left in place — needs a person",
          );

          return;
        }
        log.debug({ runId: cand.runId, reason }, "reconcile: skipped");

        return;
      }
    }
  });

  const summary: ReconcileSweepSummary = {
    candidates: candidates.length,
    crashed,
    abandoned,
    redispatched,
    reattached,
    skipped,
    cutoverSessionsStopped,
    staleClaimsCleared,
    syncRecovered,
    orphanSessionsReaped,
    handlesLost,
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
