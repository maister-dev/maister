import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { readTaskLaunchReceipt } from "@/lib/tasks/launch-receipt";
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
    return NextResponse.json(
      await readTaskLaunchReceipt(db, intent),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
