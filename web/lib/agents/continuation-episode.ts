import "server-only";

import type { AgentContinuationEpisode, Run } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { AgentPreparationOwner } from "./preparation-workspace";
import type { OperationalProbeContext } from "./operational-diagnostics";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import pino from "pino";

import { assertHistoricalAgentAssignmentsQuiescent } from "./execution-quiescence";
import { advanceAgentPreparation } from "./preparation-ownership";
import { operationalFailureDiagnostic } from "./operational-diagnostics";
import {
  agentContinuationEpisodes as episodes,
  agentIncidentOccurrences,
  agentTurns,
  executionEvents,
  runs,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { isFencedError } from "@/lib/execution-host/deliverer";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import { recordAgentIncident } from "@/lib/runs/agent-incidents";
import { notifyContinuationAttentionChanged } from "@/lib/runs/peek-wake";

const log = pino({ name: "agent-continuation-episode" });
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS = [15, 30, 60, 120] as const;
type Claim = AgentContinuationEpisode & { claimToken: string };
type Identity = Pick<
  Claim,
  "runId" | "logicalKey" | "claimToken" | "assignmentId" | "assignmentEpoch"
>;

export const continuationObservation = sql<string>`md5(concat_ws(':',
  ${episodes.runId}, ${episodes.logicalKey}, ${episodes.assignmentId},
  ${episodes.assignmentEpoch}, extract(epoch from ${episodes.updatedAt})))`;

export async function rearmAgentContinuationSettlement(
  db: Db,
  input: {
    runId: string;
    projectId: string;
    userId: string;
    observation: string;
  },
): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ assignmentId: runs.executionAssignmentId })
      .from(runs)
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.projectId, input.projectId),
          eq(runs.runKind, "agent"),
          eq(runs.agentKind, "operational"),
          eq(runs.status, "Running"),
        ),
      )
      .for("update");
    if (
      !run?.assignmentId ||
      !(await lockCurrentSessionAssignment(tx, {
        runId: input.runId,
        assignmentId: run.assignmentId,
      }))
    )
      return undefined;

    const [updated] = await tx
      .update(episodes)
      .set({
        state: "settlement",
        dueAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(episodes.runId, input.runId),
          eq(episodes.state, "attention"),
          sql`${continuationObservation} = ${input.observation}`,
        ),
      )
      .returning({
        assignmentEpoch: episodes.assignmentEpoch,
        failure: episodes.failure,
      });
    if (updated) await notifyContinuationAttentionChanged(tx, input.runId);
    return updated;
  });
  if (!changed)
    throw new MaisterError("CONFLICT", "Continuation attention changed", {
      details: {
        reason: "agent_continuation_attention_stale",
        runId: input.runId,
      },
    });
  log.info(
    {
      runId: input.runId,
      actorId: input.userId,
      assignmentEpoch: changed.assignmentEpoch,
      reason: changed.failure?.reason,
      blockedReason: changed.failure?.blockedReason,
    },
    "agent-continuation-settlement-rearmed",
  );
  runEventWakeBus.wake(input.runId);
}

const newTeardownEvidence = sql`(
  ce.failure->>'blockedReason' = 'agent_execution_quiescence_unproven'
  AND EXISTS (
    SELECT 1 FROM ${executionEvents} AS evidence
    WHERE evidence.run_id = ce.run_id AND evidence.received_at > ce.updated_at
      AND evidence.source = 'host'
      AND evidence.execution_assignment_id = coalesce(
        ce.failure->>'blockedAssignmentId', evidence.execution_assignment_id)
      AND evidence.ingest_disposition IN ('accepted', 'stale_epoch')
      AND EXISTS (
        SELECT 1 FROM ${runSessionIncarnations} AS binding
        WHERE binding.run_id = evidence.run_id
          AND binding.execution_assignment_id = evidence.execution_assignment_id
          AND binding.assignment_epoch = evidence.assignment_epoch
          AND binding.execution_host_id = evidence.execution_host_id
          AND binding.host_session_id = evidence.host_session_id
      )
      AND (
        evidence.event_type IN ('session.exited', 'session.crashed') OR
        (evidence.event_type = 'session.command'
          AND evidence.payload->>'kind' = 'session.checkpoint'
          AND evidence.payload->>'phase' = 'completed'
          AND evidence.payload->>'status' = 'succeeded'
          AND evidence.payload->'result'->>'sessionId' = evidence.host_session_id)
      )
  )
)`;

export function agentContinuationBlocked(
  runId: typeof runs.id | typeof episodes.runId,
) {
  return sql`EXISTS (
    SELECT 1 FROM ${episodes} AS ce WHERE ce.run_id = ${runId}
      AND ((ce.state = 'attention' AND NOT coalesce(${newTeardownEvidence}, false)) OR
           (ce.state IN ('backoff', 'settlement') AND ce.due_at > clock_timestamp()) OR
           (ce.state IN ('claimed', 'settlement') AND ce.claim_expires_at > clock_timestamp()))
  )`;
}

export function agentContinuationSettlementReady(
  runId: typeof runs.id | string,
) {
  return sql`EXISTS (
    SELECT 1 FROM ${episodes} AS ce WHERE ce.run_id = ${runId}
      AND ((ce.state = 'settlement' AND ce.due_at <= clock_timestamp()
         AND (ce.claim_expires_at IS NULL OR ce.claim_expires_at <= clock_timestamp()))
        OR (ce.state = 'attention' AND ${newTeardownEvidence}))
  )`;
}

export async function recoverAgentContinuationSettlement(
  db: Db,
  hosts: ExecutionHosts,
  runId: string,
  expectedAssignmentId?: string,
): Promise<boolean> {
  const [ready] = await db
    .select({
      assignmentId: runs.executionAssignmentId,
      logicalKey: episodes.logicalKey,
    })
    .from(episodes)
    .innerJoin(runs, eq(runs.id, episodes.runId))
    .where(
      and(
        eq(runs.id, runId),
        sql`${episodes.state} IN ('settlement', 'attention')`,
      ),
    );
  if (!ready?.assignmentId) return false;
  if (
    expectedAssignmentId !== undefined &&
    ready.assignmentId !== expectedAssignmentId
  )
    throw staleSessionBinding(runId, expectedAssignmentId);
  const claim = await claimAgentContinuation(db, {
    runId,
    assignmentId: ready.assignmentId,
    logicalKey: ready.logicalKey,
  });
  if (claim?.state === "settlement")
    await settleAgentContinuation(db, hosts, claim);
  return true;
}

export async function claimAgentContinuation(
  db: Db,
  input: { runId: string; assignmentId: string; logicalKey: string },
): Promise<Claim | null> {
  return db.transaction(async (tx) => {
    const owner = await lockCurrentSessionAssignment(tx, input);
    if (!owner) return null;
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, input.runId));
    if (run?.status !== "Running") return null;

    const [open] = await tx
      .select({
        row: episodes,
        sameClaim: sql<boolean>`${episodes.claimExpiresAt} > clock_timestamp()`,
        premature: sql<boolean>`${episodes.dueAt} > clock_timestamp()`,
        evidenceAvailable: agentContinuationSettlementReady(input.runId),
      })
      .from(episodes)
      .where(and(eq(episodes.runId, input.runId), ne(episodes.state, "closed")))
      .for("update");
    if (
      open?.sameClaim ||
      open?.premature ||
      (open?.row.state === "attention" && !open.evidenceAvailable)
    )
      return null;

    const claimToken = randomUUID();
    const claimExpiresAt = sql`clock_timestamp() + interval '90 seconds'`;
    const current = open?.row;
    if (!current) {
      const [inserted] = await tx
        .insert(episodes)
        .values({
          ...input,
          assignmentEpoch: owner.epoch,
          state: "claimed",
          attempts: 1,
          claimToken,
          claimExpiresAt,
        })
        .onConflictDoNothing()
        .returning();
      return inserted ? { ...inserted, claimToken } : null;
    }
    const settling =
      current.state === "settlement" || current.state === "attention";
    const attemptsSpent = !settling && current.attempts >= MAX_ATTEMPTS;
    const enteringSettlement = settling || attemptsSpent;
    const [updated] = await tx
      .update(episodes)
      .set({
        assignmentId: owner.id,
        assignmentEpoch: owner.epoch,
        ...(current.assignmentId === owner.id ? {} : { preparationId: null }),
        state: enteringSettlement ? "settlement" : "claimed",
        dueAt: enteringSettlement ? sql`clock_timestamp()` : null,
        claimToken,
        claimExpiresAt,
        attempts: enteringSettlement ? current.attempts : current.attempts + 1,
        ...(attemptsSpent
          ? {
              firstFailureAt: sql`coalesce(${episodes.firstFailureAt}, clock_timestamp())`,
              failure: {
                ...current.failure,
                code: current.failure?.code ?? "SPAWN",
                reason: "agent_continuation_attempts_exhausted",
                reasons: current.failure
                  ? [current.failure.reason, ...(current.failure.reasons ?? [])]
                  : [],
              },
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(episodes.runId, current.runId),
          eq(episodes.logicalKey, current.logicalKey),
        ),
      )
      .returning();
    if (current.state === "attention")
      await notifyContinuationAttentionChanged(tx, current.runId);
    return { ...updated, claimToken };
  });
}

function claimMatches(claim: Identity) {
  return and(
    eq(episodes.runId, claim.runId),
    eq(episodes.logicalKey, claim.logicalKey),
    eq(episodes.assignmentId, claim.assignmentId),
    eq(episodes.assignmentEpoch, claim.assignmentEpoch),
    eq(episodes.claimToken, claim.claimToken),
  );
}

export function legacyOperationalEphemeralWitness(
  baseline: Run["operationalIntegrityBaseline"],
): boolean {
  return (
    baseline !== null &&
    ((baseline.version === 1 &&
      baseline.resourceKind === "ephemeral_checkout") ||
      (baseline.contextMounts?.some(
        ({ baseline: mount }) =>
          mount.version === 1 && mount.resourceKind === "ephemeral_checkout",
      ) ??
        false))
  );
}

export function requireOperationalContinuationWitness(
  baseline: Run["operationalIntegrityBaseline"],
): void {
  if (legacyOperationalEphemeralWitness(baseline))
    throw new MaisterError(
      "PRECONDITION",
      "Legacy ephemeral source integrity cannot be verified for continuation",
      {
        details: { reason: "operational_legacy_baseline_unverifiable" },
      },
    );
}

function classifyFailure(error: unknown) {
  const reason =
    isMaisterError(error) && typeof error.details?.reason === "string"
      ? error.details.reason
      : "agent_continuation_failed";
  const reasons =
    isMaisterError(error) && Array.isArray(error.details?.reasons)
      ? error.details.reasons.filter(
          (entry): entry is string =>
            typeof entry === "string" && /^[a-z_]{1,128}$/.test(entry),
        )
      : isMaisterError(error) &&
          typeof error.details?.causeCode === "string" &&
          /^[a-z_]{1,128}$/.test(error.details.causeCode)
        ? [error.details.causeCode]
        : [];
  const code = isMaisterError(error) ? error.code : "SPAWN";
  const definitive =
    reason === "prompt_owner_invariant" ||
    reason === "operational_legacy_baseline_unverifiable" ||
    reason === "operational_preparation_identity_changed" ||
    reason === "operational_context_baseline_missing" ||
    (reason === "operational_integrity_refused" &&
      reasons.some(
        (entry) =>
          ![
            "operational_integrity_probe_failed",
            "operational_integrity_file_race",
            "operational_context_integrity_refused",
          ].includes(entry),
      ));
  return {
    failure: {
      code,
      reason: /^[a-z_]{1,128}$/.test(reason)
        ? reason
        : "agent_continuation_failed",
      reasons,
    },
    definitive,
  };
}

export async function recordAgentContinuationFailure(
  db: Db,
  claim: Claim,
  error: unknown,
  preparation: AgentPreparationOwner | null,
  context: OperationalProbeContext,
): Promise<void> {
  const { failure, definitive } = classifyFailure(error);
  const exhausted = claim.attempts >= MAX_ATTEMPTS;
  const diagnostic = operationalFailureDiagnostic(error, context);
  const retained = {
    ...failure,
    ...(diagnostic.integrityLimit ? { infrastructureFailure: diagnostic } : {}),
  };
  await db.transaction(async (tx) => {
    const owner = await lockCurrentSessionAssignment(tx, claim);
    if (owner?.epoch !== claim.assignmentEpoch) return;
    const [changed] = await tx
      .update(episodes)
      .set({
        state: definitive || exhausted ? "settlement" : "backoff",
        claimToken: null,
        claimExpiresAt: null,
        preparationId: preparation?.operation.id ?? null,
        firstFailureAt: sql`coalesce(${episodes.firstFailureAt}, clock_timestamp())`,
        dueAt:
          definitive || exhausted
            ? sql`clock_timestamp()`
            : sql`clock_timestamp() + ${RETRY_DELAYS[claim.attempts - 1]} * interval '1 second'`,
        failure:
          exhausted && !definitive
            ? {
                ...retained,
                reason: "agent_continuation_attempts_exhausted",
                reasons: [failure.reason, ...failure.reasons],
              }
            : retained,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimMatches(claim))
      .returning({ dueAt: episodes.dueAt });
    if (!changed) return;
    if (preparation) {
      preparation.assertHeld();
      await advanceAgentPreparation(tx, preparation.operation, {
        phase: "failed",
        failure: diagnostic,
      });
    }
    log[definitive || exhausted ? "info" : "debug"](
      {
        runId: claim.runId,
        assignmentId: claim.assignmentId,
        attempts: claim.attempts,
        reason: failure.reason,
        integrityLimit: diagnostic.integrityLimit,
        dueAt: changed.dueAt,
      },
      "agent-continuation-failure-recorded",
    );
  });
}

/** Call inside prompt admission, after the Run and assignment are locked. */
export async function finishAgentContinuationOnPrompt(
  tx: Db,
  runId: string,
  assignmentId: string,
): Promise<void> {
  await assertAgentDispatchNotRefused(tx, runId);
  await tx
    .update(episodes)
    .set({
      state: "closed",
      claimToken: null,
      claimExpiresAt: null,
      dueAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(episodes.runId, runId),
        eq(episodes.assignmentId, assignmentId),
        inArray(episodes.state, ["eligible", "backoff", "claimed"]),
      ),
    );
}

export async function hasAgentContinuationSettlement(
  tx: Db,
  runId: string,
): Promise<boolean> {
  const [refusal] = await tx
    .select({ runId: episodes.runId })
    .from(episodes)
    .where(
      and(
        eq(episodes.runId, runId),
        inArray(episodes.state, ["settlement", "attention"]),
      ),
    );
  return refusal !== undefined;
}

async function assertAgentDispatchNotRefused(
  tx: Db,
  runId: string,
): Promise<void> {
  if (await hasAgentContinuationSettlement(tx, runId))
    throw new MaisterError(
      "PRECONDITION",
      "Agent dispatch is blocked by retained settlement",
      {
        details: { reason: "agent_continuation_settlement_pending", runId },
      },
    );
}

export async function assertAgentCreateNotRefused(
  tx: Db,
  runId: string,
  assignmentId: string,
): Promise<void> {
  if (!(await lockCurrentSessionAssignment(tx, { runId, assignmentId })))
    throw staleSessionBinding(runId, assignmentId);
  await assertAgentDispatchNotRefused(tx, runId);
}

export async function recordAgentDispatchIntegrityFailure(
  db: Db,
  input: {
    runId: string;
    assignmentId: string;
    turnId: string;
    hostSessionId: string;
  },
  error: unknown,
): Promise<boolean> {
  const { failure, definitive } = classifyFailure(error);
  if (!definitive || failure.reason !== "operational_integrity_refused")
    return false;

  return db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, input);
    if (!assignment) throw staleSessionBinding(input.runId, input.assignmentId);

    const [turn] = await tx
      .select({ id: agentTurns.id })
      .from(agentTurns)
      .innerJoin(runs, eq(runs.id, agentTurns.runId))
      .innerJoin(
        runSessionIncarnations,
        and(
          eq(runSessionIncarnations.runSessionId, agentTurns.runSessionId),
          eq(runSessionIncarnations.runId, input.runId),
          eq(runSessionIncarnations.executionAssignmentId, assignment.id),
          eq(runSessionIncarnations.assignmentEpoch, assignment.epoch),
          eq(
            runSessionIncarnations.executionHostId,
            assignment.executionHostId,
          ),
          eq(runSessionIncarnations.hostSessionId, input.hostSessionId),
        ),
      )
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.agentKind, "operational"),
          sql`${runs.projectId} IS NOT NULL`,
          eq(runs.status, "Running"),
          eq(agentTurns.id, input.turnId),
          eq(agentTurns.executionAssignmentId, assignment.id),
          eq(agentTurns.assignmentEpoch, assignment.epoch),
          eq(agentTurns.state, "claimed"),
          sql`${agentTurns.commandId} IS NULL`,
        ),
      );
    if (!turn) return false;
    const [existing] = await tx
      .select()
      .from(episodes)
      .where(and(eq(episodes.runId, input.runId), ne(episodes.state, "closed")))
      .for("update");
    if (existing?.state === "settlement" || existing?.state === "attention")
      return true;

    const diagnostic = operationalFailureDiagnostic(error, {
      runId: input.runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      stage: "dispatch",
    });
    const state = {
      state: "settlement" as const,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      preparationId: null,
      firstFailureAt: sql`coalesce(${episodes.firstFailureAt}, clock_timestamp())`,
      dueAt: sql`clock_timestamp()`,
      claimToken: null,
      claimExpiresAt: null,
      failure: {
        ...failure,
        ...(diagnostic.integrityLimit
          ? { infrastructureFailure: diagnostic }
          : {}),
        dispatch: {
          assignmentId: assignment.id,
          turnId: turn.id,
          hostSessionId: input.hostSessionId,
        },
      },
      updatedAt: sql`clock_timestamp()`,
    };
    if (existing) {
      await tx
        .update(episodes)
        .set(state)
        .where(
          and(
            eq(episodes.runId, input.runId),
            eq(episodes.logicalKey, existing.logicalKey),
          ),
        );
    } else {
      await tx.insert(episodes).values({
        ...state,
        runId: input.runId,
        logicalKey: `prompt-integrity:${turn.id}`,
        firstFailureAt: sql`clock_timestamp()`,
        attempts: 1,
      });
    }
    log.info(
      {
        runId: input.runId,
        turnId: turn.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        reason: failure.reason,
        integrityLimit: diagnostic.integrityLimit,
      },
      "agent-prompt-integrity-refusal-recorded",
    );

    return true;
  });
}

function continuationIncidentKey(runId: string, logicalKey: string): string {
  return `continuation:${runId}:${logicalKey}`;
}

export async function findAgentContinuationIncident(
  tx: Db,
  runId: string,
  logicalKey: string,
  reason: string,
): Promise<string | undefined> {
  const [incident] = await tx
    .select({ episodeId: agentIncidentOccurrences.episodeId })
    .from(agentIncidentOccurrences)
    .where(
      and(
        eq(
          agentIncidentOccurrences.sourceFactKey,
          continuationIncidentKey(runId, logicalKey),
        ),
        eq(agentIncidentOccurrences.fingerprint, reason),
      ),
    );
  return incident?.episodeId;
}

async function recordAgentContinuationIncident(
  tx: Db,
  run: Pick<
    Run,
    "id" | "projectId" | "sourceAgentId" | "agentId" | "agentActivitySnapshot"
  >,
  logicalKey: string,
  reason: string,
  observedAt: Date,
): Promise<void> {
  const agentId = run.sourceAgentId ?? run.agentId;
  if (!run.projectId || !agentId) return;
  await recordAgentIncident(tx, {
    projectId: run.projectId,
    agentId,
    runId: run.id,
    channel: "execution_failure",
    scopeKind: "infrastructure",
    scopeKey:
      run.agentActivitySnapshot?.comparisonScopes?.infrastructure ?? run.id,
    sourceFactKey: continuationIncidentKey(run.id, logicalKey),
    fingerprint: reason,
    reasonCode: reason,
    observedAt,
  });
}

async function assertSettlementOwner(tx: Db, claim: Claim): Promise<void> {
  const owner = await lockCurrentSessionAssignment(tx, claim);
  if (owner?.epoch !== claim.assignmentEpoch)
    throw staleSessionBinding(claim.runId, claim.assignmentId);

  const [settlement] = await tx
    .select({ runId: episodes.runId })
    .from(episodes)
    .where(
      and(
        claimMatches(claim),
        eq(episodes.state, "settlement"),
        sql`${episodes.claimExpiresAt} > clock_timestamp()`,
      ),
    );
  if (!settlement) throw staleSessionBinding(claim.runId, claim.assignmentId);
}

export async function settleAgentContinuation(
  db: Db,
  executionHosts: ExecutionHosts,
  claim: Claim,
): Promise<void> {
  const failure = claim.failure;
  if (!failure)
    throw new MaisterError(
      "CONFIG",
      "Continuation settlement requires its persisted failure",
    );
  try {
    await db.transaction((tx) => assertSettlementOwner(tx, claim));
    const dispatch =
      failure.dispatch?.assignmentId === claim.assignmentId
        ? failure.dispatch
        : undefined;
    if (dispatch) {
      const client = await executionHosts.forAssignment({
        id: claim.assignmentId,
      });
      const sessions = await client.sessionsForRun();
      if (
        sessions.some(
          (session) =>
            session.status === "live" &&
            session.sessionId === dispatch.hostSessionId,
        )
      )
        await client.deleteSession(dispatch.hostSessionId, {
          assertCommit: (tx) => assertSettlementOwner(tx, claim),
        });
    }
    await assertHistoricalAgentAssignmentsQuiescent(
      db,
      { id: claim.runId, executionAssignmentId: claim.assignmentId },
      executionHosts,
    );
    await db.transaction((tx) => assertSettlementOwner(tx, claim));
    const { prepareAgentRunFinalization } = await import("./finalization");
    const prepared = await prepareAgentRunFinalization(claim.runId, "Failed", {
      db,
      executionHosts,
      expectedAssignmentId: claim.assignmentId,
      reason: dispatch
        ? "agent_prompt_dispatch_failed"
        : "agent_workspace_prepare_failed",
      causeReason: failure.reason,
      infrastructureFailure: failure.infrastructureFailure,
      continuationFailure: {
        logicalKey: claim.logicalKey,
        claimToken: claim.claimToken,
        reasons: failure.reasons ?? [],
        dispatchTurnId: dispatch?.turnId,
      },
    });
    const result = await db.transaction(prepared.apply);
    await prepared.afterCommit(result);
  } catch (error) {
    if (isFencedError(error)) throw error;
    await db.transaction(async (tx) => {
      const owner = await lockCurrentSessionAssignment(tx, claim);
      if (owner?.epoch !== claim.assignmentEpoch) return;
      const attempts = Math.min(MAX_ATTEMPTS, claim.settlementAttempts + 1);
      const blockedReason =
        isMaisterError(error) &&
        typeof error.details?.reason === "string" &&
        /^[a-z_]{1,128}$/.test(error.details.reason)
          ? error.details.reason
          : "agent_continuation_settlement_failed";
      const exhausted = attempts >= MAX_ATTEMPTS;
      const blockedAssignmentId =
        isMaisterError(error) &&
        typeof error.details?.assignmentId === "string" &&
        error.details.assignmentId.length <= 256
          ? error.details.assignmentId
          : undefined;
      const [changed] = await tx
        .update(episodes)
        .set({
          state: exhausted ? "attention" : "settlement",
          settlementAttempts: attempts,
          failure: { ...failure, blockedReason, blockedAssignmentId },
          claimToken: null,
          claimExpiresAt: null,
          dueAt: exhausted
            ? null
            : sql`clock_timestamp() + ${RETRY_DELAYS[attempts - 1]} * interval '1 second'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            claimMatches(claim),
            sql`${episodes.claimExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ runId: episodes.runId });
      if (!changed || !exhausted) return;
      await notifyContinuationAttentionChanged(tx, claim.runId);
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, claim.runId));
      if (run)
        await recordAgentContinuationIncident(
          tx,
          run,
          claim.logicalKey,
          failure.reason,
          new Date(),
        );
      log.warn(
        {
          runId: claim.runId,
          assignmentId: claim.assignmentId,
          attempts,
          reason: failure.reason,
        },
        "agent-continuation-attention-required",
      );
    });
    throw error;
  }
}
