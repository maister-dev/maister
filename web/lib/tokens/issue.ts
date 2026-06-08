import "server-only";

import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { generateToken } from "@/lib/tokens/secret";
import { normalizeTokenScopes, type TokenScope } from "@/lib/tokens/scopes";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenKind = "project" | "user";

export type IssueTokenInput = {
  projectId: string;
  name: string;
  tokenKind?: TokenKind;
  ownerUserId?: string | null;
  scopes?: TokenScope[];
  createdByUserId?: string | null;
  expiresAt?: Date | null;
};

export type IssuedToken = {
  tokenId: string;
  secret: string;
  prefix: string;
  name: string;
  tokenKind: TokenKind;
  ownerUserId: string | null;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
};

/**
 * Insert a project_tokens row storing ONLY the hash (never the secret).
 * Returns the plaintext secret exactly once — never persisted.
 */
export async function issueToken(
  input: IssueTokenInput,
  db?: Db,
): Promise<IssuedToken> {
  const d = db ?? getDb();
  const { secret, prefix, hash } = generateToken();
  const id = randomUUID();
  const now = new Date();
  const tokenKind = input.tokenKind ?? "project";
  const ownerUserId = input.ownerUserId ?? null;
  const scopes = normalizeTokenScopes(input.scopes);

  if (tokenKind === "user" && ownerUserId === null) {
    throw new MaisterError("CONFIG", "ownerUserId is required for user tokens");
  }

  await d.insert(projectTokens).values({
    id,
    project_id: input.projectId,
    name: input.name,
    token_kind: tokenKind,
    owner_user_id: ownerUserId,
    prefix,
    token_hash: hash,
    scopes,
    created_by: input.createdByUserId ?? null,
    created_at: now,
    expires_at: input.expiresAt ?? null,
  });

  return {
    tokenId: id,
    secret,
    prefix,
    name: input.name,
    tokenKind,
    ownerUserId,
    scopes,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
  };
}
