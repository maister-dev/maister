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
import {
  commitWorkingDir,
  diffWorkingDir,
  getLocalPackage,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/commit",
  level: process.env.LOG_LEVEL ?? "info",
});

// Commit every working-tree edit to the local-package branch. `sessionId` is a
// body token → `assertHoldsLock` gates the git op (skill-context: guard before
// effect). Returns the post-commit diff so the editor refreshes its changed-count
// (clean → 0) without a second round-trip.
type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    message: z.string().max(1000).optional(),
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
    await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    await assertHoldsLock(id, parsed.data.sessionId);
    await commitWorkingDir(pkg, parsed.data.message);

    const diff = await diffWorkingDir(pkg);

    log.info({ id, changedCount: diff.changedCount }, "[localPkg.commit]");

    return NextResponse.json(diff);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/commit POST");
  }
}
