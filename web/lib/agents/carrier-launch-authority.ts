import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput, LoadedAgentContext } from "./launch";
import type { LaunchRunInput } from "@/lib/services/runs";
import type { PreparedTaskDeliveryAdmission } from "@/lib/tasks/qualification-admission";

import { and, eq, inArray } from "drizzle-orm";

import { retryDigest } from "./retry-guards";

import {
  tasks,
  projects,
  runs,
  flows,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";
import { loadTaskQualificationInput } from "@/lib/tasks/qualification";
import { loadTaskSemanticInput } from "@/lib/tasks/launch-input";
import { agentTargetMetadataToken } from "@/lib/tasks/launch-agent-resolution";
import { taskLaunchSelectedConfiguration } from "@/lib/tasks/launch-resolution";
import { MaisterError } from "@/lib/errors";

const carrierAuthority = Symbol("fresh taskless agent Flow carrier");

type CarrierScope = Readonly<{
  taskId: string;
  projectId: string;
  agentId: string;
  flowId: string;
  triggerEventId: number | null;
  taskDigest: string;
  metadataDigest: string;
}>;
export type TasklessAgentFlowCarrierAdmission = Readonly<{
  [carrierAuthority]: true;
  scope: CarrierScope;
  admission: PreparedTaskDeliveryAdmission;
}>;

function carrierRefusal(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Taskless agent carrier no longer owns its original request",
    {
      details: { reason: "agent_carrier_scope_changed" },
    },
  );
}

function carrierTaskDigest(task: typeof tasks.$inferSelect): string {
  return retryDigest({
    projectId: task.projectId,
    agentId: task.agentId,
    triggerEventId: task.triggerEventId,
    title: task.title,
    prompt: task.prompt,
    flowId: task.flowId,
    revision: task.revision,
    qualificationInputRevision: task.qualificationInputRevision,
    createdByUserId: task.createdByUserId,
    configuration: taskLaunchSelectedConfiguration(task),
    queuePaused: task.queuePaused,
    triageStatus: task.triageStatus,
    triageFlagOrigin: task.triageFlagOrigin,
  });
}

export function assertPreparedTasklessAgentFlowCarrierAdmission(
  value: TasklessAgentFlowCarrierAdmission,
): void {
  if (value?.[carrierAuthority] !== true) throw carrierRefusal();
}

/** Refuse a mismatched internal caller before allocating any Git workspace. */
export function assertTasklessAgentFlowCarrierInput(
  proof: TasklessAgentFlowCarrierAdmission,
  input: Pick<
    LaunchRunInput,
    "taskId" | "flowId" | "agentId" | "triggerEventId"
  >,
): void {
  assertPreparedTasklessAgentFlowCarrierAdmission(proof);
  const scope = proof.scope;

  if (
    input.taskId !== scope.taskId ||
    input.flowId !== scope.flowId ||
    input.agentId !== scope.agentId ||
    (input.triggerEventId ?? null) !== scope.triggerEventId
  )
    throw carrierRefusal();
}

/** The generated task is an execution carrier, never an exemption for an existing incoming request. */
export async function createTasklessAgentFlowCarrier(
  db: Db,
  context: LoadedAgentContext,
  input: LaunchAgentRunInput,
  flowId: string,
): Promise<
  Readonly<{
    taskId: string;
    deduped: boolean;
    admission: TasklessAgentFlowCarrierAdmission | null;
  }>
> {
  if (
    input.taskId != null ||
    context.effective.parsed.kind !== "code_delivery" ||
    !context.effective.parsed.flow ||
    context.agent.id !== input.agentId ||
    context.project.id !== input.projectId ||
    context.link.agentId !== input.agentId ||
    context.link.projectId !== input.projectId
  )
    throw carrierRefusal();
  const [flow] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(
      and(
        eq(flows.id, flowId),
        eq(flows.projectId, input.projectId),
        eq(flows.flowRefId, context.effective.parsed.flow),
      ),
    );

  if (!flow) throw carrierRefusal();
  const created = await createTask(
    {
      title: `${context.effective.parsed.name} (${input.trigger.source})`,
      prompt: context.effective.parsed.prompt,
      flowId,
      agentId: input.agentId,
      triggerEventId: input.trigger.eventId ?? null,
    },
    { projectId: input.projectId, actorUserId: null },
    db,
  );

  if (created.deduped)
    return { taskId: created.taskId, deduped: true, admission: null };
  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.id, created.taskId), eq(tasks.projectId, input.projectId)),
    );
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId));

  if (
    !task ||
    !project ||
    task.revision !== 0 ||
    task.attemptNumber !== 0 ||
    task.createdByUserId !== null ||
    task.agentId !== input.agentId
  )
    throw carrierRefusal();
  const semantic = await loadTaskSemanticInput(db, input.projectId, task.id);
  const qualification = await loadTaskQualificationInput(
    db,
    input.projectId,
    task.id,
  );
  const scope: CarrierScope = {
    taskId: task.id,
    projectId: input.projectId,
    agentId: input.agentId,
    flowId,
    triggerEventId: input.trigger.eventId ?? null,
    taskDigest: carrierTaskDigest(task),
    metadataDigest: await agentTargetMetadataToken(db, project, {
      agentId: input.agentId,
    }),
  };
  const snapshot = {
    version: 1 as const,
    policyVersion: 1 as const,
    mode: "legacy" as const,
    inputRevision: qualification.inputRevision,
    qualificationId: null,
    qualificationRevision: null,
    evidenceTarget: null,
    evidenceSha: null,
    parent: null,
    carrier: {
      inputSnapshot: semantic.snapshot,
      inputDigest: retryDigest(semantic.snapshot),
      agentId: scope.agentId,
      metadataDigest: scope.metadataDigest,
    },
  };
  const proof: TasklessAgentFlowCarrierAdmission = {
    [carrierAuthority]: true,
    scope,
    admission: {
      snapshot,
      baseCommit: null,
      apply: async (tx) => {
        await assertTasklessAgentFlowCarrierAdmission(tx, proof, {
          taskId: scope.taskId,
          flowId: scope.flowId,
          agentId: scope.agentId,
          triggerEventId: scope.triggerEventId,
        });

        return snapshot;
      },
    },
  };

  return { taskId: task.id, deduped: false, admission: proof };
}

/** Recheck under the run-insert task lock; a later edit or a second attempt cannot reuse this authority. */
export async function assertTasklessAgentFlowCarrierAdmission(
  db: Db,
  proof: TasklessAgentFlowCarrierAdmission,
  input: Pick<
    LaunchRunInput,
    "taskId" | "flowId" | "agentId" | "triggerEventId"
  >,
): Promise<void> {
  assertPreparedTasklessAgentFlowCarrierAdmission(proof);
  assertTasklessAgentFlowCarrierInput(proof, input);
  const scope = proof.scope;

  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.id, scope.taskId), eq(tasks.projectId, scope.projectId)),
    )
    .for("update");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, scope.projectId));
  const semantic = task
    ? await loadTaskSemanticInput(db, scope.projectId, scope.taskId)
    : null;
  const [existing] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, scope.taskId))
    .limit(1);
  const [intent] = await db
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.taskId, scope.taskId),
        inArray(taskLaunchIntents.state, [
          "queued",
          "preparing",
          "run_bound",
          "held",
        ]),
      ),
    )
    .limit(1);

  if (
    !task ||
    !project ||
    project.archivedAt ||
    task.revision !== 0 ||
    task.attemptNumber !== 1 ||
    carrierTaskDigest(task) !== scope.taskDigest ||
    !semantic ||
    proof.admission.snapshot.version !== 1 ||
    retryDigest(semantic.snapshot) !==
      proof.admission.snapshot.carrier?.inputDigest ||
    existing ||
    intent ||
    (await agentTargetMetadataToken(db, project, {
      agentId: scope.agentId,
    })) !== scope.metadataDigest
  )
    throw carrierRefusal();
}
