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
  resolveScopeLabel?: (context: OwnedExtCtx) => Promise<string>;
  endpoint: string;
  method: string;
  admitInstallation?: true;
  admitLibrarian?: true;
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
  let scopeLabel = options.scopeLabel;

  try {
    if (actor.installationScope && !options.admitInstallation)
      throw new MaisterError(
        "UNAUTHORIZED",
        "This endpoint does not admit an installation agent",
      );
    if (actor.tokenKind === "librarian" && !options.admitLibrarian)
      throw new MaisterError(
        "UNAUTHORIZED",
        "This endpoint does not admit a librarian token",
        { details: { reason: "librarian_not_admitted" } },
      );
    if (options.resolveScopeLabel)
      scopeLabel = await options.resolveScopeLabel({ actor });
    if (!tokenHasScope(actor.scopes, scopeLabel))
      throw new MaisterError(
        "UNAUTHORIZED",
        `This endpoint requires '${scopeLabel}'`,
      );
    response = await work({ actor });
  } catch (error) {
    response = onError(error);
  }
  await recordRequiredTokenAudit(
    {
      ...tokenAuditIdentity(actor),
      projectId: actor.projectId,
      scopeUsed: scopeLabel,
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
