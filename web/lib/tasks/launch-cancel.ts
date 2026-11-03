import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type { LaunchAcceptanceAuthority } from "./launch-intent";
import type { TaskLaunchAuditContext } from "./launch-intent";
import type { TokenTaskLaunchPrincipal } from "./launch-token";
import type { TaskLaunchCancelRequest } from "./launch-schema";
import type {
  TaskLaunchReceipt,
  TaskLaunchCancellationReceipt,
} from "./launch-types";
import type { DomainEventActor } from "@/lib/domain-events/outbox";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import {
  interactiveTaskLaunchAuthority,
  tokenTaskLaunchAuthority,
} from "./launch-intent";
import { assertTaskLaunchTokenAuthentication } from "./launch-token";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { launchRefusal } from "./launch-resolution";
import { taskLaunchReceipt } from "./launch-receipt";
import { taskLaunchCancelBodySchema } from "./launch-schema";
import { emitTaskLaunchChanged } from "./launch-events";
import { taskLaunchForUser, taskLaunchForTokenWrite } from "./launch-access";

import { runs, taskLaunchIntents } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";
import { abandonRunInTransaction } from "@/lib/runs/state-transitions";

const log = pino({
  name: "task-launch-cancel",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Caller holds the task reservation, bound run and intent locks, in that order. */
export async function cancelLockedTaskLaunch(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
  decision: Readonly<{
    expectedStateVersion: number;
    receipt: TaskLaunchCancellationReceipt | null;
    actor: DomainEventActor;
  }>,
): Promise<typeof taskLaunchIntents.$inferSelect> {
  if (intent.stateVersion !== decision.expectedStateVersion)
    throw launchRefusal("launch_state_changed");
  if (intent.dispatchCommittedAt)
    throw launchRefusal("launch_dispatch_committed");
  if (!["queued", "preparing", "held", "run_bound"].includes(intent.state))
    throw launchRefusal("launch_state_changed");
  if (intent.runId) {
    const [run] = await db.select().from(runs).where(eq(runs.id, intent.runId));
    const dispatched = await db.execute(sql`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM execution_commands WHERE run_id=${intent.runId})
      OR EXISTS(SELECT 1 FROM run_session_incarnations WHERE run_id=${intent.runId})`);

    if (!run || run.status !== "Pending" || dispatched.rows.length)
      throw launchRefusal("launch_dispatch_committed");
    if (
      !(await abandonRunInTransaction(db, run.id, {
        code: null,
        reason: "launch_cancelled",
        source: "operator",
      }))
    )
      throw launchRefusal("launch_state_changed");
  }
  const [cancelled] = await db
    .update(taskLaunchIntents)
    .set({
      state: "cancelled",
      stateVersion: intent.stateVersion + 1,
      reason: "launch_cancelled",
      cancellationReceipt: decision.receipt,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(taskLaunchIntents.id, intent.id),
        eq(taskLaunchIntents.stateVersion, intent.stateVersion),
      ),
    )
    .returning();

  if (!cancelled) throw launchRefusal("launch_state_changed");
  await emitTaskLaunchChanged(db, cancelled, decision.actor);

  return cancelled;
}

export async function cancelInteractiveTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  intentId: string,
  request: TaskLaunchCancelRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  assertInteractiveTaskLaunchPrincipal(principal);
  const parsed = parseCancellation(request, requestKey);
  const initial = await taskLaunchForUser(db, intentId, principal.userId);

  return cancelTaskLaunch(
    db,
    interactiveTaskLaunchAuthority(principal),
    initial,
    parsed,
    requestKey,
  );
}

function parseCancellation(
  request: TaskLaunchCancelRequest,
  requestKey: string,
): TaskLaunchCancelRequest {
  const parsed = taskLaunchCancelBodySchema.safeParse(request);

  if (!parsed.success || !requestKey || requestKey.length > 256)
    throw launchRefusal("launch_request_invalid", "CONFIG");

  return parsed.data;
}

export async function cancelTokenTaskLaunch(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  intentId: string,
  request: TaskLaunchCancelRequest,
  requestKey: string,
  audit?: TaskLaunchAuditContext,
): Promise<TaskLaunchReceipt> {
  await assertTaskLaunchTokenAuthentication(db, principal);
  const parsed = parseCancellation(request, requestKey);
  const initial = await taskLaunchForTokenWrite(db, intentId, principal);

  return cancelTaskLaunch(
    db,
    tokenTaskLaunchAuthority(principal, audit),
    initial,
    parsed,
    requestKey,
  );
}

async function cancelTaskLaunch(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  initial: typeof taskLaunchIntents.$inferSelect,
  request: TaskLaunchCancelRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  const intentId = initial.id;
  const actions = requiresLaunchUnattended(
    initial.settingsSnapshot.executionPolicy,
  )
    ? (["launchRun", "launchUnattended"] as const)
    : (["launchRun"] as const);

  await authority.assert(db, initial.projectId, actions);
  const payloadDigest = retryDigest({
    version: 1,
    operation: "cancel",
    intentId,
    request,
  });
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1818326382, hashtext(${`${authority.principalKind}:${authority.principalId}:${initial.projectId}:cancel:${requestKey}`}))`,
    );
    await lockTaskLaunchReservation(tx, initial.taskId);
    await authority.assert(tx, initial.projectId, actions);
    await lockTaskLaunchBoundRun(tx, intentId);
    const [intent] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");

    if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
    // Scope before the state CAS so a lost successful response can replay its original version.
    const replay = await tx.execute<{
      id: string;
      cancellationReceipt: TaskLaunchCancellationReceipt;
    }>(sql`
      SELECT id,cancellation_receipt AS "cancellationReceipt" FROM task_launch_intents
      WHERE project_id=${initial.projectId} AND cancellation_receipt->>'principalKind'=${authority.principalKind}
        AND cancellation_receipt->>'principalId'=${authority.principalId} AND cancellation_receipt->>'requestKey'=${requestKey}`);

    if (replay.rows.length) {
      if (
        replay.rows[0].id !== intentId ||
        replay.rows[0].cancellationReceipt.payloadDigest !== payloadDigest
      )
        throw launchRefusal("launch_request_key_conflict");
      log.info(
        { intentId, principalKind: authority.principalKind },
        "task-launch-cancel-replayed",
      );

      const receipt = taskLaunchReceipt(intent);

      await authority.recordSuccessAudit?.(tx, receipt);

      return receipt;
    }
    const time = await tx.execute<{ acceptedAt: string }>(
      sql`SELECT clock_timestamp()::text AS "acceptedAt"`,
    );
    const cancelled = await cancelLockedTaskLaunch(tx, intent, {
      expectedStateVersion: request.expectedStateVersion,
      actor: authority.actor,
      receipt: {
        version: 1,
        principalKind: authority.principalKind,
        principalId: authority.principalId,
        actorUserId: authority.actorUserId,
        requestKey,
        payloadDigest,
        expectedStateVersion: request.expectedStateVersion,
        cancelledAt: new Date(time.rows[0].acceptedAt).toISOString(),
      },
    });

    log.info(
      {
        intentId,
        stateVersion: cancelled.stateVersion,
        runId: cancelled.runId,
      },
      "task-launch-cancelled",
    );

    const receipt = taskLaunchReceipt(cancelled);

    await authority.recordSuccessAudit?.(tx, receipt);

    return receipt;
  });

  return result;
}
