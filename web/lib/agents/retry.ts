import "server-only";

import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { Db } from "@/lib/execution-host/db";
import type { AgentRetryClaim } from "@/lib/agents/retry-types";
import type { AgentRetryOptions } from "@/lib/agents/retry-preparation";

import { randomUUID } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  createAgentTaskRetryLaunchSource,
  previewAgentTaskRetry,
  taskRetryDecisionRequired,
} from "./task-retry-authority";

import { manualTriageHoldPredicate } from "@/lib/tasks/triage-flag-origin";
import {
  agentRetryIntents,
  runs,
  runSessions,
  tasks,
  taskLaunchIntents,
} from "@/lib/db/schema";
import {
  prepareAgentRetry,
  retryRecipeFor,
  retryDigest,
  retryRefusal,
  assertRetryAuthority,
} from "@/lib/agents/retry-preparation";
import { assertQualificationRetryAuthority } from "@/lib/agents/retry-guards";
import { retryRecipeStrategy } from "@/lib/agents/retry-types";
import { assertAgentRetryClaim } from "@/lib/agents/retry-ownership";
import { launchAgentRun } from "@/lib/agents/launch";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";
import { recordAgentIncident } from "@/lib/runs/agent-incidents";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { reconciliationRetryDelayMs } from "@/lib/gc/workspace-reconciliation-findings";
import { withAgentMaterializationLock } from "@/lib/agents/materialization-manifest";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";
import { preserveWorktree } from "@/lib/gc/preserve";
import { removeOwnedWorktree, listWorktrees } from "@/lib/worktree";
import { worktreesRoot } from "@/lib/instance-config";
import { taskLaunchBodySchema } from "@/lib/tasks/launch-schema";
import { assertInteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { acceptInteractiveAgentTaskRetry } from "@/lib/tasks/launch-intent";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";

const log = pino({
  name: "agent-retry",
  level: process.env.LOG_LEVEL ?? "info",
});
const requestSchema = z
  .object({
    runnerId: z.string().min(1).max(256),
    requestKey: z.string().uuid(),
    previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    strategy: z.enum(["pre_work_retry", "fresh_qualification"]).optional(),
    launchRequest: taskLaunchBodySchema.optional(),
  })
  .strict();

export type AgentRetryRequest = z.infer<typeof requestSchema>;
export type AgentRetryReceipt = {
  retryIntentId: string;
  sourceRunId: string;
  runId: string | null;
  intentState: "accepted" | "launched" | "refused";
  runStatus: typeof runs.$inferSelect.status | null;
  queueReason: string | null;
  refusalReason: string | null;
  cleanup: {
    state: "armed" | "released" | "exhausted";
    revision: number;
    reason: string | null;
  } | null;
};

export async function getAgentRetryOptions(
  db: Db,
  runId: string,
  userId: string,
  runnerId?: string,
): Promise<AgentRetryOptions> {
  const existingIntent = async (): Promise<string | null> => {
    const [existing] = await db
      .select({ id: agentRetryIntents.id })
      .from(agentRetryIntents)
      .where(
        and(
          eq(agentRetryIntents.sourceRunId, runId),
          sql`(${agentRetryIntents.state} IN ('accepted','launched') OR ${agentRetryIntents.allocation}->>'disposition' IN ('armed','exhausted'))`,
        ),
      )
      .limit(1);

    if (existing) return existing.id;
    const [canonical] = await db
      .select({ id: taskLaunchIntents.id })
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.sourceRunId, runId),
          eq(taskLaunchIntents.operation, "retry"),
          sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->>'kind'='agent_retry'`,
          sql`${taskLaunchIntents.state} IN ('queued','preparing','run_bound','settled')`,
        ),
      )
      .limit(1);

    return canonical?.id ?? null;
  };

  try {
    const prepared = await prepareAgentRetry(db, runId, userId);
    let options = prepared.options;

    if (
      prepared.source.taskId &&
      prepared.source.agentKind === "code_delivery" &&
      options.eligible
    ) {
      const selected = runnerId ?? options.selectedRunnerId;

      if (!selected) throw retryRefusal("retry_runner_unavailable");
      const preview = await previewAgentTaskRetry(db, prepared, selected);

      options = {
        ...options,
        selectedRunnerId: selected,
        launchRequest: preview.request,
        launchPreview: { title: preview.title, prompt: preview.prompt },
      };
    }
    const existing = await existingIntent();

    return existing
      ? {
          ...options,
          eligible: false,
          reason: "retry_successor_already_owned",
          existingIntentId: existing,
        }
      : options;
  } catch (error) {
    if (
      !isMaisterError(error) ||
      (!["PRECONDITION", "CONFIG"].includes(error.code) &&
        !(
          error.code === "CONFLICT" &&
          [
            "retry_task_changed",
            "retry_context_changed",
            "retry_runner_unavailable",
          ].includes(String(error.details?.reason))
        )) ||
      error.details?.reason === "retry_source_unavailable"
    )
      throw error;

    const [sourceSession] = await db
      .select({ runnerId: runSessions.runnerId })
      .from(runSessions)
      .where(
        and(
          eq(runSessions.runId, runId),
          eq(runSessions.sessionName, "default"),
        ),
      );
    const reason =
      typeof error.details?.reason === "string"
        ? error.details.reason
        : "retry_agent_unavailable";

    return {
      eligible: false,
      reason,
      expiresAt: new Date().toISOString(),
      previewFingerprint: retryDigest({
        runId,
        userId,
        reason,
      }),
      sourceRunnerId: sourceSession?.runnerId ?? null,
      selectedRunnerId: null,
      strategy: "pre_work_retry",
      qualificationOptIn: false,
      existingIntentId: await existingIntent(),
      runners: [],
      differences: [],
    };
  }
}

async function receiptFor(
  db: Db,
  intent: typeof agentRetryIntents.$inferSelect,
): Promise<AgentRetryReceipt> {
  const [run] = intent.createdRunId
    ? await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, intent.createdRunId))
    : [];

  return {
    retryIntentId: intent.id,
    sourceRunId: intent.sourceRunId,
    runId: intent.createdRunId,
    intentState: intent.state,
    runStatus: run?.status ?? null,
    queueReason: null,
    refusalReason: intent.refusalReason,
    cleanup: intent.allocation
      ? {
          state: intent.allocation.disposition,
          revision: intent.allocation.revision,
          reason: intent.allocation.errorCode,
        }
      : null,
  };
}

export async function getAgentRetryReceipt(
  db: Db,
  runId: string,
  intentId: string,
  userId: string,
): Promise<AgentRetryReceipt> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(
      and(
        eq(agentRetryIntents.id, intentId),
        eq(agentRetryIntents.sourceRunId, runId),
      ),
    );

  if (!intent) {
    const [canonical] = await db
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.id, intentId),
          eq(taskLaunchIntents.sourceRunId, runId),
          eq(taskLaunchIntents.operation, "retry"),
          sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->>'kind'='agent_retry'`,
        ),
      );

    if (!canonical) throw retryRefusal("retry_intent_unavailable");
    await assertRetryAuthority(db, canonical.projectId, userId);

    return taskRetryReceipt(db, taskLaunchReceipt(canonical), runId);
  }
  await assertRetryAuthority(db, intent.projectId, userId);

  return receiptFor(db, intent);
}

async function taskRetryReceipt(
  db: Db,
  receipt: TaskLaunchReceipt,
  runId: string,
): Promise<AgentRetryReceipt> {
  const [run] = receipt.runId
    ? await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, receipt.runId))
    : [];
  const refused = ["held", "failed", "cancelled"].includes(receipt.state);

  return {
    retryIntentId: receipt.intentId,
    sourceRunId: runId,
    runId: receipt.runId,
    intentState: refused ? "refused" : receipt.runId ? "launched" : "accepted",
    runStatus: run?.status ?? null,
    queueReason: receipt.queueReason ?? null,
    refusalReason: refused ? receipt.reason : null,
    cleanup: null,
  };
}

/** Acceptance is durable; the existing sweep, rather than the HTTP connection, owns eventual admission. */
export async function acceptAgentRetry(
  db: Db,
  runId: string,
  userId: string,
  body: unknown,
  principal?: InteractiveTaskLaunchPrincipal,
): Promise<AgentRetryReceipt> {
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Expected runnerId, requestKey UUID, previewFingerprint and optional retry strategy",
      { details: { reason: "retry_request_invalid" } },
    );
  const request = parsed.data;
  const actorIdentity = `user:${userId}`;
  const requestDigest = retryDigest({ runId, ...request });
  const [replayed] = await db
    .select()
    .from(agentRetryIntents)
    .where(
      and(
        eq(agentRetryIntents.actorIdentity, actorIdentity),
        eq(agentRetryIntents.requestKey, request.requestKey),
      ),
    );

  if (replayed) {
    await assertRetryAuthority(db, replayed.projectId, userId);
    if (replayed.requestDigest !== requestDigest)
      throw retryRefusal("retry_request_key_reused");

    return receiptFor(db, replayed);
  }
  const [source] = await db.select().from(runs).where(eq(runs.id, runId));

  if (source?.taskId && source.agentKind === "code_delivery") {
    if (
      !request.launchRequest ||
      request.launchRequest.relaunchOfRunId !== runId ||
      request.launchRequest.runnerId !== request.runnerId
    )
      throw taskRetryDecisionRequired();
    if (!principal)
      throw new MaisterError(
        "UNAUTHORIZED",
        "A fresh authenticated task retry decision is required",
        { details: { reason: "launch_manual_authority_required" } },
      );
    assertInteractiveTaskLaunchPrincipal(principal);
    if (principal.userId !== userId)
      throw retryRefusal("retry_authority_revoked");
    const authority = await createAgentTaskRetryLaunchSource(
      db,
      request.launchRequest,
    );
    const [existing] = await db
      .select({ id: taskLaunchIntents.id })
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.principalKind, "session_user"),
          eq(taskLaunchIntents.principalId, userId),
          eq(taskLaunchIntents.projectId, source.projectId!),
          eq(taskLaunchIntents.operation, "retry"),
          eq(taskLaunchIntents.requestKey, request.requestKey),
        ),
      );

    if (!existing) {
      const current = await prepareAgentRetry(db, runId, userId);

      if (!current.options.eligible)
        throw retryRefusal(current.options.reason!);
      if ((request.strategy ?? "pre_work_retry") !== current.options.strategy)
        throw retryRefusal("retry_strategy_changed");
      if (current.options.previewFingerprint !== request.previewFingerprint)
        throw retryRefusal("retry_preview_stale");
      const preview = await previewAgentTaskRetry(
        db,
        current,
        request.runnerId,
      );

      if (retryDigest(preview.request) !== retryDigest(request.launchRequest))
        throw retryRefusal("retry_preview_stale");
    }
    const accepted = await acceptInteractiveAgentTaskRetry(
      db,
      principal,
      authority,
      request.launchRequest,
      request.requestKey,
    );

    log.info(
      {
        sourceRunId: runId,
        intentId: accepted.intentId,
        runnerId: request.runnerId,
      },
      "[FIX:LA08] fresh task agent retry accepted",
    );

    return taskRetryReceipt(db, accepted, runId);
  }
  if (request.launchRequest) throw retryRefusal("retry_request_invalid");
  assertUpgradeMaintenanceAllows("run_admission");
  const prepared = await prepareAgentRetry(db, runId, userId);

  if (!prepared.options.eligible) throw retryRefusal(prepared.options.reason!);
  if ((request.strategy ?? "pre_work_retry") !== prepared.options.strategy)
    throw retryRefusal("retry_strategy_changed");
  if (prepared.options.previewFingerprint !== request.previewFingerprint)
    throw retryRefusal("retry_preview_stale");
  const recipe = await retryRecipeFor(db, prepared, request.runnerId);
  const id = randomUUID();
  const successorRunId = randomUUID();

  try {
    const intent = await db.transaction(async (tx) => {
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      await assertRetryAuthority(tx, prepared.source.projectId, userId);
      if (recipe.version === 2 && recipe.strategy === "fresh_qualification") {
        await assertQualificationRetryAuthority(
          tx,
          prepared.source.projectId,
          userId,
        );
        const [task] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, recipe.taskId!),
              eq(tasks.projectId, recipe.projectId),
            ),
          )
          .for("update");

        if (
          !task ||
          task.qualificationInputRevision !== recipe.taskRevision ||
          task.status !== "Backlog" ||
          task.qualificationMode === "execution_child"
        )
          throw retryRefusal("retry_task_changed");
        if (task.qualificationMode === "legacy") {
          if (!prepared.options.qualificationOptIn)
            throw retryRefusal("retry_preview_stale");
          await tx
            .update(tasks)
            .set({
              qualificationMode: "required",
              qualificationChildProof: null,
              triageStatus: sql`CASE WHEN ${manualTriageHoldPredicate()} THEN 'flagged' ELSE NULL END`,
              triageFlagOrigin: sql`CASE WHEN ${manualTriageHoldPredicate()} THEN ${tasks.triageFlagOrigin} ELSE NULL END`,
              launchMode: null,
              launchArmedAt: null,
              queueClaimedAt: null,
            })
            .where(eq(tasks.id, task.id));
          await emitDomainEvent({
            db: tx,
            kind: "task.qualification_changed",
            projectId: recipe.projectId,
            taskId: task.id,
            actor: { type: "user", id: userId },
            payload: {
              projectId: recipe.projectId,
              taskId: task.id,
              inputRevision: task.qualificationInputRevision,
              qualificationRevision: null,
              reason: "qualification_retry_opt_in",
            },
          });
        }
      }
      const inserted = await tx
        .insert(agentRetryIntents)
        .values({
          id,
          projectId: prepared.source.projectId,
          sourceAgentId: recipe.agentId,
          sourceRunId: runId,
          actorIdentity,
          actorUserId: userId,
          requestKey: request.requestKey,
          requestDigest,
          selectedRunnerId: request.runnerId,
          recipe,
          previewFingerprint: request.previewFingerprint,
          successorRunId,
          leaseOwner: id,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 300_000),
        })
        .returning();

      await assertAgentRetryClaim(tx, { intentId: id, owner: id, fence: 1 });
      const [accepted] = await tx
        .update(agentRetryIntents)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(agentRetryIntents.id, id))
        .returning();

      if (!inserted[0] || !accepted)
        throw retryRefusal("retry_acceptance_lost");
      await emitDomainEvent({
        db: tx,
        kind: "agent.activity_changed",
        projectId: accepted.projectId,
        payload: {
          projectId: accepted.projectId,
          agentId: accepted.sourceAgentId,
          revision: 1,
        },
      });

      return accepted;
    });

    log.info(
      { sourceRunId: runId, retryIntentId: id, runnerId: request.runnerId },
      "[FIX:agent-retry] agent retry accepted",
    );

    return receiptFor(db, intent);
  } catch (error) {
    if (pgErrorOf(error)?.code === "23505") {
      const [winner] = await db
        .select()
        .from(agentRetryIntents)
        .where(
          and(
            eq(agentRetryIntents.actorIdentity, actorIdentity),
            eq(agentRetryIntents.requestKey, request.requestKey),
          ),
        );

      if (winner?.requestDigest === requestDigest)
        return receiptFor(db, winner);
      throw retryRefusal("retry_successor_already_owned");
    }
    throw error;
  }
}

async function claimDueIntent(
  db: Db,
  now: Date,
): Promise<AgentRetryClaim | null> {
  return db.transaction(async (tx) => {
    const due = await tx.execute<{
      id: string;
    }>(sql`SELECT id FROM agent_retry_intents
      WHERE ((state='accepted' AND attempts<3) OR (state='refused' AND allocation->>'disposition'='armed'))
        AND due_at<=${now} AND (lease_expires_at IS NULL OR lease_expires_at<=${now})
      ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);

    if (!due.rows[0]) return null;
    const owner = randomUUID();
    const [claimed] = await tx
      .update(agentRetryIntents)
      .set({
        leaseOwner: owner,
        leaseFence: sql`${agentRetryIntents.leaseFence}+1`,
        leaseExpiresAt: new Date(now.getTime() + 300_000),
        updatedAt: now,
      })
      .where(eq(agentRetryIntents.id, due.rows[0].id))
      .returning();

    return { intentId: claimed.id, owner, fence: claimed.leaseFence };
  });
}

async function refuseClaim(
  db: Db,
  claim: AgentRetryClaim,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentRetryIntents)
      .where(eq(agentRetryIntents.id, claim.intentId));

    if (!row) return;
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, row.sourceRunId))
      .for("update");
    const [refused] = await tx
      .update(agentRetryIntents)
      .set({
        state: "refused",
        attempts: sql`least(3,${agentRetryIntents.attempts}+1)`,
        refusalReason: reason,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRetryIntents.id, claim.intentId),
          eq(agentRetryIntents.state, "accepted"),
          eq(agentRetryIntents.leaseOwner, claim.owner),
          eq(agentRetryIntents.leaseFence, claim.fence),
        ),
      )
      .returning();

    if (!refused) return;
    await recordAgentIncident(tx, {
      projectId: refused.projectId,
      agentId: refused.sourceAgentId,
      sourceFactKey: `retry:${refused.id}:refused`,
      scopeKey: "unknown",
      scopeKind: "unknown",
      fingerprint: retryDigest({ channel: "admission_refusal", reason }),
      reasonCode: reason,
      runId: null,
      channel: "admission_refusal",
      observedAt: new Date(),
    });
    await emitDomainEvent({
      db: tx,
      kind: "agent.activity_changed",
      projectId: refused.projectId,
      payload: {
        projectId: refused.projectId,
        agentId: refused.sourceAgentId,
        revision: refused.leaseFence,
      },
    });
  });
  log.warn(
    { retryIntentId: claim.intentId, fence: claim.fence, reason },
    "agent retry refused",
  );
}

async function deliverClaim(db: Db, claim: AgentRetryClaim): Promise<void> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (!intent) throw retryRefusal("retry_intent_unavailable");
  if (intent.state === "refused") {
    await disposeClaim(db, claim);

    return;
  }
  if (!intent.actorUserId) throw retryRefusal("retry_authority_revoked");
  const current = await prepareAgentRetry(
    db,
    intent.sourceRunId,
    intent.actorUserId,
    new Date(),
    intent.id,
  );

  if (current.source.taskId && current.source.agentKind === "code_delivery")
    throw taskRetryDecisionRequired();
  if (!current.options.eligible) throw retryRefusal(current.options.reason!);
  if (
    (intent.recipe.version === 1
      ? current.legacyContextDigest
      : current.contextDigest) !== intent.recipe.contextDigest
  )
    throw retryRefusal("retry_context_changed");
  await db.transaction((tx) => assertAgentRetryClaim(tx, claim));
  const outcome = await launchAgentRun({
    db,
    agentId: intent.sourceAgentId,
    projectId: intent.projectId,
    taskId: intent.recipe.taskId,
    launchOverrideRunnerId: intent.selectedRunnerId,
    runId: intent.successorRunId,
    trigger: {
      source:
        retryRecipeStrategy(intent.recipe) === "fresh_qualification"
          ? "manual"
          : intent.recipe.trigger.source,
      payload:
        retryRecipeStrategy(intent.recipe) === "fresh_qualification"
          ? null
          : intent.recipe.trigger.payload,
    },
    retryClaim: claim,
    scheduledRequestSnapshot: intent.recipe.scheduledRequestSnapshot ?? null,
  });

  if ("deduped" in outcome || "queued" in outcome)
    throw retryRefusal("retry_successor_mismatch");
  log.info(
    {
      retryIntentId: intent.id,
      sourceRunId: intent.sourceRunId,
      runId: outcome.runId,
      status: outcome.status,
      runnerId: intent.selectedRunnerId,
    },
    "agent retry successor recorded",
  );
}

/** No new timer: the system sweep runs bounded, leased admission and pre-run disposal before orphan GC. */
export async function runAgentRetryAdmissionSweep(
  db: Db,
  now: Date = new Date(),
): Promise<{ processed: number; errors: string[] }> {
  assertUpgradeMaintenanceAllows("run_admission");
  const errors: string[] = [];
  let processed = 0;

  for (; processed < 100; processed++) {
    const claim = await claimDueIntent(db, now);

    if (!claim) break;
    try {
      await deliverClaim(db, claim);
    } catch (error) {
      const [receipt] = await db
        .select()
        .from(agentRetryIntents)
        .where(eq(agentRetryIntents.id, claim.intentId));

      if (receipt?.state === "launched") continue;
      if (receipt?.state === "refused") {
        errors.push(`retry cleanup ${claim.intentId} failed`);
        await failDisposal(db, claim, error);
        continue;
      }
      const reason =
        isMaisterError(error) && typeof error.details?.reason === "string"
          ? error.details.reason
          : isMaisterError(error) && error.code === "UNAUTHORIZED"
            ? "retry_authority_revoked"
            : "retry_admission_failed";
      const attempts = (receipt?.attempts ?? 0) + 1;
      const transient =
        isMaisterError(error) &&
        (error.code === "EXECUTOR_UNAVAILABLE" ||
          error.details?.reason === "agent_materialization_lock_timeout") &&
        attempts < 3;

      if (transient)
        await db
          .update(agentRetryIntents)
          .set({
            attempts,
            dueAt: new Date(
              now.getTime() + reconciliationRetryDelayMs(attempts),
            ),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentRetryIntents.id, claim.intentId),
              eq(agentRetryIntents.leaseOwner, claim.owner),
              eq(agentRetryIntents.leaseFence, claim.fence),
            ),
          );
      else await refuseClaim(db, claim, reason);
      errors.push(`retry ${claim.intentId}: ${reason}`);
      log.warn(
        {
          retryIntentId: claim.intentId,
          fence: claim.fence,
          attempts,
          reason,
          transient,
        },
        "agent retry admission failed",
      );
    }
  }

  return { processed, errors };
}

async function disposeClaim(db: Db, claim: AgentRetryClaim): Promise<void> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (
    !intent?.allocation ||
    intent.state !== "refused" ||
    intent.createdRunId ||
    intent.leaseOwner !== claim.owner ||
    intent.leaseFence !== claim.fence
  )
    throw retryRefusal("retry_cleanup_owner_stale");
  for (const resource of intent.allocation.resources) {
    await mkdir(path.dirname(resource.path), { recursive: true });
    await withAgentMaterializationLock(
      path.dirname(resource.path),
      async () => {
        const [current] = await db
          .select()
          .from(agentRetryIntents)
          .where(eq(agentRetryIntents.id, intent.id));

        if (
          current?.leaseOwner !== claim.owner ||
          current.leaseFence !== claim.fence ||
          current.createdRunId ||
          current.state !== "refused"
        )
          throw retryRefusal("retry_cleanup_owner_stale");
        let present: boolean;

        try {
          await lstat(resource.path);
          present = true;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
          present = false;
        }
        const canonicalPath = path.join(
          await realpath(path.dirname(resource.path)),
          path.basename(resource.path),
        );

        if (
          !present &&
          (await listWorktrees(resource.repositoryPath)).some(
            (tree) => tree.path === canonicalPath,
          )
        )
          throw retryRefusal("retry_cleanup_registry_conflict");
        if (present) {
          const renewed = await db
            .update(agentRetryIntents)
            .set({ leaseExpiresAt: new Date(Date.now() + 900_000) })
            .where(
              and(
                eq(agentRetryIntents.id, intent.id),
                eq(agentRetryIntents.leaseOwner, claim.owner),
                eq(agentRetryIntents.leaseFence, claim.fence),
                sql`${agentRetryIntents.leaseExpiresAt}>clock_timestamp()`,
              ),
            )
            .returning({ id: agentRetryIntents.id });

          if (renewed.length !== 1)
            throw retryRefusal("retry_cleanup_owner_stale");
          const metadata = await readWorktreeProvenanceMetadata(resource.path);

          if (
            retryDigest(metadata) !== resource.provenanceDigest ||
            resource.kind !== "worktree" ||
            !resource.branch ||
            !resource.baseCommit
          )
            throw retryRefusal("retry_resource_conflict");
          const preserved = await preserveWorktree({
            worktreePath: resource.path,
            parentRepoPath: resource.repositoryPath,
            branch: resource.branch,
            baseRef: resource.baseCommit,
            runId: intent.successorRunId,
          });

          if (!preserved.ok)
            throw retryRefusal(
              preserved.failureReason ?? "retry_preservation_failed",
            );
          const preservedAllocation = {
            ...current.allocation!,
            resources: current.allocation!.resources.map((item) =>
              item.path === resource.path
                ? {
                    ...item,
                    preservation: {
                      branch: preserved.archivedBranch ?? null,
                      commit: preserved.archivedCommit ?? null,
                      outcome: preserved.preservationOutcome ?? "not_needed",
                    },
                  }
                : item,
            ),
            revision: current.allocation!.revision + 1,
          };

          const saved = await db
            .update(agentRetryIntents)
            .set({ allocation: preservedAllocation })
            .where(
              and(
                eq(agentRetryIntents.id, intent.id),
                eq(agentRetryIntents.leaseOwner, claim.owner),
                eq(agentRetryIntents.leaseFence, claim.fence),
                sql`${agentRetryIntents.leaseExpiresAt}>clock_timestamp()`,
              ),
            )
            .returning({ id: agentRetryIntents.id });

          if (saved.length !== 1)
            throw retryRefusal("retry_cleanup_owner_stale");
          await removeOwnedWorktree({
            allowedRoot: worktreesRoot(),
            projectRepoPath: resource.repositoryPath,
            worktreePath: resource.path,
          });
          if (
            (await listWorktrees(resource.repositoryPath)).some(
              (tree) => tree.path === canonicalPath,
            )
          )
            throw retryRefusal("retry_cleanup_not_removed");
          try {
            await lstat(resource.path);
            throw retryRefusal("retry_cleanup_not_removed");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            )
              throw error;
          }
        }
      },
    );
  }
  const [latest] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, intent.id));

  const released = await db
    .update(agentRetryIntents)
    .set({
      allocation: {
        ...latest.allocation!,
        disposition: "released",
        revision: latest.allocation!.revision + 1,
        dueAt: null,
        errorCode: null,
      },
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentRetryIntents.id, intent.id),
        eq(agentRetryIntents.leaseOwner, claim.owner),
        eq(agentRetryIntents.leaseFence, claim.fence),
      ),
    )
    .returning({ id: agentRetryIntents.id });

  if (released.length !== 1) throw retryRefusal("retry_cleanup_owner_stale");
}

async function failDisposal(
  db: Db,
  claim: AgentRetryClaim,
  error: unknown,
): Promise<void> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (
    !intent?.allocation ||
    intent.leaseOwner !== claim.owner ||
    intent.leaseFence !== claim.fence
  )
    return;
  const attempts = intent.allocation.attempts + 1;
  const exhausted = attempts >= 5;
  const reason =
    isMaisterError(error) && typeof error.details?.reason === "string"
      ? error.details.reason
      : "retry_cleanup_failed";
  const dueAt = new Date(Date.now() + reconciliationRetryDelayMs(attempts));

  await db.transaction(async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, intent.sourceRunId))
      .for("update");
    const saved = await tx
      .update(agentRetryIntents)
      .set({
        allocation: {
          ...intent.allocation!,
          attempts,
          disposition: exhausted ? "exhausted" : "armed",
          revision: intent.allocation!.revision + 1,
          dueAt: exhausted ? null : dueAt.toISOString(),
          errorCode: reason,
        },
        dueAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRetryIntents.id, intent.id),
          eq(agentRetryIntents.leaseOwner, claim.owner),
          eq(agentRetryIntents.leaseFence, claim.fence),
        ),
      )
      .returning({ id: agentRetryIntents.id });

    if (saved.length !== 1) return;
    if (exhausted)
      await recordAgentIncident(tx, {
        projectId: intent.projectId,
        agentId: intent.sourceAgentId,
        sourceFactKey: `retry:${intent.id}:cleanup:${intent.allocation!.revision + 1}`,
        scopeKey: "unknown",
        scopeKind: "unknown",
        fingerprint: retryDigest({ channel: "cleanup", reason }),
        reasonCode: reason,
        runId: null,
        channel: "cleanup",
        observedAt: new Date(),
      });
  });
}

const cleanupRequestSchema = z
  .object({
    expectedDispositionRevision: z.number().int().positive(),
    requestKey: z.string().uuid(),
  })
  .strict();

export type AgentRetryCleanupReceipt = {
  retryIntentId: string;
  dispositionRevision: number;
  state: "armed" | "released" | "exhausted";
};

export async function rearmAgentRetryCleanup(
  db: Db,
  sourceRunId: string,
  intentId: string,
  userId: string,
  body: unknown,
): Promise<AgentRetryCleanupReceipt> {
  const parsed = cleanupRequestSchema.safeParse(body);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Expected expectedDispositionRevision and requestKey UUID only",
      { details: { reason: "retry_cleanup_request_invalid" } },
    );

  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(agentRetryIntents)
      .where(
        and(
          eq(agentRetryIntents.id, intentId),
          eq(agentRetryIntents.sourceRunId, sourceRunId),
        ),
      )
      .for("update");

    if (!intent) throw retryRefusal("retry_intent_unavailable");
    await assertRetryAuthority(tx, intent.projectId, userId);
    const allocation = intent.allocation;

    if (intent.state !== "refused" || intent.createdRunId || !allocation)
      throw retryRefusal("retry_cleanup_not_available");
    if (allocation.rearmReceipt?.requestKey === parsed.data.requestKey) {
      if (
        allocation.rearmReceipt.expectedRevision !==
        parsed.data.expectedDispositionRevision
      )
        throw retryRefusal("retry_cleanup_key_reused");

      return {
        retryIntentId: intent.id,
        dispositionRevision: allocation.revision,
        state: allocation.disposition,
      };
    }
    if (
      allocation.revision !== parsed.data.expectedDispositionRevision ||
      allocation.disposition !== "exhausted" ||
      intent.leaseOwner
    )
      throw retryRefusal("retry_cleanup_revision_stale");
    const revision = allocation.revision + 1;

    await tx
      .update(agentRetryIntents)
      .set({
        allocation: {
          ...allocation,
          disposition: "armed",
          revision,
          attempts: 0,
          dueAt: new Date().toISOString(),
          errorCode: null,
          rearmReceipt: {
            requestKey: parsed.data.requestKey,
            expectedRevision: parsed.data.expectedDispositionRevision,
          },
        },
        dueAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRetryIntents.id, intent.id));
    await emitDomainEvent({
      db: tx,
      kind: "agent.activity_changed",
      projectId: intent.projectId,
      payload: {
        projectId: intent.projectId,
        agentId: intent.sourceAgentId,
        revision,
      },
    });

    return {
      retryIntentId: intent.id,
      dispositionRevision: revision,
      state: "armed",
    };
  });
}
