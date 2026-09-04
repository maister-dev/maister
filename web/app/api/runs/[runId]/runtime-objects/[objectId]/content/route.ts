import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { httpStatusForAuthz, requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  getRuntimeObjectForRun,
  readRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";

type RouteParams = { params: Promise<{ runId: string; objectId: string }> };
const rangePattern = /^bytes=(\d+)-(\d*)$/;

function errorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const reason = error.details?.reason;
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

function parseRange(header: string | null): { start: number; end?: number } | undefined {
  if (!header) return undefined;
  const match = header.match(rangePattern);
  if (!match) {
    throw new MaisterError("PRECONDITION", "runtime object Range must use a single byte range", {
      details: { reason: "runtime_object_range_invalid" },
    });
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    throw new MaisterError("PRECONDITION", "runtime object Range is invalid", {
      details: { reason: "runtime_object_range_invalid" },
    });
  }
  return { start, ...(end === undefined ? {} : { end }) };
}

export async function GET(
  request: Request,
  { params }: RouteParams,
): Promise<Response> {
  try {
    await requireActiveSession();
    const { runId, objectId } = await params;
    if (!z.string().uuid().safeParse(objectId).success) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    const db = getDb();
    const loaded = await getRuntimeObjectForRun({ db, runId, objectId });
    if (!loaded || !loaded.projectId) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    await requireProjectAction(loaded.projectId, "readBoard");
    const range = parseRange(request.headers.get("range"));
    const { object, content } = await readRuntimeObjectContent({
      db,
      runId,
      objectId,
      range,
    });
    const headers = new Headers({
      "content-type": object.mimeType,
      "content-length": String(content.bytes.byteLength),
      "accept-ranges": "bytes",
      etag: `\"${object.sha256}\"`,
    });
    if (content.contentDigest) headers.set("content-digest", content.contentDigest);
    if (content.contentRange) headers.set("content-range", content.contentRange);
    return new Response(content.bytes, {
      status: content.contentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
