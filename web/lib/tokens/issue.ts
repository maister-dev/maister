import "server-only";

import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { generateToken } from "@/lib/tokens/secret";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type IssueTokenInput = {
  projectId: string;
  name: string;
  createdByUserId?: string | null;
  expiresAt?: Date | null;
};

export type IssuedToken = {
  tokenId: string;
  secret: string;
  prefix: string;
  name: string;
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

  await d.insert(projectTokens).values({
    id,
    project_id: input.projectId,
    name: input.name,
    prefix,
    token_hash: hash,
    scopes: ["*"],
    created_by: input.createdByUserId ?? null,
    created_at: now,
    expires_at: input.expiresAt ?? null,
  });

  return {
    tokenId: id,
    secret,
    prefix,
    name: input.name,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
  };
}
