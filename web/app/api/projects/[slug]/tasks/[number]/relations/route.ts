import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { addTaskRelation, removeTaskRelation } from "@/lib/social/relations";
import {
  resolveProjectTaskByNumber,
  resolveTaskByKeyRef,
} from "@/lib/social/task-lookup";

const log = pino({
  name: "api-task-relations",
  level: process.env.LOG_LEVEL ?? "info",
});

// `toNumber` is body-controlled but resolved STRICTLY within the URL-param
// project via (project_id, number) — it cannot reach another project.
// `toTaskKey` (ADR-155) deliberately CAN: it is resolved against the
// platform-unique `projects.task_key`, so it is gated by re-checking
// `manageTaskRelations` on whatever project it lands in.
const bodySchema = z
  .object({
    kind: z.enum([
      "blocks",
      "depends_on",
      "parent_of",
      "requires",
      "duplicate_of",
    ]),
    toNumber: z.number().int().min(1).optional(),
    toTaskKey: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (b) => (b.toNumber === undefined) !== (b.toTaskKey === undefined),
    "provide exactly one of toNumber or toTaskKey",
  );

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

    const to =
      body.toTaskKey === undefined
        ? await resolveProjectTaskByNumber(slug, body.toNumber!)
        : await resolveTaskByKeyRef(body.toTaskKey);

    if (!to || to.project.archivedAt !== null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    // ADR-155 D3: a cross-project relation needs authority on BOTH ends. The
    // from-end is already covered above; only a differing target adds a check.
    if (to.project.id !== from.project.id) {
      await requireProjectAction(to.project.id, "manageTaskRelations");
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
      {
        slug,
        taskNumber,
        kind: body.kind,
        toNumber: body.toNumber,
        toTaskKey: body.toTaskKey,
        fromProjectId: from.project.id,
        toProjectId: to.project.id,
        crossProject: to.project.id !== from.project.id,
        mode,
      },
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
