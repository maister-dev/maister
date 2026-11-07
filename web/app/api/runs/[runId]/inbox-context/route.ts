import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { assertCompanyRunReadAccess } from "@/lib/agents/company-run-read-access";
import { getDb } from "@/lib/db/client";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { getInboxCardContext } from "@/lib/queries/inbox-context";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-run-inbox-context",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };
// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

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

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      {
        status:
          err.details?.reason === "run_unavailable"
            ? 404
            : httpStatusForCode(err.code),
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "GET /api/runs/[runId]/inbox-context");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const user = await requireActiveSession();

    const db = getDb() as unknown as Db;
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0];

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    if (run.projectId === null)
      await assertCompanyRunReadAccess(getDb(), user.id, runId);
    else await requireProjectAction(run.projectId, "readBoard");
    const recipient = { kind: "user" as const, userId: user.id };

    await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

    const context = await getInboxCardContext({
      id: run.id,
      projectId: run.projectId,
      currentStepId: run.currentStepId ?? null,
      flowRevisionId: run.flowRevisionId ?? null,
      flowId: run.flowId ?? null,
    });

    if (run.projectId === null)
      await assertCompanyRunReadAccess(getDb(), user.id, runId);
    else await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

    return NextResponse.json(context, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
