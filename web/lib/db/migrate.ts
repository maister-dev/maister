import "@/lib/load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import pino from "pino";

import { maskDbUrl, resolvePostgresDbUrl } from "./postgres-url";

const log = pino({ name: "db:migrate" });

async function main(): Promise<void> {
  const url = resolvePostgresDbUrl();

  log.info({ driver: "postgres", url: maskDbUrl(url) }, "running migrations");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  log.info("migrations done");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "migration failed");
  process.exit(1);
});
