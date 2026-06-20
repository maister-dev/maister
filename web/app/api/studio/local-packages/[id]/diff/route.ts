import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession } from "@/lib/authz";
import { diffWorkingDir, getLocalPackage } from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/diff",
  level: process.env.LOG_LEVEL ?? "info",
});

// `id` is a url-param (→ server row → working_dir, never client-exposed). The
// working-tree-vs-HEAD diff of the local package's git working dir: the
// uncommitted edits the editor is about to commit/discard. Read-only —
// requireActiveSession only, NO edit-lock (a second viewer may inspect the diff).
type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();
    const { id } = await params;
    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    // `@git-diff-view` DTO (files/perFile/truncated) + a changed-count. Carries
    // NO abs path — `working_dir` never leaves the server.
    const diff = await diffWorkingDir(pkg);

    return NextResponse.json(diff);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/diff GET");
  }
}
