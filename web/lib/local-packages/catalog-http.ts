import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { ZodError } from "zod";

import { CatalogError } from "./catalog-client";
import { getLocalPackage } from "./service";

import { errorResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole, requireProjectAction } from "@/lib/authz";

const log = pino({
  name: "studio-catalog-http",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function catalogOwner(id: string) {
  const actor = await requireGlobalRole("member");
  const draft = await getLocalPackage(id);

  if (!draft || draft.status !== "active")
    throw new CatalogError(404, "Draft unavailable");
  if (draft.projectId)
    await requireProjectAction(draft.projectId, "editSettings");

  return {
    packageId: draft.id,
    workingDir: draft.workingDir,
    actorId: actor.id,
  };
}
export function catalogResponse(error: unknown): NextResponse {
  if (error instanceof CatalogError) {
    log.warn(
      { status: error.status, code: error.code },
      "Catalog request refused",
    );

    return NextResponse.json(
      { code: error.code, message: error.message },
      {
        status: error.status,
        headers: error.status === 429 ? { "Retry-After": "60" } : {},
      },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError)
    return NextResponse.json(
      { code: "CONFIG", message: "Invalid catalog request or source data" },
      { status: 400 },
    );

  return errorResponse(error, log, "studio-catalog");
}
