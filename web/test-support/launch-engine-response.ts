import type { Db } from "@/lib/execution-host/db";
import type { LaunchRunInput, LaunchRunContext } from "@/lib/services/runs";
import type { TokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { TaskLaunchFlowClaim } from "@/lib/tasks/launch-dispatch-claim";
import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { launchAcceptedTaskRun } from "@/lib/services/runs";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { httpStatusForCode } from "@/lib/api/project-route-helpers";
import { readLaunchErrorDetails } from "@/lib/runs/launch-progress";
import { tasks, taskLaunchIntents, projects } from "@/lib/db/schema";
import {
  resolveExecutionPolicy,
  requiresLaunchUnattended,
} from "@/lib/runs/execution-policy";
import { issueToken } from "@/lib/tokens/issue";
import { tokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import {
  acceptTokenTaskLaunch,
  acceptConcurrentInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  cancelTokenTaskLaunch,
  cancelInteractiveTaskLaunch,
} from "@/lib/tasks/launch-cancel";
import { taskLaunchFieldsSchema } from "@/lib/tasks/launch-schema";
import {
  assertTaskLaunchFlowClaim,
  claimTaskLaunchIntent,
} from "@/lib/tasks/launch-dispatch-claim";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";

const engineSelectionSchema = taskLaunchFieldsSchema.omit({
  expectedTaskRevision: true,
  expectedSettingsToken: true,
});

/** Real bearer admission and preparation for technical engine consumers; never manufactures an authority or a Run. */
export async function launchQualifiedEngineRun(
  input: LaunchRunInput,
  context: LaunchRunContext,
  db: Db,
): Promise<{ runId: string; status: string }> {
  const { receipt, principal } = await acceptQualifiedEngineFixture(
    input,
    context,
    db,
  );

  try {
    return await bindAcceptedEngineFixture(db, receipt);
  } catch (error) {
    await cancelTokenTaskLaunch(
      db,
      principal,
      receipt.intentId,
      {
        expectedStateVersion: await fixtureIntentVersion(db, receipt.intentId),
      },
      randomUUID(),
    );
    throw error;
  }
}

/** The receipt can remain queued honestly when a capacity test deliberately prevents preparation. */
export async function acceptQualifiedEngineFixture(
  input: LaunchRunInput,
  context: LaunchRunContext,
  db: Db,
): Promise<
  Readonly<{ receipt: TaskLaunchReceipt; principal: TokenTaskLaunchPrincipal }>
> {
  if (
    input.allowConcurrent === true ||
    context.assertLaunchOwnership ||
    context.recordSuccessAudit
  )
    throw new Error(
      "Use the actual concurrent, source-family or audit constructor for this engine fixture",
    );
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));

  if (!task)
    throw new MaisterError("PRECONDITION", "Engine fixture task is missing");
  await context.authorize(task.projectId, "launchRun");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId));

  if (!project) throw new Error("Engine fixture project disappeared");
  if (
    requiresLaunchUnattended(
      resolveExecutionPolicy({
        launchOverride: input.executionPolicy ?? null,
        taskDefault: task.executionPolicy,
        projectDefault: project.executionPolicyDefault,
      }),
    )
  )
    await context.authorize(task.projectId, "launchUnattended");
  const { allowConcurrent: _allowConcurrent, ...fields } = input;
  const selection = engineSelectionSchema.parse(fields);
  const token = await issueToken(
    {
      projectId: task.projectId,
      tokenKind: context.actorUserId ? "user" : "project",
      ownerUserId: context.actorUserId ?? null,
      name: `engine-fixture-${randomUUID()}`,
      scopes: ["runs:launch", "tasks:update"],
    },
    db,
  );
  const principal = await tokenTaskLaunchPrincipal(db, token.secret);
  const receipt = await acceptTokenTaskLaunch(
    db,
    principal,
    {
      ...selection,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        db,
        task.id,
        selection,
      ),
    },
    randomUUID(),
  );

  return { receipt, principal };
}

/** The existing authenticated session boundary mints the human proof; no context actor flag substitutes for it. */
export async function launchConcurrentEngineRun(
  input: LaunchRunInput,
  context: LaunchRunContext,
  db: Db,
): Promise<{ runId: string; status: string }> {
  const { receipt, principal } = await acceptConcurrentEngineFixture(
    input,
    context,
    db,
  );

  try {
    return await bindAcceptedEngineFixture(db, receipt);
  } catch (error) {
    await cancelInteractiveTaskLaunch(
      db,
      principal,
      receipt.intentId,
      {
        expectedStateVersion: await fixtureIntentVersion(db, receipt.intentId),
      },
      randomUUID(),
    );
    throw error;
  }
}

export async function acceptConcurrentEngineFixture(
  input: LaunchRunInput,
  context: LaunchRunContext,
  db: Db,
): Promise<
  Readonly<{
    receipt: TaskLaunchReceipt;
    principal: InteractiveTaskLaunchPrincipal;
  }>
> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));

  if (!task)
    throw new MaisterError("PRECONDITION", "Engine fixture task is missing");
  await context.authorize(task.projectId, "launchRun");
  const { allowConcurrent: _allowConcurrent, ...fields } = input;
  const selection = engineSelectionSchema.parse(fields);
  const principal = await interactiveTaskLaunchPrincipal();
  const receipt = await acceptConcurrentInteractiveTaskLaunch(
    db,
    principal,
    {
      ...selection,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        db,
        task.id,
        selection,
      ),
    },
    randomUUID(),
  );

  return { receipt, principal };
}

async function fixtureIntentVersion(db: Db, intentId: string): Promise<number> {
  const [intent] = await db
    .select({ stateVersion: taskLaunchIntents.stateVersion })
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw new Error("Accepted engine fixture intent disappeared");

  return intent.stateVersion;
}

export async function bindAcceptedEngineFixture(
  db: Db,
  receipt: TaskLaunchReceipt,
): Promise<{ runId: string; status: string }> {
  const claim = await claimTaskLaunchIntent(db, receipt.intentId);

  if (!claim)
    throw new Error(
      `Engine fixture launch remains queued: ${receipt.intentId}`,
    );
  assertTaskLaunchFlowClaim(claim);

  return bindClaimedEngineFixture(db, claim);
}

/** Concurrent allocation tests can claim together, then serialize physical Git effects under the real repository fence. */
export async function bindClaimedEngineFixture(
  db: Db,
  claim: TaskLaunchFlowClaim,
): Promise<{ runId: string; status: string }> {
  const fence = await acquireRepositoryMutationFence(
    claim.identity.parentRepoPath,
  );

  try {
    return await fence.run(async () =>
      launchAcceptedTaskRun(await acceptedTaskLaunchExecution(db, claim), db),
    );
  } finally {
    await fence.release();
  }
}

/** Test-only response projection for existing synchronous engine assertions. This is not an HTTP admission adapter. */
export async function launchEngineResponse(
  db: Db,
  input: LaunchRunInput,
  context: LaunchRunContext,
): Promise<Response> {
  try {
    const launch =
      input.allowConcurrent === true
        ? launchConcurrentEngineRun
        : launchQualifiedEngineRun;

    return Response.json(await launch(input, context, db), {
      status: 202,
    });
  } catch (error) {
    if (!isMaisterError(error)) throw error;

    return Response.json(
      {
        code: error.code,
        message: error.message,
        details: {
          ...readLaunchErrorDetails(error.details),
          ...(typeof error.details?.reason === "string"
            ? { reason: error.details.reason }
            : {}),
        },
      },
      { status: httpStatusForCode(error.code) },
    );
  }
}
