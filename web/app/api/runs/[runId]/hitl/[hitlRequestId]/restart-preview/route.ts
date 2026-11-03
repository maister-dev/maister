import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { previewBudgetRestart } from "@/lib/tasks/launch-budget-restart";
import { taskLaunchErrorResponse } from "@/lib/tasks/launch-http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string; hitlRequestId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await interactiveTaskLaunchPrincipal();
    const parsed = z
      .object({
        runId: z.string().min(1).max(256),
        hitlRequestId: z.string().min(1).max(256),
      })
      .strict()
      .safeParse(await context.params);

    if (!parsed.success)
      return NextResponse.json(
        { code: "CONFIG", message: "Restart preview is unavailable" },
        { status: 404 },
      );
    const { runId, hitlRequestId } = parsed.data;
    const preview = await getDb().transaction((tx) =>
      previewBudgetRestart(tx, principal, runId, hitlRequestId),
    );

    return NextResponse.json(preview, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (
      isMaisterError(error) &&
      (error.code === "UNAUTHORIZED" ||
        error.details?.reason === "budget_restart_preview_required")
    )
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message:
            "Restart preview is unavailable; inspect the run or create a fresh Launch",
        },
        { status: 404 },
      );

    return taskLaunchErrorResponse(error);
  }
}
