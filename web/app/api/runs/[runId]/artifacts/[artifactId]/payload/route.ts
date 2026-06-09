import "server-only";

import type { ArtifactInstance, ArtifactLocator } from "@/lib/db/schema";

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/instance-config";
import { getRunDetail } from "@/lib/queries/run";
import { DIFF_TRUNCATED_MARKER, diffRange, logRange } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { artifactInstances, gateResults, hitlRequests } =
  schemaModule as unknown as Record<string, any>;

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

async function serveFile(
  locatorPath: string,
  projectSlug: string,
  runId: string,
): Promise<NextResponse> {
  const runDirRoot = path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
  );
  const lexical = path.resolve(runDirRoot, locatorPath);
  const rootResolved = path.resolve(runDirRoot);

  // Lexical confinement BEFORE any fs access: a `../` traversal is rejected
  // without ever touching the outside path.
  if (
    lexical !== rootResolved &&
    !lexical.startsWith(rootResolved + path.sep)
  ) {
    return notFound();
  }

  let real: string;

  try {
    real = await realpath(lexical);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return gone();
    }
    throw e;
  }

  // Symlink-escape confinement: the realpath must still be inside the run dir.
  const rootReal = await realpath(rootResolved);

  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return notFound();
  }

  const body = await readFile(real, "utf8");

  return new NextResponse(body, { headers: TEXT_HEADERS });
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

    const locator = artifact.locator as ArtifactLocator;

    switch (locator.kind) {
      case "inline":
        return new NextResponse(locator.text, { headers: TEXT_HEADERS });

      case "gate-verdict": {
        const rows = (await db
          .select()
          .from(gateResults)
          .where(
            and(
              eq(gateResults.id, locator.gateResultId),
              eq(gateResults.runId, runId),
            ),
          )) as Array<{
          id: string;
          runId: string;
          verdict: unknown;
        }>;
        const row = rows.find(
          (r) => r.id === locator.gateResultId && r.runId === runId,
        );

        if (!row) {
          return notFound();
        }

        return NextResponse.json(row.verdict);
      }

      case "hitl-response": {
        const rows = (await db
          .select()
          .from(hitlRequests)
          .where(
            and(
              eq(hitlRequests.id, locator.hitlRequestId),
              eq(hitlRequests.runId, runId),
            ),
          )) as Array<{
          id: string;
          runId: string;
          response: unknown;
        }>;
        const row = rows.find(
          (r) => r.id === locator.hitlRequestId && r.runId === runId,
        );

        if (!row) {
          return notFound();
        }

        return NextResponse.json(row.response);
      }

      case "git-range": {
        // F3: render against the STORED immutable headRef SHA, not the live
        // branch, so an old artifact never picks up commits made after it was
        // recorded. (A SHA satisfies diffRange's branch validation.)
        const range = await diffRange({
          worktreePath: detail.worktreePath,
          baseRef: locator.baseCommit,
          branch: locator.headRef,
        });
        // Re-append the in-band marker on truncation so the text/plain payload
        // still flags the cut (no structured channel on a raw byte response).
        const diff = range.truncated
          ? range.text + DIFF_TRUNCATED_MARKER
          : range.text;

        return new NextResponse(diff, { headers: TEXT_HEADERS });
      }

      case "git-log": {
        const out = await logRange({
          worktreePath: detail.worktreePath,
          baseRef: locator.baseRef,
          branch: locator.headRef,
        });

        return new NextResponse(out, { headers: TEXT_HEADERS });
      }

      case "file":
        return await serveFile(locator.path, detail.projectSlug, runId);

      default:
        return notFound();
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
