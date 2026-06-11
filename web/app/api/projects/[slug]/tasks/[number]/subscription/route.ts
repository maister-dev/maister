import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { subscribe, unsubscribe } from "@/lib/social/subscriptions";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-subscription",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "task subscription unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function parseTaskNumber(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === raw
    ? parsed
    : null;
}

type RouteParams = { params: Promise<{ slug: string; number: string }> };

// The subscriber is ALWAYS the session user (auth-context) — never a
// body-supplied pair (ADR-075 audit table).
async function handleSubscription(
  { params }: RouteParams,
  mode: "follow" | "unfollow",
): Promise<NextResponse> {
  const { slug, number } = await params;

  try {
    const user = await requireActiveSession();
    const taskNumber = parseTaskNumber(number);

    if (taskNumber === null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    const resolved = await resolveProjectTaskByNumber(slug, taskNumber);

    if (!resolved) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(resolved.project.id, "readBoard");

    const subscriber = { type: "user" as const, id: user.id };

    if (mode === "follow") {
      await subscribe(getDb(), {
        taskId: resolved.task.id,
        subscriber,
        reason: "manual",
      });
    } else {
      await unsubscribe(getDb(), {
        taskId: resolved.task.id,
        subscriber,
      });
    }

    log.info({ slug, taskNumber, mode }, "task subscription mutated");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function POST(
  _req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleSubscription(ctx, "follow");
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleSubscription(ctx, "unfollow");
}
