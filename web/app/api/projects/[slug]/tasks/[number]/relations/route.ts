import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { addTaskRelation, removeTaskRelation } from "@/lib/social/relations";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-relations",
  level: process.env.LOG_LEVEL ?? "info",
});

// `toNumber` is body-controlled but resolved STRICTLY within the URL-param
// project via (project_id, number) — cross-project reach is impossible by
// construction (ADR-078 audit table).
const bodySchema = z
  .object({
    kind: z.enum(["blocks", "depends_on", "parent_of", "requires"]),
    toNumber: z.number().int().min(1),
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

  log.error({ slug, err: message }, "task relations unhandled error");

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

type Mode = "add" | "remove";

async function handleRelationMutation(
  req: NextRequest,
  { params }: RouteParams,
  mode: Mode,
): Promise<NextResponse> {
  const { slug, number } = await params;

  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid body: ${(err as Error).message}`),
      slug,
    );
  }

  try {
    const user = await requireActiveSession();
    const taskNumber = parseTaskNumber(number);

    if (taskNumber === null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    const from = await resolveProjectTaskByNumber(slug, taskNumber);

    if (!from) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(from.project.id, "manageTaskRelations");

    const to = await resolveProjectTaskByNumber(slug, body.toNumber);

    if (!to) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    const input = {
      projectId: from.project.id,
      fromTaskId: from.task.id,
      kind: body.kind,
      toTaskId: to.task.id,
      actor: { type: "user" as const, id: user.id },
    };

    if (mode === "add") {
      await addTaskRelation(input);
    } else {
      await removeTaskRelation(input);
    }

    log.info(
      { slug, taskNumber, kind: body.kind, toNumber: body.toNumber, mode },
      "task relation mutated",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function POST(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleRelationMutation(req, ctx, "add");
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleRelationMutation(req, ctx, "remove");
}
