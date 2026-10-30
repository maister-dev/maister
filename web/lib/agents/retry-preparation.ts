import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { AgentRetryRecipe } from "@/lib/agents/retry-types";
import type { LoadedAgentContext } from "@/lib/agents/launch";
import type { AgentTriggerSource } from "@/lib/agents/launch";

import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { runs, runSessions, platformAcpRunners, tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertRetryAuthority,
  retrySafetyReason,
  retryRefusal,
  retryDigest,
} from "@/lib/agents/retry-guards";
export {
  assertRetryAuthority,
  retrySafetyReason,
  retryRefusal,
  retryDigest,
} from "@/lib/agents/retry-guards";
import {
  loadAgentContext,
  resolveRunnerForAgent,
  runnerCatalogEntry,
  resolveAgentContextExecutionPolicy,
} from "@/lib/agents/launch";
import {
  resolveAgentRunner,
  type RunnerResolution,
} from "@/lib/acp-runners/resolve";
import { resolveAgentConfig } from "@/lib/agents/config";
import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";

export const RETRY_PREVIEW_WINDOW_MS = 5 * 60_000;
export type RetryRunnerOption = {
  id: string;
  label: string;
  ready: boolean;
  reason: string | null;
};
export type AgentRetryOptions = {
  eligible: boolean;
  reason: string | null;
  expiresAt: string;
  previewFingerprint: string;
  sourceRunnerId: string | null;
  existingIntentId: string | null;
  runners: RetryRunnerOption[];
  differences: Array<{
    field: string;
    source: string | null;
    current: string | null;
  }>;
};
export type RetrySource = Run & {
  projectId: string;
  triggerSource: AgentTriggerSource;
};
export type RetryPreparation = {
  source: RetrySource;
  context: LoadedAgentContext;
  options: AgentRetryOptions;
  resolutions: ReadonlyMap<string, RunnerResolution>;
  taskRevision: number | null;
  contextDigest: string;
};

export async function prepareAgentRetry(
  db: Db,
  runId: string,
  userId: string,
  now: Date = new Date(),
): Promise<RetryPreparation> {
  const [source] = await db.select().from(runs).where(eq(runs.id, runId));

  if (!source)
    throw new MaisterError(
      "PRECONDITION",
      "Agent retry source is unavailable",
      { details: { reason: "retry_source_unavailable" } },
    );
  if (!source.projectId) throw retryRefusal("retry_source_unsupported");
  if (!isRetryTrigger(source.triggerSource))
    throw retryRefusal("retry_trigger_unsupported");
  const qualifiedSource: RetrySource = {
    ...source,
    projectId: source.projectId,
    triggerSource: source.triggerSource,
  };

  await assertRetryAuthority(db, source.projectId, userId);
  const agentId = source.sourceAgentId ?? source.agentId;

  if (!agentId) throw retryRefusal("retry_agent_unknown");
  const context = await loadAgentContext(db, {
    agentId,
    projectId: source.projectId,
    taskId: source.taskId,
    trigger: {
      source: qualifiedSource.triggerSource,
      payload: source.triggerPayload,
    },
  });
  let reason = await retrySafetyReason(db, source);

  if (context.effective.parsed.flow) reason = "retry_source_unsupported";
  const [task] = source.taskId
    ? await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, source.taskId),
            eq(tasks.projectId, source.projectId),
          ),
        )
    : [];

  if (
    source.taskId &&
    (!task || task.status !== "Backlog" || task.triageStatus === "triaged")
  )
    reason = "retry_task_changed";
  const catalog = await db
    .select()
    .from(platformAcpRunners)
    .orderBy(platformAcpRunners.id)
    .limit(101);

  if (catalog.length > 100)
    throw new MaisterError(
      "PRECONDITION",
      "Retry runner catalog exceeds the supported 100 candidates",
      { details: { reason: "retry_runner_catalog_limit" } },
    );
  const resolutions = new Map<string, RunnerResolution>();
  const runners: RetryRunnerOption[] = catalog.map((runner) => {
    try {
      const resolution = resolveAgentRunner({
        launchOverrideRunnerId: runner.id,
        link: {},
        agent: {
          mode: context.effective.parsed.mode,
          workspace: context.effective.parsed.workspace,
        },
        project: {},
        platform: { defaultRunnerId: runner.id },
        runners: catalog.map(runnerCatalogEntry),
      });

      resolutions.set(runner.id, resolution);

      return {
        id: runner.id,
        label: `${runner.capabilityAgent} · ${runner.model}`.slice(0, 256),
        ready: true,
        reason: null,
      };
    } catch (error) {
      if (!(error instanceof MaisterError)) throw error;

      return {
        id: runner.id,
        label: `${runner.capabilityAgent} · ${runner.model}`.slice(0, 256),
        ready: false,
        reason: "runner_unavailable_or_incompatible",
      };
    }
  });

  if (!resolutions.size && reason === null) reason = "retry_runner_unavailable";
  const [sourceSession] = await db
    .select({ runnerId: runSessions.runnerId })
    .from(runSessions)
    .where(
      and(eq(runSessions.runId, runId), eq(runSessions.sessionName, "default")),
    );
  const definition = buildAgentActivitySnapshot(agentId, context.effective);
  const configuration = resolveAgentConfig(
    context.effective.parsed.config,
    context.link.config ?? null,
  );
  const taskRevision = task?.qualificationInputRevision ?? null;
  const contextDigest = retryDigest({
    definition,
    configuration,
    taskRevision,
    taskId: source.taskId,
    triggerSource: source.triggerSource,
    triggerPayload: source.triggerPayload,
    project: {
      mainBranch: context.project.mainBranch,
      branchPrefix: context.project.branchPrefix,
      branchBase: context.link.branchBase,
    },
    policy: resolveAgentContextExecutionPolicy(context),
    runners: [...resolutions.values()].map((value) => value.runnerSnapshot),
  });
  const bucket = Math.floor(now.getTime() / RETRY_PREVIEW_WINDOW_MS);
  const differences: AgentRetryOptions["differences"] = [];

  if (
    source.agentActivitySnapshot?.definitionSha256 !==
    definition.definitionSha256
  )
    differences.push({
      field: "definition",
      source: source.agentActivitySnapshot?.definitionSha256 ?? null,
      current: definition.definitionSha256,
    });
  if (source.agentKind !== context.effective.parsed.kind)
    differences.push({
      field: "kind",
      source: source.agentKind ?? "code_delivery",
      current: context.effective.parsed.kind,
    });

  return {
    source: qualifiedSource,
    context,
    resolutions,
    taskRevision,
    contextDigest,
    options: {
      eligible: reason === null,
      reason,
      expiresAt: new Date((bucket + 1) * RETRY_PREVIEW_WINDOW_MS).toISOString(),
      previewFingerprint: retryDigest({ runId, userId, contextDigest, bucket }),
      sourceRunnerId: sourceSession?.runnerId ?? null,
      existingIntentId: null,
      runners,
      differences,
    },
  };
}

export async function retryRecipeFor(
  db: Db,
  preparation: RetryPreparation,
  runnerId: string,
): Promise<AgentRetryRecipe> {
  const { source, context } = preparation;
  const resolution = await resolveRunnerForAgent(
    db,
    context,
    runnerId,
    context.effective.parsed.workspace,
  );

  if (!preparation.resolutions.has(runnerId))
    throw retryRefusal("retry_runner_unavailable");

  return {
    version: 1,
    agentId: source.sourceAgentId ?? source.agentId!,
    projectId: source.projectId,
    taskId: source.taskId,
    taskRevision: preparation.taskRevision,
    definition: context.effective,
    configuration: retryConfiguration(context),
    trigger: {
      source: source.triggerSource,
      eventId: source.triggerEventId,
      payload: source.triggerPayload,
    },
    runner: resolution.runnerSnapshot,
    policy: resolveAgentContextExecutionPolicy(context),
    contextDigest: preparation.contextDigest,
    project: {
      mainBranch: context.project.mainBranch,
      branchPrefix: context.project.branchPrefix,
      branchBase: context.link.branchBase ?? null,
    },
  };
}

function isRetryTrigger(
  value: string | null,
): value is Exclude<AgentTriggerSource, "flow"> {
  return (
    value === "manual" ||
    value === "cron" ||
    value === "domain_event" ||
    value === "webhook"
  );
}

function retryConfiguration(
  context: LoadedAgentContext,
): Record<string, string | number | boolean> {
  const parsed = z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .safeParse(
      resolveAgentConfig(
        context.effective.parsed.config,
        context.link.config ?? null,
      ),
    );

  if (!parsed.success) throw retryRefusal("retry_configuration_invalid");

  return parsed.data;
}
