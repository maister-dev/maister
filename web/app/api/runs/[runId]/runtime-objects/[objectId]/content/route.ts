import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { httpStatusForAuthz, requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import {
  getRuntimeObjectForRun,
  openRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";
import { authorizeRuntimeObjectContentActor } from "@/lib/execution-host/runtime-object-access";
import { safeDownloadHeaders } from "@/lib/http/safe-download";
import { parseSingleByteRange } from "@/lib/http/single-byte-range";

type RouteParams = { params: Promise<{ runId: string; objectId: string }> };

const log = pino({
  name: "api-run-runtime-object-content",
  level: process.env.LOG_LEVEL ?? "info",
});

function errorResponse(
  error: unknown,
  ids: { runId: string; objectId: string },
): NextResponse {
  if (isMaisterError(error)) {
    const reason = error.details?.reason;

    // Refusals are logged by identity and code only — never a name or header.
    log.warn(
      { ...ids, code: error.code, reason: reason ?? null },
      "runtime object content refused",
    );

    if (reason === "runtime_object_not_found") {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    if (reason === "runtime_object_range_invalid") {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: 416 },
      );
    }
    if (reason === "runtime_object_missing") {
      return NextResponse.json(
        { code: "PRECONDITION", message: "Runtime object content is gone." },
        { status: 410 },
      );
    }
    if (reason === "runtime_object_integrity_mismatch") {
      return NextResponse.json(
        {
          code: "CONFLICT",
          message: "Runtime object content failed its integrity check.",
        },
        { status: 409 },
      );
    }
    if (error.code === "EXECUTOR_UNAVAILABLE") {
      return NextResponse.json(
        { code: error.code, message: "Runtime object host is unavailable." },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { code: error.code, message: error.message },
      { status: httpStatusForAuthz(error.code) ?? 409 },
    );
  }

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  request: Request,
  { params }: RouteParams,
): Promise<Response> {
  const { runId, objectId } = await params;

  try {
    const sessionUser = await requireActiveSession();

    if (!z.string().uuid().safeParse(objectId).success) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    const db = getDb();
    const loaded = await getRuntimeObjectForRun({ db, runId, objectId });

    if (!loaded) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    await authorizeRuntimeObjectContentActor(loaded, sessionUser.id);
    const range = parseSingleByteRange(request.headers.get("range"), {
      syntax: "runtime object Range must use a single byte range",
      bounds: "runtime object Range is invalid",
    });
    const { object, content } = await openRuntimeObjectContent({
      db,
      runId,
      objectId,
      range,
    });
    // AB-12 (D5): the catalogued MIME is caller-supplied metadata, never a
    // response type. Bytes leave as an opaque, non-sniffable, sandboxed,
    // uncacheable attachment named after the manager's logical name.
    const headers = new Headers({
      ...safeDownloadHeaders({
        fileName: object.logicalName,
        mediaClass: "opaque",
      }),
      "accept-ranges": "bytes",
      etag: `\"${object.sha256}\"`,
    });

    if (content.contentLength !== null) {
      headers.set("content-length", String(content.contentLength));
    }
    if (content.contentDigest)
      headers.set("content-digest", content.contentDigest);
    if (content.contentRange)
      headers.set("content-range", content.contentRange);

    log.debug(
      { runId, objectId, mediaClass: "opaque", policy: "attachment" },
      "runtime object content served",
    );

    return new Response(content.body, {
      status: content.contentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    return errorResponse(error, { runId, objectId });
  }
}
