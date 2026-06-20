import "server-only";

import type { ImportEntry } from "@/lib/local-packages/import";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import {
  collectImportEntries,
  commitImport,
  previewImport,
} from "@/lib/local-packages/import";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/import",
  level: process.env.LOG_LEVEL ?? "info",
});

// `id` is a url-param (→ server row → working_dir, never client-exposed). The
// body is multipart/form-data: `mode` (preview|commit), `sessionId`, `kind`
// (folder|archive), `files` (one File per folder member OR one archive File),
// and for a folder a `paths` JSON array index-aligned to `files` carrying the
// webkitRelativePath of each member (FormData does NOT preserve it). Every
// member path is confined + capped inside the import lib BEFORE any write;
// commit additionally asserts the session edit-lock.
type RouteParams = { params: Promise<{ id: string }> };

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

async function toBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;

    let form: FormData;

    try {
      form = await req.formData();
    } catch {
      return badBody("expected multipart/form-data");
    }

    const mode = form.get("mode");
    const sessionId = form.get("sessionId");
    const kind = form.get("kind");

    if (mode !== "preview" && mode !== "commit") {
      return badBody("mode must be 'preview' or 'commit'");
    }
    if (kind !== "folder" && kind !== "archive") {
      return badBody("kind must be 'folder' or 'archive'");
    }
    if (
      mode === "commit" &&
      (typeof sessionId !== "string" || sessionId.trim() === "")
    ) {
      return badBody("sessionId is required for commit");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const fileParts = form
      .getAll("files")
      .filter((v): v is File => v instanceof File);

    if (fileParts.length === 0) return badBody("no files provided");

    let collected: { entries: ImportEntry[] };

    if (kind === "folder") {
      const pathsRaw = form.get("paths");

      if (typeof pathsRaw !== "string") {
        return badBody("folder import requires a 'paths' array");
      }

      let relPaths: unknown;

      try {
        relPaths = JSON.parse(pathsRaw);
      } catch {
        return badBody("'paths' must be a JSON array");
      }

      if (
        !Array.isArray(relPaths) ||
        relPaths.length !== fileParts.length ||
        !relPaths.every((p) => typeof p === "string")
      ) {
        return badBody("'paths' must be a string array aligned to 'files'");
      }

      const files = await Promise.all(
        fileParts.map(async (file, i) => ({
          relativePath: relPaths[i] as string,
          bytes: await toBytes(file),
        })),
      );

      collected = await collectImportEntries({ kind: "folder", files });
    } else {
      if (fileParts.length !== 1) {
        return badBody("archive import expects exactly one file");
      }
      const archive = fileParts[0];

      collected = await collectImportEntries({
        kind: "archive",
        fileName: archive.name,
        bytes: await toBytes(archive),
      });
    }

    if (collected.entries.length === 0) {
      throw new MaisterError("PRECONDITION", "the import contains no files");
    }

    if (mode === "preview") {
      const plan = await previewImport(pkg, collected.entries);

      return NextResponse.json({ ...plan, mode: "preview" });
    }

    // Commit: lock first (skill-context: guard before effect), then write. The
    // import lib validates ALL entries before the first write — a reject leaves
    // the working dir unchanged.
    await assertHoldsLock(id, (sessionId as string).trim());
    const plan = await commitImport(pkg, collected.entries);

    log.info(
      { id, fileCount: plan.files.length, totalBytes: plan.totalBytes },
      "[localPkg.import] committed",
    );

    return NextResponse.json({ ...plan, mode: "commit" }, { status: 201 });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/import POST");
  }
}
