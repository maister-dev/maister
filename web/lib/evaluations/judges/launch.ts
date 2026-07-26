import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationExecutionJudgePolicySnapshot } from "@/lib/evaluations/types";

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { issueJudgeAttemptToken } from "@/lib/agents/tokens";
import {
  generateRoundRobinPairs,
  PAIRWISE_TOURNAMENT_ALGORITHM,
} from "@/lib/evaluations/aggregation/tournament";
import { frozenExecutionParticipants } from "@/lib/evaluations/frozen-participants";
import { getDb } from "@/lib/db/client";
import {
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
  evaluationStudies,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "evaluations-judge-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

// The resolved panel binding for one logical judge role (D8). `agentId` is a
// package-qualified platform agent (`<packageName>:<stem>`); `count` is the
// independent attempt count for the role (method-declared).
interface ResolvedRole {
  role: string;
  agentId: string;
  runnerId: string | null;
  count: number;
}

// The spawn seam: launch one dedicated workspace:none agent Run for an attempt
// and mint its attempt-bound judge token. Injectable so the provisioning +
// duplicate-adoption logic is testable without a live agent; production wires the
// real agent launcher + MCP materialization (the supervisor delivers the judge
// token to the agent's evaluator-facade MCP config).
// CONTRACT: `runId` is the crash-safe launch intent recorded on the attempt row
// BEFORE this seam runs — the adapter MUST create the run with EXACTLY this id
// (launchAgentRun accepts a caller-supplied runId), so a crashed spawn is
// adopted or re-spawned convergently, never duplicated.
export interface JudgeSpawn {
  runId: string;
  tokenId: string;
  // The run's launch status. "Pending" = cap-queued by the agent scheduler —
  // the attempt keeps its pre-running state (no runningAt) until the run is
  // actually Running, so the timeout clock never starts before the session
  // does (D12). Absent = assume Running (legacy seams).
  runStatus?: "Running" | "Pending";
}

export type JudgeSpawnFn = (args: {
  agentId: string;
  projectId: string;
  runnerId: string | null;
  executionId: string;
  attemptId: string;
  role: string;
  ordinal: number;
  runId: string;
}) => Promise<JudgeSpawn>;

// Token-minting seam for the adoption path (the run already exists, only the
// attempt bookkeeping is missing). Injectable alongside `spawn` for tests.
export type JudgeTokenFn = (args: {
  agentId: string;
  projectId: string;
  runId: string;
}) => Promise<{ tokenId: string }>;

interface ExecutionForLaunch {
  id: string;
  studyId: string;
  status: string;
  methodRevisionId: string | null;
  judgePolicySnapshot: EvaluationExecutionJudgePolicySnapshot | null;
  projectId: string;
}

async function loadExecutionForLaunch(
  executionId: string,
  d: Db,
): Promise<ExecutionForLaunch> {
  const [row] = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      methodRevisionId: evaluationExecutions.methodRevisionId,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
      projectId: evaluationStudies.projectId,
    })
    .from(evaluationExecutions)
    .innerJoin(
      evaluationStudies,
      eq(evaluationExecutions.studyId, evaluationStudies.id),
    )
    .where(eq(evaluationExecutions.id, executionId));

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  return {
    ...row,
    // The snapshot column is an opaque jsonb Record; startEvaluationExecution is
    // the only writer and it stores exactly this roleBindings shape.
    judgePolicySnapshot:
      row.judgePolicySnapshot as ExecutionForLaunch["judgePolicySnapshot"],
  };
}

// Resolve the (role × ordinal) attempt matrix: each method judge role's declared
// count crossed with its panel-bound agent. A role with no panel binding is a
// CONFIG refusal (the panel is incomplete) — never a silently dropped role.
// `isPairwise` (ADR-147) drives the per-participant-pair fan-out at provisioning.
async function resolvePanel(
  exec: ExecutionForLaunch,
  d: Db,
): Promise<{ roles: ResolvedRole[]; isPairwise: boolean }> {
  if (!exec.methodRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `execution ${exec.id} has no method revision`,
    );
  }

  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, exec.methodRevisionId));

  const definition = (rev?.normalizedDefinition?.definition ?? {}) as {
    judges?: { roles?: Array<{ id: string; count: number }> };
    aggregation?: { algorithm?: string };
  };
  const roles = definition.judges?.roles ?? [];
  const bindings = new Map(
    (exec.judgePolicySnapshot?.roleBindings ?? []).map((b) => [b.role, b]),
  );

  const resolved = roles.map((r) => {
    const binding = bindings.get(r.id);

    if (!binding) {
      throw new MaisterError(
        "CONFIG",
        `judge role "${r.id}" has no panel agent binding`,
      );
    }

    return {
      role: r.id,
      agentId: binding.agentId,
      runnerId: binding.runnerId ?? null,
      count: r.count,
    };
  });

  return {
    roles: resolved,
    isPairwise:
      definition.aggregation?.algorithm === PAIRWISE_TOURNAMENT_ALGORITHM,
  };
}

// Provision the attempt matrix for an execution's panel (D12). Idempotent —
// each (execution, role, ordinal) is inserted with an ON CONFLICT DO NOTHING on
// the unique index (execution, role, ordinal, retry_ordinal=0), so a duplicate
// call adopts the existing rows rather than double-creating. Returns the current
// primary attempt rows (queued or already-launched).
export async function provisionJudgeAttempts(
  executionId: string,
  db?: Db,
): Promise<
  Array<{
    id: string;
    role: string;
    ordinal: number;
    agentId: string;
    runnerId: string | null;
    agentRunId: string | null;
    intendedRunId: string | null;
    status: string;
    matchA: string | null;
    matchB: string | null;
  }>
> {
  const d = db ?? getDb();
  const exec = await loadExecutionForLaunch(executionId, d);
  const { roles, isPairwise } = await resolvePanel(exec, d);

  // Insert one primary attempt for a (role, ordinal, match) cell. Idempotent via
  // the six-column NULLS-NOT-DISTINCT unique — the ON CONFLICT target MUST list
  // all six (match_a/match_b are NULL for non-pairwise), or it matches no
  // constraint and double-provisions on a re-drive.
  const insertAttempt = async (
    r: ResolvedRole,
    ordinal: number,
    matchA: string | null,
    matchB: string | null,
  ): Promise<void> => {
    await d
      .insert(evaluationJudgeAttempts)
      .values({
        executionId,
        role: r.role,
        ordinal,
        retryOrdinal: 0,
        agentId: r.agentId,
        status: "queued",
        matchA,
        matchB,
      })
      .onConflictDoNothing({
        target: [
          evaluationJudgeAttempts.executionId,
          evaluationJudgeAttempts.role,
          evaluationJudgeAttempts.ordinal,
          evaluationJudgeAttempts.retryOrdinal,
          evaluationJudgeAttempts.matchA,
          evaluationJudgeAttempts.matchB,
        ],
      });
  };

  if (isPairwise) {
    // ADR-147 D13: one attempt matrix PER unordered participant pair (round
    // robin) over the execution's FROZEN snapshot participant set (Codex-4) —
    // a Study membership change mid-flight never adds or removes pairs. A judge
    // attempt compares exactly two participants and submits a pick; the
    // tournament aggregation tallies the resolved matches over the SAME set.
    const frozen = await frozenExecutionParticipants(executionId, d);
    const participantIds = frozen.map((p) => p.id);

    for (const [a, b] of generateRoundRobinPairs(participantIds)) {
      for (const r of roles) {
        for (let ordinal = 1; ordinal <= r.count; ordinal++) {
          await insertAttempt(r, ordinal, a, b);
        }
      }
    }
  } else {
    for (const r of roles) {
      for (let ordinal = 1; ordinal <= r.count; ordinal++) {
        await insertAttempt(r, ordinal, null, null);
      }
    }
  }

  const rows = await d
    .select({
      id: evaluationJudgeAttempts.id,
      role: evaluationJudgeAttempts.role,
      ordinal: evaluationJudgeAttempts.ordinal,
      agentId: evaluationJudgeAttempts.agentId,
      agentRunId: evaluationJudgeAttempts.agentRunId,
      intendedRunId: evaluationJudgeAttempts.intendedRunId,
      status: evaluationJudgeAttempts.status,
      matchA: evaluationJudgeAttempts.matchA,
      matchB: evaluationJudgeAttempts.matchB,
    })
    .from(evaluationJudgeAttempts)
    .where(
      and(
        eq(evaluationJudgeAttempts.executionId, executionId),
        eq(evaluationJudgeAttempts.retryOrdinal, 0),
      ),
    );

  const byRole = new Map(roles.map((p) => [p.role, p]));

  return rows.map((r) => ({
    ...r,
    // agent_id is nullable only through agents.onDelete "set null"; attempts
    // are provisioned above with a concrete agent and consumed in the same
    // judging window, so a null here is unreachable in practice.
    agentId: r.agentId as string,
    runnerId: byRole.get(r.role)?.runnerId ?? null,
  }));
}

// Launch the judge panel: provision the attempt matrix, then spawn a dedicated
// agent Run per not-yet-launched attempt. Crash-safe adoption boundary: a fresh
// attempt first records a pre-generated `intendedRunId` via CAS (the launch
// intent), THEN spawns with exactly that id. A crash between intent and
// bookkeeping is recovered on the next drive — the run is adopted if the spawn
// created it, or re-spawned with the SAME id — never duplicated. Each spawn
// mints an attempt-bound judge token stored on the attempt row; the timeout clock
// anchors at Running, never at enqueue (D12). Returns the launched/adopted count.
export async function launchJudgePanel(
  executionId: string,
  deps: { spawn: JudgeSpawnFn; issueToken?: JudgeTokenFn },
  db?: Db,
): Promise<{ launched: number; adopted: number }> {
  const d = db ?? getDb();
  const exec = await loadExecutionForLaunch(executionId, d);

  if (exec.status !== "judging") {
    throw new MaisterError(
      "CONFLICT",
      `execution ${executionId} is ${exec.status}, not judging`,
    );
  }

  const issueToken: JudgeTokenFn =
    deps.issueToken ??
    (async (args) => {
      const token = await issueJudgeAttemptToken({ ...args, db });

      return { tokenId: token.tokenId };
    });

  const attempts = await provisionJudgeAttempts(executionId, d);

  // Effective parallelism = the RESOLVED policy snapshotted at start (D8/D12).
  // Absent (legacy execution) means unthrottled — the historical behavior.
  const snapshotMax = exec.judgePolicySnapshot?.policy?.maxParallelAttempts;
  const maxParallel =
    typeof snapshotMax === "number" && snapshotMax > 0
      ? snapshotMax
      : Number.POSITIVE_INFINITY;

  let launched = 0;
  let adopted = 0;
  // Attempts occupying a parallel slot: linked to a run and not yet terminal.
  // A cap-queued (Pending-run) attempt still counts — it is already submitted
  // to the agent scheduler.
  let liveCount = attempts.filter(
    (a) =>
      a.agentRunId !== null &&
      (a.status === "queued" || a.status === "running"),
  ).length;

  const finalize = async (attemptId: string, spawn: JudgeSpawn) => {
    const started = spawn.runStatus !== "Pending";

    await d
      .update(evaluationJudgeAttempts)
      .set({
        agentRunId: spawn.runId,
        tokenId: spawn.tokenId,
        // The attempt timeout clock anchors at session Running, never at
        // enqueue (D12). A cap-queued (Pending) run leaves the attempt queued
        // with runningAt null; a later pass promotes it once the run actually
        // runs — so a queued judge is never reaped as timed_out unstarted.
        ...(started
          ? { status: "running" as const, runningAt: new Date() }
          : {}),
      })
      .where(eq(evaluationJudgeAttempts.id, attemptId));
  };

  // Promote an already-linked attempt whose run has left Pending: stamp the
  // timeout anchor exactly when the session is actually Running. CAS on
  // status='queued' so a concurrent seal/reap is never clobbered.
  const promoteIfRunning = async (attempt: {
    id: string;
    agentRunId: string;
  }) => {
    const [run] = await d
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, attempt.agentRunId));

    if (run?.status !== "Running") return;

    await d
      .update(evaluationJudgeAttempts)
      .set({ status: "running", runningAt: new Date() })
      .where(
        and(
          eq(evaluationJudgeAttempts.id, attempt.id),
          eq(evaluationJudgeAttempts.status, "queued"),
        ),
      );
  };

  for (const attempt of attempts) {
    if (attempt.agentRunId) {
      adopted++;
      if (attempt.status === "queued") {
        await promoteIfRunning({
          id: attempt.id,
          agentRunId: attempt.agentRunId,
        });
      }
      continue;
    }

    if (attempt.intendedRunId) {
      // A prior claim crashed between the intent write and the bookkeeping.
      // Adopt the run if the crashed spawn created it; otherwise re-spawn with
      // the SAME id. A token minted by the crashed window stays orphaned on the
      // token ledger (same attempt + run scope — no privilege widening); the
      // attempt row records only the fresh one.
      const [existingRun] = await d
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(eq(runs.id, attempt.intendedRunId));

      if (existingRun) {
        const token = await issueToken({
          agentId: attempt.agentId,
          projectId: exec.projectId,
          runId: attempt.intendedRunId,
        });

        await finalize(attempt.id, {
          runId: attempt.intendedRunId,
          tokenId: token.tokenId,
          runStatus: existingRun.status === "Pending" ? "Pending" : "Running",
        });
        adopted++;
        liveCount++;
        log.warn(
          { executionId, attemptId: attempt.id, runId: attempt.intendedRunId },
          "adopted crashed judge launch intent",
        );
      } else {
        if (liveCount >= maxParallel) continue;

        const spawn = await deps.spawn({
          agentId: attempt.agentId,
          projectId: exec.projectId,
          runnerId: attempt.runnerId,
          executionId,
          attemptId: attempt.id,
          role: attempt.role,
          ordinal: attempt.ordinal,
          runId: attempt.intendedRunId,
        });

        await finalize(attempt.id, spawn);
        launched++;
        liveCount++;
        log.warn(
          { executionId, attemptId: attempt.id, runId: attempt.intendedRunId },
          "re-spawned crashed judge launch intent",
        );
      }
      continue;
    }

    // Throttle (D12): leave the remainder queued (no intent claimed) — the
    // next dispatch tick continues once live attempts terminalize and free
    // parallel slots.
    if (liveCount >= maxParallel) continue;

    // Fresh attempt: record the launch intent BEFORE any spawn side effect.
    // The CAS loses to a concurrent driver that already claimed this attempt.
    const intendedRunId = randomUUID();
    const claim = await d
      .update(evaluationJudgeAttempts)
      .set({ intendedRunId, enqueuedAt: new Date() })
      .where(
        and(
          eq(evaluationJudgeAttempts.id, attempt.id),
          eq(evaluationJudgeAttempts.status, "queued"),
          isNull(evaluationJudgeAttempts.intendedRunId),
        ),
      )
      .returning({ id: evaluationJudgeAttempts.id });

    if (!claim.length) {
      adopted++;
      continue;
    }

    const spawn = await deps.spawn({
      agentId: attempt.agentId,
      projectId: exec.projectId,
      runnerId: attempt.runnerId,
      executionId,
      attemptId: attempt.id,
      role: attempt.role,
      ordinal: attempt.ordinal,
      runId: intendedRunId,
    });

    await finalize(attempt.id, spawn);
    launched++;
    liveCount++;
  }

  log.info({ executionId, launched, adopted }, "judge panel launched");

  return { launched, adopted };
}

// The default production spawn seam: a dedicated workspace:none agent Run per
// attempt with an attempt-bound judge token. The token→evaluator-facade MCP wiring
// is delivered by the supervisor at materialization; this returns the runId +
// tokenId the attempt row records for server-derived attribution.
export function defaultJudgeSpawn(db?: Db): JudgeSpawnFn {
  return async (args) => {
    const { launchAgentRun } = await import("@/lib/agents/launch");
    const result = await launchAgentRun({
      agentId: args.agentId,
      projectId: args.projectId,
      launchOverrideRunnerId: args.runnerId,
      trigger: { source: "manual" },
      workspace: "none",
      // The pre-recorded launch intent — the run MUST get exactly this id so
      // a crashed window is adopted, never duplicated (seam contract above).
      runId: args.runId,
      db,
    });

    if ("deduped" in result) {
      throw new MaisterError(
        "CONFLICT",
        `judge attempt ${args.attemptId} spawn deduped unexpectedly`,
      );
    }

    const token = await issueJudgeAttemptToken({
      agentId: args.agentId,
      projectId: args.projectId,
      runId: result.runId,
      db,
    });

    return {
      runId: result.runId,
      tokenId: token.tokenId,
      runStatus: result.status,
    };
  };
}
