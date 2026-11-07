import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { acceptInteractiveTaskLaunch } from "@/lib/tasks/launch-intent";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
  taskLaunchErrorResponse,
  taskLaunchRequestKey,
} from "@/lib/tasks/launch-http";
import { taskLaunchBodySchema } from "@/lib/tasks/launch-schema";
import { MaisterError } from "@/lib/errors";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const requestKey = taskLaunchRequestKey(request);
    const parsed = taskLaunchBodySchema.safeParse(
      await readTaskLaunchBody(request),
    );

    if (!parsed.success)
      throw new MaisterError("CONFIG", "Task launch body is invalid", {
        details: { reason: "launch_request_invalid" },
      });
    const receipt = await acceptInteractiveTaskLaunch(
      getDb(),
      principal,
      parsed.data,
      requestKey,
    );

    wakeAcceptedTaskLaunch(getDb(), receipt);

    return NextResponse.json(receipt, {
      status: 202,
      headers: {
        Location: `/api/task-launch-intents/${receipt.intentId}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
