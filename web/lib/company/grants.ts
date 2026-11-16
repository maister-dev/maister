import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyGrantDto,
  CompanyGrantInput,
  CompanyGrantPage,
  CompanyGrantPageInput,
  CompanyGrantRevoke,
} from "./grant-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  companyGrantInputSchema,
  companyGrantSchema,
  companyGrantPageInputSchema,
  companyGrantRevokeSchema,
} from "./grant-types";

import { databaseTimestamp } from "@/lib/db/timestamp";
import { contentDigest } from "@/lib/evaluations/digest";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "company:grants",
  level: process.env.LOG_LEVEL ?? "info",
});
const cursorNamespace = "maister.company-grants.v1";

export async function authorizeCompanyAdministrator(
  tx: SqlTransaction,
  userId: string,
): Promise<void> {
  const user = (
    await tx.execute(
      sql`SELECT id,role,account_status,must_change_password FROM users WHERE id=${userId} FOR SHARE`,
    )
  ).rows[0];

  if (!user)
    throw new MaisterError(
      "UNAUTHENTICATED",
      "An active installation administrator is required",
    );
  if (user.account_status !== "active")
    throw new MaisterError(
      "ACCOUNT_INACTIVE",
      "The installation administrator account is inactive",
    );
  if (user.must_change_password === true)
    throw new MaisterError(
      "PASSWORD_CHANGE_REQUIRED",
      "Change the password before administering company authority",
    );
  if (user.role !== "admin")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current installation administrator authority is required",
    );
}

export async function installationCompany(tx: SqlTransaction): Promise<string> {
  const rows = (await tx.execute(sql`SELECT id FROM companies FOR SHARE`)).rows;

  if (rows.length !== 1 || typeof rows[0].id !== "string")
    throw new MaisterError(
      "CONFIG",
      "The installation company identity is unavailable; apply the required migrations",
    );

  return rows[0].id;
}

async function beginPolicyTransaction(
  tx: SqlTransaction,
  administratorId: string,
): Promise<string> {
  await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
  await authorizeCompanyAdministrator(tx, administratorId);

  return installationCompany(tx);
}

function grantDto(row: Readonly<Record<string, unknown>>): CompanyGrantDto {
  const parsed = companyGrantSchema.safeParse({
    id: row.id,
    principalKind: row.principal_type,
    principalId: row.principal_id,
    action: row.action,
    revision: row.revision,
    confirmationClasses: row.confirmation_classes,
    createdBy: row.created_by,
    createdAt: databaseTimestamp(row.created_at),
    revokedAt: databaseTimestamp(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Retained company authority does not match its native contract",
    );

  return parsed.data;
}

async function lockPrincipalPolicy(
  tx: SqlTransaction,
  companyId: string,
  kind: string,
  principalId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-authority:${companyId}:${kind}:${principalId}`},0))`,
  );
}

export async function createCompanyGrants(
  db: SqlDatabase,
  administratorId: string,
  input: CompanyGrantInput,
): Promise<{ page: CompanyGrantPage; duplicate: boolean }> {
  const parsed = companyGrantInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid explicit company authority input",
    );
  const request = {
    ...parsed.data,
    actions: [...parsed.data.actions].sort(),
    confirmationClasses: [...(parsed.data.confirmationClasses ?? [])].sort(),
  };
  const digest = contentDigest({
    principalKind: request.principalKind,
    principalId: request.principalId,
    actions: request.actions,
    confirmationClasses: request.confirmationClasses,
  });

  try {
    return await db.transaction(async (tx) => {
      const companyId = await beginPolicyTransaction(tx, administratorId);

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-grant-delivery:${companyId}:${administratorId}:${request.idempotencyKey}`},0))`,
      );
      const previous = (
        await tx.execute(
          sql`SELECT * FROM company_grants WHERE company_id=${companyId} AND created_by=${administratorId} AND creation_key=${request.idempotencyKey} ORDER BY action FOR SHARE`,
        )
      ).rows;

      if (previous.length > 0) {
        if (previous.some((row) => row.creation_digest !== digest))
          throw new MaisterError(
            "CONFLICT",
            "Company authority delivery key already names different policy input",
          );

        return {
          page: { companyId, items: previous.map(grantDto), nextCursor: null },
          duplicate: true,
        };
      }
      await lockPrincipalPolicy(
        tx,
        companyId,
        request.principalKind,
        request.principalId,
      );
      const principal =
        request.principalKind === "user"
          ? (
              await tx.execute(
                sql`SELECT id FROM users WHERE id=${request.principalId} FOR SHARE`,
              )
            ).rows[0]
          : (
              await tx.execute(
                sql`SELECT id FROM agents WHERE id=${request.principalId} FOR SHARE`,
              )
            ).rows[0];

      if (!principal)
        throw new MaisterError(
          "PRECONDITION",
          "Select an existing company authority principal",
          { details: { reason: "company_principal_unavailable" } },
        );
      const existing = (
        await tx.execute(
          sql`SELECT id FROM company_grants WHERE company_id=${companyId} AND principal_type=${request.principalKind} AND principal_id=${request.principalId} AND action IN (${sql.join(
            request.actions.map((action) => sql`${action}`),
            sql`, `,
          )}) AND revoked_at IS NULL FOR UPDATE`,
        )
      ).rows;

      if (existing.length > 0)
        throw new MaisterError(
          "CONFLICT",
          "A requested company action already has a live grant; inspect or revoke the existing policy",
        );
      const items: CompanyGrantDto[] = [];

      for (const action of request.actions) {
        const classes =
          action === "knowledge:confirm" ? request.confirmationClasses : [];
        const row = (
          await tx.execute(
            sql`INSERT INTO company_grants(company_id,principal_type,principal_id,action,confirmation_classes,created_by,creation_key,creation_digest) VALUES(${companyId},${request.principalKind},${request.principalId},${action},${JSON.stringify(classes)}::jsonb,${administratorId},${request.idempotencyKey},${digest}) RETURNING *`,
          )
        ).rows[0];

        if (!row)
          throw new MaisterError("CRASH", "Company authority was not retained");
        items.push(grantDto(row));
      }
      log.info(
        {
          companyId,
          administratorId,
          principalKind: request.principalKind,
          principalId: request.principalId,
          count: items.length,
        },
        "explicit company authority granted",
      );

      return { page: { companyId, items, nextCursor: null }, duplicate: false };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export async function revokeCompanyGrant(
  db: SqlDatabase,
  administratorId: string,
  grantId: string,
  input: CompanyGrantRevoke,
): Promise<{
  id: string;
  revision: number;
  status: "revoked";
  duplicate: boolean;
}> {
  const parsed = companyGrantRevokeSchema.safeParse(input);

  if (
    !parsed.success ||
    !postgresTextSchema.min(1).max(128).safeParse(grantId).success
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision company authority revocation",
    );
  const digest = contentDigest({
    expectedRevision: parsed.data.expectedRevision,
    reason: parsed.data.reason,
  });

  try {
    return await db.transaction(async (tx) => {
      const companyId = await beginPolicyTransaction(tx, administratorId);
      const selected = (
        await tx.execute(
          sql`SELECT principal_type,principal_id FROM company_grants WHERE company_id=${companyId} AND id=${grantId}`,
        )
      ).rows[0];

      if (!selected)
        throw new MaisterError(
          "PRECONDITION",
          "Company authority reference is unavailable",
          { details: { reason: "company_grant_unavailable" } },
        );
      await lockPrincipalPolicy(
        tx,
        companyId,
        String(selected.principal_type),
        String(selected.principal_id),
      );
      const current = (
        await tx.execute(
          sql`SELECT * FROM company_grants WHERE company_id=${companyId} AND id=${grantId} FOR UPDATE`,
        )
      ).rows[0];

      if (!current)
        throw new MaisterError(
          "PRECONDITION",
          "Company authority reference is unavailable",
          { details: { reason: "company_grant_unavailable" } },
        );
      if (current.revoked_at !== null) {
        if (
          current.revocation_key === parsed.data.idempotencyKey &&
          current.revocation_digest === digest
        )
          return {
            id: grantId,
            revision: Number(current.revision),
            status: "revoked",
            duplicate: true,
          };
        throw new MaisterError(
          "CONFLICT",
          "Company authority already has a different revocation decision",
        );
      }
      if (
        Number(current.revision) !== parsed.data.expectedRevision ||
        Number(current.revision) === 2147483647
      )
        throw new MaisterError(
          "CONFLICT",
          "Company authority revision is stale or exhausted",
          { details: { currentRevision: Number(current.revision) } },
        );
      const revision = Number(current.revision) + 1;

      await tx.execute(
        sql`UPDATE company_grants SET revision=${revision},revoked_at=clock_timestamp(),revoked_by=${administratorId},revocation_reason=${parsed.data.reason},revocation_key=${parsed.data.idempotencyKey},revocation_digest=${digest} WHERE id=${grantId}`,
      );
      log.info(
        { companyId, grantId, revision, administratorId },
        "company authority revoked",
      );

      return { id: grantId, revision, status: "revoked", duplicate: false };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export async function listCompanyGrants(
  db: SqlDatabase,
  administratorId: string,
  input: CompanyGrantPageInput,
): Promise<CompanyGrantPage> {
  const parsed = companyGrantPageInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid company authority page selector");
  const { cursor: rawCursor, limit } = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      const companyId = await beginPolicyTransaction(tx, administratorId);
      const scope = contentDigest({
        companyId,
        administratorId,
        authority: "installation-admin",
        limit,
      });
      const cursor =
        rawCursor === undefined
          ? null
          : decodeKeysetCursor(cursorNamespace, rawCursor, scope);
      const upper =
        cursor?.upper ??
        String(
          (
            await tx.execute(
              sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
            )
          ).rows[0].at,
        );
      const after =
        cursor === null
          ? sql`true`
          : sql`(g.created_at,g.id)<(${cursor.at}::timestamptz,${cursor.id})`;
      const rows = (
        await tx.execute(
          sql`SELECT g.*,to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM company_grants g WHERE g.company_id=${companyId} AND g.created_at<=${upper}::timestamptz AND ${after} ORDER BY g.created_at DESC,g.id DESC LIMIT ${limit + 1}`,
        )
      ).rows;
      const items: CompanyGrantDto[] = [];
      let nextCursor: string | null = null;

      for (let index = 0; index < rows.length && index < limit; index++) {
        const row = rows[index];
        const item = grantDto(row);
        const next =
          index + 1 < rows.length
            ? encodeKeysetCursor(cursorNamespace, {
                version: 1,
                scope,
                upper,
                at: String(row.at),
                id: String(row.id),
              })
            : null;

        if (
          Buffer.byteLength(
            JSON.stringify({
              companyId,
              items: [...items, item],
              nextCursor: next,
            }),
            "utf8",
          ) > 131072
        ) {
          if (items.length === 0)
            throw new MaisterError(
              "PRECONDITION",
              "Company authority metadata exceeds the bounded page contract",
            );
          break;
        }
        items.push(item);
        nextCursor = next;
      }

      return { companyId, items, nextCursor };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
