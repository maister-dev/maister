import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { revokeOwnerToken } from "@/lib/tokens/revoke";
import { TOKEN_SCOPE_VALUES, type TokenScope } from "@/lib/tokens/scopes";
import { updateOwnerToken, type TokenUpdatePatch } from "@/lib/tokens/update";

const log = pino({
  name: "api-account-tokens-id",
  level: process.env.LOG_LEVEL ?? "info",
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

  log.error({ err: message }, "account tokens/[tokenId] route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ tokenId: string }> };

const HUMAN_HITL_SCOPE = "hitl:respond:human" satisfies TokenScope;

// ADR-168 D5. Mirrors THIS surface's POST: the exact human scope is granted
// through `humanHitl`, never inside `scopes`. Every field optional, but an
// empty object is a client error. `expiresAt` is the only nullable field.
const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPE_VALUES)).min(1).optional(),
    humanHitl: z.boolean().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "patch body must change at least one field",
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

function patchFromBody(
  body: z.infer<typeof patchBodySchema>,
): TokenUpdatePatch {
  const patch: TokenUpdatePatch = {};

  if (body.name !== undefined) patch.name = body.name;
  if (body.scopes !== undefined) patch.scopes = body.scopes;
  if (body.humanHitl !== undefined) patch.humanHitl = body.humanHitl;
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
  const { tokenId } = await params;

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

    const result = await updateOwnerToken(
      { tokenId, ownerUserId: user.id },
      patchFromBody(body),
      { userId: user.id, label: `user:${user.id}` },
    );

    if (result.outcome === "not-found" || !result.token) {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    log.info(
      {
        tokenId,
        ownerUserId: user.id,
        outcome: result.outcome,
        changed: result.changed,
      },
      "token updated",
    );

    return NextResponse.json(
      {
        ...result.token,
        humanHitl: result.token.scopes.includes(HUMAN_HITL_SCOPE),
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { tokenId } = await params;

  try {
    const user = await requireActiveSession();
    const { outcome } = await revokeOwnerToken(
      { tokenId, ownerUserId: user.id },
      { userId: user.id, label: `user:${user.id}` },
    );

    if (outcome === "not-found") {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    log.info({ tokenId, ownerUserId: user.id, outcome }, "token revoked");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
