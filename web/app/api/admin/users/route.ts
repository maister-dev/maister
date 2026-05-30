import "server-only";

import type { AccountStatus } from "@/lib/db/schema";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { listAdminUsers } from "@/lib/users";

const log = pino({
  name: "api-admin-users",
  level: process.env.LOG_LEVEL ?? "info",
});

const querySchema = z.object({
  q: z.string().min(1).max(120).optional(),
  status: z.enum(["pending", "active", "disabled"]).optional(),
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
    "admin users unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = querySchema.safeParse({
    q: req.nextUrl.searchParams.get("q") ?? undefined,
    status: req.nextUrl.searchParams.get("status") ?? undefined,
  });

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid query: ${parsed.error.message}`),
    );
  }

  try {
    await requireGlobalRole("admin");

    const users = await listAdminUsers({
      q: parsed.data.q,
      status: parsed.data.status as AccountStatus | undefined,
    });

    return NextResponse.json({ users });
  } catch (err) {
    return errorResponse(err);
  }
}
