import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { acquireLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";

// (ADR-093, D10) Editor keep-alive — mirrors POST /api/runs/{runId}/activity.
// Acquire-or-extend: idempotent, called on editor open AND on the heartbeat.
// `heldByMe=false` in the response means another session holds a live lock
// (the editor renders read-only); no 409 — the state is the signal.
const log = pino({
  name: "api/studio/local-packages/[id]/lock-refresh",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.object({ sessionId: z.string().min(1).max(200) }).strict();

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        { code: "CONFIG", message: "sessionId required" },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const lock = await acquireLock(id, user.id, parsed.data.sessionId);

    return NextResponse.json(lock);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/lock-refresh");
  }
}
