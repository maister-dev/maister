import "@/lib/load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import pino from "pino";

import { maskDbUrl, resolvePostgresDbUrl } from "./postgres-url";

// Project Brain migration lineage (ADR-122). Runs the HAND-AUTHORED `brain_*` +
// `CREATE EXTENSION vector` migrations from a SEPARATE folder into a SEPARATE
// ledger table (`drizzle.__drizzle_brain_migrations`). The main migrator
// (`migrate.ts`) hardcodes `./lib/db/migrations` → `drizzle.__drizzle_migrations`;
// sharing one ledger across both lineages would corrupt migration accounting.
// Runs AFTER `db:migrate` (brain FKs reference `projects`/`runs`).

const log = pino({ name: "db:migrate:brain" });

async function main(): Promise<void> {
  const url = resolvePostgresDbUrl();

  log.info(
    { driver: "postgres", url: maskDbUrl(url) },
    "running brain-lineage migrations",
  );
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  await migrate(db, {
    migrationsFolder: "./lib/db/brain-migrations",
    migrationsTable: "__drizzle_brain_migrations",
  });
  log.info("brain migrations done");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "brain migration failed");
  process.exit(1);
});
