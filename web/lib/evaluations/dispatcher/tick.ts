import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { ObjectiveCheckProvider } from "@/lib/evaluations/method-schema";

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import pino from "pino";

import { advanceExecution, failWedgedJudgingExecution } from "./advance";
import { deriveEvidenceProtocolDigest, retryFailedExecution } from "./start";

import { revokeAgentRunToken } from "@/lib/agents/tokens";
import { getDb } from "@/lib/db/client";
import {
  evaluationAggregateResults,
  evaluationEvents,
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
  evaluationReviews,
  runs,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  evaluateAndAdvancePanel,
  runAggregationForExecution,
} from "@/lib/evaluations/aggregation/worker";
import { captureEvidenceForExecution } from "@/lib/evaluations/evidence/capture";
import { frozenExecutionParticipants } from "@/lib/evaluations/frozen-participants";
import {
  defaultJudgeSpawn,
  launchJudgePanel,
} from "@/lib/evaluations/judges/launch";
import {
  runObjectiveChecks,
  type ParticipantFacts,
} from "@/lib/evaluations/objective/execute";
import { loadObjectiveFactSource } from "@/lib/evaluations/objective/source";
import { openReview } from "@/lib/evaluations/reviews";
import {
  createExecutionHosts,
  type ExecutionHosts,
} from "@/lib/execution-host";

const log = pino({
  name: "evaluations-dispatch-tick",
  level: process.env.LOG_LEVEL ?? "info",
});

// The maximum queued executions a single tick drives — bounded so one tick never
// starves the shared scheduler lease; the singleton dispatcher re-claims the tail
// next tick (or the immediate in-process kick picks it up).
const MAX_QUEUED_PER_TICK = 20;
const MAX_JUDGING_PER_TICK = 50;
const MAX_RECOVERY_PER_TICK = 20;

// Crash-recovery age cutoff: a non-waiting state (capturing/checking/
// aggregating) older than this is treated as orphaned by a dead process, and a
// judging execution whose panel drive keeps FAILING past it is wedged. The
// freshest timestamp available on the row is `started_at` (stamped at the
// queued→capturing claim), falling back to `requested_at` for rows that never
// started.
const STALE_RECOVERY_MS = 10 * 60_000;

// coalesce(started_at, requested_at) — the freshest liveness anchor the
// executions row carries (there is no per-state updated_at column).
const freshestExecutionTimestamp = sql<Date>`coalesce(${evaluationExecutions.startedAt}, ${evaluationExecutions.requestedAt})`;

// The injectable step seam (mirrors ObjectiveFactSource / JudgeSpawnFn): tests
// inject deterministic capture/check/launch/advance so the FSM driver is verified
// without a live agent; production wires the real functions.
export interface EvaluationDispatchDeps {
  captureEvidence(args: {
    executionId: string;
    evidenceProtocolDigest: string;
  }): Promise<{ snapshotId: string }>;
  runChecks(executionId: string): Promise<void>;
  launchPanel(executionId: string): Promise<void>;
  advancePanel(executionId: string): Promise<boolean>;
  now(): Date;
  // ADR-164: the host the reaper tears live judge sessions down through.
  executionHosts?: ExecutionHosts;
}

export function defaultDispatchDeps(db?: Db): EvaluationDispatchDeps {
  const d = db ?? getDb();

  return {
    captureEvidence: (args) =>
      captureEvidenceForExecution(args, undefined, d).then((r) => ({
        snapshotId: r.snapshotId,
      })),
    runChecks: (id) => runChecksForExecution(id, d),
    launchPanel: (id) =>
      launchJudgePanel(id, { spawn: defaultJudgeSpawn(d) }, d).then(
        () => undefined,
      ),
    advancePanel: (id) => evaluateAndAdvancePanel(id, d),
    now: () => new Date(),
  };
}

// Run every declared objective check over the execution's frozen snapshot
// participant set using the LIVE fact source (T3.2). No package command runs;
// missing facts stay honest absence.
export async function runChecksForExecution(
  executionId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  const [exec] = await d
    .select({
      objectivePolicySnapshot: evaluationExecutions.objectivePolicySnapshot,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  const snapshot = (exec?.objectivePolicySnapshot ?? {}) as {
    checks?: Array<{
      id: string;
      provider: string;
      policy: string;
      criterionId?: string;
      hostCheckProfile?: string;
    }>;
    registeredHostProfiles?: string[];
  };
  const checks = (snapshot.checks ?? []).map((c) => ({
    id: c.id,
    provider: c.provider as ObjectiveCheckProvider,
    policy: c.policy,
    criterionId: c.criterionId,
    hostCheckProfile: c.hostCheckProfile,
  }));

  if (checks.length === 0) return;

  const registeredHostProfiles = new Set(snapshot.registeredHostProfiles ?? []);

  // Checks run over the execution's FROZEN snapshot participant set (Codex-4)
  // — the run ids come from the capture-time watermarks, so a Study membership
  // change between capture and checking is inert.
  const participants = await frozenExecutionParticipants(executionId, d);

  const facts: ParticipantFacts[] = [];

  for (const p of participants) {
    facts.push({
      participantId: p.id,
      facts: await loadObjectiveFactSource(
        { runId: p.runId, registeredHostProfiles },
        d,
      ),
    });
  }

  await runObjectiveChecks({ executionId, checks, participants: facts }, d);
}

// The evidence-protocol digest derives from the SNAPSHOTTED method revision's
// definition (its `evidence` block), never a constant — a legacy execution
// without a method revision honestly falls back to the default protocol.
async function loadMethodDefinitionForDigest(
  methodRevisionId: string | null,
  d: Db,
): Promise<Record<string, unknown>> {
  if (!methodRevisionId) return {};

  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, methodRevisionId));

  return (rev?.normalizedDefinition?.definition ?? {}) as Record<
    string,
    unknown
  >;
}

// Drive one queued execution through capturing → checking → judging (D4). Each
// step is an intent-first CAS transition. Returns whether THIS caller claimed
// and drove the row: a lost queued→capturing CAS (a concurrent tick/kick owns
// the row) returns false WITHOUT throwing, so the caller's poison guard only
// ever fires for failures that happened AFTER this caller's own successful
// claim — a claim loser must never terminalize the winner's live execution. On
// the final edge the judge panel is launched (idempotent adoption).
async function driveQueuedExecution(
  executionId: string,
  deps: EvaluationDispatchDeps,
  d: Db,
): Promise<boolean> {
  const [exec] = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
      methodRevisionId: evaluationExecutions.methodRevisionId,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!exec || exec.status !== "queued") return false;

  const methodDef = await loadMethodDefinitionForDigest(
    exec.methodRevisionId,
    d,
  );
  const protocolDigest = deriveEvidenceProtocolDigest(methodDef);

  // queued → capturing (claims the row; a lost CAS = another tick has it).
  let captured: { version: number };

  try {
    captured = await advanceExecution(
      {
        studyId: exec.studyId,
        executionId,
        from: "queued",
        to: "capturing",
        expectedVersion: exec.version,
      },
      d,
    );
  } catch (err) {
    if (
      isMaisterError(err) &&
      (err.code === "CONFLICT" || err.code === "PRECONDITION")
    ) {
      // Lost the claim (or the row vanished): the winner owns the row —
      // NEVER poisonable by this caller.
      log.debug(
        { executionId, code: err.code },
        "queued claim lost to a concurrent dispatcher; skipping",
      );

      return false;
    }
    throw err;
  }

  const cap = await deps.captureEvidence({
    executionId,
    evidenceProtocolDigest: protocolDigest,
  });

  const checking = await advanceExecution(
    {
      studyId: exec.studyId,
      executionId,
      from: "capturing",
      to: "checking",
      expectedVersion: captured.version,
      patch: { evidenceSnapshotId: cap.snapshotId },
    },
    d,
  );

  await deps.runChecks(executionId);

  await advanceExecution(
    {
      studyId: exec.studyId,
      executionId,
      from: "checking",
      to: "judging",
      expectedVersion: checking.version,
    },
    d,
  );

  await deps.launchPanel(executionId);

  return true;
}

// Count how many retries already occurred in this execution's lineage (bounded
// walk of the retry_of chain) so poison recovery respects the method's maxRetries.
async function retryDepth(executionId: string, d: Db): Promise<number> {
  let depth = 0;
  let cursor: string | null = executionId;

  for (let i = 0; i < 16 && cursor; i++) {
    const rows: Array<{ retryOf: string | null }> = await d
      .select({ retryOf: evaluationExecutions.retryOf })
      .from(evaluationExecutions)
      .where(eq(evaluationExecutions.id, cursor));
    const row = rows[0];

    if (!row?.retryOf) break;
    depth += 1;
    cursor = row.retryOf;
  }

  return depth;
}

// Poison a mid-flight execution whose capture/check step threw: terminalize to
// `failed` (only from capturing/checking — the FSM has those edges) and, if the
// method's maxRetries budget allows, spawn a retry_of successor. A queued-state
// CAS loss never reaches this path (driveQueuedExecution swallows it — the
// winner owns the row); a judging-phase transient is NOT terminalized
// (idempotent retry next tick). The internal status re-read + exact-version CAS
// keep a live owner safe: if the owner advances concurrently, this CAS loses as
// CONFLICT instead of terminalizing a live execution. Returns whether a
// terminal failure was recorded.
async function poisonExecution(
  executionId: string,
  err: unknown,
  d: Db,
): Promise<boolean> {
  const [exec] = await d
    .select({
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!exec) return false;
  if (exec.status !== "capturing" && exec.status !== "checking") {
    log.warn(
      { executionId, status: exec.status, err: messageOf(err) },
      "evaluation execution step failed but is not terminalizable; leaving for retry",
    );

    return false;
  }

  const reason = isMaisterError(err) ? err.code : "DISPATCH_STEP";

  await advanceExecution(
    {
      studyId: exec.studyId,
      executionId,
      from: exec.status,
      to: "failed",
      expectedVersion: exec.version,
      patch: { terminalReason: reason },
      payload: { reason },
    },
    d,
  );

  const maxRetries = Number(
    (exec.judgePolicySnapshot as { policy?: { maxRetries?: number } } | null)
      ?.policy?.maxRetries ?? 0,
  );

  if (maxRetries > 0 && (await retryDepth(executionId, d)) < maxRetries) {
    await retryFailedExecution(executionId, d);
  }

  log.warn(
    { executionId, reason, from: exec.status },
    "evaluation execution poisoned (terminal failed)",
  );

  return true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Stop a reaped judge attempt's agent run so it stops burning one of the
// MAISTER_MAX_CONCURRENT_AGENTS slots. Judge runs are workspace:none — a
// briefly-outliving agent process cannot mutate a worktree and its facade
// tokens are revoked, so supervisor teardown is best-effort (the tick must not
// wedge on an unreachable supervisor); the authoritative stop is
// finalizeAgentRun — the SAME terminal choke point the run-stop dispatcher
// (workbench-lifecycle stopAgentAfterAuth) uses for agent-kind runs — which
// flips the run terminal, bulk-revokes its `agent-run:<runId>` tokens, and
// frees the agent pool slot. Dynamic import mirrors defaultJudgeSpawn (judges/
// launch.ts) and keeps @/lib/agents/launch out of this module's static graph.
async function stopReapedJudgeRun(
  runId: string,
  d: Db,
  hosts: ExecutionHosts,
): Promise<void> {
  try {
    const live = (await hosts.local().listSessions()).filter(
      (session) => session.status === "live" && session.runId === runId,
    );

    if (live.length > 0) {
      // ADR-164: a fenced `session.delete` under the run's newest assignment.
      const client = await hosts.forRun(runId, { teardown: true });

      for (const session of live) {
        await client.deleteSession(session.sessionId);
        log.info(
          { runId, supervisorSessionId: session.sessionId },
          "reaped judge attempt — live supervisor session killed",
        );
      }
    }
  } catch (err) {
    log.warn(
      { runId, err: messageOf(err) },
      "reaped judge attempt — supervisor teardown unavailable; proceeding to finalize (workspace:none, tokens revoked)",
    );
  }

  try {
    const { finalizeAgentRun } = await import("@/lib/agents/launch");

    await finalizeAgentRun(runId, "Abandoned", {
      db: d,
      reason: "judge_attempt_timeout",
      closeAssignments: {
        kind: "system",
        reason: "judge attempt timed out",
      },
    });
  } catch (err) {
    log.warn(
      { runId, err: messageOf(err) },
      "reaped judge attempt — agent run finalize failed; retrying next tick",
    );
  }
}

async function reapTimedOutAttempts(
  now: Date,
  d: Db,
  hosts: ExecutionHosts,
): Promise<number> {
  const judging = await d
    .select({
      id: evaluationExecutions.id,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "judging"));

  let count = 0;

  for (const exec of judging) {
    const timeoutMs = (
      exec.judgePolicySnapshot as { policy?: { timeoutMs?: number } } | null
    )?.policy?.timeoutMs;

    if (!timeoutMs || timeoutMs <= 0) continue;

    const cutoff = new Date(now.getTime() - timeoutMs);
    // `running_at` may be stamped while the agent run is still cap-queued
    // Pending (launch bookkeeping fires at spawn, admission happens later), so
    // join the linked run: a Pending run's attempt has not actually started and
    // must NOT be reaped — its timeout clock is re-anchored instead.
    const candidates = await d
      .select({
        id: evaluationJudgeAttempts.id,
        tokenId: evaluationJudgeAttempts.tokenId,
        agentRunId: evaluationJudgeAttempts.agentRunId,
        runStatus: runs.status,
      })
      .from(evaluationJudgeAttempts)
      .leftJoin(runs, eq(evaluationJudgeAttempts.agentRunId, runs.id))
      .where(
        and(
          eq(evaluationJudgeAttempts.executionId, exec.id),
          eq(evaluationJudgeAttempts.status, "running"),
          lt(evaluationJudgeAttempts.runningAt, cutoff),
        ),
      );

    for (const candidate of candidates) {
      if (candidate.runStatus === "Pending") {
        // The session is not Running yet — the D12 anchor contract says the
        // clock must not tick while cap-queued. Re-stamp so the timeout counts
        // from (at worst) the last tick before admission.
        await d
          .update(evaluationJudgeAttempts)
          .set({ runningAt: now })
          .where(
            and(
              eq(evaluationJudgeAttempts.id, candidate.id),
              eq(evaluationJudgeAttempts.status, "running"),
            ),
          );
        continue;
      }

      const reaped = await d
        .update(evaluationJudgeAttempts)
        .set({ status: "timed_out", terminalAt: now, reason: "timeout" })
        .where(
          and(
            eq(evaluationJudgeAttempts.id, candidate.id),
            eq(evaluationJudgeAttempts.status, "running"),
          ),
        )
        .returning({ id: evaluationJudgeAttempts.id });

      if (reaped.length === 0) continue; // sealed concurrently

      count += 1;

      // Terminal hygiene, mirroring seal.ts: the attempt token dies with the
      // attempt, and the agent run is stopped so it frees its slot.
      if (candidate.tokenId) {
        await revokeAgentRunToken(candidate.tokenId, d);
      }
      if (candidate.agentRunId) {
        await stopReapedJudgeRun(candidate.agentRunId, d, hosts);
      }
    }
  }

  return count;
}

// Crash recovery for the states the queued/judging scans never select (a dead
// process strands them forever otherwise):
// - stale `capturing`/`checking` → poisoned through the standard poison path
//   (its internal status+version CAS keeps a still-live owner safe);
// - stale `aggregating` → runAggregationForExecution re-invoked (idempotent:
//   aggregate rows are append-only and the terminal edge is CAS-claimed);
// - `review_required` without an open review row (crash between the worker's
//   advance tx and its openReview tx) → the review row is created, gated on the
//   `review.required` transition event being older than the cutoff so a LIVE
//   worker mid-openReview is not raced (a missing event — impossible for a real
//   advance — recovers immediately).
async function recoverStaleExecutions(now: Date, d: Db): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RECOVERY_MS);
  let recovered = 0;

  const stalled: Array<{ id: string; status: string }> = await d
    .select({
      id: evaluationExecutions.id,
      status: evaluationExecutions.status,
    })
    .from(evaluationExecutions)
    .where(
      and(
        inArray(evaluationExecutions.status, ["capturing", "checking"]),
        lt(freshestExecutionTimestamp, cutoff),
      ),
    )
    .orderBy(asc(evaluationExecutions.requestedAt))
    .limit(MAX_RECOVERY_PER_TICK);

  for (const row of stalled) {
    try {
      const poisoned = await poisonExecution(
        row.id,
        new MaisterError(
          "CRASH",
          `execution stalled in ${row.status} past ${STALE_RECOVERY_MS}ms — dispatcher crash assumed`,
        ),
        d,
      );

      if (poisoned) recovered += 1;
    } catch (err) {
      log.warn(
        { executionId: row.id, err: messageOf(err) },
        "stale capture/check recovery lost its CAS; leaving for next tick",
      );
    }
  }

  const aggregating: Array<{ id: string }> = await d
    .select({ id: evaluationExecutions.id })
    .from(evaluationExecutions)
    .where(
      and(
        eq(evaluationExecutions.status, "aggregating"),
        lt(freshestExecutionTimestamp, cutoff),
      ),
    )
    .orderBy(asc(evaluationExecutions.requestedAt))
    .limit(MAX_RECOVERY_PER_TICK);

  for (const row of aggregating) {
    try {
      await runAggregationForExecution(row.id, d);
      recovered += 1;
      log.warn(
        { executionId: row.id },
        "stale aggregating execution re-aggregated",
      );
    } catch (err) {
      log.warn(
        { executionId: row.id, err: messageOf(err) },
        "stale aggregating recovery failed; retrying next tick",
      );
    }
  }

  const orphanedReviews: Array<{ id: string; studyId: string }> = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
    })
    .from(evaluationExecutions)
    .leftJoin(
      evaluationReviews,
      and(
        eq(evaluationReviews.executionId, evaluationExecutions.id),
        eq(evaluationReviews.status, "required"),
      ),
    )
    .where(
      and(
        eq(evaluationExecutions.status, "review_required"),
        isNull(evaluationReviews.id),
      ),
    )
    .limit(MAX_RECOVERY_PER_TICK);

  for (const row of orphanedReviews) {
    try {
      const [entered] = await d
        .select({ createdAt: evaluationEvents.createdAt })
        .from(evaluationEvents)
        .where(
          and(
            eq(evaluationEvents.executionId, row.id),
            eq(evaluationEvents.eventType, "review.required"),
          ),
        )
        .orderBy(desc(evaluationEvents.createdAt))
        .limit(1);

      if (entered && entered.createdAt.getTime() > cutoff.getTime()) continue;

      // Mirror the worker's kind/flags derivation from the latest aggregate's
      // dispersion signals (worker.ts openReview call).
      const [agg] = await d
        .select({ dispersion: evaluationAggregateResults.dispersion })
        .from(evaluationAggregateResults)
        .where(eq(evaluationAggregateResults.executionId, row.id))
        .orderBy(desc(evaluationAggregateResults.revision))
        .limit(1);
      const signals = (
        agg?.dispersion as {
          signals?: { objectiveContradiction?: boolean } & Record<
            string,
            unknown
          >;
        } | null
      )?.signals;

      await openReview(
        {
          studyId: row.studyId,
          executionId: row.id,
          kind: signals?.objectiveContradiction ? "escalation" : "disagreement",
          flags: signals,
        },
        d,
      );
      recovered += 1;
      log.warn(
        { executionId: row.id },
        "review_required execution had no open review; review row recreated",
      );
    } catch (err) {
      log.warn(
        { executionId: row.id, err: messageOf(err) },
        "orphaned review recovery failed; retrying next tick",
      );
    }
  }

  return recovered;
}

export interface EvaluationDispatchSummary {
  drivenToJudging: number;
  poisoned: number;
  panelsAdvanced: number;
  timedOutAttempts: number;
  recovered: number;
  wedgedFailed: number;
}

// The `evaluation_dispatch` scheduler arm (T3.3). One tick: reap timed-out judge
// attempts, recover crash-stranded mid-flight states, drive queued executions
// through capture→check→judge, then re-check each judging panel for
// quorum/all-terminal (recovery for a submit that never fired the completion,
// and for reaped timeouts). Bounded + idempotent — safe to run on the 60s cron
// AND as an immediate in-process kick after start.
export async function runEvaluationDispatchTick(
  deps?: EvaluationDispatchDeps,
  db?: Db,
): Promise<EvaluationDispatchSummary> {
  const d = db ?? getDb();
  const dep = deps ?? defaultDispatchDeps(d);
  const now = dep.now();
  const hosts =
    dep.executionHosts ??
    createExecutionHosts({ db: d as unknown as ExecutionDb });

  const summary: EvaluationDispatchSummary = {
    drivenToJudging: 0,
    poisoned: 0,
    panelsAdvanced: 0,
    timedOutAttempts: 0,
    recovered: 0,
    wedgedFailed: 0,
  };

  summary.timedOutAttempts = await reapTimedOutAttempts(now, d, hosts);
  summary.recovered = await recoverStaleExecutions(now, d);

  const queued: Array<{ id: string }> = await d
    .select({ id: evaluationExecutions.id })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "queued"))
    .orderBy(asc(evaluationExecutions.requestedAt))
    .limit(MAX_QUEUED_PER_TICK);

  for (const q of queued) {
    try {
      // Reaching the catch below implies THIS tick's claim succeeded (a lost
      // claim returns false without throwing), so poisoning cannot terminalize
      // a concurrent winner's live execution.
      if (await driveQueuedExecution(q.id, dep, d)) {
        summary.drivenToJudging += 1;
      }
    } catch (err) {
      try {
        if (await poisonExecution(q.id, err, d)) summary.poisoned += 1;
        else
          log.debug(
            { executionId: q.id, err: messageOf(err) },
            "queued execution not driven this tick (race or transient)",
          );
      } catch (poisonErr) {
        // A poison CAS loss must not abort the rest of the tick (liveness).
        log.warn(
          { executionId: q.id, err: messageOf(poisonErr) },
          "poison attempt lost its CAS; leaving for next tick",
        );
      }
    }
  }

  const judging: Array<{
    id: string;
    studyId: string;
    version: number;
    startedAt: Date | null;
    requestedAt: Date;
  }> = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      version: evaluationExecutions.version,
      startedAt: evaluationExecutions.startedAt,
      requestedAt: evaluationExecutions.requestedAt,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "judging"))
    // Deterministic FIFO — without an ORDER BY the tail beyond the limit
    // starves forever (same ordering as the queued scan).
    .orderBy(asc(evaluationExecutions.requestedAt))
    .limit(MAX_JUDGING_PER_TICK);

  for (const j of judging) {
    try {
      await dep.launchPanel(j.id);
    } catch (err) {
      const code = isMaisterError(err) ? err.code : null;

      if (code === "CONFLICT") {
        // Benign: the execution moved past judging under a concurrent driver.
        log.debug(
          { executionId: j.id, err: messageOf(err) },
          "judging panel launch skipped (execution moved on)",
        );
        continue;
      }

      const anchor = j.startedAt ?? j.requestedAt;

      if (anchor.getTime() < now.getTime() - STALE_RECOVERY_MS) {
        // A panel whose drive keeps FAILING (unresolvable binding, persistent
        // spawn failure) past the cutoff can never reach allTerminal — a
        // healthy panel never throws here (launch is idempotent adoption).
        try {
          await failWedgedJudgingExecution(
            {
              studyId: j.studyId,
              executionId: j.id,
              expectedVersion: j.version,
              reason: code ?? "DISPATCH_STEP",
            },
            d,
          );
          summary.wedgedFailed += 1;
        } catch (failErr) {
          log.warn(
            { executionId: j.id, err: messageOf(failErr) },
            "wedged judging terminalization lost its CAS; leaving for next tick",
          );
        }
        continue;
      }

      log.warn(
        { executionId: j.id, err: messageOf(err) },
        "judging panel launch failed; retrying next tick",
      );
    }
    try {
      if (await dep.advancePanel(j.id)) summary.panelsAdvanced += 1;
    } catch (err) {
      const level =
        isMaisterError(err) && err.code === "CONFLICT"
          ? ("debug" as const)
          : ("warn" as const);

      log[level](
        { executionId: j.id, err: messageOf(err) },
        "judging panel advance deferred",
      );
    }
  }

  log.info(summary, "evaluation dispatch tick completed");

  return summary;
}

// Immediate in-process kick (T3.3): fire a dispatch tick without awaiting so an
// interactive start does not wait for the 60s cron cadence. Errors are logged,
// never surfaced to the caller (the durable singleton tick is the backstop).
export function kickEvaluationDispatch(): void {
  void runEvaluationDispatchTick().catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "immediate evaluation dispatch kick failed (cron backstop remains)",
    );
  });
}
