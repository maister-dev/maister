import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { updateAdminUser } from "@/lib/users";

const log = pino({
  name: "api-admin-user",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({
    role: z.enum(["viewer", "member", "admin"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    password: z.string().min(12).optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.role !== undefined ||
      b.status !== undefined ||
      b.password !== undefined ||
      b.mustChangePassword !== undefined,
    { message: "no fields to update" },
  );

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
    "user mutation unhandled error",
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

export async function PATCH(
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
      new MaisterError("CONFIG", `invalid PATCH body: ${parsed.error.message}`),
      userId,
    );
  }

  try {
    const admin = await requireGlobalRole("admin");

    await updateAdminUser({
      adminUserId: admin.id,
      targetUserId: userId,
      role: parsed.data.role,
      status: parsed.data.status,
      password: parsed.data.password,
      mustChangePassword: parsed.data.mustChangePassword,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, userId);
  }
}
