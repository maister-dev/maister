import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import pino from "pino";

const log = pino({ name: "db:migrate" });

function maskUrl(url: string): string {
  return url.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3");
}

async function main() {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    log.error({ url }, "DB_URL must point at Postgres for migration runs");
    process.exit(1);
  }

  log.info({ url: maskUrl(url) }, "running migrations");
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
