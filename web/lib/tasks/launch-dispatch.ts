import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchClaim } from "./launch-dispatch-claim";
import type { TaskLaunchReceipt } from "./launch-types";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

import {
  acceptedTaskAgentLaunchExecution,
  taskAgentPreparationWorkspace,
} from "./launch-agent-execution";
import {
  claimTaskLaunchIntent,
  lockedTaskLaunchClaim,
  renewTaskLaunchClaim,
} from "./launch-dispatch-claim";
import {
  acceptedTaskLaunchExecution,
  assertTaskLaunchBoundWorkspace,
} from "./launch-execution";
import { taskLaunchReceipt } from "./launch-receipt";
import { emitTaskLaunchChanged } from "./launch-events";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { launchRefusal } from "./launch-resolution";

import {
  launchAcceptedTaskAgentRun,
  startAgentSession,
} from "@/lib/agents/launch";
import { runs, taskLaunchIntents } from "@/lib/db/schema";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { withoutGitOwnership } from "@/lib/project-config-persistence/git-process";
import { launchAcceptedTaskRun } from "@/lib/services/runs";
import { takeSchedulerLock, tryStartRun } from "@/lib/scheduler";
import { runFlow } from "@/lib/flows/runner";
import { isMaisterError } from "@/lib/errors";
import { operationalCauseChain } from "@/lib/agents/operational-diagnostics";
import { pgErrorOf, queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "task-launch-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

async function currentReceipt(
  db: Db,
  intentId: string,
): Promise<TaskLaunchReceipt> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
  const receipt = taskLaunchReceipt(intent);

  if (!intent.runId) return receipt;
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, intent.runId));

  return { ...receipt, ...(run ? { runStatus: run.status } : {}) };
}

/** Fences a failed current owner; a stale callback never mutates its successor. */
async function settlePreparationFailure(
  db: Db,
  claim: TaskLaunchClaim,
  error: unknown,
): Promise<void> {
  const reason =
    isMaisterError(error) && typeof error.details?.reason === "string"
      ? error.details.reason
      : "launch_preparation_failed";
  const busy =
    (isMaisterError(error) && error.code === "EXECUTOR_UNAVAILABLE") ||
    [
      "operation_busy",
      "host_pressured",
      "network",
      "timeout",
      "http",
      "launch_runner_unavailable",
    ].includes(reason);
  const transient =
    !isMaisterError(error) ||
    error.code === "EXECUTOR_UNAVAILABLE" ||
    pgErrorOf(error) !== null;

  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await lockTaskLaunchReservation(tx, claim.taskId);
    const [current] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.id, claim.intentId),
          eq(taskLaunchIntents.state, "preparing"),
          eq(taskLaunchIntents.leaseToken, claim.leaseToken),
          sql`${taskLaunchIntents.leaseExpiresAt}>clock_timestamp()`,
        ),
      )
      .for("update");

    if (!current) return;
    const attempts = current.attempts + (busy || !transient ? 0 : 1);
    const retry = busy || (transient && attempts < 3);
    const [next] = await tx
      .update(taskLaunchIntents)
      .set({
        state: retry ? "queued" : "held",
        stateVersion: current.stateVersion + 1,
        reason,
        attempts,
        dueAt: retry
          ? sql`clock_timestamp()+make_interval(secs=>${busy ? 1 : 2 ** Math.max(0, attempts - 1)})`
          : null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
        cleanupState: retry ? null : "pending",
      })
      .where(eq(taskLaunchIntents.id, current.id))
      .returning();

    await emitTaskLaunchChanged(tx, next, { type: "system", id: null });
    log.warn(
      {
        intentId: current.id,
        runId: claim.identity.runId,
        preparationPhase: current.preparationPhase,
        state: next.state,
        attempts,
        reason,
        causeChain: operationalCauseChain(error),
        ...queryErrorDiagnostics(error),
      },
      "[FIX:launch-dispatch] current preparation stopped",
    );
  });
}

async function holdUndispatchedBoundRun(
  db: Db,
  intentId: string,
  error: unknown,
): Promise<void> {
  const [initial] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!initial || initial.dispatchCommittedAt || initial.state !== "run_bound")
    return;
  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await lockTaskLaunchReservation(tx, initial.taskId);
    await lockTaskLaunchBoundRun(tx, intentId);
    const [current] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");

    if (
      !current ||
      current.dispatchCommittedAt ||
      current.state !== "run_bound"
    )
      return;
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_dispatch_unavailable";
    const [held] = await tx
      .update(taskLaunchIntents)
      .set({
        state: "held",
        stateVersion: current.stateVersion + 1,
        reason,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(taskLaunchIntents.id, current.id))
      .returning();

    await emitTaskLaunchChanged(tx, held, { type: "system", id: null });
  });
}

async function deferBoundTaskLaunch(
  db: Db,
  intentId: string,
  error: unknown,
): Promise<void> {
  const [initial] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!initial) return;
  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await lockTaskLaunchReservation(tx, initial.taskId);
    await lockTaskLaunchBoundRun(tx, intentId);
    const [current] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");

    if (
      !current ||
      current.state !== "run_bound" ||
      current.dispatchCommittedAt
    )
      return;
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_dispatch_unavailable";
    const [deferred] = await tx
      .update(taskLaunchIntents)
      .set({
        reason,
        dueAt: sql`clock_timestamp()+interval '1 second'`,
        stateVersion:
          current.reason === reason
            ? current.stateVersion
            : current.stateVersion + 1,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(taskLaunchIntents.id, intentId))
      .returning();

    if (deferred.stateVersion !== current.stateVersion)
      await emitTaskLaunchChanged(tx, deferred, { type: "system", id: null });
  });
}

async function startBoundTaskLaunch(db: Db, intentId: string): Promise<void> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (
    !intent?.runId ||
    intent.dispatchCommittedAt ||
    intent.state !== "run_bound" ||
    !intent.preparationIdentity
  )
    return;
  if (intent.settingsSnapshot.kind === "agent") {
    const [bound] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, intent.runId));

    // A Running agent's preparation/continuation already owns its effects.
    if (bound?.status !== "Pending") return;
  }
  const fence = intent.preparationIdentity.parentRepoPath
    ? await acquireRepositoryMutationFence(
        intent.preparationIdentity.parentRepoPath,
      )
    : null;
  let started = false;

  try {
    const outcome = fence
      ? await fence.run(() => tryStartRun(intent.runId!, { db }))
      : await tryStartRun(intent.runId!, { db });

    started = outcome.started;
  } finally {
    try {
      await fence?.release();
    } catch (error) {
      fence?.retain();
      throw error;
    }
  }
  if (started)
    withoutGitOwnership(async () => {
      const drive =
        intent.settingsSnapshot.kind === "agent"
          ? startAgentSession(intent.runId!, { db })
          : runFlow(intent.runId!);

      void drive.catch((error: unknown) =>
        log.error(
          { intentId, runId: intent.runId, ...queryErrorDiagnostics(error) },
          "accepted Flow driver failed",
        ),
      );
    });
}

/** Refused due work is held only when queued or its unbound preparation no longer has a valid owner. */
export async function holdQueuedTaskLaunchIntent(
  db: Db,
  intentId: string,
  error: unknown,
): Promise<void> {
  const [initial] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!initial) throw error;
  const held = await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await lockTaskLaunchReservation(tx, initial.taskId);
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_workspace_unavailable";
    const [held] = await tx
      .update(taskLaunchIntents)
      .set({
        state: "held",
        stateVersion: initial.stateVersion + 1,
        reason,
        leaseToken: null,
        leaseExpiresAt: null,
        cleanupState: initial.preparationIdentity
          ? "pending"
          : initial.cleanupState,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(taskLaunchIntents.id, initial.id),
          or(
            eq(taskLaunchIntents.state, "queued"),
            and(
              eq(taskLaunchIntents.state, "preparing"),
              isNull(taskLaunchIntents.runId),
              isNull(taskLaunchIntents.originalRunId),
              sql`${taskLaunchIntents.leaseExpiresAt}<=clock_timestamp()`,
            ),
          ),
          eq(taskLaunchIntents.stateVersion, initial.stateVersion),
        ),
      )
      .returning();

    if (held)
      await emitTaskLaunchChanged(tx, held, { type: "system", id: null });

    return held;
  });

  if (!held) {
    log.debug(
      { intentId },
      "launch refusal left a current owner or changed request untouched",
    );

    return;
  }
  log.warn(
    {
      intentId,
      causeChain: operationalCauseChain(error),
      ...queryErrorDiagnostics(error),
    },
    "accepted launch held before preparation claim",
  );
}

/** Bounded preparation of one accepted request; retries keep its exact durable identity. */
export async function prepareTaskLaunchIntent(
  db: Db,
  intentId: string,
): Promise<TaskLaunchReceipt> {
  let claim: TaskLaunchClaim | null;

  try {
    claim = await claimTaskLaunchIntent(db, intentId);
  } catch (error) {
    if (pgErrorOf(error)) throw error;
    await holdQueuedTaskLaunchIntent(db, intentId, error);

    return currentReceipt(db, intentId);
  }

  if (claim) await prepareClaimedTaskLaunchIntent(db, claim);

  return currentReceipt(db, intentId);
}

/** Consumes the durable owner selected under the common scheduler lock. */
async function prepareClaimedTaskLaunchIntent(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<void> {
  let fence: Awaited<ReturnType<typeof acquireRepositoryMutationFence>> | null =
    null;
  let renewal: Promise<void> = Promise.resolve();
  let renewalFailure: unknown;
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => renewTaskLaunchClaim(db, claim))
      .catch((error: unknown) => {
        renewalFailure = error;
      });
  }, 20_000);

  try {
    if (claim.identity.parentRepoPath)
      fence = await acquireRepositoryMutationFence(
        claim.identity.parentRepoPath,
      );
    const prepare = async (): Promise<void> => {
      const current = await lockedTaskLaunchClaim(db, claim);

      if (renewalFailure) throw renewalFailure;
      if (current.settingsSnapshot.kind === "agent") {
        const execution = await acceptedTaskAgentLaunchExecution(db, claim);

        if (execution.intent.runId) {
          const [bound] = await db
            .select()
            .from(runs)
            .where(eq(runs.id, execution.intent.runId));

          if (!bound) throw launchRefusal("launch_worker_fenced");
          await taskAgentPreparationWorkspace(db, bound);
          await db.transaction(async (tx) => {
            await execution.beginBinding(tx);
            await execution.bindRun(tx);
          });
        } else await launchAcceptedTaskAgentRun(execution, db);
      } else {
        const execution = await acceptedTaskLaunchExecution(db, claim);

        if (execution.intent.runId) {
          await assertTaskLaunchBoundWorkspace(db, execution.intent);
          await db.transaction(async (tx) => {
            await execution.beginBinding(tx);
            await execution.bindRun(tx);
          });
        } else await launchAcceptedTaskRun(execution, db);
      }
    };

    if (fence) await fence.run(prepare);
    else await prepare();
  } catch (error) {
    await settlePreparationFailure(db, claim, error);
  } finally {
    clearInterval(timer);
    await renewal;
    if (fence)
      try {
        await fence.release();
      } catch (error) {
        fence.retain();
        throw error;
      }
  }
}

export async function driveClaimedTaskLaunchIntent(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<TaskLaunchReceipt> {
  await prepareClaimedTaskLaunchIntent(db, claim);
  await dispatchBoundTaskLaunchIntent(db, claim.intentId);

  return currentReceipt(db, claim.intentId);
}

/** Preparation and first dispatch use separate physical ownership intervals. */
export async function dispatchTaskLaunchIntent(
  db: Db,
  intentId: string,
): Promise<TaskLaunchReceipt> {
  const { promoteNextPending } = await import("@/lib/scheduler");

  const [intent] = await db
    .select({ settings: taskLaunchIntents.settingsSnapshot })
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
  await promoteNextPending({ db, pool: intent.settings.kind });

  return currentReceipt(db, intentId);
}

export async function dispatchBoundTaskLaunchIntent(
  db: Db,
  intentId: string,
): Promise<void> {
  try {
    await startBoundTaskLaunch(db, intentId);
  } catch (error) {
    const yielded =
      isMaisterError(error) &&
      ["launch_worker_fenced", "run_state_changed", "operation_busy"].includes(
        String(error.details?.reason),
      );

    if (
      !yielded &&
      (!isMaisterError(error) || error.code !== "EXECUTOR_UNAVAILABLE")
    )
      await holdUndispatchedBoundRun(db, intentId, error);
    else {
      if (
        !yielded ||
        (isMaisterError(error) && error.details?.reason === "operation_busy")
      )
        await deferBoundTaskLaunch(db, intentId, error);
      log.warn(
        {
          intentId,
          causeChain: operationalCauseChain(error),
          ...queryErrorDiagnostics(error),
        },
        "accepted launch waits for dispatch availability",
      );
    }
  }
}

/** Existing sweeps/wakes call this; held rows cannot occupy the due-work page. */
export async function reconcileTaskLaunchIntents(
  db: Db,
  limit = 25,
): Promise<number> {
  const candidates = await db
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      sql`(
    ${taskLaunchIntents.state}='queued' AND ${taskLaunchIntents.dueAt}<=clock_timestamp()
    OR ${taskLaunchIntents.state}='preparing' AND ${taskLaunchIntents.leaseExpiresAt}<=clock_timestamp()
    OR ${taskLaunchIntents.state}='run_bound' AND ${taskLaunchIntents.dispatchCommittedAt} IS NULL AND ${taskLaunchIntents.dueAt}<=clock_timestamp()
  )`,
    )
    .orderBy(asc(taskLaunchIntents.dueAt), asc(taskLaunchIntents.id))
    .limit(Math.min(100, Math.max(1, limit)));

  for (const candidate of candidates) {
    try {
      await dispatchTaskLaunchIntent(db, candidate.id);
    } catch (error) {
      log.warn(
        {
          intentId: candidate.id,
          causeChain: operationalCauseChain(error),
          ...queryErrorDiagnostics(error),
        },
        "accepted launch reconciliation deferred",
      );
    }
  }

  return candidates.length;
}
