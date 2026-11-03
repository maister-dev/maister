import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
  taskLaunchErrorResponse,
} from "@/lib/tasks/launch-http";
import {
  resolveTaskLaunchHold,
  resolveTaskLaunchHoldSchema,
} from "@/lib/tasks/launch-hold";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const body = resolveTaskLaunchHoldSchema.safeParse(
      await readTaskLaunchBody(request),
    );

    if (!body.success)
      throw new MaisterError("CONFIG", "Hold resolution body is invalid", {
        details: { reason: "launch_request_invalid" },
      });

    return NextResponse.json(
      await resolveTaskLaunchHold(getDb(), principal, body.data),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
