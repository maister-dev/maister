import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { createBrainSource, listBrainSources } from "@/lib/brain/sources";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

type RouteParams = { params: Promise<{ slug: string }> };

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 404;
    case "CONFIG":
      return 422;
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
      { status: statusForCode(err.code) },
    );
  }

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadProject(slug: string) {
  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

function sourceInputFromBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new MaisterError("CONFIG", "Brain source body must be an object");
  }

  const raw = body as Record<string, unknown>;
  const input: Record<string, unknown> = {};

  for (const key of ["kind", "path", "chunkerId", "enabled"]) {
    if (key in raw) input[key] = raw[key];
  }

  return input;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();
    const project = await loadProject(slug);

    await requireProjectAction(project.id, "readBrain");

    const sources = await listBrainSources(getDb() as any, project.id);

    return NextResponse.json({ sources });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();
    const project = await loadProject(slug);

    await requireProjectAction(project.id, "editSettings");

    let body: unknown;

    try {
      body = await req.json();
    } catch {
      throw new MaisterError("CONFIG", "invalid JSON body");
    }

    const source = await createBrainSource(getDb() as any, {
      projectId: project.id,
      repoPath: project.repoPath,
      mainBranch: project.mainBranch,
      input: sourceInputFromBody(body),
    });

    return NextResponse.json(source, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
