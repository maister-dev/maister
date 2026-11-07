import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { taskLaunchReceipt } from "@/lib/tasks/launch-intent";
import { taskLaunchErrorResponse } from "@/lib/tasks/launch-http";
import { taskLaunchForUser } from "@/lib/tasks/launch-access";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ intentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { intentId } = await params;
    const db = getDb();
    const intent = await taskLaunchForUser(db, intentId, user.id);
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
