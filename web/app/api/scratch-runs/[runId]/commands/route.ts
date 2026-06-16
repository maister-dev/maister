import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { readScratchAvailableCommands } from "@/lib/scratch-runs/available-commands";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-scratch-commands",
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
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "/api/scratch-runs/[runId]/commands error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// GET /api/scratch-runs/[runId]/commands — Designed (FR-A2): latest ACP
// availableCommands snapshot for the running-scratch composer autocomplete.
// `runId` url-param; the session/log are resolved from server state.
export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as { select: any };
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0] as
      | { projectId: string; runKind: string }
      | undefined;

    if (!run) {
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    }
    if (run.runKind !== "scratch") {
      throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
    }

    await requireProjectAction(run.projectId, "readScratchRun");

    const commands = await readScratchAvailableCommands(runId, db);

    return NextResponse.json({ commands });
  } catch (err) {
    return errorResponse(err);
  }
}
