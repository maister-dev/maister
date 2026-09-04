import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { httpStatusForAuthz, requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getRuntimeObjectForRun } from "@/lib/execution-host/runtime-objects";
import { authorizeRuntimeObjectActor } from "@/lib/execution-host/runtime-object-access";

type RouteParams = { params: Promise<{ runId: string; objectId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    if (error.details?.reason === "runtime_object_not_found") {
      return NextResponse.json({ message: "not found" }, { status: 404 });
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
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const sessionUser = await requireActiveSession();
    const { runId, objectId } = await params;
    if (!z.string().uuid().safeParse(objectId).success) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    const loaded = await getRuntimeObjectForRun({
      db: getDb(),
      runId,
      objectId,
    });
    if (!loaded) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }
    await authorizeRuntimeObjectActor(loaded, sessionUser.id);
    const { object } = loaded;
    return NextResponse.json({
      objectId: object.id,
      kind: object.kind,
      logicalName: object.logicalName,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes?.toString() ?? null,
      sha256: object.sha256,
      generation: object.generation,
      retentionClass: object.retentionClass,
      state: object.state,
      createdAt: object.createdAt.toISOString(),
      sealedAt: object.sealedAt?.toISOString() ?? null,
      expiresAt: object.expiresAt?.toISOString() ?? null,
      deletedAt: object.deletedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
