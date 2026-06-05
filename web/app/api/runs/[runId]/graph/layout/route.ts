import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { upsertNodeLayout } from "@/lib/runs/flow-layout-write";

// FIXME(any): dual drizzle-orm peer-dep variants; route tests use a fake DB.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

const log = pino({
  name: "api-run-graph-layout",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

const bodySchema = z.object({
  nodeId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "PUT /api/runs/[runId]/graph/layout");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function PUT(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const session = await requireActiveSession();

    const db = getDb() as unknown as Db;
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0];

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "editFlowLayout");

    let rawBody: unknown;

    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json(
        { code: "CONFIG", message: "invalid body" },
        { status: 400 },
      );
    }

    const parsed = bodySchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        { code: "CONFIG", message: "invalid body" },
        { status: 400 },
      );
    }

    await upsertNodeLayout({
      runId,
      nodeId: parsed.data.nodeId,
      x: parsed.data.x,
      y: parsed.data.y,
      userId: session.id ?? null,
      db: db as never,
    });

    log.info({ runId, nodeId: parsed.data.nodeId }, "layout upserted");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
