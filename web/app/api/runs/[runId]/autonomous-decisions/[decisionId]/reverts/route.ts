import { eq } from "drizzle-orm";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import {
  recordAutonomousReversal,
  reversalBody,
} from "@/lib/auto-promotion/reversals";
import { requireActiveSession, requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; decisionId: string }> },
) {
  if (request.headers.has("authorization"))
    return privateJson(
      { code: "UNAUTHORIZED", message: "Session authorization required" },
      403,
    );

  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { runId, decisionId } = await params;
    const db = getDb();
    const [run] = await db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!run?.projectId)
      return privateJson({ code: "NOT_FOUND", message: "Run not found" }, 404);
    await requireProjectActionForUser(user.id, run.projectId, "promoteRun");
    const body = reversalBody.safeParse(await readBoundedJson(request, 4096));

    if (!body.success)
      return privateJson(
        { code: "CONFIG", message: "Invalid revert commit" },
        422,
      );
    const reversal = await recordAutonomousReversal(db, {
      runId,
      projectId: run.projectId,
      decisionId,
      reporterId: user.id,
      revertSha: body.data.revertSha,
    });

    return privateJson(
      { receiptId: reversal.receiptId },
      reversal.created ? 201 : 200,
    );
  } catch (error: unknown) {
    return privateErrorResponse(
      error,
      "/api/runs/{runId}/autonomous-decisions/{decisionId}/reverts",
    );
  }
}
