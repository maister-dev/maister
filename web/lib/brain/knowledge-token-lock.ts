import "server-only";

import type { projectTokens } from "@/lib/db/schema";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { MaisterError } from "@/lib/errors";
import { parseBoundRunId } from "@/lib/tokens/verify";

type NativeKnowledgeToken = Pick<
  typeof projectTokens.$inferSelect,
  | "id"
  | "name"
  | "token_kind"
  | "owner_user_id"
  | "project_id"
  | "company_id"
  | "company_run_id"
  | "installation_run_id"
  | "bound_run_id"
  | "origin_kind"
  | "agent_id"
  | "scopes"
  | "knowledge_node_attempt_id"
>;

const BINDING_FIELDS = [
  "name",
  "token_kind",
  "owner_user_id",
  "project_id",
  "company_id",
  "company_run_id",
  "installation_run_id",
  "bound_run_id",
  "origin_kind",
  "agent_id",
  "knowledge_node_attempt_id",
] as const satisfies readonly (keyof NativeKnowledgeToken)[];
const log = pino({
  name: "brain:native-token-lock",
  level: process.env.LOG_LEVEL ?? "info",
});

/** The unlocked name is only a lock locator; current scope and role still authorize the caller. */
export async function lockCurrentNativeKnowledgeToken(
  tx: SqlTransaction,
  tokenId: string,
): Promise<NativeKnowledgeToken> {
  const query = sql`SELECT id,name,token_kind,owner_user_id,project_id,company_id,company_run_id,installation_run_id,bound_run_id,origin_kind,agent_id,scopes,knowledge_node_attempt_id FROM project_tokens
    WHERE id=${tokenId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`;
  const observed = (await tx.execute(query)).rows[0] as
    NativeKnowledgeToken | undefined;

  if (!observed)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current native knowledge token is required",
    );
  const runId =
    observed.token_kind === "user" ? null : parseBoundRunId(observed.name);

  if (runId !== null)
    await tx.execute(
      sql`SELECT id FROM runs WHERE id=${runId} FOR NO KEY UPDATE`,
    );
  const current = (await tx.execute(sql`${query} FOR SHARE`)).rows[0] as
    NativeKnowledgeToken | undefined;

  if (
    !current ||
    BINDING_FIELDS.some((field) => current[field] !== observed[field])
  ) {
    log.warn(
      { tokenId, runId },
      "[FIX:native-token-order] credential changed while waiting for its execution",
    );
    throw new MaisterError(
      "UNAUTHORIZED",
      "The native credential is no longer current; authenticate with the current execution credential",
    );
  }
  log.debug(
    { tokenId, runId, tokenKind: current.token_kind },
    "[FIX:native-token-order] execution and current credential locked in owner order",
  );

  return current;
}
