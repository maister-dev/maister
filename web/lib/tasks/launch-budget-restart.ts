import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";
import type { BudgetRestartPreview } from "./launch-budget-restart-contract";
import type { TaskLaunchRequest } from "./launch-schema";

import { and, asc, eq } from "drizzle-orm";

import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import { assertTaskLaunchUserAuthority } from "./launch-authority";
import { taskLaunchSettingsToken } from "./launch-resolution";
import { taskLaunchBodySchema } from "./launch-schema";
import {
  loadTaskSemanticInput,
  taskLaunchEffectivePrompt,
} from "./launch-input";
import { prepareInteractiveTaskLaunchHandoff } from "./launch-intent";

import {
  flows,
  hitlRequests,
  runs,
  runSessions,
  tasks,
  workspaces,
  taskLaunchIntents,
  agents,
  flowRevisions,
  packageInstalls,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export function budgetRestartDecisionRequired(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Preview the current request and settings, then confirm Restart; an older restart cannot authorize a changed request",
    { details: { reason: "budget_restart_preview_required" } },
  );
}

export function readBudgetRestartLaunch(value: unknown): TaskLaunchRequest {
  const parsed = taskLaunchBodySchema.safeParse(value);

  if (!parsed.success || !parsed.data.relaunchOfRunId)
    throw budgetRestartDecisionRequired();

  return parsed.data;
}

/** Read only: the displayed request is submitted unchanged with the subsequent destructive decision. */
export async function previewBudgetRestart(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  runId: string,
  hitlRequestId: string,
): Promise<BudgetRestartPreview> {
  assertInteractiveTaskLaunchPrincipal(principal);
  const [source] = await db.select().from(runs).where(eq(runs.id, runId));

  if (!source?.projectId || !source.taskId)
    throw budgetRestartDecisionRequired();
  await assertTaskLaunchUserAuthority(db, source.projectId, principal.userId, [
    "answerHitl",
    "launchRun",
  ]);
  const [gate] = await db
    .select()
    .from(hitlRequests)
    .where(
      and(eq(hitlRequests.id, hitlRequestId), eq(hitlRequests.runId, runId)),
    );

  if (
    !gate ||
    gate.kind !== "budget_breach" ||
    gate.respondedAt ||
    !["NeedsInput", "NeedsInputIdle"].includes(source.status) ||
    source.parentRunId ||
    (source.runKind !== "flow" && source.runKind !== "agent") ||
    source.agentKind === "operational" ||
    (source.runKind === "flow" && !source.flowId) ||
    (source.runKind === "agent" && (!source.agentId || !source.agentWorkspace))
  )
    throw budgetRestartDecisionRequired();
  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.id, source.taskId), eq(tasks.projectId, source.projectId)),
    )
    .for("share");
  const [flow] = source.flowId
    ? await db.select().from(flows).where(eq(flows.id, source.flowId))
    : [];
  const [agent] =
    source.runKind === "agent" && source.agentId
      ? await db.select().from(agents).where(eq(agents.id, source.agentId))
      : [];
  const [origin] = source.taskLaunchIntentId
    ? await db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, source.taskLaunchIntentId))
    : [];
  const [session] = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, source.id))
    .orderBy(asc(runSessions.sessionName))
    .limit(1);
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, source.id));

  if (
    !task ||
    (source.runKind === "flow" && !flow) ||
    (source.runKind === "agent" && !agent) ||
    !session?.runnerSnapshot ||
    !session.runnerId ||
    (source.agentWorkspace !== "none" && (!workspace || workspace.removedAt))
  )
    throw budgetRestartDecisionRequired();
  if (
    source.runKind === "agent" &&
    origin &&
    (origin.settingsSnapshot.kind !== "agent" ||
      origin.settingsSnapshot.agentId !== source.agentId ||
      origin.settingsSnapshot.workspace !== source.agentWorkspace)
  )
    throw budgetRestartDecisionRequired();
  const target: Partial<TaskLaunchRequest> =
    source.runKind === "flow" && source.flowId
      ? { flowId: source.flowId }
      : source.agentId && source.agentWorkspace
        ? { agentId: source.agentId, workspace: source.agentWorkspace }
        : {};
  const targetName = source.runKind === "flow" ? flow?.flowRefId : agent?.name;

  if ((!target.agentId && !target.flowId) || !targetName)
    throw budgetRestartDecisionRequired();
  const selection = {
    ...target,
    runnerId: session.runnerId,
    relaunchOfRunId: source.id,
    ...(workspace?.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
    ...(workspace?.targetBranch
      ? { targetBranch: workspace.targetBranch }
      : {}),
    executionPolicy: source.executionPolicy,
    ...(source.deliveryPolicySnapshot
      ? { deliveryPolicy: source.deliveryPolicySnapshot }
      : {}),
    brainContext: source.brainContext,
    autoPromote:
      origin?.settingsSnapshot.autoPromote ??
      source.promotionHold?.source !== "launch",
  };
  const request = taskLaunchBodySchema.parse({
    ...selection,
    taskId: task.id,
    expectedTaskRevision: task.revision,
    expectedSettingsToken: await taskLaunchSettingsToken(
      db,
      task.id,
      selection,
    ),
  });
  const semantic = await loadTaskSemanticInput(db, source.projectId, task.id);
  const prepared = await prepareInteractiveTaskLaunchHandoff(
    db,
    principal,
    request,
    `budget_preview:${hitlRequestId}`,
    undefined,
    source,
  );

  if (prepared.kind !== "prepared") throw budgetRestartDecisionRequired();
  const selected = prepared.resolved;
  const [revision] =
    selected.kind === "flow"
      ? await db
          .select({ label: flowRevisions.versionLabel })
          .from(flowRevisions)
          .where(eq(flowRevisions.id, selected.flowRevisionId))
      : await db
          .select({ label: packageInstalls.versionLabel })
          .from(packageInstalls)
          .where(
            eq(packageInstalls.id, selected.agentSnapshot.packageInstallId),
          );

  if (selected.sessions.length === 0 || !revision)
    throw budgetRestartDecisionRequired();

  return {
    request,
    title: task.title,
    prompt: taskLaunchEffectivePrompt(semantic.snapshot),
    flowName: targetName,
    runnerLabel: selected.sessions
      .map(
        (session) =>
          `${session.sessionName} · ${session.runnerSnapshot.capabilityAgent} · ${session.runnerSnapshot.model}`,
      )
      .join("; "),
    targetRevision: revision.label,
    settings: {
      executionPolicy: selected.executionPolicy,
      deliveryPolicy: selected.deliveryPolicy,
      autoPromote: selected.autoPromote,
      brainContext: selected.brainContext ?? null,
      targetBranch: selected.targetBranch,
      workspace: selected.workspace,
    },
  };
}
