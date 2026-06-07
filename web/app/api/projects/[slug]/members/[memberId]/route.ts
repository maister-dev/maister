import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  changeProjectMemberRole,
  removeProjectMember,
} from "@/lib/project-members";
import { getProjectBySlug } from "@/lib/queries/project";

const log = pino({
  name: "api-project-members",
  level: process.env.LOG_LEVEL ?? "info",
});

const roleEnum = z.enum(["owner", "admin", "member", "viewer"]);

const patchBodySchema = z
  .object({
    role: roleEnum,
    expectedRole: roleEnum,
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
    "member [memberId] route unhandled error",
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

type RouteParams = { params: Promise<{ slug: string; memberId: string }> };

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, memberId } = await params;

  try {
    // Auth-first: clear the session/account gate BEFORE resolving the slug so an
    // unauthenticated caller cannot probe project existence via the 409-vs-403
    // response split. Project membership is enforced below against project.id.
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    const access = await requireProjectAction(project.id, "manageMembers");

    const raw = await parseJson(req);
    const parsed = patchBodySchema.safeParse(raw);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    await changeProjectMemberRole({
      projectId: project.id,
      memberId,
      role: parsed.data.role,
      expectedRole: parsed.data.expectedRole,
      actorId: access.user.id,
    });

    log.info({ slug, memberId, role: parsed.data.role }, "member role changed");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, memberId } = await params;

  try {
    // Auth-first (see PATCH): authenticate before resolving the slug.
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    const access = await requireProjectAction(project.id, "manageMembers");

    const expectedRole = roleEnum.safeParse(
      req.nextUrl.searchParams.get("expectedRole"),
    );

    if (!expectedRole.success) {
      throw new MaisterError(
        "CONFIG",
        "missing or invalid expectedRole query parameter",
      );
    }

    await removeProjectMember({
      projectId: project.id,
      memberId,
      expectedRole: expectedRole.data,
      actorId: access.user.id,
    });

    log.info({ slug, memberId }, "member removed");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
