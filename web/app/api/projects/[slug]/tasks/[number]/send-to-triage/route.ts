import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { sendTaskToTriage } from "@/lib/services/triage";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-send-to-triage",
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

// M33 (ADR-087 D13): the task.triage_requeued emitter — ONE transaction
// clears the triage stamp, emits the domain event (subscribed triager agents
// pick it up on the next dispatch tick), and records the activity entry.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
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

    await requireProjectAction(resolved.project.id, "editTask");

    await sendTaskToTriage({
      taskId: resolved.task.id,
      projectId: resolved.project.id,
      taskRef: `${resolved.project.taskKey}-${resolved.task.number}`,
      title: resolved.task.title,
      actor: { type: "user", id: user.id },
    });

    log.info({ slug, taskNumber }, "task re-queued for triage");

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: httpStatusForCode(err.code) },
      );
    }
    const message = err instanceof Error ? err.message : String(err);

    log.error({ slug, err: message }, "send-to-triage unhandled error");

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
