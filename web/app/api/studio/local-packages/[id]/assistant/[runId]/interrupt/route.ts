import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";
import { interruptScratchRun } from "@/lib/scratch-runs/service";

const log = pino({
  name: "api/studio/local-packages/[id]/assistant/[runId]/interrupt",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string; runId: string }> };

// Not strict — the composer reuses messageBodyExtras (sessionId + focus); only
// sessionId is needed here and any extra keys are ignored.
const bodySchema = z.object({ sessionId: z.string().trim().min(1) });

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

// Interrupt the local-package authoring assistant's in-flight turn — same Stop
// control as a project scratch run, gated by the editor lock so only the
// session holding the lock can cancel its own turn.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id, runId } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    await assertHoldsLock(id, parsed.data.sessionId);

    const result = await interruptScratchRun(runId);

    log.info(
      { localPackageId: id, runId, cancelled: result.cancelled },
      "[localPkg.assistant] interrupt requested",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/assistant/[runId]/interrupt POST",
    );
  }
}
