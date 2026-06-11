import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  deleteSubscription,
  getSubscription,
  updateSubscription,
} from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-admin-webhook",
  level: process.env.LOG_LEVEL ?? "info",
});

const PLATFORM_SCOPE = { projectId: null } as const;

type RouteParams = { params: Promise<{ id: string }> };

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().min(1).optional(),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    event_types: z.array(z.string()).min(1).optional(),
    signing_secret_ref: z.string().min(1).optional(),
    secondary_signing_secret_ref: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
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

function errorResponse(err: unknown, id: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { id, err: err instanceof Error ? err.message : String(err) },
    "admin webhook mutation error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function notFound(id: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `webhook subscription not found: ${id}` },
    { status: 404 },
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

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    const subscription = await getSubscription(PLATFORM_SCOPE, id);

    if (!subscription) return notFound(id);

    return NextResponse.json(subscription);
  } catch (err) {
    return errorResponse(err, id);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const updated = await updateSubscription(PLATFORM_SCOPE, id, parsed.data);

    if (!updated) return notFound(id);

    log.debug({ id }, "platform webhook subscription updated");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, id);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    const deleted = await deleteSubscription(PLATFORM_SCOPE, id);

    if (!deleted) return notFound(id);

    log.info({ id }, "platform webhook subscription deleted");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, id);
  }
}
