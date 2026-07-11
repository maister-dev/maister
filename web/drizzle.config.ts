import "dotenv/config";

import { defineConfig } from "drizzle-kit";

import { resolvePostgresDbUrl } from "./lib/db/postgres-url";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: resolvePostgresDbUrl(),
  },
  verbose: true,
  strict: true,
});
