import "server-only";

import type { NextResponse } from "next/server";
import type { ExtCtx } from "@/lib/tokens/ext-handler";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { acceptTokenTaskLaunch } from "@/lib/tasks/launch-intent";
import {
  readTaskLaunchBody,
  taskLaunchRequestKey,
} from "@/lib/tasks/launch-http";
import {
  externalTaskLaunchAudit,
  externalTaskLaunchErrorResponse,
  externalTaskLaunchPrincipal,
} from "@/lib/tasks/launch-external";
import {
  legacyExternalTaskLaunchContinuation,
  legacyExternalTaskLaunchResponse,
} from "@/lib/tasks/launch-legacy-external";
import { handleExt } from "@/lib/tokens/ext-handler";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";

const ENDPOINT = "POST /api/v1/ext/runs";
const CONTRACT = { endpoint: ENDPOINT, statusCode: 202 } as const;
const identifier = z.string().min(1).max(256);
const postBodySchema = z
  .object({
    taskId: identifier,
    expectedTaskRevision: z.number().int().nonnegative().optional(),
    expectedSettingsToken: identifier.optional(),
    runnerId: identifier.optional(),
    executorOverrideId: identifier.optional(),
    baseBranch: identifier.optional(),
    targetBranch: identifier.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.runnerId === undefined ||
      body.executorOverrideId === undefined ||
      body.runnerId === body.executorOverrideId,
    {
      message: "runnerId and executorOverrideId must match when both are set",
      path: ["executorOverrideId"],
    },
  );
const projectResolutionBodySchema = z
  .object({ taskId: identifier })
  .passthrough();

async function readBody(
  request: Request,
): Promise<z.infer<typeof postBodySchema>> {
  const parsed = postBodySchema.safeParse(await readTaskLaunchBody(request));

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Legacy launch body is invalid; use task_launch_options and task_launch",
      { details: { reason: "launch_request_invalid" } },
    );

  return parsed.data;
}

export async function POST(
  request: Request,
  _routeContext: object,
): Promise<NextResponse> {
  const db = getDb();
  const accept = async (context: ExtCtx): Promise<NextResponse> => {
    try {
      const principal = await externalTaskLaunchPrincipal(db, request, context);
      const body = await readBody(request.clone());

      if (
        body.expectedTaskRevision === undefined ||
        body.expectedSettingsToken === undefined
      ) {
        throw new MaisterError(
          "CONFIG",
          "Refresh launch options, then provide expectedTaskRevision and expectedSettingsToken with Idempotency-Key; use task_launch_options and task_launch",
          { details: { reason: "launch_request_upgrade_required" } },
        );
      }
      const key = taskLaunchRequestKey(request);
      const runnerId = body.runnerId ?? body.executorOverrideId;
      const receipt = await acceptTokenTaskLaunch(
        db,
        principal,
        {
          taskId: body.taskId,
          expectedTaskRevision: body.expectedTaskRevision,
          expectedSettingsToken: body.expectedSettingsToken,
          ...(runnerId !== undefined ? { runnerId } : {}),
          ...(body.baseBranch !== undefined
            ? { baseBranch: body.baseBranch }
            : {}),
          ...(body.targetBranch !== undefined
            ? { targetBranch: body.targetBranch }
            : {}),
        },
        key,
        externalTaskLaunchAudit(context, CONTRACT),
      );

      wakeAcceptedTaskLaunch(db, receipt);

      return await legacyExternalTaskLaunchResponse(db, receipt);
    } catch (error) {
      return externalTaskLaunchErrorResponse(error);
    }
  };

  try {
    return await handleExt(
      request,
      {
        scopeLabel: "runs:launch",
        admitLibrarian: true,
        endpoint: ENDPOINT,
        method: "POST",
        successAuditInWork: true,
        db,
        resolveProjectId: async () => {
          const parsed = projectResolutionBodySchema.safeParse(
            await readTaskLaunchBody(request.clone()),
          );

          if (!parsed.success) return null;
          const [task] = await db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, parsed.data.taskId));

          return task?.projectId ?? null;
        },
        idempotency: {
          kind: "run_launch",
          keyMaxLength: 256,
          target: { route: "/api/v1/ext/runs" },
          parseBody: readBody,
          continuation: legacyExternalTaskLaunchContinuation(
            db,
            request,
            CONTRACT,
            accept,
          ),
        },
      },
      accept,
    );
  } catch (error) {
    return externalTaskLaunchErrorResponse(error);
  }
}
