import "dotenv/config";

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DB_URL ?? "postgres://maister:maister@localhost:5432/maister",
  },
  verbose: true,
  strict: true,
});
