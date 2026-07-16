import "server-only";

import type { ObjectiveCheckProvider } from "@/lib/evaluations/method-schema";

import { and, asc, eq, isNull, lt } from "drizzle-orm";
import pino from "pino";

import { advanceExecution } from "./advance";
import { deriveEvidenceProtocolDigest, retryFailedExecution } from "./start";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { evaluateAndAdvancePanel } from "@/lib/evaluations/aggregation/worker";
import { captureEvidenceForExecution } from "@/lib/evaluations/evidence/capture";
import {
  defaultJudgeSpawn,
  launchJudgePanel,
} from "@/lib/evaluations/judges/launch";
import {
  runObjectiveChecks,
  type ParticipantFacts,
} from "@/lib/evaluations/objective/execute";
import { loadObjectiveFactSource } from "@/lib/evaluations/objective/source";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const {
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationParticipants,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-dispatch-tick",
  level: process.env.LOG_LEVEL ?? "info",
});

// The maximum queued executions a single tick drives — bounded so one tick never
// starves the shared scheduler lease; the singleton dispatcher re-claims the tail
// next tick (or the immediate in-process kick picks it up).
const MAX_QUEUED_PER_TICK = 20;
const MAX_JUDGING_PER_TICK = 50;

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

// Run every declared objective check over every live participant using the LIVE
// fact source (T3.2). No package command runs; missing facts stay honest absence.
export async function runChecksForExecution(
  executionId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  const [exec] = await d
    .select({
      studyId: evaluationExecutions.studyId,
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

  const participants: Array<{ id: string; runId: string | null }> = await d
    .select({
      id: evaluationParticipants.id,
      runId: evaluationParticipants.runId,
    })
    .from(evaluationParticipants)
    .where(
      and(
        eq(evaluationParticipants.studyId, exec.studyId),
        isNull(evaluationParticipants.removedAt),
      ),
    );

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

// Drive one queued execution through capturing → checking → judging (D4). Each
// step is an intent-first CAS transition; the loser of a queued→capturing race
// (another tick) leaves the row untouched, handled by the poison guard. On the
// final edge the judge panel is launched (idempotent adoption).
async function driveQueuedExecution(
  executionId: string,
  deps: EvaluationDispatchDeps,
  d: Db,
): Promise<void> {
  const [exec] = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!exec || exec.status !== "queued") return;

  const protocolDigest = deriveEvidenceProtocolDigest({});

  // queued → capturing (claims the row; a lost CAS = another tick has it).
  const captured = await advanceExecution(
    {
      studyId: exec.studyId,
      executionId,
      from: "queued",
      to: "capturing",
      expectedVersion: exec.version,
    },
    d,
  );

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
// CAS loss or a judging-phase transient is NOT terminalized (idempotent retry
// next tick). Returns whether a terminal failure was recorded.
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

async function reapTimedOutAttempts(now: Date, d: Db): Promise<number> {
  const judging: Array<{
    id: string;
    judgePolicySnapshot: { policy?: { timeoutMs?: number } } | null;
  }> = await d
    .select({
      id: evaluationExecutions.id,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "judging"));

  let count = 0;

  for (const exec of judging) {
    const timeoutMs = exec.judgePolicySnapshot?.policy?.timeoutMs;

    if (!timeoutMs || timeoutMs <= 0) continue;

    const cutoff = new Date(now.getTime() - timeoutMs);
    const reaped = await d
      .update(evaluationJudgeAttempts)
      .set({ status: "timed_out", terminalAt: now, reason: "timeout" })
      .where(
        and(
          eq(evaluationJudgeAttempts.executionId, exec.id),
          eq(evaluationJudgeAttempts.status, "running"),
          lt(evaluationJudgeAttempts.runningAt, cutoff),
        ),
      )
      .returning({ id: evaluationJudgeAttempts.id });

    count += reaped.length;
  }

  return count;
}

export interface EvaluationDispatchSummary {
  drivenToJudging: number;
  poisoned: number;
  panelsAdvanced: number;
  timedOutAttempts: number;
}

// The `evaluation_dispatch` scheduler arm (T3.3). One tick: reap timed-out judge
// attempts, drive queued executions through capture→check→judge, then re-check
// each judging panel for quorum/all-terminal (recovery for a submit that never
// fired the completion, and for reaped timeouts). Bounded + idempotent — safe to
// run on the 60s cron AND as an immediate in-process kick after start.
export async function runEvaluationDispatchTick(
  deps?: EvaluationDispatchDeps,
  db?: Db,
): Promise<EvaluationDispatchSummary> {
  const d = db ?? getDb();
  const dep = deps ?? defaultDispatchDeps(d);
  const now = dep.now();

  const summary: EvaluationDispatchSummary = {
    drivenToJudging: 0,
    poisoned: 0,
    panelsAdvanced: 0,
    timedOutAttempts: 0,
  };

  summary.timedOutAttempts = await reapTimedOutAttempts(now, d);

  const queued: Array<{ id: string }> = await d
    .select({ id: evaluationExecutions.id })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "queued"))
    .orderBy(asc(evaluationExecutions.requestedAt))
    .limit(MAX_QUEUED_PER_TICK);

  for (const q of queued) {
    try {
      await driveQueuedExecution(q.id, dep, d);
      summary.drivenToJudging += 1;
    } catch (err) {
      if (await poisonExecution(q.id, err, d)) summary.poisoned += 1;
      else
        log.debug(
          { executionId: q.id, err: messageOf(err) },
          "queued execution not driven this tick (race or transient)",
        );
    }
  }

  const judging: Array<{ id: string }> = await d
    .select({ id: evaluationExecutions.id })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.status, "judging"))
    .limit(MAX_JUDGING_PER_TICK);

  for (const j of judging) {
    try {
      await dep.launchPanel(j.id);
    } catch (err) {
      log.debug(
        { executionId: j.id, err: messageOf(err) },
        "judging panel launch retry deferred",
      );
    }
    try {
      if (await dep.advancePanel(j.id)) summary.panelsAdvanced += 1;
    } catch (err) {
      log.debug(
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
