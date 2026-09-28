import "server-only";

import type { LibrarianTurnRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { generateToken } from "@/lib/tokens/secret";
import {
  isTokenScope,
  LIBRARIAN_READ_SCOPES,
  LIBRARIAN_TOKEN_SCOPES,
  TOKEN_SCOPE_ALL,
} from "@/types/token-scopes";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "librarian.authority",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-186: the reserved name every librarian turn token carries. Human issuance
// refuses it (`assertTokenNameAllowed`), so it can only come from here.
export const LIBRARIAN_TOKEN_NAME_PREFIX = "librarian-turn:";

export function scopesForLibrarianTurn(
  variant: LibrarianTurnRow["variant"],
): readonly string[] {
  if (variant === "explain") return LIBRARIAN_READ_SCOPES;
  if (variant === "owner_message") return LIBRARIAN_TOKEN_SCOPES;

  throw new MaisterError("CONFIG", "summary turns cannot receive tool tokens");
}

export function librarianTokenName(turnId: string): string {
  return `${LIBRARIAN_TOKEN_NAME_PREFIX}${turnId}`;
}

export type IssuedLibrarianToken = {
  tokenId: string;
  secret: string;
  expiresAt: Date;
};

// ADR-186 D1: one token per librarian turn, owner-bound, project-less, with an
// explicit scope list (never `*`) and a hard expiry at the turn deadline. The
// secret is returned once and only injected into that turn's facade process.
export async function issueLibrarianTurnToken(
  input: {
    ownerUserId: string;
    turnId: string;
    scopes: readonly string[];
    expiresAt: Date;
  },
  db?: Db,
): Promise<IssuedLibrarianToken> {
  const d = db ?? getDb();

  if (
    input.scopes.length === 0 ||
    input.scopes.some(
      (scope) => scope === TOKEN_SCOPE_ALL || !isTokenScope(scope),
    )
  ) {
    throw new MaisterError(
      "CONFIG",
      "a librarian token carries an explicit, known scope list",
    );
  }

  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();

  await d.insert(projectTokens).values({
    id: tokenId,
    project_id: null,
    name: librarianTokenName(input.turnId),
    token_kind: "librarian",
    owner_user_id: input.ownerUserId,
    librarian_turn_id: input.turnId,
    prefix,
    token_hash: hash,
    scopes: [...new Set(input.scopes)],
    created_by: null,
    expires_at: input.expiresAt,
  });

  log.info(
    { turnId: input.turnId, tokenId, expiresAt: input.expiresAt.toISOString() },
    "librarian-token-issued",
  );

  return { tokenId, secret, expiresAt: input.expiresAt };
}

// Idempotent: returns how many live tokens this call revoked (0 on a repeat).
export async function revokeLibrarianTurnToken(
  turnId: string,
  db?: Db,
): Promise<number> {
  const d = db ?? getDb();
  const revoked = await d
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.librarian_turn_id, turnId),
        eq(projectTokens.token_kind, "librarian"),
        isNull(projectTokens.revoked_at),
      ),
    )
    .returning({ id: projectTokens.id });

  if (revoked.length > 0) {
    log.info(
      { turnId, tokenIds: revoked.map((row: { id: string }) => row.id) },
      "librarian-token-revoked",
    );
  }

  return revoked.length;
}
