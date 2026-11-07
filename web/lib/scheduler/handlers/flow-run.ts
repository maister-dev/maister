import "server-only";

import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { ScheduledJobLaunchIdentity } from "@/lib/scheduler/task-launch-source";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  loadScheduledJobLaunchScope,
  scheduledJobTaskLaunchSource,
} from "@/lib/scheduler/task-launch-source";
import {
  acceptServerTaskLaunch,
  serverTaskLaunchRequest,
} from "@/lib/tasks/launch-intent";
import { findServerTaskLaunch } from "@/lib/tasks/launch-server-source";
import { dispatchTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";

export async function runScheduledFlowJob(
  target: Record<string, unknown>,
  identity: ScheduledJobLaunchIdentity,
): Promise<TaskLaunchReceipt> {
  const db = getDb();
  const scope = await loadScheduledJobLaunchScope(db, identity);

  if (JSON.stringify(target) !== JSON.stringify(scope.target))
    throw new MaisterError("CONFLICT", "Scheduled job target changed", {
      details: { reason: "launch_source_changed" },
    });
  const key = identity.attemptId;
  const existing = await findServerTaskLaunch(db, scope.snapshot, key);

  if (existing) return existing;
  const source = await scheduledJobTaskLaunchSource(db, identity);
  const selection = { runnerId: stringProp(scope.target, "runnerId") };
  const request = await serverTaskLaunchRequest(db, source, {
    taskId: scope.taskId,
    ...selection,
    baseBranch: stringProp(scope.target, "baseBranch"),
    targetBranch: stringProp(scope.target, "targetBranch"),
  });
  const receipt = await acceptServerTaskLaunch(db, source, request, key);

  await dispatchTaskLaunchIntent(db, receipt.intentId);

  return (await findServerTaskLaunch(db, scope.snapshot, key)) ?? receipt;
}

function stringProp(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}
