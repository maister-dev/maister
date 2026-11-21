import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import { platformAllowsAutonomousCompletion } from "@/lib/auto-promotion/config";
import {
  completionGrantSchema,
  completionSettingsSchema,
} from "@/lib/auto-promotion/completion-policy";
import { recordAutonomousDecision } from "@/lib/auto-promotion/decisions";
import {
  executionAssignments,
  nodeAttempts,
  platformRuntimeSettings,
  projects,
  runPublications,
  runPublicationObservations,
  runSyncAttempts,
  runWaits,
  runs,
  workspaces,
  RUN_SYNC_TERMINAL_PHASES,
} from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { flowConflictSyncAttemptId } from "@/lib/flows/graph/finish-continuation";
import { autonomousCompletionFromSnapshot } from "@/lib/runs/execution-policy";
import { countLiveRuns, effectivePoolCap } from "@/lib/scheduler";

const log = pino({
  name: "flow-pr-conflict",
  level: process.env.LOG_LEVEL ?? "info",
});

async function readHandoff(db: Db, runId: string, waitId: string) {
  const [row] = await db
    .select({
      run: runs,
      wait: runWaits,
      publication: runPublications,
      attempt: nodeAttempts,
      workspace: workspaces,
    })
    .from(runs)
    .innerJoin(runWaits, eq(runWaits.runId, runs.id))
    .innerJoin(nodeAttempts, eq(nodeAttempts.id, runWaits.nodeAttemptId))
    .innerJoin(runPublications, eq(runPublications.id, runWaits.publicationId))
    .innerJoin(workspaces, eq(workspaces.id, runPublications.workspaceId))
    .where(and(eq(runs.id, runId), eq(runWaits.id, waitId)));
  const handoff = row?.attempt.finishContinuation?.prConflict;

  if (
    !row ||
    !handoff ||
    handoff.waitId !== row.wait.id ||
    handoff.publicationId !== row.publication.id ||
    row.attempt.finishContinuation?.targetNodeId !== row.run.currentStepId ||
    row.wait.conditionKind !== "pr" ||
    row.wait.resumeState !== "applied" ||
    row.wait.result?.source !== "provider" ||
    row.wait.result.outcome !== "conflict" ||
    row.run.flowRevision !== row.wait.flowRevision ||
    row.publication.sourceHead !== row.wait.bindingHeadSha ||
    row.workspace.removedAt ||
    row.workspace.prState !== "open" ||
    !row.publication.prNumber ||
    row.publication.prNumber !== row.workspace.prNumber ||
    row.publication.prUrl !== row.workspace.prUrl ||
    row.publication.remoteName !== row.workspace.publishedRemote ||
    row.publication.headRef !== `refs/heads/${row.workspace.publishedBranch}` ||
    row.publication.baseRef !== `refs/heads/${row.workspace.targetBranch}`
  )
    return null;

  const [original] = await db
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, handoff.assignmentId),
        eq(executionAssignments.runId, runId),
        eq(executionAssignments.state, "released"),
        eq(executionAssignments.releasedReason, "waiting_condition"),
      ),
    );

  const [latestFact] = await db
    .select({
      id: runPublicationObservations.id,
      baseRef: sql<
        string | null
      >`${runPublicationObservations.fact}->>'baseRef'`,
    })
    .from(runPublicationObservations)
    .where(
      and(
        eq(runPublicationObservations.publicationId, row.publication.id),
        eq(runPublicationObservations.kind, "pr"),
        sql`${runPublicationObservations.fact}->>'waitId' = ${row.wait.id}`,
      ),
    )
    .orderBy(
      desc(runPublicationObservations.observedAt),
      desc(runPublicationObservations.id),
    )
    .limit(1);

  return original &&
    latestFact?.baseRef === row.publication.baseRef &&
    latestFact.id === row.wait.result.sourceId
    ? { ...row, handoff, original }
    : null;
}

/** Called under the existing Run lock before the ADR-141 claim or a new graph admission. */
export async function authorizeFlowConflictHandoff(
  db: Db,
  runId: string,
  waitId: string,
  now: Date,
) {
  const owned = await readHandoff(db, runId, waitId);

  if (
    !owned?.run.projectId ||
    owned.run.status !== "Review" ||
    owned.run.runKind !== "flow" ||
    owned.run.parentRunId ||
    owned.run.workspaceMode === "shared" ||
    owned.run.promotionHold ||
    Date.parse(owned.handoff.expiresAt) <= now.getTime() ||
    (owned.run.flowDriverToken &&
      (!owned.run.flowDriverLeaseExpiresAt ||
        owned.run.flowDriverLeaseExpiresAt > now)) ||
    owned.run.deliveryPolicySnapshot?.strategy !== "pull_request" ||
    autonomousCompletionFromSnapshot(owned.run.executionPolicy) !==
      "evidence_gated"
  )
    return null;
  const grant = completionGrantSchema.safeParse(
    owned.run.autonomousCompletionGrant,
  );

  if (!grant.success || grant.data.flowRevisionId !== owned.run.flowRevisionId)
    return null;
  const [platform] = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .for("share");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, owned.run.projectId))
    .for("share");
  const current = completionSettingsSchema.safeParse(
    project?.autonomousCompletion,
  );

  if (
    !platformAllowsAutonomousCompletion(
      platform?.autonomousCompletionEnabled,
    ) ||
    !project ||
    project.archivedAt ||
    !current.success ||
    !current.data.enabled
  )
    return null;
  const [latest] = await db
    .select({ id: runPublications.id })
    .from(runPublications)
    .where(
      and(
        eq(runPublications.runId, runId),
        eq(runPublications.phase, "observed"),
      ),
    )
    .orderBy(desc(runPublications.generation))
    .limit(1);

  if (latest?.id !== owned.publication.id) return null;

  return {
    ...owned,
    projectId: project.id,
    projectRevision: project.autonomousCompletionRevision,
    platformRevision: platform.autonomousCompletionRevision,
  };
}

async function finishHandoff(
  db: Db,
  runId: string,
  waitId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ state: workspaces.lifecycleOperationState })
      .from(workspaces)
      .where(eq(workspaces.runId, runId))
      .for("update");
    const [run] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.status, "Review")))
      .for("update");

    if (!run || !workspace || workspace.state === "claiming") return false;
    const owned = await authorizeFlowConflictHandoff(tx, runId, waitId, now);
    const [sync] = await tx
      .select()
      .from(runSyncAttempts)
      .where(eq(runSyncAttempts.runId, runId))
      .orderBy(desc(runSyncAttempts.attempt))
      .limit(1);

    if (
      !owned ||
      !sync ||
      sync.id !== flowConflictSyncAttemptId(waitId) ||
      sync.phase !== "succeeded" ||
      sync.actorType !== "system" ||
      !sync.headShaAfter ||
      sync.headShaAfter === owned.publication.sourceHead
    )
      return false;
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(
        and(
          eq(executionAssignments.id, owned.run.executionAssignmentId ?? ""),
          eq(executionAssignments.state, "released"),
        ),
      );

    if (
      !assignment ||
      assignment.executionHostId !== owned.original.executionHostId ||
      (assignment.id !== owned.original.id &&
        assignment.releasedReason !== "sync_finished")
    )
      return false;
    const [queued] = await tx
      .update(runWaits)
      .set({
        resumeState: "queued",
        resumeAssignmentId: null,
        queuedAt: now,
        version: owned.wait.version + 1,
      })
      .where(and(eq(runWaits.id, waitId), eq(runWaits.resumeState, "applied")))
      .returning({ id: runWaits.id });

    if (!queued) return false;
    await tx
      .update(runs)
      .set({
        status: "Pending",
        reviewEnteredAt: null,
        endedAt: null,
        flowDriverToken: null,
        flowDriverLeaseExpiresAt: null,
      })
      .where(eq(runs.id, runId));

    return true;
  });
}

async function releaseToOperator(
  db: Db,
  runId: string,
  waitId: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ state: workspaces.lifecycleOperationState })
      .from(workspaces)
      .where(eq(workspaces.runId, runId))
      .for("update");

    if (!workspace || workspace.state === "claiming") return;
    const [released] = await tx
      .update(runs)
      .set({ currentStepId: null, endedAt: now })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, "Review"),
          sql`EXISTS (
          SELECT 1 FROM ${nodeAttempts}
          WHERE ${nodeAttempts.runId} = ${runs.id}
            AND ${nodeAttempts.finishContinuation}->'prConflict'->>'waitId' = ${waitId}
            AND ${nodeAttempts.finishContinuation}->>'targetNodeId' = ${runs.currentStepId}
        )`,
        ),
      )
      .returning({ projectId: runs.projectId });

    if (!released?.projectId) return;
    const [project] = await tx
      .select({ revision: projects.autonomousCompletionRevision })
      .from(projects)
      .where(eq(projects.id, released.projectId))
      .for("share");
    const [platform] = await tx
      .select({
        revision: platformRuntimeSettings.autonomousCompletionRevision,
      })
      .from(platformRuntimeSettings)
      .where(eq(platformRuntimeSettings.id, "singleton"))
      .for("share");

    await recordAutonomousDecision(tx, {
      runId,
      projectId: released.projectId,
      action: "finalize_pr",
      phase: "refused",
      reason: "pr_conflict_action_required",
      createdAt: now,
      projectRevision: project?.revision ?? 0,
      platformRevision: platform?.revision ?? 0,
      witness: { waitId },
    });
  });
}

/** Redrive only attempts selected by a verified conflict edge on the pinned Flow. */
export async function runFlowPrConflictSweep(input: {
  db: Db;
  now?: Date;
  executionHosts?: ExecutionHosts;
}): Promise<void> {
  const { db } = input;
  const now = input.now ?? new Date();
  const pending = await db
    .select({ runId: runs.id, waitId: runWaits.id })
    .from(runs)
    .innerJoin(runWaits, eq(runWaits.runId, runs.id))
    .innerJoin(nodeAttempts, eq(runWaits.nodeAttemptId, nodeAttempts.id))
    .where(
      and(
        eq(runs.status, "Review"),
        eq(runWaits.conditionKind, "pr"),
        eq(runWaits.resumeState, "applied"),
        or(
          isNull(runs.flowDriverToken),
          lte(runs.flowDriverLeaseExpiresAt, now),
        ),
        sql`${nodeAttempts.finishContinuation}->>'targetNodeId' = ${runs.currentStepId}`,
        sql`${nodeAttempts.finishContinuation}->'prConflict'->>'waitId' = ${runWaits.id}`,
      ),
    )
    .orderBy(runWaits.resolvedAt, runWaits.id)
    .limit(5);

  for (const { runId, waitId } of pending) {
    const [existing] = await db
      .select({ phase: runSyncAttempts.phase })
      .from(runSyncAttempts)
      .where(eq(runSyncAttempts.id, flowConflictSyncAttemptId(waitId)));

    if (existing) {
      if (
        existing.phase === "succeeded" &&
        (await finishHandoff(db, runId, waitId, now))
      )
        continue;
      if (RUN_SYNC_TERMINAL_PHASES.some((phase) => phase === existing.phase))
        await releaseToOperator(db, runId, waitId, now);
      continue;
    }
    const owned = await authorizeFlowConflictHandoff(db, runId, waitId, now);

    if (!owned) {
      await releaseToOperator(db, runId, waitId, now);
      continue;
    }
    if (
      (await countLiveRuns(db, "flow")) >=
      (await effectivePoolCap(db, "flow")).cap
    )
      continue;
    const { syncRunTarget } = await import("@/lib/runs/sync-target");

    try {
      await syncRunTarget({
        runId,
        db,
        executionHosts: input.executionHosts,
        flowConflictWaitId: waitId,
        strategy: "merge",
        agent: true,
        push: false,
        actor: { type: "system", id: null },
      });
    } catch (error) {
      if (!isMaisterError(error)) throw error;
      if (error.details?.reason === "flow_sync_already_claimed") continue;
      log.warn(
        { runId, waitId, code: error.code },
        "Flow PR conflict requires operator action",
      );
      await releaseToOperator(db, runId, waitId, now);
    }
  }
}

export async function recordFlowConflictClaim(
  db: Db,
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizeFlowConflictHandoff>>
  >,
  attemptId: string,
): Promise<void> {
  await recordAutonomousDecision(
    db as Parameters<typeof recordAutonomousDecision>[0],
    {
      runId: authorization.run.id,
      projectId: authorization.projectId,
      action: "finalize_pr",
      phase: "claimed",
      reason: "pr_conflict_sync",
      projectRevision: authorization.projectRevision,
      platformRevision: authorization.platformRevision,
      witness: {
        waitId: authorization.wait.id,
        publicationId: authorization.publication.id,
        syncAttemptId: attemptId,
      },
    },
  );
}
