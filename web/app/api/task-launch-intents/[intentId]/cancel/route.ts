import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import { taskLaunchCancelBodySchema } from "@/lib/tasks/launch-schema";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
  taskLaunchErrorResponse,
  taskLaunchRequestKey,
} from "@/lib/tasks/launch-http";
import { MaisterError } from "@/lib/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const key = taskLaunchRequestKey(request);
    const parsed = taskLaunchCancelBodySchema.safeParse(
      await readTaskLaunchBody(request),
    );

    if (!parsed.success)
      throw new MaisterError("CONFIG", "Cancellation body is invalid", {
        details: { reason: "launch_request_invalid" },
      });
    const { intentId } = await params;
    const receipt = await cancelInteractiveTaskLaunch(
      getDb(),
      principal,
      intentId,
      parsed.data,
      key,
    );

    return NextResponse.json(receipt, {
      headers: {
        Location: `/api/task-launch-intents/${receipt.intentId}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
