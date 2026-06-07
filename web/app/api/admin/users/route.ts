import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createAdminUser } from "@/lib/users";

const log = pino({
  name: "api-admin-users",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  role: z.enum(["viewer", "member", "admin"]),
  status: z.enum(["active", "pending"]),
  password: z.string().min(12).optional(),
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
    "users admin API error",
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const admin = await requireGlobalRole("admin");

    const body = await parseJson(req);
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const { name, email, role, status, password } = parsed.data;
    const res = await createAdminUser({
      adminUserId: admin.id,
      name,
      email,
      role,
      status,
      password,
    });

    return NextResponse.json(
      { id: res.id, tempPassword: res.tempPassword },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
