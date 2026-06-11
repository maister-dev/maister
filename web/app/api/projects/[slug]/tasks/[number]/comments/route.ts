import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  addTaskComment,
  listTaskComments,
  toCommentDTOs,
} from "@/lib/social/comments";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-comments",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z
  .object({
    body: z.string().min(1).max(10_000),
  })
  .strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Runs-family mapping: CONFIG → 400 (NOT the legacy tasks-route 422).
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

  log.error({ slug, err: message }, "task comments unhandled error");

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

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
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

    await requireProjectAction(resolved.project.id, "readBoard");

    const query = listQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    if (!query.success) {
      throw new MaisterError("CONFIG", "invalid limit/offset query");
    }

    const rows = await listTaskComments(resolved.task.id, query.data);
    const comments = await toCommentDTOs(rows);

    return NextResponse.json({ comments });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, number } = await params;

  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      slug,
    );
  }

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

    await requireProjectAction(resolved.project.id, "commentTask");

    const record = await addTaskComment({
      taskId: resolved.task.id,
      body: body.body,
      actor: { type: "user", id: user.id },
    });
    const [comment] = await toCommentDTOs([record]);

    log.info(
      { slug, taskNumber, commentId: comment.id },
      "task comment posted",
    );

    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
