import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireActiveSession, requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs, taskLaunchIntents } from "@/lib/db/schema";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { taskLaunchReceipt } from "@/lib/tasks/launch-intent";
import { taskLaunchErrorResponse } from "@/lib/tasks/launch-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ intentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { intentId } = await params;
    const db = getDb();
    const [intent] = await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId));

    if (!intent)
      throw new MaisterError("PRECONDITION", "Task launch is unavailable", {
        details: { reason: "launch_not_found" },
      });
    try {
      await requireProjectActionForUser(user.id, intent.projectId, "readBoard");
    } catch (error) {
      if (isMaisterError(error) && error.code === "UNAUTHORIZED")
        throw new MaisterError("PRECONDITION", "Task launch is unavailable", {
          details: { reason: "launch_not_found" },
        });
      throw error;
    }
    const [run] = intent.runId
      ? await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, intent.runId))
      : [];

    return NextResponse.json(
      {
        ...taskLaunchReceipt(intent),
        ...(run ? { runStatus: run.status } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
