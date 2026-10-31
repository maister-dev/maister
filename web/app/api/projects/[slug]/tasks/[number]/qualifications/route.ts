import { NextResponse } from "next/server";

import {
  requireTaskQualificationAccess,
  taskQualificationErrorResponse,
} from "@/lib/tasks/qualification-http";
import { getTaskQualificationHistory } from "@/lib/tasks/qualification-queries";
import { requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
): Promise<NextResponse> {
  try {
    const { slug, number: taskId } = await params;
    const access = await requireTaskQualificationAccess(slug, taskId);

    await requireProjectAction(access.projectId, "readRepoFiles");
    const query = new URL(request.url).searchParams;

    if (
      [...query.keys()].some((key) => !["cursor", "limit"].includes(key)) ||
      [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
    )
      throw new MaisterError(
        "CONFIG",
        "Unknown or repeated qualification history query",
      );
    const limit = query.has("limit") ? Number(query.get("limit")) : undefined;

    return NextResponse.json(
      await getTaskQualificationHistory(access.db, {
        projectId: access.projectId,
        taskId,
        cursor: query.get("cursor") ?? undefined,
        limit,
      }),
    );
  } catch (error) {
    return taskQualificationErrorResponse(error);
  }
}
