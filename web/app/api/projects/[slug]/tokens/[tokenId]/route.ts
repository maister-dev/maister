import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { revokeToken } from "@/lib/tokens/revoke";
import { TOKEN_SCOPE_VALUES } from "@/lib/tokens/scopes";
import { updateProjectToken, type TokenUpdatePatch } from "@/lib/tokens/update";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-tokens-id",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForAuthz(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForAuthz(err.code) },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "tokens/[tokenId] route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ slug: string; tokenId: string }> };

// ADR-168 D5. Every field optional, but an empty object is a client error, not
// a silent no-op. `expiresAt` is the ONLY nullable field — `null` clears expiry;
// `null` for the others is a 422 rather than a silent reset.
const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPE_VALUES)).min(1).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "patch body must change at least one field",
  });

function patchFromBody(
  body: z.infer<typeof patchBodySchema>,
): TokenUpdatePatch {
  const patch: TokenUpdatePatch = {};

  if (body.name !== undefined) patch.name = body.name;
  if (body.scopes !== undefined) patch.scopes = body.scopes;
  // JSON has no `undefined`, so a present key is the only way to reach here.
  if (body.expiresAt !== undefined) {
    patch.expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
  }

  return patch;
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, tokenId } = await params;

  try {
    const user = await requireActiveSession();
    let body: z.infer<typeof patchBodySchema>;

    try {
      body = patchBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${(err as Error).message}`,
      );
    }

    const db = getDb() as unknown as { select: any };

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "editSettings");

    const result = await updateProjectToken(
      { tokenId, projectId: project.id },
      patchFromBody(body),
      { userId: user.id, label: `user:${user.id}` },
    );

    if (result.outcome === "not-found") {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    log.info(
      { slug, tokenId, outcome: result.outcome, changed: result.changed },
      "token updated",
    );

    return NextResponse.json(result.token, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, tokenId } = await params;

  try {
    await requireActiveSession();
    const db = getDb() as unknown as { select: any };

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "editSettings");

    const { outcome } = await revokeToken({ tokenId, projectId: project.id });

    if (outcome === "not-found") {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    // "revoked" and "already-revoked" both return 204 (idempotent).
    log.info({ slug, tokenId, outcome }, "token revoked");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
