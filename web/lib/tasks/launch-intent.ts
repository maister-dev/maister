import "server-only";

import type { Run } from "@/lib/db/schema";
import type { TaskLaunchServerSource } from "./launch-server-source";
import type { ProjectAction } from "@/lib/authz";
import type { DomainEventActor } from "@/lib/domain-events/outbox";
import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type {
  TaskLaunchReceipt,
  TaskLaunchBasis,
  TaskLaunchSettingsSnapshot,
  TaskLaunchSettingsV2Snapshot,
} from "./launch-types";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TokenTaskLaunchPrincipal } from "./launch-token";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import {
  assertTaskLaunchServerSource,
  assertStoredTaskLaunchServerSource,
} from "./launch-server-source";
import { automaticTaskLaunchBasis } from "./launch-automatic";
import { resolveServerFlowLaunchSettings } from "./launch-resolution";
import { captureTaskLaunchRelaunchSource } from "./launch-continuation";
import { isManualTriageHold } from "./manual-launch-hold";
import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import {
  assertTaskLaunchUserAuthority,
  assertTaskLaunchReadAuthority,
} from "./launch-authority";
import { taskLaunchBodySchema } from "./launch-schema";
import { loadTaskSemanticInput } from "./launch-input";
import {
  launchRefusal,
  resolveTaskLaunchSettings,
  type ResolvedTaskLaunchSettings,
} from "./launch-resolution";
import {
  resolveTaskLaunchBase,
  resolveInteractiveTaskAgentHandoffSettings,
  resolveServerAgentTaskLaunchSettings,
  resolveTaskLaunchAutomaticEvidenceCommit,
} from "./launch-agent-resolution";
import { taskExecutionChildAdmissionProof } from "./qualification-admission";
import { captureTaskLaunchFlowAssets } from "./launch-flow-assets";
import { composeTaskLaunchSettingsToken } from "./launch-resolution";
import { resolvePreparedAgentTaskLaunchSettings } from "./launch-agent-resolution";
import { captureTaskLaunchCapabilityBundles } from "./launch-capabilities";
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
import { taskLaunchReservationConflict } from "./launch-conflict";

import { recordTaskAgentTriggerIntentAccepted } from "@/lib/agents/task-trigger-reservation";
import { resolveAgentFlowTaskLaunchSource } from "@/lib/agents/flow-launch-authority";
import { tasks, projects, taskLaunchIntents, runs } from "@/lib/db/schema";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { retryDigest } from "@/lib/agents/retry-guards";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";

export { taskLaunchSettingsToken } from "./launch-resolution";
export { taskLaunchReceipt } from "./launch-receipt";

const log = pino({
  name: "task-launch-intent",
  level: process.env.LOG_LEVEL ?? "info",
});
const launchAuthority = Symbol("server task launch authority");
const sourceHandoffAuthority = Symbol("interactive source terminal handoff");
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
  [sourceHandoffAuthority]?: true;
  handoffOriginalRun?: Run;
  serverSource?: TaskLaunchServerSource;
  basisKind: "manual" | "automatic" | "execution_child";
  operation: "launch" | "retry" | "replace";
  reservationLane: "ordinary" | "concurrent";
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
    currentBaseCommit: string | null,
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
    ...(authority.reservationLane === "concurrent"
      ? { reservationLane: "concurrent" }
      : {}),
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
  resolved: ResolvedTaskLaunchSettings;
  metadataToken: string;
  baseCommit: string | null;
  currentBaseCommit: string | null;
}>;
export type TaskLaunchPreparationOutcome =
  | PreparedTaskLaunch
  | Readonly<{
      kind: "replayed";
      receipt: TaskLaunchReceipt;
      projectId: string;
      payloadDigest: string;
    }>;

function bindTaskLaunchSettingsBase(
  resolved: ResolvedTaskLaunchSettings,
  baseCommit: string | null,
): TaskLaunchSettingsV2Snapshot {
  if (resolved.kind === "flow") {
    if (!baseCommit)
      throw launchRefusal("launch_target_unavailable", "PRECONDITION");

    return { ...resolved, baseCommit };
  }

  return { ...resolved, baseCommit };
}

function sourceFlowSelection(
  request: TaskLaunchRequest,
  source: TaskLaunchServerSource,
): Partial<TaskLaunchRequest> {
  if (!request.agentId) return request;
  const flowId = source.snapshot.execution.flowId;

  if (!flowId)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const { agentId: _agentId, workspace: _workspace, ...selection } = request;

  return {
    ...selection,
    flowId,
    ...(!selection.baseBranch && source.snapshot.branchBase
      ? { baseBranch: source.snapshot.branchBase }
      : {}),
  };
}

async function resolveSettingsForAuthority(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  request: TaskLaunchRequest,
  authority: LaunchAcceptanceAuthority,
): Promise<ResolvedTaskLaunchSettings> {
  if (
    !authority.serverSource &&
    authority[sourceHandoffAuthority] &&
    authority.handoffOriginalRun &&
    request.agentId
  )
    return resolveInteractiveTaskAgentHandoffSettings(
      db,
      task,
      project,
      request,
      authority.handoffOriginalRun,
    );
  if (!authority.serverSource)
    return resolveTaskLaunchSettings(db, task, project, request);
  const settings = await resolveSourceTaskLaunchSettings(
    db,
    task,
    project,
    request,
    authority.serverSource,
  );

  return settings;
}

async function resolveSourceTaskLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  request: TaskLaunchRequest,
  source: TaskLaunchServerSource,
): Promise<ResolvedTaskLaunchSettings> {
  if (source.snapshot.execution.agentId && !source.snapshot.execution.flowId)
    return resolveServerAgentTaskLaunchSettings(
      db,
      task,
      project,
      request,
      source.snapshot,
    );
  if (["budget_restart", "agent_retry"].includes(source.snapshot.kind))
    return {
      ...(await resolveTaskLaunchSettings(db, task, project, request)),
      serverExecution: source.snapshot,
    };

  return resolveServerFlowLaunchSettings(
    db,
    task,
    project,
    sourceFlowSelection(request, source),
    source.snapshot,
  );
}

async function resolvePreparedSettingsForAuthority(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  request: TaskLaunchRequest,
  prepared: PreparedTaskLaunch,
): Promise<ResolvedTaskLaunchSettings> {
  return prepared.resolved.kind === "agent"
    ? resolvePreparedAgentTaskLaunchSettings(
        db,
        task,
        project,
        request,
        prepared.resolved,
      )
    : resolveSettingsForAuthority(
        db,
        task,
        project,
        request,
        prepared.authority,
      );
}

/** Builds an optimistic request against the actual server-owned pinned target. */
export async function serverTaskLaunchRequest(
  db: Db,
  source: TaskLaunchServerSource,
  selection: Omit<
    TaskLaunchRequest,
    "expectedTaskRevision" | "expectedSettingsToken"
  >,
): Promise<TaskLaunchRequest> {
  assertTaskLaunchServerSource(source);
  const current = await scopedTask(db, selection.taskId);

  if (
    current.project.id !== source.snapshot.projectId ||
    current.task.id !== source.snapshot.taskId
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  await source.assertCurrent(db, source.snapshot);
  const cleanSelection = Object.fromEntries(
    Object.entries(selection).filter(([, value]) => value !== undefined),
  );
  const parsed = taskLaunchBodySchema.safeParse({
    ...cleanSelection,
    expectedTaskRevision: current.task.revision,
    expectedSettingsToken: "server-preflight",
  });

  if (!parsed.success) throw launchRefusal("launch_request_invalid", "CONFIG");
  const settings = await resolveSourceTaskLaunchSettings(
    db,
    current.task,
    current.project,
    parsed.data,
    source,
  );
  const flowAssets =
    settings.kind === "flow"
      ? await captureTaskLaunchFlowAssets(db, {
          flowRevisionId: settings.flowRevisionId,
        })
      : null;

  return {
    ...parsed.data,
    expectedSettingsToken:
      settings.kind === "flow"
        ? composeTaskLaunchSettingsToken(settings.resolutionToken, flowAssets)
        : settings.resolutionToken,
  };
}

function serverTaskLaunchAuthority(
  source: TaskLaunchServerSource,
  request: TaskLaunchRequest,
  audit?: TaskLaunchAuditContext,
): LaunchAcceptanceAuthority {
  assertTaskLaunchServerSource(source);
  if (["budget_restart", "agent_retry"].includes(source.snapshot.kind))
    throw launchRefusal("launch_interactive_origin_required", "PRECONDITION");
  if (request.taskId !== source.snapshot.taskId)
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const assert = async (connection: Db, projectId: string): Promise<void> => {
    if (projectId !== source.snapshot.projectId)
      throw launchRefusal("launch_source_unavailable", "PRECONDITION");
    await assertStoredTaskLaunchServerSource(connection, source.snapshot);
  };

  return {
    [launchAuthority]: true,
    recordSuccessAudit: audit?.recordSuccessAudit,
    basisKind: "automatic",
    serverSource: source,
    operation: source.snapshot.kind === "ralph_retry" ? "retry" : "launch",
    reservationLane: source.snapshot.execution.allowConcurrent
      ? "concurrent"
      : "ordinary",
    replacesIntentId: null,
    expectedStateVersion: null,
    principalKind: "system",
    principalId: `${source.snapshot.kind}:${source.snapshot.id}`,
    actorUserId: null,
    launchSource:
      source.snapshot.kind === "ralph_retry" ? "retry" : "scheduler",
    actor: { type: "system", id: null },
    assertVisibility: assert,
    assert,
    admit: async (connection, task, settings, currentBaseCommit) =>
      task.qualificationMode === "execution_child"
        ? {
            kind: "execution_child",
            parent: await taskExecutionChildAdmissionProof(
              connection,
              task.projectId,
              task.id,
            ),
          }
        : automaticTaskLaunchBasis(
            connection,
            task,
            settings,
            currentBaseCommit,
          ),
  };
}

/** Prepare a source-owned acceptance for atomic token audit or a larger admission transaction. */
export async function prepareServerTaskLaunch(
  db: Db,
  source: TaskLaunchServerSource,
  request: TaskLaunchRequest,
  requestKey: string,
  audit?: TaskLaunchAuditContext,
): Promise<TaskLaunchPreparationOutcome> {
  return prepareTaskLaunchRequest(
    db,
    serverTaskLaunchAuthority(source, request, audit),
    request,
    requestKey,
  );
}

/** Closed producer adapters retain source identity while current qualification supplies automated admission. */
export async function acceptServerTaskLaunch(
  db: Db,
  source: TaskLaunchServerSource,
  request: TaskLaunchRequest,
  requestKey: string,
  audit?: TaskLaunchAuditContext,
): Promise<TaskLaunchReceipt> {
  return acceptTaskLaunch(
    db,
    serverTaskLaunchAuthority(source, request, audit),
    request,
    requestKey,
  );
}

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
  if (authority.serverSource)
    await authority.serverSource.assertCurrent(
      db,
      authority.serverSource.snapshot,
    );
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
  const derivedSource =
    !authority.serverSource && !authority.handoffOriginalRun && request.agentId
      ? await resolveAgentFlowTaskLaunchSource(db, {
          agentId: request.agentId,
          projectId: initial.project.id,
          taskId: request.taskId,
          trigger: { source: "manual" },
          ...(request.runnerId
            ? { launchOverrideRunnerId: request.runnerId }
            : {}),
          ...(request.workspace ? { workspace: request.workspace } : {}),
        })
      : null;
  const acceptanceAuthority: LaunchAcceptanceAuthority = derivedSource
    ? { ...authority, serverSource: derivedSource }
    : authority;

  if (initial.task.revision !== request.expectedTaskRevision)
    throw launchRefusal("launch_input_changed");
  if (
    request.relaunchOfRunId &&
    authority.reservationLane === "ordinary" &&
    authority[sourceHandoffAuthority] !== true
  )
    await captureTaskLaunchRelaunchSource(db, {
      sourceRunId: request.relaunchOfRunId,
      projectId: initial.project.id,
      taskId: initial.task.id,
    });
  const target = await resolveSettingsForAuthority(
    db,
    initial.task,
    initial.project,
    request,
    acceptanceAuthority,
  );
  const flowAssets =
    target.kind === "flow"
      ? await captureTaskLaunchFlowAssets(db, {
          flowRevisionId: target.flowRevisionId,
        })
      : null;
  const resolved = {
    ...target,
    acceptedTaskStatus: initial.task.status,
    ...(flowAssets ? { flowAssets } : {}),
    resolutionToken:
      target.kind === "flow"
        ? composeTaskLaunchSettingsToken(target.resolutionToken, flowAssets)
        : target.resolutionToken,
    capabilityBundles:
      target.workspace === "none"
        ? []
        : await captureTaskLaunchCapabilityBundles(db, initial.project.id),
  };

  if (resolved.resolutionToken !== request.expectedSettingsToken)
    throw launchRefusal("launch_settings_changed");
  const { baseCommit, currentBaseCommit: resourceCommit } =
    await resolveTaskLaunchBase(db, initial.project, resolved, request);
  const currentBaseCommit =
    acceptanceAuthority.basisKind === "automatic" &&
    initial.task.qualificationMode !== "execution_child" &&
    resolved.workspace === "none"
      ? await resolveTaskLaunchAutomaticEvidenceCommit(
          db,
          initial.project,
          request.taskId,
        )
      : resourceCommit;

  log.debug(
    { taskId: request.taskId, currentBaseCommit, baseCommit },
    "task-launch-git-preflight-resolved",
  );

  return {
    kind: "prepared",
    [launchPreparation]: true,
    authority: acceptanceAuthority,
    requestKey,
    request,
    payloadDigest,
    projectId: initial.project.id,
    resolved,
    metadataToken: target.resolutionToken,
    baseCommit,
    currentBaseCommit,
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
  if (
    prepared.authority[sourceHandoffAuthority] &&
    !prepared.authority.serverSource
  )
    throw launchRefusal("launch_handoff_source_required", "PRECONDITION");
  const {
    authority,
    requestKey,
    request,
    payloadDigest,
    projectId,
    resolved,
    baseCommit,
  } = prepared;

  if (authority.serverSource)
    await assertStoredTaskLaunchServerSource(
      tx,
      authority.serverSource.snapshot,
    );
  await authority.assert(
    tx,
    projectId,
    requiresLaunchUnattended(resolved.executionPolicy)
      ? ["launchRun", "launchUnattended"]
      : ["launchRun"],
  );

  if (request.relaunchOfRunId && authority.reservationLane === "ordinary") {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, request.relaunchOfRunId))
      .for("update");
    await captureTaskLaunchRelaunchSource(tx, {
      sourceRunId: request.relaunchOfRunId,
      projectId,
      taskId: request.taskId,
    });
  }

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
    .select({
      id: taskLaunchIntents.id,
      runId: taskLaunchIntents.runId,
      basis: taskLaunchIntents.basis,
    })
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.taskId, locked.id),
        inArray(taskLaunchIntents.state, ACTIVE_INTENT_STATES),
      ),
    )
    .limit(1);

  if (reserved && authority.reservationLane === "ordinary")
    throw taskLaunchReservationConflict({
      intentId: reserved.id,
      runId: reserved.runId,
      basis: reserved.basis.kind,
    });
  const [liveRun] = await tx
    .select({
      id: runs.id,
      intentId: runs.taskLaunchIntentId,
      admission: runs.taskAdmissionSnapshot,
    })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, locked.id),
        sql`${runs.agentKind} IS DISTINCT FROM 'operational'`,
        sql`(${runs.taskAdmissionSnapshot}->>'version'='3' AND ${runs.taskAdmissionSnapshot}->>'mode'='execution_child' AND ${runs.taskAdmissionSnapshot}->>'scope'='consensus_draft') IS DISTINCT FROM TRUE`,
        inArray(runs.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(1);

  if (liveRun && authority.reservationLane === "ordinary")
    throw taskLaunchReservationConflict({
      intentId: liveRun.intentId,
      runId: liveRun.id,
      basis:
        liveRun.admission?.version === 2
          ? liveRun.admission.basis
          : "historical",
    });
  if (locked.revision !== request.expectedTaskRevision)
    throw launchRefusal("launch_input_changed");
  if (
    authority.basisKind !== "manual" &&
    ["Done", "Abandoned"].includes(locked.status)
  )
    throw launchRefusal("target_terminal", "PRECONDITION");
  if (locked.queuePaused) throw launchRefusal("queue_paused", "PRECONDITION");
  if ((await countOpenBlockingClarifications(locked.id, tx)) > 0)
    throw launchRefusal("clarification_pending", "PRECONDITION");
  if ((await getOpenRelationBlockers([locked.id], tx)).get(locked.id)?.length)
    throw launchRefusal("blocked", "PRECONDITION");
  const beforeConfiguration = await scopedTask(tx, locked.id);
  const currentResolution = await resolvePreparedSettingsForAuthority(
    tx,
    locked,
    beforeConfiguration.project,
    request,
    prepared,
  );

  if (currentResolution.resolutionToken !== prepared.metadataToken)
    throw launchRefusal("launch_settings_changed");
  const configuration = {
    flowId: resolved.flowId,
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

  if (
    resolved.kind === "flow" &&
    !authority.serverSource &&
    authority.reservationLane === "ordinary" &&
    retryDigest(configuration) !== retryDigest(previousConfiguration)
  ) {
    await authority.assert(tx, locked.projectId, ["launchRun", "editTask"]);
    [launchTask] = await tx
      .update(tasks)
      .set({ ...configuration, revision: locked.revision + 1 })
      .where(eq(tasks.id, locked.id))
      .returning();
  }
  const current = await scopedTask(tx, locked.id);
  const settings = {
    ...bindTaskLaunchSettingsBase(
      await resolvePreparedSettingsForAuthority(
        tx,
        launchTask,
        current.project,
        request,
        prepared,
      ),
      baseCommit,
    ),
    ...(prepared.resolved.flowAssets
      ? { flowAssets: prepared.resolved.flowAssets }
      : {}),
    capabilityBundles: prepared.resolved.capabilityBundles,
    acceptedTaskStatus: locked.status,
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
  const basis = await authority.admit(
    tx,
    launchTask,
    settings,
    prepared.currentBaseCommit,
  );
  const [accepted] = await tx
    .insert(taskLaunchIntents)
    .values({
      id: randomUUID(),
      projectId: locked.projectId,
      taskId: locked.id,
      principalKind: authority.principalKind,
      principalId: authority.principalId,
      actorUserId: authority.actorUserId,
      launchSource:
        basis.kind === "execution_child"
          ? "execution_child"
          : authority.launchSource,
      operation: authority.operation,
      reservationLane: authority.reservationLane,
      replacesIntentId: authority.replacesIntentId,
      sourceRunId: request.relaunchOfRunId ?? null,
      requestKey,
      payloadDigest,
      taskRevision: launchTask.revision,
      inputRevision: launchTask.qualificationInputRevision,
      inputDigest: retryDigest(snapshot),
      inputSnapshot: snapshot,
      settingsDigest: retryDigest(settings),
      settingsSnapshot: settings,
      basis,
      dueAt: sql`clock_timestamp()`,
    })
    .returning();

  await recordTaskAgentTriggerIntentAccepted(tx, accepted);
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

/** Read-only preparation for an interactive decision whose caller atomically terminalizes its source before apply. */
export async function prepareInteractiveTaskLaunchHandoff(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  request: TaskLaunchRequest,
  requestKey: string,
  source?: TaskLaunchServerSource,
  originalRun?: Run,
): Promise<TaskLaunchPreparationOutcome> {
  if (!request.relaunchOfRunId)
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  if (!source && request.agentId && !originalRun)
    throw launchRefusal("launch_handoff_source_required", "PRECONDITION");
  const authority = interactiveTaskLaunchAuthority(principal);

  if (source) {
    assertTaskLaunchServerSource(source);
    if (
      source.snapshot.taskId !== request.taskId ||
      source.snapshot.kind !== "budget_restart"
    )
      throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  }

  return prepareTaskLaunchRequest(
    db,
    {
      ...authority,
      ...(originalRun ? { handoffOriginalRun: originalRun } : {}),
      ...(source
        ? {
            serverSource: source,
            operation: "retry" as const,
            launchSource: "retry" as const,
          }
        : {}),
      [sourceHandoffAuthority]: true,
    },
    request,
    requestKey,
  );
}

/** A real session decision can select a database-owned Flow-driving facade without becoming automation. */
export async function acceptInteractiveSourceTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  source: TaskLaunchServerSource,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  assertTaskLaunchServerSource(source);
  if (
    source.snapshot.kind !== "agent_trigger" ||
    source.snapshot.taskId !== request.taskId
  )
    throw launchRefusal("launch_source_authority_required", "PRECONDITION");
  const authority = interactiveTaskLaunchAuthority(principal);

  return acceptTaskLaunch(
    db,
    { ...authority, serverSource: source },
    request,
    requestKey,
  );
}

/** A task agent retry is a fresh session decision; the failed run supplies provenance, never a permanent grant. */
export async function acceptInteractiveAgentTaskRetry(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  source: TaskLaunchServerSource,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  assertTaskLaunchServerSource(source);
  if (
    source.snapshot.kind !== "agent_retry" ||
    source.snapshot.taskId !== request.taskId
  )
    throw launchRefusal("launch_source_authority_required", "PRECONDITION");
  const authority = interactiveTaskLaunchAuthority(principal);

  return acceptTaskLaunch(
    db,
    {
      ...authority,
      serverSource: source,
      operation: "retry",
      launchSource: "retry",
    },
    request,
    requestKey,
  );
}

/** Explicit session relaunch has its own lane; normal clicks and bearer callers cannot select it. */
export async function acceptConcurrentInteractiveTaskLaunch(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  request: TaskLaunchRequest,
  requestKey: string,
): Promise<TaskLaunchReceipt> {
  const authority = interactiveTaskLaunchAuthority(principal);

  return acceptTaskLaunch(
    db,
    { ...authority, reservationLane: "concurrent" },
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
    basisKind: "automatic",
    operation: "launch",
    reservationLane: "ordinary",
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
    admit: async (tx, task, settings, currentBaseCommit) => ({
      ...(await armedAutomaticTaskLaunchBasis(
        tx,
        task,
        settings,
        currentBaseCommit,
      )),
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
    basisKind: "manual",
    operation: "launch",
    reservationLane: "ordinary",
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
    admit: async (_tx, task) => {
      if (isManualTriageHold(task)) throw launchRefusal("launch_task_held");

      return { kind: "manual", userId: principal.userId };
    },
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
      basisKind: "automatic",
      operation: "launch",
      reservationLane: "ordinary",
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
