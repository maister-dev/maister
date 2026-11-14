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
import {
  boundArtifactText,
  resolveArtifactContent,
} from "@/lib/flows/graph/artifact-content";
import {
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_PREVIEW_TRUNCATED_HEADER,
} from "@/lib/http/artifact-preview";
import { safeDownloadHeaders } from "@/lib/http/safe-download";
import { CONSENSUS_AGENT_OUTPUT_ARTIFACT_DEFS } from "@/lib/flows/graph/consensus/artifact-defs";
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

function textPreview(
  artifact: ArtifactInstance,
  text: string,
  sourceTruncated?: true,
): NextResponse {
  const bounded = boundArtifactText(text, ARTIFACT_PREVIEW_MAX_BYTES);

  return new NextResponse(bounded.text, {
    headers: {
      ...artifactDownloadHeaders(artifact, "text"),
      [ARTIFACT_PREVIEW_TRUNCATED_HEADER]: String(
        sourceTruncated === true || bounded.truncated,
      ),
    },
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
    // Error taxonomy: missing host bytes 404, tombstone 410, failed
    // integrity 422 — the same distinct outcomes as the content route.
    if (reason === "runtime_object_missing") {
      return NextResponse.json(
        { code: "PRECONDITION", message: "Artifact payload is missing." },
        { status: 404 },
      );
    }
    if (reason === "runtime_object_deleted") {
      return gone();
    }
    if (reason === "runtime_object_integrity_mismatch") {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message: "Artifact payload failed its integrity check.",
        },
        { status: 422 },
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

    // Execution objects and inline consensus output can quote private source.
    // Both require the repository-content grant used by direct object reads.
    if (
      locator.kind === "execution-object" ||
      (locator.kind === "inline" &&
        artifact.artifactDefId !== null &&
        CONSENSUS_AGENT_OUTPUT_ARTIFACT_DEFS.has(artifact.artifactDefId))
    )
      await requireProjectAction(detail.projectId, "readRepoFiles");
    const views = new URL(req.url).searchParams.getAll("view");
    const preview = views.length === 1 && views[0] === "preview";

    if (views.length && (!preview || req.headers.has("range"))) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message:
            "Artifact preview requires one view=preview and no Range header.",
        },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    if (locator.kind === "execution-object") {
      const { object, content } = await openRuntimeObjectContent({
        db: db as unknown as ExecutionHostDb,
        runId,
        objectId: locator.objectId,
        signal: req.signal,
        range: preview
          ? { start: 0, end: ARTIFACT_PREVIEW_MAX_BYTES - 1 }
          : parseSingleByteRange(req.headers.get("range"), {
              syntax: "artifact payload Range must be one bounded byte range",
              bounds: "artifact payload Range is invalid",
            }),
      });
      const headers = new Headers({
        ...safeDownloadHeaders({
          fileName: object.logicalName,
          mediaClass: "opaque",
        }),
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
      if (preview) {
        headers.set(
          ARTIFACT_PREVIEW_TRUNCATED_HEADER,
          String(
            object.sizeBytes !== null &&
              object.sizeBytes > ARTIFACT_PREVIEW_MAX_BYTES,
          ),
        );
      } else {
        headers.set("accept-ranges", "bytes");
        if (content.contentRange)
          headers.set("content-range", content.contentRange);
      }

      return new Response(content.body, {
        status: !preview && content.contentRange ? 206 : 200,
        headers,
      });
    }

    // ADR-120 (P2, D7): delegate to the SHARED resolver — the SAME locator
    // resolution the runner uses for prompt injection, so the two never drift.
    // Downloads keep their full representation and passive content type.
    const resolved = await resolveArtifactContent(artifact, {
      worktreePath: detail.worktreePath,
      projectSlug: detail.projectSlug,
      runId,
      runtimeRoot: runtimeRoot(),
      db,
      ...(preview ? { maxBytes: ARTIFACT_PREVIEW_MAX_BYTES } : {}),
    });

    switch (resolved.kind) {
      case "text":
        if (preview)
          return textPreview(artifact, resolved.text, resolved.truncated);

        return new NextResponse(resolved.text, {
          headers: artifactDownloadHeaders(artifact, "text"),
        });
      case "json": {
        const body = JSON.stringify(resolved.value);

        if (preview) return textPreview(artifact, body);

        return new NextResponse(body, {
          headers: artifactDownloadHeaders(artifact, "json"),
        });
      }
      case "gone":
        return gone();
      case "notfound":
        return notFound();
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
