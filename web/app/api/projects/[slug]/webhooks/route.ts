import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectRole } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/queries/project";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  createSubscription,
  listSubscriptions,
} from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-project-webhooks",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

// Permissive shape — taxonomy/url/secret-ref validation lives in the service so
// the platform and project routes share one source of truth (CONFIG → 422). The
// body carries config only; project_id is NEVER read from it — the scope comes
// from the slug-resolved project. STRICT (additionalProperties:false in the
// OpenAPI WebhookSubscriptionCreate, mirroring the admin route): an unknown key —
// e.g. a smuggled `project_id` — is REJECTED (422 CONFIG), not silently dropped,
// so the body cannot carry a cross-resource id at all.
const createBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    url: z.string().min(1),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    event_types: z.array(z.string()).min(1),
    signing_secret_ref: z.string().min(1),
    secondary_signing_secret_ref: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
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
    "project webhook API error",
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

// Auth-first, then resolve the URL slug to a project (server-state) — an
// unauthenticated caller gets 401 and cannot probe project existence; a missing
// or archived project is 404. The resolved id is the ONLY scope source.
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
  const { slug } = await params;

  try {
    const scope = await resolveScope(slug, "viewer");

    if (scope instanceof NextResponse) return scope;

    const subscriptions = await listSubscriptions(scope);

    return NextResponse.json({ subscriptions });
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
    const scope = await resolveScope(slug, "member");

    if (scope instanceof NextResponse) return scope;

    const parsed = createBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const created = await createSubscription(scope, parsed.data);

    log.debug(
      { id: created.id, projectId: scope.projectId },
      "project webhook subscription created",
    );

    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
