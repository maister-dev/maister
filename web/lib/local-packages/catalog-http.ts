import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { ZodError } from "zod";

import { CatalogError } from "./catalog-client";
import { withWorkingDirLock } from "./lock";
import { getLocalPackage } from "./service";

import { errorResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";

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

// A live writer owns all mutations. Readers can observe its atomically published
// receipt, while an idle lease still reconciles interrupted applies before use.
export async function withCatalogReceipt<T>(
  id: string,
  underLease: () => Promise<T>,
  whileBusy: () => Promise<T | null>,
): Promise<T> {
  try {
    return await withWorkingDirLock(id, underLease);
  } catch (error) {
    if (
      !isMaisterError(error) ||
      error.code !== "CONFLICT" ||
      error.details?.reason !== "operation_in_progress"
    )
      throw error;
    const receipt = await whileBusy();

    if (receipt === null) throw error;

    return receipt;
  }
}
