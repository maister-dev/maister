import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { updateTask } from "@/lib/services/tasks";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-patch",
  level: process.env.LOG_LEVEL ?? "info",
});

// Board/card edits are PATCH-shaped: SET/CLEAR symmetric for nullable launch
// defaults, and content fields can be patched independently for inline edits.
// Never touches triage_status.
const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
    flowId: z.string().min(1).nullable().optional(),
    runnerId: z.string().min(1).nullable().optional(),
    targetBranch: z.string().min(1).max(255).nullable().optional(),
    promotionMode: z
      .enum(["local_merge", "pull_request"])
      .nullable()
      .optional(),
    executionPolicy: executionPolicySchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

// The full card editor is PUT-shaped: it writes the first-level editable task
// fields as one issue-style save. Lifecycle fields stay owned by the run state.
const putBodySchema = z
  .object({
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    flowId: z.string().min(1).nullable(),
    runnerId: z.string().min(1).nullable(),
    targetBranch: z.string().min(1).max(255).nullable(),
    promotionMode: z.enum(["local_merge", "pull_request"]).nullable(),
    executionPolicy: executionPolicySchema.nullable(),
  })
  .strict();

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

async function handleTaskUpdate<T extends z.ZodTypeAny>(
  req: NextRequest,
  { params }: RouteParams,
  bodySchema: T,
  label: string,
): Promise<NextResponse> {
  const { slug, number } = await params;

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

    let body: z.infer<T>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return errorResponse(
        new MaisterError("CONFIG", `invalid body: ${(err as Error).message}`),
        slug,
      );
    }

    await updateTask(resolved.task.id, resolved.project.id, body);

    log.info({ slug, taskNumber, fields: Object.keys(body) }, label);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleTaskUpdate(req, ctx, patchBodySchema, "task patched");
}

export async function PUT(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleTaskUpdate(req, ctx, putBodySchema, "task replaced");
}
