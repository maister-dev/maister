import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { deleteBrainSource, updateBrainSource } from "@/lib/brain/sources";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

type RouteParams = { params: Promise<{ slug: string; sourceId: string }> };

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

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, sourceId } = await params;

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

    const source = await updateBrainSource(getDb() as any, {
      projectId: project.id,
      repoPath: project.repoPath,
      mainBranch: project.mainBranch,
      sourceId,
      input: sourceInputFromBody(body),
    });

    return NextResponse.json(source);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, sourceId } = await params;

  try {
    await requireActiveSession();
    const project = await loadProject(slug);

    await requireProjectAction(project.id, "editSettings");
    await deleteBrainSource(getDb() as any, { projectId: project.id, sourceId });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
