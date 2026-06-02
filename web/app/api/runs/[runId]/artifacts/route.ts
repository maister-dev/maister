import "server-only";

import type { ArtifactInstance } from "@/lib/db/schema";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { getArtifactsForRun } from "@/lib/flows/graph/artifact-store";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// Public DTO: ONLY the 17 OpenAPI ArtifactInstance fields. Internal handles
// (monotonicId, supersededById) are deliberately dropped — the evidence-graph
// query reads those separately; the public list must not leak them.
function toArtifactDto(row: ArtifactInstance) {
  return {
    id: row.id,
    runId: row.runId,
    nodeAttemptId: row.nodeAttemptId,
    nodeId: row.nodeId,
    attempt: row.attempt,
    artifactDefId: row.artifactDefId,
    kind: row.kind,
    producer: row.producer,
    locator: row.locator,
    uri: row.uri,
    hash: row.hash,
    sizeBytes: row.sizeBytes,
    validity: row.validity,
    requiredFor: row.requiredFor,
    visibility: row.visibility,
    retention: row.retention,
    createdAt: row.createdAt,
  };
}

// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

const log = pino({
  name: "api-run-artifacts",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

// Inlined authz → HTTP mapping (the route's own copy; the test mocks
// @/lib/authz with a partial factory, so importing httpStatusForAuthz from
// there is unsafe). Non-authz codes fall through to 500.
function httpStatusForAuthz(code: string): number | null {
  if (code === "UNAUTHENTICATED") return 401;
  if (
    code === "UNAUTHORIZED" ||
    code === "PASSWORD_CHANGE_REQUIRED" ||
    code === "ACCOUNT_INACTIVE"
  ) {
    return 403;
  }

  return null;
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForAuthz(err.code);

    if (status !== null) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "GET /api/runs/[runId]/artifacts");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0] as { projectId: string } | undefined;

    if (!run) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(run.projectId, "readBoard");

    const all = await getArtifactsForRun(runId);

    const { searchParams } = new URL(req.url);
    const node = searchParams.get("node");
    const kind = searchParams.get("kind");
    const validity = searchParams.get("validity");

    const filtered = all.filter(
      (a) =>
        (node === null || a.nodeId === node) &&
        (kind === null || a.kind === kind) &&
        (validity === null || a.validity === validity),
    );

    return NextResponse.json({ artifacts: filtered.map(toArtifactDto) });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
