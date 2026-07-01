import "server-only";

import type { ArtifactInstance } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveArtifactContent } from "@/lib/flows/graph/artifact-content";
import { runtimeRoot } from "@/lib/instance-config";
import { getRunDetail } from "@/lib/queries/run";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { artifactInstances } = schemaModule as unknown as Record<string, any>;

// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

const log = pino({
  name: "api-run-artifact-payload",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string; artifactId: string }> };

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" };

function notFound(): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: "Artifact not found under this run." },
    { status: 404 },
  );
}

function gone(): NextResponse {
  return NextResponse.json(
    {
      code: "PRECONDITION",
      message: "Artifact payload is gone (file deleted).",
    },
    { status: 410 },
  );
}

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

  log.error(
    { runId, err: message },
    "GET /api/runs/[runId]/artifacts/[artifactId]/payload",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, artifactId } = await params;

  try {
    await requireActiveSession();

    const detail = await getRunDetail(runId);

    if (!detail) {
      return notFound();
    }

    await requireProjectAction(detail.projectId, "readBoard");

    const db = getDb() as unknown as Db;
    const artifactRows = (await db
      .select()
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.id, artifactId),
          eq(artifactInstances.runId, runId),
        ),
      )) as ArtifactInstance[];

    const artifact = artifactRows.find(
      (a) => a.id === artifactId && a.runId === runId,
    );

    if (!artifact) {
      return notFound();
    }

    // ADR-120 (P2, D7): delegate to the SHARED resolver — the SAME locator
    // resolution the runner uses for prompt injection, so the two never drift.
    // The route returns the FULL body (NO cap, NO json→text conversion); the
    // 256 KiB inline cap lives only at the runner's injection seam. This keeps the
    // HTTP contract byte-identical (incl. >256 KiB payloads + structured JSON).
    const resolved = await resolveArtifactContent(artifact, {
      worktreePath: detail.worktreePath,
      projectSlug: detail.projectSlug,
      runId,
      runtimeRoot: runtimeRoot(),
      db,
    });

    switch (resolved.kind) {
      case "text":
        return new NextResponse(resolved.text, { headers: TEXT_HEADERS });
      case "json":
        return NextResponse.json(resolved.value);
      case "gone":
        return gone();
      case "notfound":
        return notFound();
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
