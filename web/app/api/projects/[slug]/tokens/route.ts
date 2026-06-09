import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { issueToken } from "@/lib/tokens/issue";
import { listTokens } from "@/lib/tokens/list";
import { TOKEN_SCOPE_VALUES } from "@/lib/tokens/scopes";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-tokens",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["project", "user"]).optional(),
  scopes: z.array(z.enum(TOKEN_SCOPE_VALUES)).min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

function httpStatusForCode(code: string): number {
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

function httpStatusForAuthz(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
      return 403;
    default:
      return httpStatusForCode(code);
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

  log.error({ slug, err: message }, "tokens route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const user = await requireActiveSession();
    let body: z.infer<typeof postBodySchema>;

    try {
      body = postBodySchema.parse(await req.json());
    } catch (err) {
      return errorResponse(
        new MaisterError(
          "CONFIG",
          `invalid POST body: ${(err as Error).message}`,
        ),
        slug,
      );
    }

    const db = getDb() as unknown as { select: any; insert: any };

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "editSettings");

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const issued = await issueToken({
      projectId: project.id,
      name: body.name,
      tokenKind: body.kind ?? "project",
      ownerUserId: body.kind === "user" ? user.id : null,
      scopes: body.scopes,
      createdByUserId: user.id,
      expiresAt,
    });

    log.info({ slug, tokenId: issued.tokenId }, "token created");

    return NextResponse.json(
      {
        id: issued.tokenId,
        name: issued.name,
        kind: issued.tokenKind,
        ownerUserId: issued.ownerUserId,
        ownerLabel:
          issued.tokenKind === "user"
            ? (user.name ?? user.email ?? null)
            : null,
        scopes: issued.scopes,
        prefix: issued.prefix,
        token: issued.secret,
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

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

    const tokens = await listTokens(project.id);

    return NextResponse.json({ tokens });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
