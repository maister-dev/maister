import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectRole } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/queries/project";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  deleteSubscription,
  getSubscription,
  updateSubscription,
} from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-project-webhook",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; id: string }> };

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().min(1).optional(),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    event_types: z.array(z.string()).min(1).optional(),
    signing_secret_ref: z.string().min(1).optional(),
    secondary_signing_secret_ref: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
  });

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

function errorResponse(err: unknown, id: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { id, err: err instanceof Error ? err.message : String(err) },
    "project webhook mutation error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function projectNotFound(slug: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `project not found: ${slug}` },
    { status: 404 },
  );
}

function notFound(id: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `webhook subscription not found: ${id}` },
    { status: 404 },
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

// Auth-first, then resolve the URL slug to a project (server-state). The
// resolved id is the ONLY scope source; a subscription outside this project (or
// a platform sub with project_id NULL) is invisible → 404 via the scoped service.
async function resolveScope(
  slug: string,
  min: "viewer" | "member",
): Promise<{ projectId: string } | NextResponse> {
  await requireActiveSession();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) return projectNotFound(slug);

  await requireProjectRole(project.id, min);

  return { projectId: project.id };
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, id } = await params;

  try {
    const scope = await resolveScope(slug, "viewer");

    if (scope instanceof NextResponse) return scope;

    const subscription = await getSubscription(scope, id);

    if (!subscription) return notFound(id);

    return NextResponse.json(subscription);
  } catch (err) {
    return errorResponse(err, id);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, id } = await params;

  try {
    const scope = await resolveScope(slug, "member");

    if (scope instanceof NextResponse) return scope;

    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const updated = await updateSubscription(scope, id, parsed.data);

    if (!updated) return notFound(id);

    log.debug({ id, projectId: scope.projectId }, "project webhook updated");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, id);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, id } = await params;

  try {
    const scope = await resolveScope(slug, "member");

    if (scope instanceof NextResponse) return scope;

    const deleted = await deleteSubscription(scope, id);

    if (!deleted) return notFound(id);

    log.info({ id, projectId: scope.projectId }, "project webhook deleted");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, id);
  }
}
