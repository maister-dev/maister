import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { computeRunAutoPromotion } from "@/lib/auto-promotion/panel";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// ADR-126 §4.8: read-only auto-promotion verdict for the run-detail panel. The
// run-detail RSC embeds the SAME computeRunAutoPromotion object server-side for
// first paint — both call the ONE evaluator (INV-10). authz = readBoard.

const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-run-auto-promotion",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 409;
    default:
      return 500;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const rows = await db
      .select({ id: runs.id, projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!rows[0]) {
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    }

    await requireProjectAction(rows[0].projectId, "readBoard");

    const panel = await computeRunAutoPromotion(db, runId);

    return NextResponse.json(panel);
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: httpStatusForCode(err.code) },
      );
    }

    log.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "run auto-promotion API error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
