import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";
import {
  clarificationRequestSchema,
  supersedeClarification,
} from "@/lib/tasks/clarification-requests";

type RouteParams = {
  params: Promise<{ slug: string; number: string; id: string }>;
};

export async function POST(
  req: NextRequest,
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
    const request = clarificationRequestSchema.parse(await req.json());
    const receipt = await supersedeClarification({
      taskId: resolved.task.id,
      clarificationId: id,
      requesterUserId: user.id,
      request,
    });

    return NextResponse.json(receipt, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { code: "CONFIG", message: "invalid clarification request" },
        { status: 422 },
      );
    }
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
