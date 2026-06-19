import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { hardDeleteAdminUser, updateAdminUser } from "@/lib/users";

const log = pino({
  name: "api-admin-user",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    role: z.enum(["viewer", "member", "admin"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    password: z.string().min(12).optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.email !== undefined ||
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

  try {
    // Auth-first: the admin check precedes reading/validating the body, so a
    // non-admin caller never receives a CONFIG/Zod schema oracle.
    const admin = await requireGlobalRole("admin");

    const parsed = bodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    await updateAdminUser({
      adminUserId: admin.id,
      targetUserId: userId,
      name: parsed.data.name,
      email: parsed.data.email,
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

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { userId } = await params;

  try {
    const admin = await requireGlobalRole("admin");

    await hardDeleteAdminUser({ adminUserId: admin.id, targetUserId: userId });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, userId);
  }
}
