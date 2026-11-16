import "server-only";

import type { TokenActor } from "./verify";

import { NextResponse } from "next/server";

import {
  authenticateExtRequest,
  recordRequiredTokenAudit,
} from "./ext-handler";
import { tokenAuditIdentity, bumpTokenLastUsed } from "./audit";
import { tokenHasScope } from "./scopes";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

/** Ownership is resolved by the domain service; this context never fabricates a project identity. */
export type OwnedExtCtx = Readonly<{ actor: TokenActor }>;
export type OwnedExtOptions = Readonly<{
  scopeLabel: string;
  endpoint: string;
  method: string;
}>;

export async function handleOwnedExt(
  request: Request,
  options: OwnedExtOptions,
  work: (context: OwnedExtCtx) => Promise<NextResponse>,
  onError: (error: unknown) => NextResponse,
): Promise<NextResponse> {
  const db = getDb();
  const authenticated = await authenticateExtRequest(request, options, db);

  if (authenticated instanceof NextResponse)
    return new NextResponse(authenticated.body, {
      status: authenticated.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        Vary: "Authorization",
      },
    });
  const actor = authenticated;
  let response: NextResponse;

  try {
    if (actor.tokenKind === "librarian")
      throw new MaisterError(
        "UNAUTHORIZED",
        "This endpoint does not admit a librarian token",
        { details: { reason: "librarian_not_admitted" } },
      );
    if (!tokenHasScope(actor.scopes, options.scopeLabel))
      throw new MaisterError(
        "UNAUTHORIZED",
        `This endpoint requires '${options.scopeLabel}'`,
      );
    response = await work({ actor });
  } catch (error) {
    response = onError(error);
  }
  await recordRequiredTokenAudit(
    {
      ...tokenAuditIdentity(actor),
      projectId: actor.projectId,
      scopeUsed: options.scopeLabel,
      endpoint: options.endpoint,
      method: options.method,
      result: response.status < 400 ? "ok" : "error",
      statusCode: response.status,
    },
    db,
  );
  await bumpTokenLastUsed(actor.tokenId, db);

  return response;
}
