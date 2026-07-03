import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import type { PromotionHold } from "@/lib/auto-promotion/types";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// ADR-126 §4.8: pause/resume a run's auto-promotion. Pure DB (no downstream
// side-effect) — authz is the same project action that could promote manually
// (D-9). No ext/MCP mirror in v1.

const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-run-promotion-hold",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

const putBodySchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
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

  log.error(
    { runId, err: err instanceof Error ? err.message : String(err) },
    "run promotion-hold API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadRunProjectId(db: any, runId: string): Promise<string> {
  const rows = await db
    .select({ id: runs.id, projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!rows[0]) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  return rows[0].projectId as string;
}

export async function PUT(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    let body: z.infer<typeof putBodySchema>;

    try {
      body = putBodySchema.parse(await req.json().catch(() => ({})));
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid PUT body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await requireActiveSession();

    const db = getDb() as any;
    const projectId = await loadRunProjectId(db, runId);

    await requireProjectAction(projectId, "promoteRun");

    // Idempotent: a re-PUT overwrites the reason but keeps source:'user'.
    const hold: PromotionHold = {
      source: "user",
      ...(body.reason ? { reason: body.reason } : {}),
      createdAt: new Date().toISOString(),
    };

    await db.update(runs).set({ promotionHold: hold }).where(eq(runs.id, runId));

    log.info({ runId, projectId }, "auto-promotion hold set");

    return NextResponse.json({ hold });
  } catch (err) {
    return errorResponse(err, runId);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const projectId = await loadRunProjectId(db, runId);

    await requireProjectAction(projectId, "promoteRun");

    // Clears a hold of ANY source; the run re-enters normal evaluation.
    await db.update(runs).set({ promotionHold: null }).where(eq(runs.id, runId));

    log.info({ runId, projectId }, "auto-promotion hold cleared");

    return NextResponse.json({ ok: true, cleared: true });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
