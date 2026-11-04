import "server-only";

import type { CompanyAction, CompanyGrantWitness } from "./types";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { MaisterError } from "@/lib/errors";

export type CompanyUserAuthority = Readonly<{
  actor: Readonly<{ kind: "user"; id: string; runId: null; attemptId: null }>;
  witness: CompanyGrantWitness;
}>;

/** Lock current account and explicit action authority for the caller's transaction. */
export async function authorizeCompanyUserAction(
  tx: SqlTransaction,
  userId: string,
  companyId: string,
  action: CompanyAction,
): Promise<CompanyUserAuthority> {
  const identity = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:read",
  );

  if (identity.kind !== "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current user identity is required for company authority",
    );
  const grant = (
    await tx.execute(
      sql`SELECT id,revision FROM company_grants WHERE company_id=${companyId} AND principal_type='user' AND principal_id=${identity.user.id} AND action=${action} AND revoked_at IS NULL FOR SHARE`,
    )
  ).rows[0];

  if (
    !grant ||
    typeof grant.id !== "string" ||
    typeof grant.revision !== "number"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current explicit company action authority is required",
      { details: { action } },
    );

  return {
    actor: { kind: "user", id: identity.user.id, runId: null, attemptId: null },
    witness: {
      kind: "company_grant",
      owner: { kind: "company", companyId },
      authorityId: grant.id,
      revision: grant.revision,
      action,
    },
  };
}
