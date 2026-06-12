import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { updateTaskVerdict } from "@/lib/services/triage";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-patch",
  level: process.env.LOG_LEVEL ?? "info",
});

// M33 (ADR-088 D11): the board card's launch popover persists its
// flow/runner/branch/policy edits here in ONE transaction — SET/CLEAR
// symmetric, an explicit null clears a field. Never touches triage_status.
const patchBodySchema = z
  .object({
    flowId: z.string().min(1).nullable().optional(),
    runnerId: z.string().min(1).nullable().optional(),
    targetBranch: z.string().min(1).max(255).nullable().optional(),
    promotionMode: z
      .enum(["local_merge", "pull_request"])
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
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

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "task PATCH unhandled error");

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

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, number } = await params;

  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid body: ${(err as Error).message}`),
      slug,
    );
  }

  try {
    await requireActiveSession();

    const taskNumber = parseTaskNumber(number);

    if (taskNumber === null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    const resolved = await resolveProjectTaskByNumber(slug, taskNumber);

    if (!resolved) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(resolved.project.id, "editTask");

    await updateTaskVerdict({
      taskId: resolved.task.id,
      projectId: resolved.project.id,
      patch: body,
    });

    log.info(
      { slug, taskNumber, fields: Object.keys(body) },
      "task verdict patched",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
