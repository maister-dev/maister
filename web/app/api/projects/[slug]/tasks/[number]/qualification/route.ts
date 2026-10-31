import { NextResponse } from "next/server";

import {
  requireTaskQualificationAccess,
  taskQualificationErrorResponse,
} from "@/lib/tasks/qualification-http";
import { taskQualificationWriteSchema } from "@/lib/tasks/qualification-schema";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { MaisterError } from "@/lib/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
): Promise<NextResponse> {
  try {
    const { slug, number: taskId } = await params;
    const access = await requireTaskQualificationAccess(slug, taskId);
    const text = await request.text();

    if (Buffer.byteLength(text) > 65536)
      throw new MaisterError(
        "CONFIG",
        "Task qualification is limited to 64 KiB",
      );
    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new MaisterError(
          "CONFIG",
          "Qualification body must contain valid JSON",
        );
      throw error;
    }
    const parsed = taskQualificationWriteSchema.safeParse(raw);

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Complete structured qualification and expected revisions are required",
      );
    const prepared = await prepareTaskQualification(access.db, {
      projectId: access.projectId,
      taskId,
      author: { kind: "user", identity: access.userId, userId: access.userId },
      request: parsed.data,
    });
    const receipt = await access.db.transaction(prepared.apply);

    return NextResponse.json(receipt);
  } catch (error) {
    return taskQualificationErrorResponse(error);
  }
}
