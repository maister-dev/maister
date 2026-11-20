import "server-only";

import type { AgentContinuationEpisode, Run } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { AgentPreparationOwner } from "./preparation-workspace";
import type { OperationalProbeContext } from "./operational-diagnostics";

import { randomUUID } from "node:crypto";

import { and, eq, ne, sql } from "drizzle-orm";
import pino from "pino";

import { assertHistoricalAgentAssignmentsQuiescent } from "./execution-quiescence";
import { advanceAgentPreparation } from "./preparation-ownership";
import { operationalFailureDiagnostic } from "./operational-diagnostics";
import {
  agentContinuationEpisodes as episodes,
  executionEvents,
  runs,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { recordAgentIncident } from "@/lib/runs/agent-incidents";

const log = pino({ name: "agent-continuation-episode" });
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS = [15, 30, 60, 120] as const;
type Claim = AgentContinuationEpisode & { claimToken: string };
type Identity = Pick<
  Claim,
  "runId" | "logicalKey" | "claimToken" | "assignmentId" | "assignmentEpoch"
>;

const newTeardownEvidence = sql`(
  ce.failure->>'blockedReason' = 'agent_execution_quiescence_unproven'
  AND EXISTS (
    SELECT 1 FROM ${executionEvents} AS evidence
    WHERE evidence.run_id = ce.run_id AND evidence.received_at > ce.updated_at
      AND evidence.source = 'host'
      AND evidence.ingest_disposition IN ('accepted', 'stale_epoch')
      AND (
        evidence.event_type IN ('session.exited', 'session.crashed') OR
        (evidence.event_type = 'session.command' AND evidence.payload->>'kind' = 'session.checkpoint')
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
  runId: typeof runs.id | typeof episodes.runId,
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
        evidenceAvailable: agentContinuationSettlementReady(episodes.runId),
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
                ...failure,
                reason: "agent_continuation_attempts_exhausted",
                reasons: [failure.reason, ...failure.reasons],
              }
            : failure,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimMatches(claim))
      .returning({ dueAt: episodes.dueAt });
    if (!changed) return;
    if (preparation) {
      preparation.assertHeld();
      await advanceAgentPreparation(tx, preparation.operation, {
        phase: "failed",
        failure: operationalFailureDiagnostic(error, context),
      });
    }
    log[definitive || exhausted ? "info" : "debug"](
      {
        runId: claim.runId,
        assignmentId: claim.assignmentId,
        attempts: claim.attempts,
        reason: failure.reason,
        dueAt: changed.dueAt,
      },
      "agent-continuation-failure-recorded",
    );
  });
}

export async function finishAgentContinuation(
  db: Db,
  claim: Claim,
): Promise<void> {
  await db.transaction(async (tx) => {
    const owner = await lockCurrentSessionAssignment(tx, claim);
    if (owner?.epoch !== claim.assignmentEpoch) return;
    await tx
      .update(episodes)
      .set({
        state: "closed",
        claimToken: null,
        claimExpiresAt: null,
        dueAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimMatches(claim));
  });
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
    await assertHistoricalAgentAssignmentsQuiescent(
      db,
      { id: claim.runId, executionAssignmentId: claim.assignmentId },
      executionHosts,
    );
    const { finalizeAgentRun } = await import("./finalization");
    await finalizeAgentRun(claim.runId, "Failed", {
      db,
      executionHosts,
      expectedAssignmentId: claim.assignmentId,
      reason: "agent_workspace_prepare_failed",
      causeReason: failure.reason,
      continuationFailure: {
        logicalKey: claim.logicalKey,
        claimToken: claim.claimToken,
        reasons: failure.reasons ?? [],
      },
    });
  } catch (error) {
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
      const [changed] = await tx
        .update(episodes)
        .set({
          state: exhausted ? "attention" : "settlement",
          settlementAttempts: attempts,
          failure: { ...failure, blockedReason },
          claimToken: null,
          claimExpiresAt: null,
          dueAt: exhausted
            ? null
            : sql`clock_timestamp() + ${RETRY_DELAYS[attempts - 1]} * interval '1 second'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(claimMatches(claim))
        .returning({ runId: episodes.runId });
      if (!changed || !exhausted) return;
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, claim.runId));
      const agentId = run?.sourceAgentId ?? run?.agentId;
      if (run?.projectId && agentId)
        await recordAgentIncident(tx, {
          projectId: run.projectId,
          agentId,
          runId: claim.runId,
          channel: "execution_failure",
          scopeKind: "infrastructure",
          scopeKey:
            run.agentActivitySnapshot?.comparisonScopes?.infrastructure ??
            claim.runId,
          sourceFactKey: `continuation:${claim.runId}:${claim.logicalKey}`,
          fingerprint: failure.reason,
          reasonCode: failure.reason,
          observedAt: new Date(),
        });
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
