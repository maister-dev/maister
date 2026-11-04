import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type {
  CompanyBindingPageInput,
  CompanySpecialistPage,
} from "./company-binding-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { decodeCompanyBindingRevision } from "./company-binding-snapshot";
import {
  companyBindingPageInputSchema,
  companySpecialistIdSchema,
} from "./company-binding-types";
import {
  beginCompanyBindingTransaction,
  companySpecialistDto,
} from "./company-bindings";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

const namespace = "maister.company-specialists.v1";
const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    agentId: companySpecialistIdSchema,
    bindingId: z.string().min(1).max(128),
  })
  .strict();

/** Retired bindings remain visible; stable role/binding keysets never infer current authority from a cursor. */
export async function listCompanySpecialists(
  db: SqlDatabase,
  userId: string,
  request: CompanyBindingPageInput,
): Promise<CompanySpecialistPage> {
  const parsed = companyBindingPageInputSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company specialist page selector is invalid",
    );
  const input = parsed.data;

  return db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const companyId = await installationCompany(tx);
    const authority = await authorizeCompanyUserAction(
      tx,
      userId,
      companyId,
      "specialists:read",
    );
    const scope = contentDigest({
      companyId,
      actor: authority.actor,
      witness: authority.witness,
    });
    const cursor =
      input.cursor === undefined
        ? null
        : cursorSchema.safeParse(parseCursorPayload(namespace, input.cursor));

    if (cursor !== null && (!cursor.success || cursor.data.scope !== scope))
      throw new MaisterError(
        "CONFIG",
        "The specialist cursor does not match this user and current company authority",
      );
    const after = cursor?.success ? cursor.data : null;
    const rows = (
      await tx.execute(
        sql`SELECT r.*,b.company_id,b.agent_id,b.created_at AS head_created_at FROM company_specialist_bindings b JOIN company_specialist_binding_revisions r ON r.binding_id=b.id AND r.revision=b.revision WHERE b.company_id=${companyId} ${after ? sql`AND (b.agent_id,b.id)>(${after.agentId},${after.bindingId})` : sql``} ORDER BY b.agent_id,b.id LIMIT ${input.limit + 1}`,
      )
    ).rows;
    const visible = rows.slice(0, input.limit);
    const items = visible.map((row) => {
      const retained = decodeCompanyBindingRevision(row);
      const createdAt = databaseTimestamp(row.head_created_at);

      if (
        !createdAt ||
        typeof row.agent_id !== "string" ||
        retained.snapshot.agentId !== row.agent_id ||
        retained.authoritySnapshot.witness.owner.companyId !== companyId
      )
        throw new MaisterError(
          "CRASH",
          "The specialist page contains an invalid owned configuration revision",
        );

      return companySpecialistDto(
        {
          id: retained.bindingId,
          companyId,
          agentId: row.agent_id,
          revision: retained.revision,
          createdAt,
        },
        retained,
      );
    });
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? signCursorPayload(namespace, {
              version: 1,
              scope,
              agentId: last.id,
              bindingId: last.bindingId,
            })
          : null,
    };
  });
}
