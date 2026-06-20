import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireGlobalRole } from "@/lib/authz";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import {
  deleteWorkingDirFile,
  getLocalPackage,
  readFileContent,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/files",
  level: process.env.LOG_LEVEL ?? "info",
});

// `id` is a url-param (server-state lookup → working_dir). `path` is the
// url-controlled `[...path]` catch-all — confined inside the service by
// `resolveWithinWorkingDir` before any fs call. `sessionId` is a body token →
// `assertHoldsLock` gates every write. Next decodes route params, so the
// segments are joined raw; the confinement guard is robust to either form.
type RouteParams = { params: Promise<{ id: string; path: string[] }> };

const writeBodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    content: z.string(),
  })
  .strict();

const deleteBodySchema = z
  .object({ sessionId: z.string().trim().min(1) })
  .strict();

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();
    const { id, path: segments } = await params;
    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const file = await readFileContent(pkg, segments.join("/"));

    return NextResponse.json(file);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/files GET");
  }
}

export async function PUT(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id, path: segments } = await params;
    const parsed = writeBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    // Lock first, then the file-system side (skill-context: guard before effect).
    await assertHoldsLock(id, parsed.data.sessionId);
    const file = await writeWorkingDirFile(
      pkg,
      segments.join("/"),
      parsed.data.content,
    );

    log.debug({ id, op: "put", path: file.path }, "[localPkg.files]");

    return NextResponse.json(file);
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/files PUT");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id, path: segments } = await params;
    const parsed = deleteBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    await assertHoldsLock(id, parsed.data.sessionId);
    await deleteWorkingDirFile(pkg, segments.join("/"));

    log.debug(
      { id, op: "delete", path: segments.join("/") },
      "[localPkg.files]",
    );

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/files DELETE");
  }
}
