import "server-only";

import type { GlobalRole } from "@/lib/db/schema";
import type { TokenActor } from "@/lib/tokens/verify";

import { NextResponse } from "next/server";

import { requireActiveUserById } from "@/lib/authz";

// A person's own surfaces (their decision queue, HITL inbox, notification
// subscriptions) accept only a GLOBAL token that acts as that person. A
// project token has no person and an agent token must never read one. A
// librarian token acts as its owner, so a read of the owner's own queue may
// admit it (ADR-186) — never a write that changes where the owner is told.
export function requirePersonalOrLibrarianActor(
  actor: Pick<TokenActor, "tokenKind" | "ownerUserId" | "projectId">,
  opts: { allowLibrarian: boolean },
): NextResponse | null {
  const personalKind =
    actor.tokenKind === "user" ||
    (opts.allowLibrarian && actor.tokenKind === "librarian");

  if (!personalKind || actor.ownerUserId === null || actor.projectId !== null) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "global personal token required" },
      { status: 403 },
    );
  }

  return null;
}

// The owner a personal or librarian token acts for, re-read live so a demoted,
// disabled or deleted owner loses the read on the very next request.
export async function personalOwner(
  actor: Pick<TokenActor, "tokenKind" | "ownerUserId" | "projectId">,
): Promise<
  | { ok: true; user: { id: string; role: GlobalRole } }
  | { ok: false; response: NextResponse }
> {
  const refused = requirePersonalOrLibrarianActor(actor, {
    allowLibrarian: true,
  });

  if (refused || actor.ownerUserId === null) {
    return {
      ok: false,
      response:
        refused ??
        NextResponse.json(
          { code: "UNAUTHORIZED", message: "global personal token required" },
          { status: 403 },
        ),
    };
  }

  const owner = await requireActiveUserById(actor.ownerUserId);

  return { ok: true, user: { id: owner.id, role: owner.role } };
}
