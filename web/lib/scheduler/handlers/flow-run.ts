import "server-only";

import { launchRun } from "@/lib/services/runs";
import { MaisterError } from "@/lib/errors";

export async function runScheduledFlowJob(
  target: Record<string, unknown>,
): Promise<{ runId: string; status: string; queuePosition?: number }> {
  const taskId = stringProp(target, "taskId");

  if (!taskId) {
    throw new MaisterError(
      "PRECONDITION",
      "flow_run target.taskId is required",
    );
  }

  return launchRun(
    {
      taskId,
      runnerId: stringProp(target, "runnerId"),
      baseBranch: stringProp(target, "baseBranch"),
      targetBranch: stringProp(target, "targetBranch"),
    },
    {
      actorUserId: null,
      authorize: async () => {},
    },
  );
}

function stringProp(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}
