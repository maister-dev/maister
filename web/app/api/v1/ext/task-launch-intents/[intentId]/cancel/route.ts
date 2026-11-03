import type { NextResponse } from "next/server";
import type { ExtCtx } from "@/lib/tokens/ext-handler";

import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { cancelTokenTaskLaunch } from "@/lib/tasks/launch-cancel";
import { taskLaunchRequestKey } from "@/lib/tasks/launch-http";
import {
  externalTaskLaunchAudit,
  externalTaskLaunchContinuation,
  externalTaskLaunchErrorResponse,
  externalTaskLaunchIntentProject,
  externalTaskLaunchPrincipal,
  externalTaskLaunchReceiptResponse,
  readExternalTaskLaunchCancellation,
} from "@/lib/tasks/launch-external";

const CONTRACT = {
  endpoint: "POST /api/v1/ext/task-launch-intents/{intentId}/cancel",
  statusCode: 200,
} as const;

export async function POST(
  request: Request,
  route: { params: Promise<{ intentId: string }> },
): Promise<NextResponse> {
  const db = getDb();
  const { intentId } = await route.params;
  const cancel = async (context: ExtCtx): Promise<NextResponse> => {
    try {
      const principal = await externalTaskLaunchPrincipal(db, request, context);
      const key = taskLaunchRequestKey(request);
      const body = await readExternalTaskLaunchCancellation(request.clone());
      const receipt = await cancelTokenTaskLaunch(
        db,
        principal,
        intentId,
        body,
        key,
        externalTaskLaunchAudit(context, CONTRACT),
      );

      return externalTaskLaunchReceiptResponse(receipt, CONTRACT.statusCode);
    } catch (error) {
      return externalTaskLaunchErrorResponse(error);
    }
  };

  try {
    return await handleExt(
      request,
      {
        db,
        scopeLabel: "runs:launch",
        admitLibrarian: true,
        endpoint: CONTRACT.endpoint,
        method: "POST",
        successAuditInWork: true,
        resolveProjectId: () => externalTaskLaunchIntentProject(db, intentId),
        idempotency: {
          kind: "task_launch_cancel",
          keyMaxLength: 256,
          target: {
            route: "/api/v1/ext/task-launch-intents/{intentId}/cancel",
            intentId,
          },
          parseBody: readExternalTaskLaunchCancellation,
          continuation: externalTaskLaunchContinuation(
            db,
            request,
            CONTRACT,
            cancel,
          ),
        },
      },
      cancel,
    );
  } catch (error) {
    return externalTaskLaunchErrorResponse(error);
  }
}
