import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { authorizeCompanyAdministrator } from "./grants";

import { redactQueryError } from "@/lib/db/pg-error";
import { postgresTextSchema } from "@/lib/text-schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "company:principal-options",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyPrincipalOption = Readonly<{
  value: string;
  kind: "user" | "agent";
  label: string;
  id: string;
}>;

/** The same current administrator gate protects searchable policy recipient names. */
export async function listCompanyPrincipalOptions(
  db: SqlDatabase,
  administratorId: string,
  query: string,
): Promise<readonly CompanyPrincipalOption[]> {
  if (!postgresTextSchema.max(200).safeParse(query).success)
    throw new MaisterError("CONFIG", "Invalid company principal search");

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await authorizeCompanyAdministrator(tx, administratorId);
      const rows = (
        await tx.execute(sql`SELECT kind,id,label FROM (
      SELECT 'user' AS kind,id,coalesce(name,email) AS label,email AS search FROM users
      UNION ALL SELECT 'agent',id,name,description FROM agents
    ) p WHERE ${query}='' OR strpos(lower(label),lower(${query}))>0 OR strpos(lower(search),lower(${query}))>0 OR id=${query} ORDER BY kind DESC,label,id LIMIT 100`)
      ).rows;

      log.debug(
        { administratorId, count: rows.length },
        "company policy recipient choices resolved",
      );

      return rows.map((row) => ({
        value: `${row.kind}:${row.id}`,
        kind: row.kind as "user" | "agent",
        label: String(row.label),
        id: String(row.id),
      }));
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
