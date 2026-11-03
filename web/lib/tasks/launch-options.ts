import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchOptionsRequest } from "./launch-schema";
import type { TaskLaunchReceipt } from "./launch-types";
import type { TaskQualificationSummary } from "./qualification-queries";
import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { and, eq } from "drizzle-orm";

import { taskLaunchOptionsSchema } from "./launch-schema";
import { taskLaunchPreview, taskLaunchPreviewState } from "./launch-preview";
import {
  resolveTaskLaunchSettings,
  resolveServerFlowLaunchSettings,
  launchRefusal,
} from "./launch-resolution";

import { tasks, projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";

/** Query parsing is shared by session and bearer adapters after authentication. */
export function readTaskLaunchOptions(
  request: Request,
): TaskLaunchOptionsRequest {
  const params = new URL(request.url).searchParams;

  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    throw new MaisterError(
      "CONFIG",
      "Launch options must not repeat query parameters",
      { details: { reason: "launch_options_invalid" } },
    );
  const raw = Object.fromEntries(params);
  let packageVersions: unknown;

  if (raw.packageVersions !== undefined) {
    if (raw.packageVersions.length > 32_768)
      throw new MaisterError("CONFIG", "Package selection is too large", {
        details: { reason: "launch_options_invalid" },
      });
    try {
      packageVersions = JSON.parse(raw.packageVersions);
    } catch (cause) {
      throw new MaisterError(
        "CONFIG",
        "Package selection must be a JSON object",
        { cause, details: { reason: "launch_options_invalid" } },
      );
    }
  }
  const result = taskLaunchOptionsSchema.safeParse({
    ...raw,
    ...(raw.packageVersions !== undefined ? { packageVersions } : {}),
  });

  if (!result.success)
    throw new MaisterError("CONFIG", "Launch options are invalid", {
      details: { reason: "launch_options_invalid" },
    });

  return result.data;
}

export type TaskLaunchOptionsTarget = Readonly<{
  kind: "flow" | "agent";
  agentId: string;
  workspace: "none" | "repo_read" | "worktree";
  flowId: string | null;
  flowRefId: string | null;
  targetBranch: string;
  runnerIds: ReadonlyArray<string>;
  sessions: ReadonlyArray<
    Readonly<{ sessionName: string; runnerId: string; model: string }>
  >;
  runners: ReadonlyArray<
    Readonly<{ id: string; capabilityAgent: string; model: string }>
  >;
  deliveryPolicy: StoredDeliveryPolicy;
  executionPolicy: ExecutionPolicy;
  autoPromote: boolean;
}>;
export type TaskLaunchOptionsSnapshot = Readonly<{
  taskId: string;
  taskRevision: number;
  settingsToken: string;
  qualification: TaskQualificationSummary | null;
  activeLaunch: TaskLaunchReceipt | null;
  target: TaskLaunchOptionsTarget | null;
}>;

/** Authorization belongs to the adapter; reads never create an intent or resolve repository HEAD. */
export async function taskLaunchOptionsSnapshot(
  db: Db,
  projectId: string,
  selection: TaskLaunchOptionsRequest,
): Promise<TaskLaunchOptionsSnapshot> {
  const [row] = await db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, selection.taskId), eq(tasks.projectId, projectId)));

  if (!row) throw launchRefusal("launch_not_found", "PRECONDITION");
  if (!selection.agentId)
    return {
      taskId: row.task.id,
      taskRevision: row.task.revision,
      ...(await taskLaunchPreview(db, row.task.id, selection)),
      target: null,
    };
  const launchInput = {
    agentId: selection.agentId,
    projectId,
    taskId: row.task.id,
    launchOverrideRunnerId: selection.runnerId,
    trigger: { source: "manual" as const },
    db,
  };
  const { loadAgentContext } = await import("@/lib/agents/launch");
  const context = await loadAgentContext(db, launchInput);
  const { settings, settingsToken } = await (async () => {
    if (!context.effective.parsed.flow) {
      const settings = await resolveTaskLaunchSettings(
        db,
        row.task,
        row.project,
        selection,
      );

      return { settings, settingsToken: settings.resolutionToken };
    }
    if (selection.workspace)
      throw launchRefusal("launch_agent_target_invalid", "CONFIG");
    const { createAgentFlowTaskLaunchSource } =
      await import("@/lib/agents/flow-launch-authority");
    const { serverTaskLaunchRequest } = await import("./launch-intent");
    const source = await createAgentFlowTaskLaunchSource(db, launchInput);
    const {
      agentId: _agentId,
      workspace: _workspace,
      ...flowSelection
    } = selection;
    const request = await serverTaskLaunchRequest(db, source, {
      ...flowSelection,
      flowId: context.effective.parsed.flow,
    });

    const settings = await resolveServerFlowLaunchSettings(
      db,
      row.task,
      row.project,
      request,
      source.snapshot,
    );

    return { settings, settingsToken: request.expectedSettingsToken };
  })();
  const [state, runners] = await Promise.all([
    taskLaunchPreviewState(db, row.task.id),
    loadRunnerCatalog(db),
  ]);

  return {
    taskId: row.task.id,
    taskRevision: row.task.revision,
    settingsToken,
    ...state,
    target: {
      kind: settings.kind,
      agentId: selection.agentId,
      workspace: settings.workspace,
      flowId: settings.flowId,
      flowRefId: settings.flowRefId,
      targetBranch: settings.targetBranch,
      runnerIds: [...new Set(settings.sessions.map((slot) => slot.runnerId))],
      sessions: settings.sessions.map((slot) => ({
        sessionName: slot.sessionName,
        runnerId: slot.runnerId,
        model: slot.runnerSnapshot.model,
      })),
      runners: runners
        .filter((runner) => runner.enabled && runner.ready)
        .map((runner) => ({
          id: runner.id,
          capabilityAgent: runner.capabilityAgent,
          model: runner.model,
        })),
      deliveryPolicy: settings.deliveryPolicy,
      executionPolicy: settings.executionPolicy,
      autoPromote: settings.autoPromote,
    },
  };
}
