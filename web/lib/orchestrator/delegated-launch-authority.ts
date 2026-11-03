import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";
import type { DelegateBody } from "./delegation-request";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { delegateBodySchema } from "./delegation-request";
import {
  parseDelegationPlanRevision,
  delegationLaunchOperation,
} from "./launch-operation";
import {
  titleFromPrompt,
  refuseUnsupportedDelegationOption,
} from "./delegation-target";

import { tasks, runs } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { resolveAgentFlowTaskLaunchSource } from "@/lib/agents/flow-launch-authority";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { taskExecutionChildAdmissionProof } from "@/lib/tasks/qualification-admission";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import {
  assertTaskLaunchDelegationTokenAuthority,
  assertTokenTaskLaunchPrincipal,
} from "@/lib/tasks/launch-token";
import {
  flowDelegationSnapshot,
  resolveDelegatableFlow,
} from "@/lib/flows/delegatable-flow";
import { resolveResultContractForDelegation } from "@/lib/run-results/resolve-profile";
import { MaisterError } from "@/lib/errors";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

const id = z.string().min(1).max(256);
const payloadSchema = z
  .object({
    kind: z.literal("delegated_child"),
    origin: z
      .object({
        version: z.literal(1),
        kind: z.literal("token"),
        tokenId: id,
        tokenKind: z.enum(["project", "user", "agent", "librarian"]),
        projectId: id.nullable(),
        ownerUserId: id.nullable(),
        agentId: id.nullable(),
        boundRunId: id.nullable(),
        librarianTurnId: id.nullable(),
      })
      .strict(),
    request: delegateBodySchema,
    operationKey: z.string().min(1).max(256),
  })
  .strict();

type DelegatedPayload = z.infer<typeof payloadSchema>;

async function delegatedSnapshot(
  db: Db,
  projectId: string,
  taskId: string,
  payload: DelegatedPayload,
): Promise<TaskLaunchServerSourceSnapshot> {
  const parentRunId = payload.origin.boundRunId;

  if (!parentRunId)
    throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");
  await assertTaskLaunchDelegationTokenAuthority(
    db,
    payload.origin,
    projectId,
    parentRunId,
  );
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  const proof = await taskExecutionChildAdmissionProof(db, projectId, taskId);
  const operation = parseDelegationPlanRevision(proof.planRevision);
  const currentOperation = delegationLaunchOperation(
    "delegate",
    payload.origin.tokenId,
    parentRunId,
    payload.operationKey,
    payload.request,
  );
  const [parent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, parentRunId), eq(runs.projectId, projectId)));
  const body = payload.request;

  if (
    !task ||
    !parent ||
    ["Abandoned", "Done"].includes(task.status) ||
    proof.parentRunId !== parentRunId ||
    operation?.kind !== "delegate" ||
    operation.identity !== currentOperation.identity ||
    operation.payloadDigest !== retryDigest(body) ||
    task.prompt !== body.prompt ||
    task.title !== (body.title ?? titleFromPrompt(body.prompt))
  )
    throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");
  const common = {
    parentRunId,
    rootRunId: parent.rootRunId ?? parent.id,
    launchMode: "manual" as const,
    triggerSource: body.target.agentId
      ? ("manual" as const)
      : ("flow" as const),
    triggerPayload: payload,
  };
  const revisionDigest = retryDigest({
    proof,
    spec: task.delegationSpec,
    payload,
  });

  if (body.target.flowId) {
    const resolved = await resolveDelegatableFlow(
      { projectId, flowId: body.target.flowId },
      db,
    );

    if (
      task.delegationSpec?.kind !== "flow" ||
      task.delegationSpec.flowId !== resolved.flowId ||
      task.flowId !== resolved.flowId ||
      task.delegationSpec.runnerOverride !== body.runnerOverride
    )
      throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");

    return {
      version: 1,
      kind: "delegated_child",
      id: taskId,
      projectId,
      taskId,
      revisionDigest,
      execution: {
        ...common,
        flowId: resolved.flowId,
        delegationSnapshot: flowDelegationSnapshot(resolved, {
          carrierTaskId: taskId,
          mode: body.mode,
          runnerOverride: body.runnerOverride ?? null,
        }),
      },
    };
  }
  const agentId = body.target.agentId;

  if (
    !agentId ||
    task.delegationSpec?.kind === "flow" ||
    task.delegationSpec?.agentId !== agentId
  )
    throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");
  const effective = await resolveEffectiveAgentDefinition(
    { agentId, projectId },
    db,
  );

  if (effective.parsed.flow) {
    const refusal = refuseUnsupportedDelegationOption("flow", body);

    if (refusal) throw new MaisterError("CONFIG", refusal);
    const facade = await resolveAgentFlowTaskLaunchSource(db, {
      agentId,
      projectId,
      taskId,
      launchOverrideRunnerId: body.runnerOverride ?? null,
      parentRunId,
      rootRunId: parent.rootRunId ?? parent.id,
      launchMode: "manual",
      trigger: { source: "manual" },
    });

    if (!facade)
      throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");

    return {
      version: 1,
      kind: "delegated_child",
      id: taskId,
      projectId,
      taskId,
      revisionDigest,
      ...(facade.snapshot.branchBase
        ? { branchBase: facade.snapshot.branchBase }
        : {}),
      execution: { ...facade.snapshot.execution, ...common },
    };
  }
  const workspace = body.workspace ?? effective.parsed.workspace;
  const resultContract = await resolveResultContractForDelegation(db, {
    parentRunId,
    name: body.resultProfile,
  });

  return {
    version: 1,
    kind: "delegated_child",
    id: taskId,
    projectId,
    taskId,
    revisionDigest,
    agentWorkspace: workspace,
    execution: {
      ...common,
      agentId,
      resultContract,
      persistent: body.persistent ?? false,
      addressableKey: body.addressableKey ?? null,
      workspaceMode: body.workspaceMode ?? null,
    },
  };
}

/** Only the verified run-bound token and the durable child proof can construct delegated launch authority. */
export async function createDelegatedTaskLaunchSource(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  projectId: string,
  taskId: string,
  body: DelegateBody,
  operationKey: string,
): Promise<TaskLaunchServerSource> {
  assertTokenTaskLaunchPrincipal(principal);
  const payload = payloadSchema.parse({
    kind: "delegated_child",
    origin: principal.origin,
    request: body,
    operationKey,
  });
  const snapshot = await delegatedSnapshot(db, projectId, taskId, payload);

  return createTaskLaunchServerSource(
    db,
    snapshot,
    assertStoredDelegatedTaskLaunchSource,
  );
}

/** Static restart owner rechecks exact token scope, parent proof, input, target and result contract. */
export async function assertStoredDelegatedTaskLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const payload = payloadSchema.safeParse(source.execution.triggerPayload);

  if (
    source.kind !== "delegated_child" ||
    source.id !== source.taskId ||
    !payload.success
  )
    throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");
  const expected = await delegatedSnapshot(
    db,
    source.projectId,
    source.taskId,
    payload.data,
  );

  if (retryDigest(source) !== retryDigest(expected))
    throw launchRefusal("delegation_launch_source_changed", "PRECONDITION");
}
