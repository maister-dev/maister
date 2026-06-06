import "server-only";

import type { NextRequest } from "next/server";

import { timingSafeEqual } from "node:crypto";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; body: { code: string; message: string } };

const CRON_TOKEN_HEADER = "X-Maister-Cron-Token";

export function authorizeCronRequest(req: NextRequest): CronAuthResult {
  const expected = process.env.MAISTER_CRON_TOKEN;

  if (!expected) {
    return {
      ok: false,
      status: 503,
      body: {
        code: "CONFIG",
        message: "MAISTER_CRON_TOKEN is unset - cron disabled",
      },
    };
  }

  const provided = cronTokenFromRequest(req);

  if (!tokenMatches(provided, expected)) {
    return {
      ok: false,
      status: 401,
      body: {
        code: "UNAUTHENTICATED",
        message: "missing or invalid cron token",
      },
    };
  }

  return { ok: true };
}

function cronTokenFromRequest(req: NextRequest): string | null {
  const header = req.headers.get(CRON_TOKEN_HEADER);

  if (header) return header;

  const authorization = req.headers.get("authorization");
  const bearerPrefix = "Bearer ";

  if (authorization?.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length);
  }

  return null;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;

  try {
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(expected);

    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
