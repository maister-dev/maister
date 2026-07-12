/* eslint-disable no-console */
import { execSync } from "node:child_process";

import { Pool } from "pg";

import { E2E_DB_URL } from "./db-url";

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
      // dbName originates from the fixed E2E database URL.
      await pool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`e2e preflight: created database ${dbName}`);
    }
  } finally {
    await pool.end();
  }
}

async function resetSchema(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url });

  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await pool.end();
  }
}

/**
 * Prepares the isolated E2E database before Next.js is allowed to boot.
 * Playwright starts `webServer` before `globalSetup`; keeping this outside
 * global setup lets the production migration guard observe an applied ledger.
 */
export async function prepareE2eDatabase(): Promise<void> {
  if (!E2E_DB_URL.startsWith("postgres")) {
    throw new Error(
      `e2e requires a Postgres E2E_DB_URL; got "${E2E_DB_URL}". ` +
        "Start Postgres (docker compose up -d db) or set E2E_DB_URL.",
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

  console.log("e2e preflight: resetting e2e schema…");
  await resetSchema(E2E_DB_URL);

  const env = { ...process.env, DB_URL: E2E_DB_URL, NODE_ENV: "test" as const };

  console.log("e2e preflight: applying migrations…");
  execSync(
    "pnpm exec tsx --import ./scripts/_register-shim.mjs lib/db/migrate.ts",
    { stdio: "inherit", env },
  );
  console.log("e2e preflight: applying brain migrations…");
  execSync("pnpm exec tsx lib/db/migrate-brain.ts", { stdio: "inherit", env });
  console.log("e2e preflight: seeding fixtures…");
  execSync("pnpm exec tsx e2e/_seed/seed-e2e.ts", { stdio: "inherit", env });
}
