import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  requireActiveSession,
  requireProjectAction,
  requireProjectRole,
} from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { addProjectMember, listProjectMembers } from "@/lib/project-members";
import { getProjectBySlug } from "@/lib/queries/project";

const log = pino({
  name: "api-project-members",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z
  .object({
    userId: z.string().min(1),
    role: z.enum(["owner", "admin", "member", "viewer"]),
  })
  .strict();

function statusForCode(code: string): number {
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
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "members route unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    // Auth-first: authenticate before resolving the slug so unauthenticated
    // callers cannot distinguish existing from missing projects.
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectRole(project.id, "viewer");

    const members = await listProjectMembers(project.id);

    return NextResponse.json({ members });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    // Auth-first: authenticate before resolving the slug (see GET).
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    const access = await requireProjectAction(project.id, "manageMembers");

    const raw = await parseJson(req);
    const parsed = postBodySchema.safeParse(raw);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const { userId, role } = parsed.data;
    const { memberId } = await addProjectMember({
      projectId: project.id,
      userId,
      role,
      actorId: access.user.id,
    });

    log.info({ slug, memberId, userId, role }, "member added");

    return NextResponse.json({ memberId }, { status: 201 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
