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
import { launchLocalPackageAssistant } from "@/lib/scratch-runs/service";

// M36 Phase 5 (ADR-097) T5.7: launch the docked authoring assistant for a local
// package. `sessionId` is the editor's working-dir lock session — `assertHoldsLock`
// gates the launch so the assistant runs UNDER the holder's lock (the run writes
// as the lock holder; only the holder may spawn it). One ACP run per editor tab,
// counting against the flow/scratch concurrency pool (MAISTER_MAX_CONCURRENT_RUNS).
const log = pino({
  name: "api/studio/local-packages/[id]/assistant",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    prompt: z.string().trim().min(1).max(60_000),
    runnerId: z.string().trim().min(1).optional(),
  })
  .strict();

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    // Lock coordination: only the live working-dir lock holder may launch the
    // assistant (a CONFLICT surfaces the editor's reload banner).
    await assertHoldsLock(id, parsed.data.sessionId);

    const result = await launchLocalPackageAssistant({
      body: {
        localPackageId: id,
        prompt: parsed.data.prompt,
        runnerId: parsed.data.runnerId,
      },
      userId: user.id,
    });

    log.info(
      { id, runId: result.runId, dialogStatus: result.status.dialogStatus },
      "[localPkg.assistant] launched",
    );

    return NextResponse.json(
      { runId: result.runId, dialogStatus: result.status.dialogStatus },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/assistant POST");
  }
}
