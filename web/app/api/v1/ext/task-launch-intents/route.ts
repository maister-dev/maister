import type { NextResponse } from "next/server";
import type { ExtCtx } from "@/lib/tokens/ext-handler";

import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { acceptTokenTaskLaunch } from "@/lib/tasks/launch-intent";
import { taskLaunchRequestKey } from "@/lib/tasks/launch-http";
import {
  externalTaskLaunchAudit,
  externalTaskLaunchContinuation,
  externalTaskLaunchErrorResponse,
  externalTaskLaunchPrincipal,
  externalTaskLaunchProject,
  externalTaskLaunchReceiptResponse,
  readExternalTaskLaunchBody,
} from "@/lib/tasks/launch-external";

const ENDPOINT = "POST /api/v1/ext/task-launch-intents";

export async function POST(request: Request): Promise<NextResponse> {
  const db = getDb();
  const accept = async (context: ExtCtx): Promise<NextResponse> => {
    try {
      const principal = await externalTaskLaunchPrincipal(db, request, context);
      const key = taskLaunchRequestKey(request);
      const body = await readExternalTaskLaunchBody(request.clone());
      const receipt = await acceptTokenTaskLaunch(
        db,
        principal,
        body,
        key,
        externalTaskLaunchAudit(context, ENDPOINT),
      );

      return externalTaskLaunchReceiptResponse(receipt);
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
          const body = await readExternalTaskLaunchBody(request.clone());

          return externalTaskLaunchProject(db, body.taskId);
        },
        idempotency: {
          kind: "run_launch",
          keyMaxLength: 256,
          target: { route: "/api/v1/ext/task-launch-intents" },
          parseBody: readExternalTaskLaunchBody,
          continuation: externalTaskLaunchContinuation(db, request, accept),
        },
      },
      accept,
    );
  } catch (error) {
    return externalTaskLaunchErrorResponse(error);
  }
}
