import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { registerPendingUser } from "@/lib/users";

const log = pino({
  name: "api-auth-register",
  level: process.env.LOG_LEVEL ?? "info",
});

const registerBodySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});

function statusForCode(code: string): number {
  if (code === "CONFLICT") return 409;
  if (code === "CONFIG") return 422;

  return 500;
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
    "register user unhandled error",
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJson(req).catch(errorResponse);

  if (body instanceof NextResponse) {
    return body;
  }

  const parsed = registerBodySchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid POST body: ${parsed.error.message}`),
    );
  }

  try {
    const result = await registerPendingUser(parsed.data);

    return NextResponse.json({ status: result.status }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
