// Single source of truth for the DEDICATED e2e database connection. Both
// playwright.config.ts (webServer env) and global-setup.ts import this so the
// app under test and the seeder always agree on the target DB. Defaults to a
// disposable `maister_e2e` DB on the local dev Postgres — never the dev DB.
export const E2E_DB_URL =
  process.env.E2E_DB_URL ??
  "postgres://maister:maister@localhost:5432/maister_e2e";
