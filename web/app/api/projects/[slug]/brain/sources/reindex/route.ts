import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  enqueueAllBrainSourcesReindex,
  type SourcesDb,
} from "@/lib/brain/sources";
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

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();
    const project = await loadProject(slug);

    await requireProjectAction(project.id, "editSettings");

    const db = getDb() as unknown as SourcesDb;
    const jobIds = await enqueueAllBrainSourcesReindex(db, {
      projectId: project.id,
      reason: "manual",
    });

    return NextResponse.json({ jobIds }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
