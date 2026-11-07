import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "@/lib/tasks/launch-schema";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";
import type { RetryPreparation } from "./retry-preparation";

import { eq } from "drizzle-orm";

import { retryDigest, retryRefusal, retrySafetyReason } from "./retry-guards";

import { projects, runs, taskLaunchIntents } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  loadTaskSemanticInput,
  taskLaunchEffectivePrompt,
} from "@/lib/tasks/launch-input";
import { serverTaskLaunchRequest } from "@/lib/tasks/launch-intent";
import { resolveServerAgentTaskLaunchSettings } from "@/lib/tasks/launch-agent-resolution";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";

export function taskRetryDecisionRequired(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "This retry needs a current task Launch decision; open the task, review its input and settings, then Launch",
    { details: { reason: "retry_launch_upgrade_required" } },
  );
}

async function loadSource(
  db: Db,
  runId: string,
): Promise<{
  source: typeof runs.$inferSelect;
  origin: typeof taskLaunchIntents.$inferSelect;
}> {
  const [source] = await db.select().from(runs).where(eq(runs.id, runId));
  const [origin] = source?.taskLaunchIntentId
    ? await db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, source.taskLaunchIntentId))
    : [];

  if (
    !source?.projectId ||
    !source.taskId ||
    source.runKind !== "agent" ||
    source.agentKind !== "code_delivery" ||
    !source.agentId ||
    !source.agentWorkspace ||
    !origin ||
    origin.runId !== source.id ||
    origin.projectId !== source.projectId ||
    origin.taskId !== source.taskId ||
    origin.inputSnapshot.version !== 2 ||
    origin.settingsSnapshot.version !== 2 ||
    origin.settingsSnapshot.kind !== "agent" ||
    origin.settingsSnapshot.agentId !== source.agentId ||
    !origin.settingsSnapshot.agentSnapshot
  )
    throw taskRetryDecisionRequired();

  return { source, origin };
}

function sourceDigest(
  source: typeof runs.$inferSelect,
  origin: typeof taskLaunchIntents.$inferSelect,
): string {
  return retryDigest({
    runId: source.id,
    intentId: origin.id,
    inputDigest: origin.inputDigest,
    settingsDigest: origin.settingsDigest,
    triggerSource: source.triggerSource,
    triggerEventId: source.triggerEventId,
    triggerPayload: source.triggerPayload,
    scheduledRequestSnapshot: source.scheduledRequestSnapshot,
  });
}

/** Preview binds current displayed tokens while retaining the actual source workspace and policies. */
export async function previewAgentTaskRetry(
  db: Db,
  preparation: RetryPreparation,
  runnerId: string,
): Promise<{ request: TaskLaunchRequest; title: string; prompt: string }> {
  const { source, origin } = await loadSource(db, preparation.source.id);
  const settings = origin.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot
  )
    throw taskRetryDecisionRequired();
  const { task, snapshot } = await loadTaskSemanticInput(
    db,
    source.projectId!,
    source.taskId!,
  );

  if (retryDigest(snapshot) !== retryDigest(origin.inputSnapshot))
    throw retryRefusal("retry_task_changed");
  const selection = {
    agentId: settings.agentId,
    workspace: settings.workspace,
    runnerId,
    relaunchOfRunId: source.id,
    baseBranch: settings.baseBranch,
    targetBranch: settings.targetBranch,
    executionPolicy: settings.executionPolicy,
    deliveryPolicy: settings.deliveryPolicy,
    autoPromote: settings.autoPromote,
    brainContext: settings.brainContext ?? null,
  };
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, source.projectId!));

  if (!project) throw taskRetryDecisionRequired();
  const authority = await createAgentTaskRetryLaunchSource(db, {
    ...selection,
    taskId: task.id,
    expectedTaskRevision: task.revision,
    expectedSettingsToken: "source-preview",
  });
  const current = await resolveServerAgentTaskLaunchSettings(
    db,
    task,
    project,
    selection,
    authority.snapshot,
  );
  const request = await serverTaskLaunchRequest(db, authority, {
    ...selection,
    taskId: task.id,
  });

  if (
    current.kind !== "agent" ||
    !current.agentSnapshot ||
    current.definitionSha256 !== settings.definitionSha256 ||
    current.agentSnapshot.packageInstallId !==
      settings.agentSnapshot.packageInstallId ||
    current.agentSnapshot.configurationDigest !==
      settings.agentSnapshot.configurationDigest ||
    current.agentSnapshot.attachmentDigest !==
      settings.agentSnapshot.attachmentDigest ||
    current.agentSnapshot.packageContentDigest !==
      settings.agentSnapshot.packageContentDigest ||
    retryDigest(current.executionPolicy) !==
      retryDigest(settings.executionPolicy)
  )
    throw retryRefusal("retry_context_changed");

  return {
    request,
    title: task.title,
    prompt: taskLaunchEffectivePrompt(snapshot),
  };
}

/** The immutable failed source supplies provenance, never the new user's manual authority. */
export async function createAgentTaskRetryLaunchSource(
  db: Db,
  request: TaskLaunchRequest,
): Promise<TaskLaunchServerSource> {
  if (!request.relaunchOfRunId) throw taskRetryDecisionRequired();
  const { source, origin } = await loadSource(db, request.relaunchOfRunId);

  if (
    request.taskId !== source.taskId ||
    request.agentId !== source.agentId ||
    request.workspace !== source.agentWorkspace ||
    !["manual", "cron", "domain_event", "webhook"].includes(
      source.triggerSource ?? "",
    )
  )
    throw taskRetryDecisionRequired();

  return createTaskLaunchServerSource(
    db,
    {
      version: 1,
      kind: "agent_retry",
      id: source.id,
      projectId: source.projectId!,
      taskId: source.taskId!,
      revisionDigest: sourceDigest(source, origin),
      agentWorkspace: source.agentWorkspace!,
      execution: {
        agentId: source.agentId!,
        triggerSource: source.triggerSource as
          "manual" | "cron" | "domain_event" | "webhook",
        triggerEventId: source.triggerEventId,
        triggerPayload: source.triggerPayload,
      },
    },
    assertStoredAgentTaskRetryLaunchSource,
  );
}

/** Restart reconstruction checks positive pre-work evidence and immutable source scope. */
export async function assertStoredAgentTaskRetryLaunchSource(
  db: Db,
  snapshot: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  if (snapshot.kind !== "agent_retry") throw taskRetryDecisionRequired();
  const { source, origin } = await loadSource(db, snapshot.id);

  if (
    source.projectId !== snapshot.projectId ||
    source.taskId !== snapshot.taskId ||
    source.agentWorkspace !== snapshot.agentWorkspace ||
    sourceDigest(source, origin) !== snapshot.revisionDigest ||
    retryDigest(snapshot.execution) !==
      retryDigest({
        agentId: source.agentId,
        triggerSource: source.triggerSource,
        triggerEventId: source.triggerEventId,
        triggerPayload: source.triggerPayload,
      })
  )
    throw taskRetryDecisionRequired();
  const reason = await retrySafetyReason(db, source);

  if (reason) throw retryRefusal(reason);
}
