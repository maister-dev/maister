import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { httpStatusForCode, toCommentDto } from "@/lib/review-comments/dto";
import { editBody, remove, setStatus } from "@/lib/review-comments/service";

// ADR-072 review-comment item routes (PATCH edit|resolve, DELETE). Thin
// handlers: zod parse, authz (projectId always derived from the run row),
// service call, MaisterError→HTTP map. The open-review-gate guard, author
// rules, and root-only resolve live in the service; its null return is
// not-found semantics (unknown commentId or row.run_id !== runId) → bare 404.
// Neither method touches the diff pipeline.

const log = pino({
  name: "api-review-comment-item",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string; commentId: string }> };

type RunRow = typeof runs.$inferSelect;

// Strict union (OpenAPI PatchReviewCommentBody): exactly one of {body} (edit)
// or {status} (resolve/re-open) — a mixed, empty, or unknown-keyed payload
// fails BOTH branches → 400.
const editBodySchema = z
  .object({ body: z.string().min(1).max(10_000) })
  .strict();

const setStatusSchema = z
  .object({ status: z.enum(["open", "resolved"]) })
  .strict();

const patchBodySchema = z.union([editBodySchema, setStatusSchema]);

function errorResponse(
  err: unknown,
  ctx: { runId: string; commentId: string; method: "PATCH" | "DELETE" },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "review-comment item error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "review-comment item unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg.
function db(): NodePgDatabase {
  return getDb() as unknown as NodePgDatabase;
}

async function loadRun(
  dbh: NodePgDatabase,
  runId: string,
): Promise<RunRow | null> {
  const rows = await dbh.select().from(runs).where(eq(runs.id, runId));

  return rows[0] ?? null;
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, commentId } = await params;

  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid review-comment patch body: ${(err as Error).message}`,
      ),
      { runId, commentId, method: "PATCH" },
    );
  }

  try {
    // Auth-first: authenticate before any resource lookup so unauthenticated
    // callers cannot probe run existence; project membership is enforced once
    // projectId is derived from the run row.
    const sessionUser = await requireActiveSession();

    const dbh = db();
    const run = await loadRun(dbh, runId);

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "answerHitl");

    const actor = {
      userId: sessionUser.id,
      label: sessionUser.name ?? sessionUser.email ?? sessionUser.id,
    };

    const updated =
      "body" in body
        ? await editBody(dbh, actor, runId, commentId, body.body)
        : await setStatus(dbh, actor, runId, commentId, body.status);

    if (!updated) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return NextResponse.json({ comment: toCommentDto(updated) });
  } catch (err) {
    return errorResponse(err, { runId, commentId, method: "PATCH" });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, commentId } = await params;

  try {
    const sessionUser = await requireActiveSession();

    const dbh = db();
    const run = await loadRun(dbh, runId);

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "answerHitl");

    const actor = {
      userId: sessionUser.id,
      label: sessionUser.name ?? sessionUser.email ?? sessionUser.id,
    };

    const removed = await remove(dbh, actor, runId, commentId);

    if (!removed) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, { runId, commentId, method: "DELETE" });
  }
}
