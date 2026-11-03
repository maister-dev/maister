import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput, LoadedAgentContext } from "./launch";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";
import type { AgentExecutionPolicyRecommendation } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import { buildAgentActivitySnapshot } from "./activity-snapshot";
import { assertScheduledRequestMatches } from "./scheduled-request-store";
import { resolveScheduledRequestFlowRevision } from "./scheduled-request-flow";
import { retryDigest } from "./retry-guards";
import {
  loadTaskAgentTriggerReservation,
  assertTaskAgentTriggerReservation,
} from "./task-trigger-reservation";
import { parseScheduledRequestSnapshot } from "./scheduled-request";

import {
  agents,
  agentProjectLinks,
  domainEvents,
  flows,
  projects,
} from "@/lib/db/schema";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { launchRefusal } from "@/lib/tasks/launch-resolution";
import { agentTargetMetadataToken } from "@/lib/tasks/launch-agent-resolution";
import { taskExecutionChildAdmissionProof } from "@/lib/tasks/qualification-admission";

type AgentFlowLaunchInput = LaunchAgentRunInput & Readonly<{ taskId: string }>;

async function assertAgentTaskDomainEventSource(
  db: Db,
  scope: Readonly<{
    projectId: string;
    taskId: string;
    eventId: number | null;
    parentRunId: string | null;
  }>,
): Promise<void> {
  if (scope.eventId === null) {
    const proof = await taskExecutionChildAdmissionProof(
      db,
      scope.projectId,
      scope.taskId,
    );

    if (!scope.parentRunId || proof.parentRunId !== scope.parentRunId)
      throw launchRefusal("launch_source_unavailable", "PRECONDITION");

    return;
  }
  const [event] = await db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.id, scope.eventId));

  if (
    !event ||
    event.projectId !== scope.projectId ||
    (event.taskId && event.taskId !== scope.taskId)
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
}

async function agentTaskSourceSnapshot(
  db: Db,
  input: AgentFlowLaunchInput,
  context: LoadedAgentContext,
): Promise<TaskLaunchServerSourceSnapshot> {
  const flowRef = context.effective.parsed.flow;

  if (
    context.effective.parsed.kind !== "code_delivery" ||
    (Boolean(flowRef) && input.workspace)
  )
    throw launchRefusal("launch_agent_target_unsupported", "PRECONDITION");
  const [flow] = flowRef
    ? await db
        .select()
        .from(flows)
        .where(
          and(
            eq(flows.projectId, input.projectId),
            eq(flows.flowRefId, flowRef),
          ),
        )
    : [];
  const agentWorkspace = flowRef
    ? undefined
    : (input.workspace ?? context.effective.parsed.workspace);

  if (flowRef && !flow) throw launchRefusal("flow_unavailable", "PRECONDITION");
  let scheduledRequestSnapshot = input.scheduledRequestSnapshot ?? null;
  const attempt = await loadTaskAgentTriggerReservation(db, input);
  const reservation = attempt
    ? { attemptId: attempt.id, runId: attempt.reservedRunId }
    : input.agentTriggerReservation;

  if (input.trigger.source === "cron" && !attempt)
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  if (attempt) {
    const frozenRequest = parseScheduledRequestSnapshot(
      attempt.scheduledRequestSnapshot,
    );

    if (input.scheduledRequestSnapshot !== undefined)
      assertScheduledRequestMatches(
        frozenRequest,
        input.scheduledRequestSnapshot,
      );
    scheduledRequestSnapshot = frozenRequest;
  }
  if (input.trigger.source === "domain_event")
    await assertAgentTaskDomainEventSource(db, {
      projectId: input.projectId,
      taskId: input.taskId,
      eventId: input.trigger.eventId ?? null,
      parentRunId: input.parentRunId ?? null,
    });
  const instance = context.link
    .executionPolicyOverride as AgentExecutionPolicyRecommendation | null;
  const recommended = context.effective.parsed.recommended?.executionPolicy;
  const autoApply = instance?.autoApply ?? recommended?.autoApply;
  const onBudgetBreach =
    instance?.onBudgetBreach ?? recommended?.onBudgetBreach;
  const agentPolicyOverlay: AgentExecutionPolicyRecommendation | null =
    autoApply || onBudgetBreach
      ? {
          ...(autoApply ? { autoApply } : {}),
          ...(onBudgetBreach ? { onBudgetBreach } : {}),
        }
      : null;
  const scheduledFlowRevisionId =
    flow && scheduledRequestSnapshot?.requestAtLaunch
      ? await resolveScheduledRequestFlowRevision(db, flow)
      : undefined;
  const execution = {
    ...(flow ? { flowId: flow.id } : {}),
    agentId: input.agentId,
    agentActivity: buildAgentActivitySnapshot(input.agentId, context.effective),
    triggerSource: input.trigger.source,
    triggerEventId: input.trigger.eventId ?? null,
    triggerPayload: input.trigger.payload ?? null,
    agentScheduleId: input.agentScheduleId ?? null,
    scheduledRequestSnapshot,
    ...(reservation
      ? {
          agentTriggerReservation: {
            ...reservation,
            ...(scheduledFlowRevisionId
              ? { flowRevisionId: scheduledFlowRevisionId }
              : {}),
          },
        }
      : {}),
    ...(scheduledFlowRevisionId ? { scheduledFlowRevisionId } : {}),
    ...(agentPolicyOverlay ? { agentPolicyOverlay } : {}),
    packagePin: { packageInstallId: context.effective.packageInstallId },
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.rootRunId ? { rootRunId: input.rootRunId } : {}),
    ...(input.launchMode ? { launchMode: input.launchMode } : {}),
    ...(input.resultContract !== undefined
      ? { resultContract: input.resultContract }
      : {}),
    ...(input.persistent !== undefined ? { persistent: input.persistent } : {}),
    ...(input.addressableKey !== undefined
      ? { addressableKey: input.addressableKey }
      : {}),
    ...(input.workspaceMode !== undefined
      ? { workspaceMode: input.workspaceMode }
      : {}),
  };
  const identity = {
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
    source: input.trigger.source,
    eventId: input.trigger.eventId ?? null,
    attemptId: reservation?.attemptId ?? null,
    ...(agentWorkspace ? { agentWorkspace } : {}),
  };
  const branchBase =
    context.link.branchBase ??
    context.effective.parsed.recommended?.branch_base ??
    null;

  return {
    version: 1,
    kind: "agent_trigger",
    id: `agent:${retryDigest(identity)}`,
    projectId: input.projectId,
    taskId: input.taskId,
    revisionDigest: retryDigest({
      identity,
      metadataDigest: await agentTargetMetadataToken(
        db,
        context.project as typeof projects.$inferSelect,
        {
          agentId: input.agentId,
          ...(agentWorkspace ? { workspace: agentWorkspace } : {}),
        },
      ),
      execution,
      branchBase,
      ...(agentWorkspace ? { agentWorkspace } : {}),
    }),
    execution,
    ...(branchBase ? { branchBase } : {}),
    ...(agentWorkspace ? { agentWorkspace } : {}),
  };
}

/** Trigger provenance is source data; only the caller's opaque session principal can grant manual admission. */
export async function createAgentFlowTaskLaunchSource(
  db: Db,
  input: AgentFlowLaunchInput,
): Promise<TaskLaunchServerSource> {
  const source = await resolveAgentFlowTaskLaunchSource(db, input);

  if (!source)
    throw launchRefusal("launch_agent_target_unsupported", "PRECONDITION");

  return source;
}

/** Null identifies a genuine standalone target; operational agents retain their separate launch contract. */
export async function resolveAgentFlowTaskLaunchSource(
  db: Db,
  input: AgentFlowLaunchInput,
): Promise<TaskLaunchServerSource | null> {
  const { loadAgentContext } = await import("./launch");
  const context = await loadAgentContext(db, input);

  if (context.effective.parsed.kind !== "code_delivery")
    throw launchRefusal("launch_agent_target_unsupported", "PRECONDITION");
  if (!context.effective.parsed.flow) return null;

  return createTaskLaunchServerSource(
    db,
    await agentTaskSourceSnapshot(db, input, context),
    assertStoredAgentTriggerLaunchSource,
  );
}

/** A standalone trigger receives the same source owner without inventing a delivery Flow. */
export async function createStandaloneAgentTaskLaunchSource(
  db: Db,
  input: AgentFlowLaunchInput,
): Promise<TaskLaunchServerSource> {
  const { loadAgentContext } = await import("./launch");
  const context = await loadAgentContext(db, input);

  if (
    context.effective.parsed.kind !== "code_delivery" ||
    context.effective.parsed.flow
  )
    throw launchRefusal("launch_agent_target_unsupported", "PRECONDITION");

  return createTaskLaunchServerSource(
    db,
    await agentTaskSourceSnapshot(db, input, context),
    assertStoredAgentTriggerLaunchSource,
  );
}

/** Reconstructed on restart from the source owner, with current enablement, trust and attachment policy. */
export async function assertStoredAgentTriggerLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const execution = source.execution;

  if (
    source.kind !== "agent_trigger" ||
    (source.agentWorkspace !== undefined &&
      (!["none", "repo_read", "worktree"].includes(source.agentWorkspace) ||
        Boolean(execution.flowId))) ||
    (execution.triggerSource === "cron" &&
      !execution.agentTriggerReservation) ||
    !execution.agentId ||
    !execution.triggerSource ||
    !["manual", "cron", "domain_event", "webhook", "flow"].includes(
      execution.triggerSource,
    )
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, execution.agentId))
    .for("share");
  await db
    .select({ id: agentProjectLinks.id })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, execution.agentId),
        eq(agentProjectLinks.projectId, source.projectId),
      ),
    )
    .for("share");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, source.projectId));

  if (!project)
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  await assertTaskAgentTriggerReservation(db, source);
  if (execution.triggerSource === "domain_event")
    await assertAgentTaskDomainEventSource(db, {
      projectId: source.projectId,
      taskId: source.taskId,
      eventId: execution.triggerEventId ?? null,
      parentRunId: execution.parentRunId ?? null,
    });
  const identity = {
    agentId: execution.agentId,
    projectId: source.projectId,
    taskId: source.taskId,
    source: execution.triggerSource,
    eventId: execution.triggerEventId ?? null,
    attemptId: execution.agentTriggerReservation?.attemptId ?? null,
    ...(source.agentWorkspace ? { agentWorkspace: source.agentWorkspace } : {}),
  };
  const digest = retryDigest({
    identity,
    metadataDigest: await agentTargetMetadataToken(db, project, {
      agentId: execution.agentId,
      ...(source.agentWorkspace ? { workspace: source.agentWorkspace } : {}),
    }),
    execution,
    branchBase: source.branchBase ?? null,
    ...(source.agentWorkspace ? { agentWorkspace: source.agentWorkspace } : {}),
  });

  if (
    source.id !== `agent:${retryDigest(identity)}` ||
    digest !== source.revisionDigest
  )
    throw launchRefusal("launch_source_changed", "PRECONDITION");
}
