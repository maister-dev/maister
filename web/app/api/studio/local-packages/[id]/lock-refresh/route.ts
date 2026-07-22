import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { acquireLock, refreshLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";

// (ADR-096, D10) Editor keep-alive — mirrors POST /api/runs/{runId}/activity.
// Acquire on editor open, refresh on heartbeat. `heldByMe=false` in an acquire
// response means another user holds a live lock (the editor renders read-only);
// no 409 — the state is the signal. A failed refresh is a 409 because this
// session was expired or taken over.
const log = pino({
  name: "api/studio/local-packages/[id]/lock-refresh",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    mode: z.enum(["acquire", "refresh"]).default("acquire"),
  })
  .strict();

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const { id } = await params;
    // An absent or malformed body must reach the documented 422, not a 500:
    // `req.json()` throws SyntaxError on an empty body and `errorResponse`
    // has no SyntaxError branch, so it would surface as CRASH.
    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);

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

    const lock =
      parsed.data.mode === "refresh"
        ? await refreshLock(id, parsed.data.sessionId)
        : await acquireLock(id, user.id, parsed.data.sessionId);

    return NextResponse.json(lock);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/lock-refresh");
  }
}
