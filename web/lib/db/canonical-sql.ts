import type { Pool } from "pg";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Database invariants (guard functions and their triggers) are redefined
 * across many migrations; the effective body is whatever the last migration
 * wrote. This directory holds that effective definition, one file per
 * function plus one trigger catalogue, regenerated from a migrated database.
 */
export const CANONICAL_SQL_DIR = "lib/db/canonical";

/** Reads every migration-owned function and trigger, keyed by canonical file name. */
export async function readCanonicalSql(
  pool: Pool,
): Promise<Map<string, string>> {
  const functions = await pool.query<{
    schema: string;
    name: string;
    definition: string;
  }>(`
    SELECT n.nspname AS schema,p.proname AS name,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg\\_%'
      AND p.prokind IN ('f','p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
      )
    ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)
  `);
  const triggers = await pool.query<{ definition: string }>(`
    SELECT pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname,c.relname,t.tgname
  `);
  const files = new Map<string, string>();

  for (const { schema, name, definition } of functions.rows) {
    const file = `${schema === "public" ? "" : `${schema}.`}${name}.sql`;
    const body = `${definition.trimEnd()};\n`;

    files.set(file, files.has(file) ? `${files.get(file)}\n${body}` : body);
  }
  files.set(
    "_triggers.sql",
    triggers.rows.map(({ definition }) => `${definition};\n`).join(""),
  );

  return files;
}

export function readCommittedCanonicalSql(root: string): Map<string, string> {
  const directory = join(root, CANONICAL_SQL_DIR);

  return new Map(
    readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => [file, readFileSync(join(directory, file), "utf8")]),
  );
}

/** File names whose committed text differs from the database, including additions and removals. */
export function canonicalSqlDrift(
  committed: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...committed.keys(), ...live.keys()])]
    .filter((file) => committed.get(file) !== live.get(file))
    .sort();
}
