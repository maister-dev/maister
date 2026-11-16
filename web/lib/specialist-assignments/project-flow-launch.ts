import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";
import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { ProjectCoordinatorFlowSnapshot } from "./types";

import { and, eq, inArray, sql } from "drizzle-orm";

import { assertProjectCoordinatorProvider } from "./project-flow-provider";
import { retainProjectSourceHandoff } from "./project-source-handoff";
import { reserveProjectCoordinatorTask } from "./project-flow-task";

import { createAgentFlowTaskLaunchSource } from "@/lib/agents/flow-launch-authority";
import { taskLaunchIntents, tasks } from "@/lib/db/schema";
import { requestTaskRequalificationIfCurrent } from "@/lib/tasks/qualification-requalification";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { assertInteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveSourceTaskLaunch,
  acceptServerTaskLaunch,
  serverTaskLaunchRequest,
} from "@/lib/tasks/launch-intent";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";

export type ProjectCoordinatorAdmission = Readonly<
  | { kind: "accepted"; receipt: TaskLaunchReceipt }
  | {
      kind: "qualification_wait";
      taskId: string;
      reason:
        | "qualification_required"
        | "qualification_stale"
        | "qualification_evidence_stale";
    }
>;

/** Preserve the assignment's private input while entering the existing durable task admission. */
export async function acceptProjectCoordinatorAssignmentLaunch(
  db: Db,
  input: LaunchAgentRunInput,
  flow: ProjectCoordinatorFlowSnapshot,
  principal?: InteractiveTaskLaunchPrincipal,
): Promise<ProjectCoordinatorAdmission> {
  const reference = input.specialistAssignment;

  if (!reference || input.nativeInput || input.parentRunId)
    throw new MaisterError(
      "PRECONDITION",
      "Project coordinator admission requires its original standalone assignment",
    );
  if (principal) {
    assertInteractiveTaskLaunchPrincipal(principal);
    if (principal.userId !== reference.userId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The interactive launch must belong to the assignment requester",
        { details: { reason: "launch_manual_authority_required" } },
      );
  }
  const carrier = await reserveProjectCoordinatorTask(db, {
    projectId: input.projectId,
    agentId: input.agentId,
    reference,
    flow,
  });
  const [existing] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.projectId, input.projectId),
        eq(taskLaunchIntents.taskId, carrier.taskId),
        sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->'execution'->'specialistAssignment'->>'assignmentId'=${reference.assignmentId}`,
        sql`${taskLaunchIntents.settingsSnapshot}->'serverExecution'->'execution'->'specialistAssignment'->>'inputRevision'=${String(reference.inputRevision)}`,
        inArray(taskLaunchIntents.state, [
          "queued",
          "preparing",
          "run_bound",
          "held",
        ]),
      ),
    );

  if (existing) {
    const receipt = taskLaunchReceipt(existing);

    return { kind: "accepted", receipt };
  }
  await assertProjectCoordinatorProvider(db, input.projectId, flow);
  await retainProjectSourceHandoff(db, input.projectId, carrier.admission);
  const source = await createAgentFlowTaskLaunchSource(db, {
    ...input,
    taskId: carrier.taskId,
    specialistAssignment: carrier.admission,
  });
  const request = await serverTaskLaunchRequest(db, source, {
    taskId: carrier.taskId,
    agentId: input.agentId,
    ...(input.launchOverrideRunnerId
      ? { runnerId: input.launchOverrideRunnerId }
      : {}),
  });
  const key = `specialist_assignment:${reference.assignmentId}:${reference.inputRevision}`;
  const [qualification] = await db
    .select({
      id: tasks.currentQualificationId,
      inputRevision: tasks.qualificationInputRevision,
    })
    .from(tasks)
    .where(
      and(eq(tasks.id, carrier.taskId), eq(tasks.projectId, input.projectId)),
    );

  if (!qualification)
    throw new MaisterError(
      "PRECONDITION",
      "The retained qualification task is unavailable",
      { details: { reason: "qualification_task_missing" } },
    );

  try {
    const receipt = principal
      ? await acceptInteractiveSourceTaskLaunch(
          db,
          principal,
          source,
          request,
          key,
        )
      : await acceptServerTaskLaunch(db, source, request, key);

    return { kind: "accepted", receipt };
  } catch (error) {
    const reason = isMaisterError(error) ? error.details?.reason : null;

    if (
      !principal &&
      isMaisterError(error) &&
      error.code === "PRECONDITION" &&
      (reason === "qualification_required" ||
        reason === "qualification_stale" ||
        reason === "qualification_evidence_stale")
    ) {
      if (
        reason === "qualification_evidence_stale" &&
        qualification.id !== null
      )
        await requestTaskRequalificationIfCurrent(db, {
          projectId: input.projectId,
          taskId: carrier.taskId,
          qualificationId: qualification.id,
          inputRevision: qualification.inputRevision,
        });

      return { kind: "qualification_wait", taskId: carrier.taskId, reason };
    }
    throw error;
  }
}
