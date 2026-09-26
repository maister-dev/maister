import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";
import { cancelClarification } from "@/lib/tasks/clarification-requests";

type RouteParams = {
  params: Promise<{ slug: string; number: string; id: string }>;
};

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, number, id } = await params;

  try {
    const user = await requireActiveSession();
    const taskNumber = Number(number);
    const resolved =
      Number.isSafeInteger(taskNumber) &&
      taskNumber > 0 &&
      String(taskNumber) === number
        ? await resolveProjectTaskByNumber(slug, taskNumber)
        : null;

    if (!resolved)
      return NextResponse.json(
        { code: "NOT_FOUND", message: "task not found" },
        { status: 404 },
      );
    const receipt = await cancelClarification({
      taskId: resolved.task.id,
      clarificationId: id,
      actorUserId: user.id,
    });

    return NextResponse.json(receipt);
  } catch (err) {
    if (!isMaisterError(err)) throw err;

    const status =
      err.code === "UNAUTHENTICATED"
        ? 401
        : err.code === "UNAUTHORIZED"
          ? 403
          : err.code === "CONFIG"
            ? 422
            : 409;

    return NextResponse.json(
      { code: err.code, message: err.message, details: err.details },
      { status },
    );
  }
}
