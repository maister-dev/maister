import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  readTaskLaunchOptions,
  taskLaunchOptionsSnapshot,
} from "@/lib/tasks/launch-options";
import {
  externalTaskLaunchErrorResponse,
  externalTaskLaunchPrincipal,
  externalTaskLaunchProject,
} from "@/lib/tasks/launch-external";
import { assertTaskLaunchTokenAuthority } from "@/lib/tasks/launch-token";
import { handleExt } from "@/lib/tokens/ext-handler";

export async function GET(request: Request): Promise<NextResponse> {
  const db = getDb();

  try {
    return await handleExt(
      request,
      {
        scopeLabel: "runs:launch",
        admitLibrarian: true,
        endpoint: "GET /api/v1/ext/task-launch-intents/options",
        method: "GET",
        db,
        resolveProjectId: async () =>
          externalTaskLaunchProject(db, readTaskLaunchOptions(request).taskId),
      },
      async (context) => {
        try {
          const principal = await externalTaskLaunchPrincipal(
            db,
            request,
            context,
          );
          const selection = readTaskLaunchOptions(request);

          await db.transaction((tx) =>
            assertTaskLaunchTokenAuthority(tx, principal, context.projectId, [
              "launchRun",
            ]),
          );
          const preview = await taskLaunchOptionsSnapshot(
            db,
            context.projectId,
            selection,
          );

          return NextResponse.json(preview, {
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
