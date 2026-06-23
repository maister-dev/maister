import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens, tokenAuditLog } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenAuditInput = {
  tokenId: string;
  projectId: string | null;
  actorLabel: string;
  scopeUsed: string;
  endpoint: string;
  method: string;
  result: "ok" | "error";
  statusCode: number;
};

/** INSERT one token_audit_log row. */
export async function recordTokenAudit(
  input: TokenAuditInput,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d.insert(tokenAuditLog).values({
    token_id: input.tokenId,
    project_id: input.projectId,
    actor_label: input.actorLabel,
    scope_used: input.scopeUsed,
    endpoint: input.endpoint,
    method: input.method,
    result: input.result,
    status_code: input.statusCode,
  });
}

/** UPDATE project_tokens.last_used_at = now() for the given token. */
export async function bumpTokenLastUsed(
  tokenId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(projectTokens)
    .set({ last_used_at: new Date() })
    .where(eq(projectTokens.id, tokenId));
}
