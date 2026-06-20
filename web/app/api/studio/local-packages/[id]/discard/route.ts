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
  diffWorkingDir,
  discardWorkingDir,
  getLocalPackage,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/discard",
  level: process.env.LOG_LEVEL ?? "info",
});

// Discard working-tree edits, restoring to HEAD. `sessionId` is a body token →
// `assertHoldsLock` gates the git op. `paths` (optional) restricts the discard;
// each entry is confined inside the service via `resolveWithinWorkingDir` BEFORE
// `git checkout` — a raw body path never reaches git. Omitted → restore all.
// Returns the post-discard diff so the editor refreshes its changed-count.
type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    paths: z.array(z.string().min(1)).optional(),
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
    await discardWorkingDir(pkg, parsed.data.paths);

    const diff = await diffWorkingDir(pkg);

    log.info({ id, changedCount: diff.changedCount }, "[localPkg.discard]");

    return NextResponse.json(diff);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/discard POST");
  }
}
