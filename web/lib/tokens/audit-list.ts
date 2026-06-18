import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tokenAuditLog } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TokenAuditEntry = {
  id: string;
  tokenId: string;
  actorLabel: string;
  scopeUsed: string;
  endpoint: string;
  method: string;
  result: "ok" | "error";
  statusCode: number;
  createdAt: Date;
};

export type TokenAuditFilters = {
  tokenId?: string;
  result?: "ok" | "error";
  page?: number;
};

export const TOKEN_AUDIT_PAGE_SIZE = 50;

/**
 * Read a project's token_audit_log — the authoritative "via named token"
 * trail for /api/v1/ext calls. Newest-first, offset-paginated, with optional
 * token / result filters. Project-scoped: NEVER returns another project's rows.
 */
export async function listTokenAudit(
  projectId: string,
  filters: TokenAuditFilters = {},
  db?: Db,
): Promise<{ rows: TokenAuditEntry[]; total: number; page: number }> {
  const d = (db ?? getDb()) as unknown as { select: any };

  const page = Math.max(filters.page ?? 1, 1);
  const conditions: unknown[] = [eq(tokenAuditLog.project_id, projectId)];

  if (filters.tokenId) {
    conditions.push(eq(tokenAuditLog.token_id, filters.tokenId));
  }
  if (filters.result) {
    conditions.push(eq(tokenAuditLog.result, filters.result));
  }

  const where = and(...(conditions as never[]));

  const totalRows = (await d
    .select({ count: sql`count(*)::int` })
    .from(tokenAuditLog)
    .where(where)) as Array<{ count: number }>;

  const rows = (await d
    .select({
      id: tokenAuditLog.id,
      tokenId: tokenAuditLog.token_id,
      actorLabel: tokenAuditLog.actor_label,
      scopeUsed: tokenAuditLog.scope_used,
      endpoint: tokenAuditLog.endpoint,
      method: tokenAuditLog.method,
      result: tokenAuditLog.result,
      statusCode: tokenAuditLog.status_code,
      createdAt: tokenAuditLog.created_at,
    })
    .from(tokenAuditLog)
    .where(where)
    .orderBy(desc(tokenAuditLog.created_at), desc(tokenAuditLog.id))
    .limit(TOKEN_AUDIT_PAGE_SIZE)
    .offset((page - 1) * TOKEN_AUDIT_PAGE_SIZE)) as Array<{
    id: string;
    tokenId: string;
    actorLabel: string;
    scopeUsed: string;
    endpoint: string;
    method: string;
    result: "ok" | "error";
    statusCode: number;
    createdAt: Date;
  }>;

  return {
    rows: rows.map((r) => ({
      id: r.id,
      tokenId: r.tokenId,
      actorLabel: r.actorLabel,
      scopeUsed: r.scopeUsed,
      endpoint: r.endpoint,
      method: r.method,
      result: r.result,
      statusCode: r.statusCode,
      createdAt: r.createdAt,
    })),
    total: Number(totalRows[0]?.count ?? 0),
    page,
  };
}
