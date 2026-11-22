import { NextResponse } from "next/server";

import { MaisterError } from "@/lib/errors";
import {
  admitTaskToBacklog,
  backlogAdmissionRequest,
} from "@/lib/tasks/backlog-admission";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
} from "@/lib/tasks/launch-http";
import {
  requireTaskQualificationAccess,
  taskQualificationErrorResponse,
} from "@/lib/tasks/qualification-http";

export async function POST(
  request: Request,
  route: { params: Promise<{ slug: string; number: string }> },
): Promise<NextResponse> {
  try {
    assertInteractiveLaunchOrigin(request);
    const { slug, number } = await route.params;
    const access = await requireTaskQualificationAccess(slug, number);
    const body = backlogAdmissionRequest.safeParse(
      await readTaskLaunchBody(request),
    );

    if (!body.success)
      throw new MaisterError("CONFIG", "Invalid backlog admission revision");
    await admitTaskToBacklog(access.db, access, body.data);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return taskQualificationErrorResponse(error);
  }
}
