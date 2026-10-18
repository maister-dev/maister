import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { completeTask } from "@/lib/services/task-completion";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-complete",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; number: string }> };

function parseTaskNumber(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 1 && String(parsed) === raw
    ? parsed
    : null;
}

function httpStatus(code: string): number {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "UNAUTHORIZED" || code === "PASSWORD_CHANGE_REQUIRED") {
    return 403;
  }
  if (code === "CONFIG") return 422;
  if (code === "PRECONDITION" || code === "CONFLICT") return 409;

  return 500;
}

export async function POST(
  req: NextRequest,
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

    let body: z.infer<typeof bodySchema>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json(
        { code: "CONFIG", message: `invalid body: ${(err as Error).message}` },
        { status: 422 },
      );
    }

    const result = await completeTask(resolved.task.id, resolved.project.id, {
      expectedRevision: body.expectedRevision,
      actor: { type: "user", id: user.id },
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message, details: err.details },
        { status: httpStatus(err.code) },
      );
    }

    log.error(
      { slug, number, error: err instanceof Error ? err.message : String(err) },
      "task completion failed",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
