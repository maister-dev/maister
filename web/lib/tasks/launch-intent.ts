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

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import { assertTaskLaunchUserAuthority } from "./launch-authority";
import { taskLaunchBodySchema } from "./launch-schema";
import { loadTaskSemanticInput } from "./launch-input";
import { launchRefusal, resolveFlowLaunchSettings } from "./launch-resolution";
import { emitTaskLaunchChanged } from "./launch-events";
import { automaticTaskLaunchBasis } from "./launch-automatic";
import { lockTaskLaunchReservation } from "./launch-locks";

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

const log = pino({
  name: "task-launch-intent",
  level: process.env.LOG_LEVEL ?? "info",
});
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

export function taskLaunchReceipt(
  row: typeof taskLaunchIntents.$inferSelect,
): TaskLaunchReceipt {
  const settings = row.settingsSnapshot;

  return {
    schemaVersion: 1,
    intentId: row.id,
    taskId: row.taskId,
    state: row.state,
    stateVersion: row.stateVersion,
    basis: row.basis.kind,
    acceptedAt: row.acceptedAt.toISOString(),
    taskRevision: row.taskRevision,
    inputRevision: row.inputRevision,
    settingsDigest: row.settingsDigest,
    runId: row.runId,
    reason: row.reason,
    snapshot: {
      kind: settings.kind,
      workspace: settings.workspace,
      flowId: settings.flowId,
      flowRevisionId: settings.flowRevisionId,
      agentId: settings.agentId,
      runnerIds: [...new Set(settings.sessions.map((slot) => slot.runnerId))],
      baseCommit: settings.baseCommit,
      targetBranch: settings.targetBranch,
      promotionMode: settings.promotionMode,
      autoPromote: settings.autoPromote,
    },
    ...(row.terminalOutcome ? { terminalOutcome: row.terminalOutcome } : {}),
  };
}

async function scopedTask(db: Db, taskId: string) {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));

  if (!row) throw launchRefusal("launch_task_missing", "PRECONDITION");

  return row;
}

type LaunchAcceptanceAuthority = Readonly<{
  principalKind: typeof taskLaunchIntents.$inferSelect.principalKind;
  principalId: string;
  actorUserId: string | null;
  launchSource: typeof taskLaunchIntents.$inferSelect.launchSource;
  actor: DomainEventActor;
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
}>;

async function replayTaskLaunch(
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
        eq(taskLaunchIntents.operation, "launch"),
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

/** Shared transaction; authority dependencies are created only by the trusted adapters below. */
async function acceptTaskLaunchRequest(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  rawRequest: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  assertUpgradeMaintenanceAllows("run_admission");
  const parsed = taskLaunchBodySchema.safeParse(rawRequest);

  if (!parsed.success || requestKey.length < 1 || requestKey.length > 256)
    throw launchRefusal("launch_request_invalid", "CONFIG");
  const request = parsed.data;
  const payloadDigest = retryDigest({
    version: 1,
    operation: "launch",
    request,
  });
  const initial = await scopedTask(db, request.taskId);

  await authority.assert(db, initial.project.id, ["launchRun"]);
  const replay = await replayTaskLaunch(
    db,
    authority,
    initial.project.id,
    requestKey,
    payloadDigest,
  );

  if (replay) return replay;
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

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1818326382, hashtext(${`${authority.principalKind}:${authority.principalId}:${initial.project.id}:launch:${requestKey}`}))`,
    );
    await lockTaskLaunchReservation(tx, request.taskId);
    await authority.assert(
      tx,
      initial.project.id,
      requiresLaunchUnattended(resolved.executionPolicy)
        ? ["launchRun", "launchUnattended"]
        : ["launchRun"],
    );

    const [locked] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, request.taskId))
      .for("update");

    if (!locked || locked.projectId !== initial.project.id)
      throw launchRefusal("launch_task_missing", "PRECONDITION");
    const existing = await replayTaskLaunch(
      tx,
      authority,
      locked.projectId,
      requestKey,
      payloadDigest,
    );

    if (existing) return existing;
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
        operation: "launch",
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

    return taskLaunchReceipt(accepted);
  });
}

async function acceptTaskLaunch(
  db: Db,
  authority: LaunchAcceptanceAuthority,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  log.debug(
    { taskId: request.taskId, principalKind: authority.principalKind },
    "task-launch-requested",
  );
  try {
    return await acceptTaskLaunchRequest(db, authority, request, requestKey);
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

/** Accept one explicit session action. No client-provided actor, source or flag can create its authority. */
export async function acceptInteractiveTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  assertInteractiveTaskLaunchPrincipal(principal);

  return acceptTaskLaunch(
    db,
    {
      principalKind: "session_user",
      principalId: principal.userId,
      actorUserId: principal.userId,
      launchSource: "api",
      actor: { type: "user", id: principal.userId },
      assert: (tx, projectId, actions) =>
        assertTaskLaunchUserAuthority(tx, projectId, principal.userId, actions),
      admit: async () => ({ kind: "manual", userId: principal.userId }),
    },
    request,
    requestKey,
  );
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
      principalKind: "system",
      principalId: "scheduler",
      actorUserId: null,
      launchSource: "scheduler",
      actor: { type: "system", id: null },
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
      admit: async (tx, task, settings) => {
        const basis = await automaticTaskLaunchBasis(tx, task, settings);

        if (
          task.launchMode !== "auto" ||
          task.triageStatus !== "triaged" ||
          (task.launchIntent !== null &&
            task.launchIntent !== "triage_then_launch")
        )
          throw launchRefusal("launch_automation_not_armed", "PRECONDITION");

        return basis;
      },
    },
    request,
    requestKey,
  );
}
