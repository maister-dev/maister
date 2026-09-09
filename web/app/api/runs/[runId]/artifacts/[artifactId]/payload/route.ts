import "server-only";

import type { ArtifactInstance, ArtifactLocator } from "@/lib/db/schema";
import type { Db as ExecutionHostDb } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { openRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import { resolveArtifactContent } from "@/lib/flows/graph/artifact-content";
import { safeDownloadHeaders } from "@/lib/http/safe-download";
import { parseSingleByteRange } from "@/lib/http/single-byte-range";
import { runtimeRoot } from "@/lib/instance-config";
import { getRunDetail } from "@/lib/queries/run";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { artifactInstances } = schemaModule as unknown as Record<string, any>;

// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

const log = pino({
  name: "api-run-artifact-payload",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string; artifactId: string }> };

// AB-12 (D5): every payload is a no-store attachment under nosniff and a
// sandboxing CSP. Server-derived text/JSON keep their passive type; an
// execution object's bytes are opaque, named by the catalogue's logical name.
function artifactDownloadHeaders(
  artifact: ArtifactInstance,
  mediaClass: "text" | "json",
): Readonly<Record<string, string>> {
  return safeDownloadHeaders({
    fileName: `${artifact.kind}-${artifact.id}.${mediaClass === "json" ? "json" : "txt"}`,
    mediaClass,
  });
}

function notFound(): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: "Artifact not found under this run." },
    { status: 404 },
  );
}

function gone(): NextResponse {
  return NextResponse.json(
    {
      code: "PRECONDITION",
      message: "Artifact payload is gone (file deleted).",
    },
    { status: 410 },
  );
}

// Inlined authz → HTTP mapping (the route's own copy; the test mocks
// @/lib/authz with a partial factory, so importing httpStatusForAuthz from
// there is unsafe). Non-authz codes fall through to 500.
function httpStatusForAuthz(code: string): number | null {
  if (code === "UNAUTHENTICATED") return 401;
  if (
    code === "UNAUTHORIZED" ||
    code === "PASSWORD_CHANGE_REQUIRED" ||
    code === "ACCOUNT_INACTIVE"
  ) {
    return 403;
  }

  return null;
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForAuthz(err.code);

    if (status !== null) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }

    const reason = err.details?.reason;

    if (reason === "runtime_object_range_invalid") {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: 416 },
      );
    }
    if (reason === "runtime_object_missing") {
      return gone();
    }
    if (reason === "runtime_object_integrity_mismatch") {
      return NextResponse.json(
        {
          code: "CONFLICT",
          message: "Artifact payload failed its integrity check.",
        },
        { status: 409 },
      );
    }
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error(
    { runId, err: message },
    "GET /api/runs/[runId]/artifacts/[artifactId]/payload",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  req: Request,
  { params }: RouteParams,
): Promise<Response> {
  const { runId, artifactId } = await params;

  try {
    await requireActiveSession();

    const detail = await getRunDetail(runId);

    if (!detail) {
      return notFound();
    }

    await requireProjectAction(detail.projectId, "readBoard");

    const db = getDb() as unknown as Db;
    const artifactRows = (await db
      .select()
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.id, artifactId),
          eq(artifactInstances.runId, runId),
        ),
      )) as ArtifactInstance[];

    const artifact = artifactRows.find(
      (a) => a.id === artifactId && a.runId === runId,
    );

    if (!artifact) {
      return notFound();
    }

    const locator = artifact.locator as ArtifactLocator;

    if (locator.kind === "execution-object") {
      // An execution object is agent session output that can quote any file
      // the agent read, so it carries the repository-content grant the direct
      // content route requires (M22 ADR-053: a viewer cannot browse source).
      // Diff/log/git/inline artifacts stay board evidence at `readBoard`.
      await requireProjectAction(detail.projectId, "readRepoFiles");
      const { object, content } = await openRuntimeObjectContent({
        db: db as unknown as ExecutionHostDb,
        runId,
        objectId: locator.objectId,
        signal: req.signal,
        range: parseSingleByteRange(req.headers.get("range"), {
          syntax: "artifact payload Range must be one bounded byte range",
          bounds: "artifact payload Range is invalid",
        }),
      });
      const headers = new Headers({
        ...safeDownloadHeaders({
          fileName: object.logicalName,
          mediaClass: "opaque",
        }),
        "accept-ranges": "bytes",
      });

      log.debug(
        { runId, artifactId, mediaClass: "opaque", policy: "attachment" },
        "artifact payload served",
      );

      if (content.contentLength !== null) {
        headers.set("content-length", String(content.contentLength));
      }

      if (content.contentDigest) {
        headers.set("content-digest", content.contentDigest);
      }
      if (content.reprDigest) headers.set("repr-digest", content.reprDigest);
      if (content.etag) headers.set("etag", content.etag);
      if (content.contentRange) {
        headers.set("content-range", content.contentRange);
      }

      return new Response(content.body, {
        status: content.contentRange ? 206 : 200,
        headers,
      });
    }

    // ADR-120 (P2, D7): delegate to the SHARED resolver — the SAME locator
    // resolution the runner uses for prompt injection, so the two never drift.
    // The route returns the FULL body (NO cap, NO json→text conversion); the
    // 256 KiB inline cap lives only at the runner's injection seam. This keeps the
    // HTTP contract byte-identical (incl. >256 KiB payloads + structured JSON).
    const resolved = await resolveArtifactContent(artifact, {
      worktreePath: detail.worktreePath,
      projectSlug: detail.projectSlug,
      runId,
      runtimeRoot: runtimeRoot(),
      db,
    });

    switch (resolved.kind) {
      case "text":
        return new NextResponse(resolved.text, {
          headers: artifactDownloadHeaders(artifact, "text"),
        });
      case "json":
        return new NextResponse(JSON.stringify(resolved.value), {
          headers: artifactDownloadHeaders(artifact, "json"),
        });
      case "gone":
        return gone();
      case "notfound":
        return notFound();
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
