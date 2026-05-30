import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { resetUserPassword } from "@/lib/users";

const log = pino({
  name: "api-admin-user-password-reset",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z.object({
  password: z.string().min(12),
  mustChangePassword: z.boolean(),
});

type RouteParams = { params: Promise<{ userId: string }> };

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, userId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { userId, err: err instanceof Error ? err.message : String(err) },
    "password reset unhandled error",
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
    const message = err instanceof Error ? err.message : String(err);

    throw new MaisterError("CONFIG", `invalid JSON body: ${message}`);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { userId } = await params;
  const body = await parseJson(req).catch((err) => errorResponse(err, userId));

  if (body instanceof NextResponse) {
    return body;
  }

  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid POST body: ${parsed.error.message}`),
      userId,
    );
  }

  try {
    const admin = await requireGlobalRole("admin");

    await resetUserPassword({
      adminUserId: admin.id,
      targetUserId: userId,
      password: parsed.data.password,
      mustChangePassword: parsed.data.mustChangePassword,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, userId);
  }
}
