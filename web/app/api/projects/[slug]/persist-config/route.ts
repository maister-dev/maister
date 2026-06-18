import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { persistProjectConfig } from "@/lib/persist-config";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-persist-config",
  level: process.env.LOG_LEVEL ?? "info",
});

// Body is optional (an empty body commits without pushing). `push` opts into a
// post-flip push; a push failure is advisory (200 + pushWarning), never fatal.
const postBodySchema = z.object({ push: z.boolean().optional() }).strict();

type RouteParams = { params: Promise<{ slug: string }> };

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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "persist-config API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  let body: z.infer<typeof postBodySchema>;

  try {
    const raw = await req.json().catch(() => ({}));

    body = postBodySchema.parse(raw ?? {});
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${err instanceof Error ? err.message : String(err)}`,
      ),
      slug,
    );
  }

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = rows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    // Identifiers (invariant A): slug = url-param (access-controlled below);
    // projectId + repo_path = server-state (the row), never the body.
    await requireProjectAction(project.id, "editSettings");

    const result = await persistProjectConfig({
      project: {
        id: project.id,
        repoPath: project.repoPath,
        name: project.name,
        mainBranch: project.mainBranch,
        branchPrefix: project.branchPrefix,
        defaultRunnerId: project.defaultRunnerId ?? null,
        promotionMode: project.promotionMode ?? null,
        maisterYamlPath: project.maisterYamlPath ?? null,
      },
      db,
      push: body.push === true,
    });

    log.info(
      {
        projectId: project.id,
        slug,
        reconciled: result.reconciled,
        usedDefaultAuthor: result.usedDefaultAuthor,
        pushed: result.pushed,
      },
      "persist-config success",
    );

    // Explicit DTO projection (PersistConfigResponse, additionalProperties:
    // false): only ok + the optional advisory flags — no DB row, no repo path.
    return NextResponse.json({
      ok: true,
      ...(result.usedDefaultAuthor ? { usedDefaultAuthor: true } : {}),
      ...(result.pushWarning ? { pushWarning: result.pushWarning } : {}),
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
