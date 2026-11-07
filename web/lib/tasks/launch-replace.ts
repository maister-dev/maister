import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type { TaskLaunchReplaceRequest } from "./launch-schema";
import type { TaskLaunchReceipt } from "./launch-types";
import type { TokenTaskLaunchPrincipal } from "./launch-token";
import type {
  TaskLaunchAuditContext,
  LaunchAcceptanceAuthority,
} from "./launch-intent";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { launchRefusal } from "./launch-resolution";
import { taskLaunchReplaceBodySchema } from "./launch-schema";
import {
  interactiveTaskLaunchAuthority,
  tokenTaskLaunchAuthority,
  commitTaskLaunchReplay,
  replayTaskLaunch,
  taskLaunchPayloadDigest,
  prepareTaskLaunchRequest,
  applyPreparedTaskLaunch,
} from "./launch-intent";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { cancelLockedTaskLaunch } from "./launch-cancel";
import { taskLaunchForUser, taskLaunchForTokenWrite } from "./launch-access";
import { assertTaskLaunchTokenAuthentication } from "./launch-token";

import { taskLaunchIntents } from "@/lib/db/schema";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

const log = pino({
  name: "task-launch-replace",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function replaceTokenTaskLaunch(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  intentId: string,
  request: TaskLaunchReplaceRequest,
  requestKey: string,
  audit?: TaskLaunchAuditContext,
): Promise<TaskLaunchReceipt> {
  await assertTaskLaunchTokenAuthentication(db, principal);

  return replaceTaskLaunch(
    db,
    tokenTaskLaunchAuthority(principal, audit),
    intentId,
    request,
    requestKey,
    () => taskLaunchForTokenWrite(db, intentId, principal),
  );
}

export async function replaceInteractiveTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  intentId: string,
  request: TaskLaunchReplaceRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  return replaceTaskLaunch(
    db,
    interactiveTaskLaunchAuthority(principal),
    intentId,
    request,
    requestKey,
    () => taskLaunchForUser(db, intentId, principal.userId),
  );
}

async function replaceTaskLaunch(
  db: Db,
  principal: LaunchAcceptanceAuthority,
  intentId: string,
  request: TaskLaunchReplaceRequest,
  requestKey: string,
  loadInitial: () => Promise<typeof taskLaunchIntents.$inferSelect>,
): Promise<TaskLaunchReceipt> {
  const authority = {
    ...principal,
    operation: "replace" as const,
    replacesIntentId: intentId,
    expectedStateVersion: request.expectedStateVersion,
  };

  assertUpgradeMaintenanceAllows("run_admission");
  const parsed = taskLaunchReplaceBodySchema.safeParse(request);

  if (!parsed.success || !requestKey || requestKey.length > 256)
    throw launchRefusal("launch_request_invalid", "CONFIG");
  const { expectedStateVersion, ...launch } = parsed.data;
  const initial = await loadInitial();
  const actions = requiresLaunchUnattended(
    initial.settingsSnapshot.executionPolicy,
  )
    ? (["launchRun", "launchUnattended"] as const)
    : (["launchRun"] as const);

  await authority.assert(db, initial.projectId, actions);
  if (initial.taskId !== launch.taskId)
    throw launchRefusal("launch_request_invalid", "CONFIG");
  const payloadDigest = taskLaunchPayloadDigest(authority, launch);
  const prepared = await prepareTaskLaunchRequest(
    db,
    authority,
    launch,
    requestKey,
  );

  if (prepared.kind === "replayed")
    return commitTaskLaunchReplay(db, authority, prepared, requestKey);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1818326382, hashtext(${`${authority.principalKind}:${authority.principalId}:${initial.projectId}:replace:${requestKey}`}))`,
    );
    await lockTaskLaunchReservation(tx, initial.taskId);
    await authority.assert(tx, initial.projectId, actions);
    const replay = await replayTaskLaunch(
      tx,
      authority,
      initial.projectId,
      requestKey,
      payloadDigest,
    );

    if (replay) {
      await authority.recordSuccessAudit?.(tx, replay);

      return replay;
    }
    await lockTaskLaunchBoundRun(tx, intentId);
    const [intent] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");

    if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
    await cancelLockedTaskLaunch(tx, intent, {
      expectedStateVersion,
      receipt: null,
      actor: authority.actor,
    });
    const successor = await applyPreparedTaskLaunch(tx, prepared);

    log.info(
      {
        intentId,
        successorIntentId: successor.intentId,
        taskId: intent.taskId,
      },
      "task-launch-replaced",
    );

    return successor;
  });
}
