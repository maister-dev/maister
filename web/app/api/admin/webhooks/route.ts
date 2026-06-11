import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  createSubscription,
  listSubscriptions,
} from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-admin-webhooks",
  level: process.env.LOG_LEVEL ?? "info",
});

const PLATFORM_SCOPE = { projectId: null } as const;

// Permissive shape — taxonomy/url/secret-ref validation lives in the service so
// the platform and project routes share one source of truth (CONFIG → 422).
const createBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    url: z.string().min(1),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    event_types: z.array(z.string()).min(1),
    signing_secret_ref: z.string().min(1),
    secondary_signing_secret_ref: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

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
    "admin webhook API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const subscriptions = await listSubscriptions(PLATFORM_SCOPE);

    return NextResponse.json({ subscriptions });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = createBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const created = await createSubscription(PLATFORM_SCOPE, parsed.data);

    log.debug({ id: created.id }, "platform webhook subscription created");

    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
