import "server-only";

import type {
  LaunchRunSeam,
  ControlledLaunchResult,
} from "@/lib/evaluations/launch-batch";
import type { LaunchRunContext } from "@/lib/services/runs";
import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";

import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import { preflightStudyRecipe } from "@/lib/evaluations/recipes";
import { createEvaluationTaskLaunchSource } from "@/lib/evaluations/launch-authority";
import {
  acceptServerTaskLaunch,
  serverTaskLaunchRequest,
} from "@/lib/tasks/launch-intent";
import { findServerTaskLaunch } from "@/lib/tasks/launch-server-source";

function controlledLaunchResult(
  receipt: TaskLaunchReceipt,
): ControlledLaunchResult {
  if (receipt.runId) return { runId: receipt.runId };
  if (["held", "failed", "cancelled", "settled"].includes(receipt.state))
    throw new MaisterError(
      "PRECONDITION",
      "The accepted evaluation launch needs a new decision",
      {
        details: {
          reason: "evaluation_launch_held",
          intentId: receipt.intentId,
        },
      },
    );

  return { accepted: true, intentId: receipt.intentId };
}

/** A controlled root retains its frozen recipe and forced hold through the same durable, currently qualified admission as every automated task launch. */
export function defaultLaunchRunSeam(
  ctx: LaunchRunContext,
  db?: Db,
): LaunchRunSeam {
  return async (args) => {
    const connection = db ?? getDb();
    const { source, definition } = await createEvaluationTaskLaunchSource(
      connection,
      args,
    );

    await ctx.authorize(source.snapshot.projectId);
    const prior = await findServerTaskLaunch(
      connection,
      source.snapshot,
      args.launchKey,
    );

    if (prior) return controlledLaunchResult(prior);
    const verdict = await preflightStudyRecipe(
      { studyId: args.studyId, projectId: args.projectId, definition },
      livePreflightLoaders(connection),
    );

    if (!verdict.ok)
      throw new MaisterError(
        "CONFIG",
        `controlled launch preflight failed: ${verdict.refusals.map((refusal) => refusal.code).join(", ")}`,
      );
    const request = await serverTaskLaunchRequest(connection, source, {
      taskId: source.snapshot.taskId,
      flowId: definition.flow.flowRefId,
      autoPromote: false,
      executionPolicy: definition.executionPolicy,
    });
    const receipt = await acceptServerTaskLaunch(
      connection,
      source,
      request,
      args.launchKey,
    );

    return controlledLaunchResult(receipt);
  };
}
