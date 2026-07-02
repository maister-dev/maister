import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { assertBrainProvisioned } from "@/lib/brain/guard";
import {
  ENV_REF_RE,
  getBrainSettings,
  MAX_EMBEDDING_DIMENSIONS,
  updateBrainSettings,
} from "@/lib/brain/settings";
import { isMaisterError, MaisterError } from "@/lib/errors";

// Admin-only platform Project-Brain embedding + distillation config (ADR-122),
// mirroring the webhook-settings admin route: the singleton
// platform_runtime_settings row. The API key is stored ONLY as its env:NAME
// reference — never the secret value.

const log = pino({
  name: "api-admin-brain-settings",
  level: process.env.LOG_LEVEL ?? "info",
});

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "admin brain settings error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new MaisterError("CONFIG", "invalid JSON body");
  }
}

const patchSchema = z
  .object({
    // A URL with embedded credentials would also leak into logs — require a
    // parseable URL shape up front.
    embeddingBaseUrl: z.string().url().nullable().optional(),
    embeddingModel: z.string().min(1).nullable().optional(),
    embeddingDimensions: z
      .number()
      .int()
      .positive()
      .max(MAX_EMBEDDING_DIMENSIONS)
      .nullable()
      .optional(),
    embeddingApiKeyRef: z.string().regex(ENV_REF_RE).nullable().optional(),
    distillModel: z.string().min(1).nullable().optional(),
  })
  .strict();

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    // SQLite → 409 PRECONDITION (E-11) before touching the settings row.
    assertBrainProvisioned();

    return NextResponse.json(await getBrainSettings(), { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    assertBrainProvisioned();

    const body = await parseJson(req);
    const parsed = patchSchema.safeParse(body);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        parsed.error.issues[0]?.message ?? "invalid brain settings body",
      );
    }

    const updated = await updateBrainSettings(parsed.data);

    return NextResponse.json(updated, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
