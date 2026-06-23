import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { issueUserAccessToken } from "@/lib/tokens/issue";
import { listOwnerTokens } from "@/lib/tokens/list";
import { TOKEN_SCOPE_VALUES, type TokenScope } from "@/lib/tokens/scopes";

const log = pino({
  name: "api-account-tokens",
  level: process.env.LOG_LEVEL ?? "info",
});

const HUMAN_HITL_SCOPE = "hitl:respond:human" satisfies TokenScope;

const postBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPE_VALUES)).min(1).optional(),
    humanHitl: z.boolean().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.scopes?.includes(HUMAN_HITL_SCOPE)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human HITL response scope must be enabled via humanHitl",
        path: ["scopes"],
      });
    }
  });

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
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

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "account tokens route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function scopesForBody(body: z.infer<typeof postBodySchema>): TokenScope[] {
  const baseScopes = body.scopes ?? ["*"];

  if (body.humanHitl !== true) {
    return baseScopes;
  }

  return [...baseScopes, HUMAN_HITL_SCOPE];
}

function hasHumanHitl(scopes: readonly string[]): boolean {
  return scopes.includes(HUMAN_HITL_SCOPE);
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const tokens = await listOwnerTokens(user.id);

    return NextResponse.json({
      tokens: tokens.map((token) => ({
        ...token,
        humanHitl: hasHumanHitl(token.scopes),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
      );
    }

    const scopes = scopesForBody(body);
    const issued = await issueUserAccessToken({
      ownerUserId: user.id,
      name: body.name ?? "Personal access token",
      scopes,
      createdByUserId: user.id,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });

    log.info({ tokenId: issued.tokenId, ownerUserId: user.id }, "token created");

    return NextResponse.json(
      {
        id: issued.tokenId,
        name: issued.name,
        kind: issued.tokenKind,
        ownerUserId: issued.ownerUserId,
        ownerLabel: user.name ?? user.email ?? null,
        scopes: issued.scopes,
        humanHitl: hasHumanHitl(issued.scopes),
        prefix: issued.prefix,
        token: issued.secret,
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
