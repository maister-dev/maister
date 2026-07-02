import "@/lib/load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";

import {
  findPendingBrainMigrations,
  findPendingMigrations,
} from "./check-migrations";

const log = pino({ name: "db:check" });

// CI / pre-deploy gate: fail non-zero if the connected database is missing any
// migration EITHER journal expects (main lineage + the ADR-122 brain lineage).
// Pair with `pnpm db:migrate` + `pnpm db:migrate:brain` on deploy so a
// silently-skipped or un-run migration breaks the pipeline instead of the app.
async function main() {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    log.error({ url }, "DB_URL must point at Postgres for db:check");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    const pending = await findPendingMigrations(db);

    if (pending.length > 0) {
      log.error(
        { pending, count: pending.length },
        "migrations recorded in the journal are NOT applied — run `pnpm db:migrate`",
      );
      process.exit(1);
    }

    const pendingBrain = await findPendingBrainMigrations(db);

    if (pendingBrain.length > 0) {
      log.error(
        { pending: pendingBrain, count: pendingBrain.length },
        "brain-lineage migrations are NOT applied — run `pnpm db:migrate:brain`",
      );
      process.exit(1);
    }

    log.info("all journal migrations are applied (main + brain lineages)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, "db:check failed");
  process.exit(1);
});
