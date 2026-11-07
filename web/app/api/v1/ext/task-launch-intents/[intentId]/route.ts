import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { taskLaunchForToken } from "@/lib/tasks/launch-access";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";
import {
  externalTaskLaunchErrorResponse,
  externalTaskLaunchIntentProject,
  externalTaskLaunchPrincipal,
} from "@/lib/tasks/launch-external";

export async function GET(
  request: Request,
  route: { params: Promise<{ intentId: string }> },
): Promise<NextResponse> {
  const db = getDb();
  const { intentId } = await route.params;

  try {
    return await handleExt(
      request,
      {
        scopeLabel: "runs:read",
        admitLibrarian: true,
        endpoint: "GET /api/v1/ext/task-launch-intents/{intentId}",
        method: "GET",
        db,
        resolveProjectId: () => externalTaskLaunchIntentProject(db, intentId),
      },
      async (context) => {
        try {
          const principal = await externalTaskLaunchPrincipal(
            db,
            request,
            context,
          );
          const intent = await taskLaunchForToken(db, intentId, principal);

          return NextResponse.json(taskLaunchReceipt(intent), {
            headers: { "Cache-Control": "no-store" },
          });
        } catch (error) {
          return externalTaskLaunchErrorResponse(error);
        }
      },
    );
  } catch (error) {
    return externalTaskLaunchErrorResponse(error);
  }
}
