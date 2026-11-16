import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ProjectAssignmentAdmission } from "./project-admission";
import type { ProjectCoordinatorFlowSnapshot } from "./types";
import type { ProjectAssignmentTask } from "./project-task";

import { reserveProjectAssignmentTask } from "./project-task";

import { createTask } from "@/lib/services/tasks";

/** Retain one private-input carrier through the existing task service, including interrupted intake recovery. */
export async function reserveProjectCoordinatorTask(
  db: Db,
  scope: Readonly<{
    projectId: string;
    agentId: string;
    reference: ProjectAssignmentAdmission;
    flow: ProjectCoordinatorFlowSnapshot;
  }>,
): Promise<ProjectAssignmentTask> {
  return reserveProjectAssignmentTask(
    db,
    scope.projectId,
    scope.reference,
    async (tx) => {
      const created = await createTask(
        {
          title: scope.agentId,
          prompt: scope.agentId,
          flowId: scope.flow.flowId,
          agentId: scope.agentId,
        },
        { projectId: scope.projectId, actorUserId: scope.reference.userId },
        tx,
      );

      return created.taskId;
    },
  );
}
