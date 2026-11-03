import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { launchRefusal } from "@/lib/tasks/launch-resolution";
import {
  readTaskLaunchOptions,
  taskLaunchOptionsSnapshot,
} from "@/lib/tasks/launch-options";
import { taskLaunchErrorResponse } from "@/lib/tasks/launch-http";

/** A read authenticates the session and current project action; it grants no launch authority. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const selection = readTaskLaunchOptions(request);
    const db = getDb();
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, selection.taskId));

    if (!task) throw launchRefusal("launch_not_found", "PRECONDITION");
    try {
      await db.transaction((tx) =>
        assertTaskLaunchUserAuthority(tx, task.projectId, user.id, [
          "launchRun",
        ]),
      );
    } catch (error) {
      if (isMaisterError(error) && error.code === "UNAUTHORIZED")
        throw launchRefusal("launch_not_found", "PRECONDITION");
      throw error;
    }
    const snapshot = await taskLaunchOptionsSnapshot(
      db,
      task.projectId,
      selection,
    );

    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
