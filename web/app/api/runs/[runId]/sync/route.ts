import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { syncRunTarget } from "@/lib/runs/sync-target";

const { runs } = schema as unknown as Record<string, any>;

const log = pino({
  name: "api-run-sync",
  level: process.env.LOG_LEVEL ?? "info",
});

const syncBodySchema = z
  .object({
    strategy: z.enum(["rebase", "merge"]).optional(),
    agent: z.boolean().optional(),
    push: z.boolean().optional(),
    runnerId: z.string().min(1).max(255).optional(),
  })
  .strict();

type SyncBody = z.infer<typeof syncBodySchema>;
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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
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

  log.error({ runId, err: message }, "POST /api/runs/[runId]/sync");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Body / runner validation failures are 422 (distinct from the 409 domain
// PRECONDITION/CONFLICT surface).
function validationResponse(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

async function runProjectId(runId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0]?.projectId ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const sessionUser = await requireActiveSession();

    // Parsed AFTER the authentication gate — an anonymous caller must never
    // reach this request's body (its sibling `reopen/route.ts` is the model).
    // Still ABOVE `runProjectId`, so an authenticated caller's malformed body is
    // answered 422 rather than the run's 404.
    let body: SyncBody;

    try {
      body = syncBodySchema.parse(await req.json());
    } catch (err) {
      return validationResponse(`invalid POST body: ${(err as Error).message}`);
    }

    // projectId is server-derived from the run row, never a body field.
    const projectId = await runProjectId(runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(projectId, "promoteRun");

    // A runnerId is not used by the mechanical path, but validate it against the
    // platform catalog (unknown → 422) and pass it through for the Task 10 resolver.
    if (body.runnerId) {
      const catalog = await loadRunnerCatalog(getDb());

      if (!catalog.some((entry) => entry.id === body.runnerId)) {
        return validationResponse(`unknown runnerId: ${body.runnerId}`);
      }
    }

    const result = await syncRunTarget({
      runId,
      strategy: body.strategy,
      agent: body.agent,
      push: body.push,
      runnerId: body.runnerId,
      actor: { type: "user", id: sessionUser.id },
    });

    return NextResponse.json(
      {
        attemptId: result.attemptId,
        outcome: result.outcome,
        behind: result.behind,
        pushed: result.pushed,
      },
      { status: result.outcome === "agent_launched" ? 202 : 200 },
    );
  } catch (err) {
    return errorResponse(err, runId);
  }
}
