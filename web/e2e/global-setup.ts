/* eslint-disable no-console */
// Playwright global setup for the authenticated/seeded e2e suite. Runs once
// before any test: provisions the dedicated e2e database, applies the schema
// migrations (incl. M11a 0010_m11a_graph_ledger), and plants the review→rework
// fixture. Auth (storageState) is handled separately by e2e/auth.setup.ts so
// it runs after the webServer is ready.
import type { Server } from "node:http";

import { execSync } from "node:child_process";

import { Pool } from "pg";

import { E2E_DB_URL } from "./_seed/db-url";
import { startStubSupervisor } from "./_seed/stub-supervisor";

async function ensureDatabase(url: string): Promise<void> {
  const dbName = new URL(url).pathname.replace(/^\//, "");

  if (!dbName) throw new Error(`E2E_DB_URL has no database name: ${url}`);

  const adminUrl = new URL(url);

  adminUrl.pathname = "/postgres";
  const pool = new Pool({ connectionString: adminUrl.toString() });

  try {
    const existing = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );

    if (existing.rowCount === 0) {
      // dbName originates from our own constant, not user input — safe to inline.
      await pool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`global-setup: created database ${dbName}`);
    }
  } finally {
    await pool.end();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!E2E_DB_URL.startsWith("postgres")) {
    throw new Error(
      `e2e requires a Postgres E2E_DB_URL; got "${E2E_DB_URL}". ` +
        `Start Postgres (docker compose up -d db) or set E2E_DB_URL.`,
    );
  }

  try {
    await ensureDatabase(E2E_DB_URL);
  } catch (err) {
    throw new Error(
      `e2e: cannot reach or create Postgres for ${E2E_DB_URL} — is the database server up? ` +
        `(${(err as Error).message})`,
    );
  }

  const env = { ...process.env, DB_URL: E2E_DB_URL };

  console.log("global-setup: applying migrations…");
  execSync("pnpm exec tsx lib/db/migrate.ts", { stdio: "inherit", env });

  console.log("global-setup: seeding review→rework fixture…");
  execSync("pnpm exec tsx e2e/_seed/seed-e2e.ts", { stdio: "inherit", env });

  // The stub supervisor must be up BEFORE the webServer boots so the M11c
  // launch-refusal scenario reads the platform as ready (and the board Launch
  // button is enabled). Returned as the Playwright global teardown.
  const stub: Server = await startStubSupervisor();

  return async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  };
}
