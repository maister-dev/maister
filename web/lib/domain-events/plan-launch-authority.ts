import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { and, eq } from "drizzle-orm";

import { retryDigest } from "@/lib/agents/retry-guards";
import { resolveAgentFlowTaskLaunchSource } from "@/lib/agents/flow-launch-authority";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { runs, tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { refuseUnsupportedDelegationOption } from "@/lib/orchestrator/delegation-target";
import {
  flowDelegationSnapshot,
  resolveDelegatableFlow,
} from "@/lib/flows/delegatable-flow";
import {
  asFlowDelegationSpec,
  asAgentDelegationSpec,
} from "@/lib/orchestrator/delegation-spec";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { taskExecutionChildAdmissionProof } from "@/lib/tasks/qualification-admission";
import { launchRefusal } from "@/lib/tasks/launch-resolution";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { resolveResultContractForDelegation } from "@/lib/run-results/resolve-profile";

async function planFacts(db: Db, projectId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (
    !task ||
    !task.delegationSpec ||
    task.launchMode !== "auto" ||
    task.qualificationMode !== "execution_child" ||
    ["Done", "Abandoned"].includes(task.status)
  )
    throw launchRefusal("plan_launch_source_changed", "PRECONDITION");
  const proof = await taskExecutionChildAdmissionProof(db, projectId, taskId);
  const [parent] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, proof.parentRunId));
  const blockers = await getOpenRelationBlockers([taskId], db);

  if (!parent || (blockers.get(taskId) ?? []).length)
    throw launchRefusal("plan_launch_dependencies_unavailable", "PRECONDITION");

  return { task, proof, parent };
}

type PlanFacts = Awaited<ReturnType<typeof planFacts>>;

function planIdentity(facts: PlanFacts) {
  return {
    version: 1 as const,
    kind: "execution_plan" as const,
    id: facts.task.id,
    projectId: facts.task.projectId,
    taskId: facts.task.id,
    revisionDigest: retryDigest({
      proof: facts.proof,
      spec: facts.task.delegationSpec,
    }),
  };
}

async function flowSnapshot(
  db: Db,
  facts: PlanFacts,
): Promise<TaskLaunchServerSourceSnapshot> {
  const spec = asFlowDelegationSpec(facts.task.delegationSpec);

  if (!spec) throw launchRefusal("plan_launch_source_changed", "PRECONDITION");
  const resolved = await resolveDelegatableFlow(
    { projectId: facts.task.projectId, flowId: spec.flowId },
    db,
  );

  return {
    ...planIdentity(facts),
    execution: {
      flowId: resolved.flowId,
      parentRunId: facts.parent.id,
      rootRunId: facts.parent.rootRunId ?? facts.parent.id,
      launchMode: "auto",
      delegationSnapshot: flowDelegationSnapshot(resolved, {
        carrierTaskId: facts.task.id,
        mode: "task",
        runnerOverride: spec.runnerOverride ?? null,
      }),
      triggerSource: "domain_event",
      triggerPayload: {
        kind: "execution_plan",
        parentRunId: facts.parent.id,
        taskId: facts.task.id,
      },
    },
  };
}

async function agentSnapshot(
  db: Db,
  facts: PlanFacts,
): Promise<TaskLaunchServerSourceSnapshot> {
  const spec = asAgentDelegationSpec(facts.task.delegationSpec);

  if (!spec) throw launchRefusal("plan_launch_source_changed", "PRECONDITION");
  const effective = await resolveEffectiveAgentDefinition(
    { projectId: facts.task.projectId, agentId: spec.agentId },
    db,
  );

  if (effective.parsed.kind !== "code_delivery")
    throw launchRefusal("plan_launch_source_changed", "PRECONDITION");
  if (effective.parsed.flow) {
    const refusal = refuseUnsupportedDelegationOption("flow", {
      ...spec,
      mode: "task",
    });

    if (refusal) throw new MaisterError("CONFIG", refusal);
    const facade = await resolveAgentFlowTaskLaunchSource(db, {
      agentId: spec.agentId,
      projectId: facts.task.projectId,
      taskId: facts.task.id,
      launchOverrideRunnerId: spec.runnerOverride ?? null,
      parentRunId: facts.parent.id,
      rootRunId: facts.parent.rootRunId ?? facts.parent.id,
      launchMode: "auto",
      trigger: { source: "manual" },
    });

    if (!facade)
      throw launchRefusal("plan_launch_source_changed", "PRECONDITION");

    return {
      ...planIdentity(facts),
      ...(facade.snapshot.branchBase
        ? { branchBase: facade.snapshot.branchBase }
        : {}),
      execution: {
        ...facade.snapshot.execution,
        parentRunId: facts.parent.id,
        rootRunId: facts.parent.rootRunId ?? facts.parent.id,
        launchMode: "auto",
        triggerPayload: {
          kind: "execution_plan",
          parentRunId: facts.parent.id,
          taskId: facts.task.id,
        },
      },
    };
  }
  const workspace = spec.workspace ?? effective.parsed.workspace;
  const resultContract = await resolveResultContractForDelegation(db, {
    parentRunId: facts.parent.id,
    name: spec.resultProfile,
  });

  return {
    ...planIdentity(facts),
    agentWorkspace: workspace,
    execution: {
      agentId: spec.agentId,
      parentRunId: facts.parent.id,
      rootRunId: facts.parent.rootRunId ?? facts.parent.id,
      launchMode: "auto",
      resultContract,
      persistent: false,
      addressableKey: null,
      workspaceMode: null,
      triggerSource: "manual",
      triggerPayload: {
        kind: "execution_plan",
        parentRunId: facts.parent.id,
        taskId: facts.task.id,
      },
    },
  };
}

/** The durable child proof and plan specification, never the settling event's actor, own this launch. */
export async function createPlanFlowTaskLaunchSource(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<TaskLaunchServerSource> {
  return createTaskLaunchServerSource(
    db,
    await flowSnapshot(db, await planFacts(db, projectId, taskId)),
    assertStoredPlanFlowTaskLaunchSource,
  );
}

export async function createPlanAgentTaskLaunchSource(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<TaskLaunchServerSource> {
  return createTaskLaunchServerSource(
    db,
    await agentSnapshot(db, await planFacts(db, projectId, taskId)),
    assertStoredPlanFlowTaskLaunchSource,
  );
}

/** Restart validation retains the exact admitted parent, dependencies and resolved delegation target. */
export async function assertStoredPlanFlowTaskLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  if (source.kind !== "execution_plan" || source.id !== source.taskId)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const facts = await planFacts(db, source.projectId, source.taskId);
  const expected = source.execution.agentId
    ? await agentSnapshot(db, facts)
    : await flowSnapshot(db, facts);

  if (retryDigest(source) !== retryDigest(expected))
    throw launchRefusal("plan_launch_source_changed", "PRECONDITION");
}
