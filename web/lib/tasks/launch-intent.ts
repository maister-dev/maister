import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { DomainEventActor } from "@/lib/domain-events/outbox";
import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type {
  TaskLaunchReceipt,
  TaskLaunchBasis,
  TaskLaunchSettingsSnapshot,
} from "./launch-types";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TokenTaskLaunchPrincipal } from "./launch-token";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import {
  assertTaskLaunchUserAuthority,
  assertTaskLaunchReadAuthority,
} from "./launch-authority";
import { taskLaunchBodySchema } from "./launch-schema";
import { loadTaskSemanticInput } from "./launch-input";
import { launchRefusal, resolveFlowLaunchSettings } from "./launch-resolution";
import { emitTaskLaunchChanged } from "./launch-events";
import { armedAutomaticTaskLaunchBasis } from "./launch-automatic";
import {
  assertTokenTaskLaunchPrincipal,
  assertTaskLaunchTokenAuthentication,
  assertTaskLaunchTokenAuthority,
  assertTaskLaunchTokenVisibility,
  taskLaunchTokenActorUserId,
} from "./launch-token";
import { lockTaskLaunchReservation } from "./launch-locks";
import { taskLaunchReceipt } from "./launch-receipt";

import { tasks, projects, taskLaunchIntents, runs } from "@/lib/db/schema";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { retryDigest } from "@/lib/agents/retry-guards";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";
import {
  resolveBaseCommit,
  assertBaseCommitReachable,
  listBranches,
} from "@/lib/worktree";

export { taskLaunchSettingsToken } from "./launch-resolution";
export { taskLaunchReceipt } from "./launch-receipt";

const log = pino({
  name: "task-launch-intent",
  level: process.env.LOG_LEVEL ?? "info",
});
const launchAuthority = Symbol("server task launch authority");
const launchPreparation = Symbol("prepared task launch");
const ACTIVE_INTENT_STATES = [
  "queued",
  "preparing",
  "run_bound",
  "held",
] as const;
const ACTIVE_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
] as const;

async function scopedTask(db: Db, taskId: string) {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));

  if (!row) throw launchRefusal("launch_not_found", "PRECONDITION");

  return row;
}

export type LaunchAcceptanceAuthority = Readonly<{
  [launchAuthority]: true;
  operation: "launch" | "replace";
  replacesIntentId: string | null;
  expectedStateVersion: number | null;
  principalKind: typeof taskLaunchIntents.$inferSelect.principalKind;
  principalId: string;
  actorUserId: string | null;
  launchSource: typeof taskLaunchIntents.$inferSelect.launchSource;
  actor: DomainEventActor;
  assertVisibility: (db: Db, projectId: string) => Promise<void>;
  assert: (
    db: Db,
    projectId: string,
    actions: readonly ProjectAction[],
  ) => Promise<void>;
  admit: (
    db: Db,
    task: typeof tasks.$inferSelect,
    settings: TaskLaunchSettingsSnapshot,
  ) => Promise<TaskLaunchBasis>;
  recordSuccessAudit?: (db: Db, receipt: TaskLaunchReceipt) => Promise<void>;
}>;

export type TaskLaunchAuditContext = Readonly<{
  recordSuccessAudit: (db: Db, receipt: TaskLaunchReceipt) => Promise<void>;
}>;

export function taskLaunchPayloadDigest(
  authority: LaunchAcceptanceAuthority,
  request: TaskLaunchRequest,
): string {
  return retryDigest({
    version: 1,
    operation: authority.operation,
    request,
    ...(authority.replacesIntentId
      ? {
          replacesIntentId: authority.replacesIntentId,
          expectedStateVersion: authority.expectedStateVersion,
        }
      : {}),
  });
}

export async function replayTaskLaunch(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  projectId: string,
  requestKey: string,
  payloadDigest: string,
): Promise<TaskLaunchReceipt | null> {
  const [existing] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.principalKind, authority.principalKind),
        eq(taskLaunchIntents.principalId, authority.principalId),
        eq(taskLaunchIntents.projectId, projectId),
        eq(taskLaunchIntents.operation, authority.operation),
        eq(taskLaunchIntents.requestKey, requestKey),
      ),
    );

  if (!existing) return null;
  if (existing.payloadDigest !== payloadDigest)
    throw launchRefusal("launch_request_key_conflict");
  await authority.assert(
    db,
    projectId,
    requiresLaunchUnattended(existing.settingsSnapshot.executionPolicy)
      ? ["launchRun", "launchUnattended"]
      : ["launchRun"],
  );
  log.info(
    {
      intentId: existing.id,
      taskId: existing.taskId,
      principalKind: authority.principalKind,
    },
    "task-launch-replayed",
  );

  return taskLaunchReceipt(existing);
}

export type PreparedTaskLaunch = Readonly<{
  kind: "prepared";
  [launchPreparation]: true;
  authority: LaunchAcceptanceAuthority;
  requestKey: string;
  request: TaskLaunchRequest;
  payloadDigest: string;
  projectId: string;
  resolved: Awaited<ReturnType<typeof resolveFlowLaunchSettings>>;
  baseCommit: string;
}>;
export type TaskLaunchPreparationOutcome =
  | PreparedTaskLaunch
  | Readonly<{
      kind: "replayed";
      receipt: TaskLaunchReceipt;
      projectId: string;
      payloadDigest: string;
    }>;

/** Resolve read-only Git facts before any acceptance/replacement transaction. */
export async function prepareTaskLaunchRequest(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  rawRequest: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchPreparationOutcome> {
  assertUpgradeMaintenanceAllows("run_admission");
  const parsed = taskLaunchBodySchema.safeParse(rawRequest);

  if (!parsed.success || requestKey.length < 1 || requestKey.length > 256)
    throw launchRefusal("launch_request_invalid", "CONFIG");
  const request = parsed.data;
  const payloadDigest = taskLaunchPayloadDigest(authority, request);
  const initial = await scopedTask(db, request.taskId);

  try {
    await authority.assertVisibility(db, initial.project.id);
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw launchRefusal("launch_not_found", "PRECONDITION");
    throw error;
  }
  await authority.assert(db, initial.project.id, ["launchRun"]);
  const replay = await replayTaskLaunch(
    db,
    authority,
    initial.project.id,
    requestKey,
    payloadDigest,
  );

  if (replay)
    return {
      kind: "replayed",
      receipt: replay,
      projectId: initial.project.id,
      payloadDigest,
    };
  if (initial.task.revision !== request.expectedTaskRevision)
    throw launchRefusal("launch_input_changed");
  const resolved = await resolveFlowLaunchSettings(
    db,
    initial.task,
    initial.project,
    request,
  );

  if (resolved.resolutionToken !== request.expectedSettingsToken)
    throw launchRefusal("launch_settings_changed");
  const branches = new Set(
    await listBranches(initial.project.repoPath, { includeRemotes: true }),
  );

  if (
    !branches.has(resolved.baseBranch) ||
    !branches.has(resolved.targetBranch)
  )
    throw launchRefusal("launch_target_unavailable", "PRECONDITION");
  const baseCommit = request.baseCommit
    ? await assertBaseCommitReachable({
        projectRepoPath: initial.project.repoPath,
        baseRef: resolved.baseBranch,
        baseCommit: request.baseCommit,
        preferRemote: "origin",
      })
    : await resolveBaseCommit({
        projectRepoPath: initial.project.repoPath,
        baseRef: resolved.baseBranch,
        preferRemote: "origin",
      });

  return {
    kind: "prepared",
    [launchPreparation]: true,
    authority,
    requestKey,
    request,
    payloadDigest,
    projectId: initial.project.id,
    resolved,
    baseCommit,
  };
}

/** DB-only application; the caller may include old-request cancellation in this transaction. */
export async function commitPreparedTaskLaunch(
  db: Db,
  prepared: PreparedTaskLaunch,
): Promise<TaskLaunchReceipt> {
  assertUpgradeMaintenanceAllows("run_admission");
  const { authority, requestKey, projectId, request } = prepared;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1818326382, hashtext(${`${authority.principalKind}:${authority.principalId}:${projectId}:${authority.operation}:${requestKey}`}))`,
    );
    await lockTaskLaunchReservation(tx, request.taskId);

    return applyPreparedTaskLaunch(tx, prepared);
  });
}

/** Caller owns scoped key and task reservation, then any predecessor run/assignment/intent rows. */
export async function applyPreparedTaskLaunch(
  tx: Db,
  prepared: PreparedTaskLaunch,
): Promise<TaskLaunchReceipt> {
  assertUpgradeMaintenanceAllows("run_admission");
  if (
    prepared[launchPreparation] !== true ||
    prepared.authority[launchAuthority] !== true
  )
    throw launchRefusal("launch_manual_authority_required", "PRECONDITION");
  const {
    authority,
    requestKey,
    request,
    payloadDigest,
    projectId,
    resolved,
    baseCommit,
  } = prepared;

  await authority.assert(
    tx,
    projectId,
    requiresLaunchUnattended(resolved.executionPolicy)
      ? ["launchRun", "launchUnattended"]
      : ["launchRun"],
  );

  const [locked] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, request.taskId))
    .for("update");

  if (!locked || locked.projectId !== projectId)
    throw launchRefusal("launch_task_missing", "PRECONDITION");
  const existing = await replayTaskLaunch(
    tx,
    authority,
    locked.projectId,
    requestKey,
    payloadDigest,
  );

  if (existing) {
    await authority.recordSuccessAudit?.(tx, existing);

    return existing;
  }
  const [reserved] = await tx
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.taskId, locked.id),
        eq(taskLaunchIntents.reservationLane, "ordinary"),
        inArray(taskLaunchIntents.state, ACTIVE_INTENT_STATES),
      ),
    )
    .limit(1);

  if (reserved) throw launchRefusal("launch_already_reserved");
  const [liveRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, locked.id),
        inArray(runs.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(1);

  if (liveRun) throw launchRefusal("launch_already_reserved");
  if (locked.revision !== request.expectedTaskRevision)
    throw launchRefusal("launch_input_changed");
  if (locked.status === "Abandoned")
    throw launchRefusal("target_terminal", "PRECONDITION");
  if (locked.queuePaused) throw launchRefusal("queue_paused", "PRECONDITION");
  if ((await countOpenBlockingClarifications(locked.id, tx)) > 0)
    throw launchRefusal("clarification_pending", "PRECONDITION");
  if ((await getOpenRelationBlockers([locked.id], tx)).get(locked.id)?.length)
    throw launchRefusal("blocked", "PRECONDITION");
  const configuration = {
    flowId: request.flowId ?? locked.flowId,
    runnerId: request.runnerId ?? locked.runnerId,
    baseBranch: request.baseBranch ?? locked.baseBranch,
    targetBranch: request.targetBranch ?? locked.targetBranch,
  };
  const previousConfiguration = {
    flowId: locked.flowId,
    runnerId: locked.runnerId,
    baseBranch: locked.baseBranch,
    targetBranch: locked.targetBranch,
  };
  let launchTask = locked;

  if (retryDigest(configuration) !== retryDigest(previousConfiguration)) {
    await authority.assert(tx, locked.projectId, ["launchRun", "editTask"]);
    [launchTask] = await tx
      .update(tasks)
      .set({ ...configuration, revision: locked.revision + 1 })
      .where(eq(tasks.id, locked.id))
      .returning();
  }
  const current = await scopedTask(tx, locked.id);
  const settings = {
    ...(await resolveFlowLaunchSettings(
      tx,
      launchTask,
      current.project,
      request,
    )),
    baseCommit,
  };
  const {
    taskSettingsDigest: _oldTaskSettings,
    resolutionToken: _oldToken,
    ...beforeExecution
  } = resolved;
  const {
    taskSettingsDigest: _newTaskSettings,
    resolutionToken: _newToken,
    ...acceptedExecution
  } = settings;

  if (
    retryDigest({ ...beforeExecution, baseCommit }) !==
    retryDigest(acceptedExecution)
  )
    throw launchRefusal("launch_settings_changed");
  const { snapshot } = await loadTaskSemanticInput(
    tx,
    locked.projectId,
    locked.id,
  );
  const sizes = await tx.execute<{
    inputBytes: number;
    settingsBytes: number;
  }>(sql`SELECT
    octet_length(${JSON.stringify(snapshot)}::jsonb::text) AS "inputBytes",
    octet_length(${JSON.stringify(settings)}::jsonb::text) AS "settingsBytes"`);

  if (
    sizes.rows[0].inputBytes > 262_144 ||
    sizes.rows[0].settingsBytes > 131_072
  )
    throw launchRefusal("launch_input_limit", "CONFIG");
  const [accepted] = await tx
    .insert(taskLaunchIntents)
    .values({
      id: randomUUID(),
      projectId: locked.projectId,
      taskId: locked.id,
      principalKind: authority.principalKind,
      principalId: authority.principalId,
      actorUserId: authority.actorUserId,
      launchSource: authority.launchSource,
      operation: authority.operation,
      replacesIntentId: authority.replacesIntentId,
      requestKey,
      payloadDigest,
      taskRevision: launchTask.revision,
      inputRevision: launchTask.qualificationInputRevision,
      inputDigest: retryDigest(snapshot),
      inputSnapshot: snapshot,
      settingsDigest: retryDigest(settings),
      settingsSnapshot: settings,
      basis: await authority.admit(tx, launchTask, settings),
      dueAt: sql`clock_timestamp()`,
    })
    .returning();

  await emitTaskLaunchChanged(tx, accepted, authority.actor);
  log.info(
    {
      intentId: accepted.id,
      taskId: locked.id,
      principalKind: authority.principalKind,
      basis: accepted.basis.kind,
      taskRevision: accepted.taskRevision,
      inputRevision: accepted.inputRevision,
      inputDigest: accepted.inputDigest,
      settingsDigest: accepted.settingsDigest,
      triageStatus: locked.triageStatus,
    },
    "task-launch-accepted",
  );

  const receipt = taskLaunchReceipt(accepted);

  await authority.recordSuccessAudit?.(tx, receipt);

  return receipt;
}

export async function acceptTaskLaunch(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  if (authority[launchAuthority] !== true)
    throw launchRefusal("launch_manual_authority_required", "PRECONDITION");
  log.debug(
    { taskId: request.taskId, principalKind: authority.principalKind },
    "task-launch-requested",
  );
  try {
    const prepared = await prepareTaskLaunchRequest(
      db,
      authority,
      request,
      requestKey,
    );

    if (prepared.kind === "prepared")
      return await commitPreparedTaskLaunch(db, prepared);

    return await commitTaskLaunchReplay(db, authority, prepared, requestKey);
  } catch (error) {
    const context = {
      taskId: request.taskId,
      principalKind: authority.principalKind,
    };

    if (isMaisterError(error))
      log.warn(
        { ...context, code: error.code, reason: error.details?.reason },
        "task-launch-refused",
      );
    else
      log.error(
        { ...context, ...queryErrorDiagnostics(error) },
        "task-launch-storage-failed",
      );
    throw error;
  }
}

/** Replays audit with current access in a short key-scoped transaction. */
export async function commitTaskLaunchReplay(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  prepared: Extract<TaskLaunchPreparationOutcome, { kind: "replayed" }>,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1818326382, hashtext(${`${authority.principalKind}:${authority.principalId}:${prepared.projectId}:${authority.operation}:${requestKey}`}))`,
    );
    const replay = await replayTaskLaunch(
      tx,
      authority,
      prepared.projectId,
      requestKey,
      prepared.payloadDigest,
    );

    if (!replay) throw launchRefusal("launch_state_changed");
    await authority.recordSuccessAudit?.(tx, replay);

    return replay;
  });
}

/** Accept one explicit session action. No client-provided actor, source or flag can create its authority. */
export async function acceptInteractiveTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  return acceptTaskLaunch(
    db,
    interactiveTaskLaunchAuthority(principal),
    request,
    requestKey,
  );
}

export async function acceptTokenTaskLaunch(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  request: TaskLaunchRequest,
  requestKey: string,
  audit?: TaskLaunchAuditContext,
): Promise<TaskLaunchReceipt> {
  assertTokenTaskLaunchPrincipal(principal);
  log.debug(
    { tokenId: principal.origin.tokenId },
    "task-launch-token-authenticating",
  );
  try {
    await assertTaskLaunchTokenAuthentication(db, principal);
  } catch (error) {
    if (isMaisterError(error))
      log.warn(
        {
          tokenId: principal.origin.tokenId,
          code: error.code,
          reason: error.details?.reason,
        },
        "task-launch-token-authentication-refused",
      );
    else
      log.error(
        { tokenId: principal.origin.tokenId, ...queryErrorDiagnostics(error) },
        "task-launch-token-authentication-failed",
      );
    throw error;
  }

  return acceptTaskLaunch(
    db,
    tokenTaskLaunchAuthority(principal, audit),
    request,
    requestKey,
  );
}

/** A bearer constructor preserves automated admission even when the token has a human owner. */
export function tokenTaskLaunchAuthority(
  principal: TokenTaskLaunchPrincipal,
  audit?: TaskLaunchAuditContext,
): LaunchAcceptanceAuthority {
  assertTokenTaskLaunchPrincipal(principal);
  const actorUserId = taskLaunchTokenActorUserId(principal.origin);

  return {
    [launchAuthority]: true,
    operation: "launch",
    replacesIntentId: null,
    expectedStateVersion: null,
    principalKind: "project_token",
    principalId: principal.origin.tokenId,
    actorUserId,
    launchSource: "api",
    actor: actorUserId
      ? { type: "user", id: actorUserId }
      : principal.origin.agentId
        ? { type: "agent", id: principal.origin.agentId }
        : { type: "system", id: null },
    assertVisibility: (tx, projectId) =>
      assertTaskLaunchTokenVisibility(tx, principal, projectId),
    assert: (tx, projectId, actions) =>
      assertTaskLaunchTokenAuthority(tx, principal, projectId, actions),
    admit: async (tx, task, settings) => ({
      ...(await armedAutomaticTaskLaunchBasis(tx, task, settings)),
      origin: principal.origin,
    }),
    recordSuccessAudit: audit?.recordSuccessAudit,
  };
}

/** Internal constructor; session proof stays opaque even to other launch adapters. */
export function interactiveTaskLaunchAuthority(
  principal: InteractiveTaskLaunchPrincipal,
): LaunchAcceptanceAuthority {
  assertInteractiveTaskLaunchPrincipal(principal);

  return {
    [launchAuthority]: true,
    operation: "launch",
    replacesIntentId: null,
    expectedStateVersion: null,
    principalKind: "session_user",
    principalId: principal.userId,
    actorUserId: principal.userId,
    launchSource: "api",
    actor: { type: "user", id: principal.userId },
    assertVisibility: (tx, projectId) =>
      assertTaskLaunchReadAuthority(tx, projectId, principal.userId),
    assert: (tx, projectId, actions) =>
      assertTaskLaunchUserAuthority(tx, projectId, principal.userId, actions),
    admit: async () => ({ kind: "manual", userId: principal.userId }),
  };
}

/** Scheduler-owned root admission. An existing manual intent never arms this operation. */
export async function acceptAutomaticTaskLaunch(
  db: Db,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  return acceptTaskLaunch(
    db,
    {
      [launchAuthority]: true,
      operation: "launch",
      replacesIntentId: null,
      expectedStateVersion: null,
      principalKind: "system",
      principalId: "scheduler",
      actorUserId: null,
      launchSource: "scheduler",
      actor: { type: "system", id: null },
      assertVisibility: async () => {},
      assert: async (tx, projectId) => {
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));

        if (!project || project.archivedAt)
          throw new MaisterError(
            "UNAUTHORIZED",
            "Automatic launch project is unavailable",
            {
              details: { reason: "launch_authority_revoked" },
            },
          );
      },
      admit: armedAutomaticTaskLaunchBasis,
    },
    request,
    requestKey,
  );
}
