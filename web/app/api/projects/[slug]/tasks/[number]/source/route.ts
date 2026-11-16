import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";
import { detachTaskSource } from "@/lib/tasks/external-source/service";

const log = pino({
  name: "api-task-source",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
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

type RouteParams = { params: Promise<{ slug: string; number: string }> };

function parseTaskNumber(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === raw
    ? parsed
    : null;
}

// ADR-206: an audited human detach. Session-only by construction — tokens never
// reach session routes, so no agent or project token can free an identity.
export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, number } = await params;

  try {
    const user = await requireActiveSession();
    const taskNumber = parseTaskNumber(number);
    const resolved =
      taskNumber === null
        ? null
        : await resolveProjectTaskByNumber(slug, taskNumber);

    if (!resolved) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(resolved.project.id, "editTask");
    await detachTaskSource({
      projectId: resolved.project.id,
      taskId: resolved.task.id,
      actor: { type: "user", id: user.id },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message, details: err.details },
        { status: httpStatusForCode(err.code) },
      );
    }
    log.error(
      { slug, err: err instanceof Error ? err.message : String(err) },
      "task source detach unhandled error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
