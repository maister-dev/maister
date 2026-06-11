import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  getWebhookSettings,
  setWebhookSettings,
} from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-admin-webhook-settings",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchBodySchema = z.object({ enabled: z.boolean() }).strict();

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
    "admin webhook settings error",
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

    const settings = await getWebhookSettings();

    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const settings = await setWebhookSettings({ enabled: parsed.data.enabled });

    log.debug({ enabled: settings.enabled }, "webhook kill-switch updated");

    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}
