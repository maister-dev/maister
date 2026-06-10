import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DiffPrepResult } from "@/lib/diff/prepare";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { extractAnchorContent } from "@/lib/review-comments/anchor";
import { httpStatusForCode, toCommentDto } from "@/lib/review-comments/dto";
import {
  computeRunDiff,
  placementOf,
} from "@/lib/review-comments/run-diff-source";
import {
  createReply,
  createRoot,
  listThreads,
} from "@/lib/review-comments/service";

// ADR-071 review-comment routes (GET list+placement, POST root|reply). Thin
// handlers: zod parse, authz (projectId always derived from the run row),
// ONE diff computation per request (`run-diff-source.ts` — shared with the
// run-detail layout's gate panel), service call, MaisterError→HTTP map.
// The open-review-gate guard and thread integrity live in the service.

const log = pino({
  name: "api-review-comments",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

type RunRow = typeof runs.$inferSelect;

// Body is a shape-discriminated STRICT union (OpenAPI PostReviewCommentBody):
// a mixed root+reply payload fails BOTH branches, and a client-sent
// lineContent is an unknown key — the server extracts it from the diff.
const rootBodySchema = z
  .object({
    filePath: z.string().min(1),
    side: z.enum(["old", "new"]),
    line: z.number().int().min(1),
    body: z.string().min(1).max(10_000),
  })
  .strict();

const replyBodySchema = z
  .object({
    parentId: z.string().uuid(),
    body: z.string().min(1).max(10_000),
  })
  .strict();

const postBodySchema = z.union([rootBodySchema, replyBodySchema]);

function errorResponse(
  err: unknown,
  ctx: { runId: string; method: "GET" | "POST" },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "review-comments error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "review-comments unhandled error");

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

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const dbh = db();
    const run = await loadRun(dbh, runId);

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "readBoard");

    const threads = await listThreads(dbh, runId);

    if (threads.length === 0) {
      return NextResponse.json({ threads: [] });
    }

    // NOT status-gated: thread history stays visible after the gate closes,
    // like the diff. When the diff source is gone (GC'd worktree, terminal
    // run) the snapshot still renders — every placement degrades to
    // "outdated" instead of failing the read.
    let prepared: DiffPrepResult | null = null;

    try {
      prepared = await computeRunDiff(dbh, run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      log.warn(
        { runId, err: message },
        "diff unavailable — placements degrade to outdated",
      );
    }

    return NextResponse.json({
      threads: threads.map((thread) => ({
        root: toCommentDto(thread.root),
        placement: placementOf(prepared, thread.root),
        replies: thread.replies.map(toCommentDto),
      })),
    });
  } catch (err) {
    return errorResponse(err, { runId, method: "GET" });
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid review-comment body: ${(err as Error).message}`,
      ),
      { runId, method: "POST" },
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

    if ("parentId" in body) {
      const created = await createReply(dbh, actor, runId, {
        parentId: body.parentId,
        body: body.body,
      });

      return NextResponse.json(
        { comment: toCommentDto(created) },
        { status: 201 },
      );
    }

    const prepared = await computeRunDiff(dbh, run);
    const extraction = extractAnchorContent(prepared, {
      filePath: body.filePath,
      side: body.side,
      line: body.line,
    });

    if (!extraction.ok) {
      throw new MaisterError(
        "PRECONDITION",
        `anchor validation failed (${extraction.reason})`,
      );
    }

    const created = await createRoot(dbh, actor, runId, {
      filePath: body.filePath,
      side: body.side,
      line: body.line,
      lineContent: extraction.lineContent,
      body: body.body,
    });

    return NextResponse.json(
      { comment: toCommentDto(created) },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, { runId, method: "POST" });
  }
}
