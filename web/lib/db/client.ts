import "server-only";

import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";

import { MaisterError } from "@/lib/errors";

import * as schema from "./schema";

const log = pino({ name: "db" });

function resolveDbUrl(): string {
  const url = process.env.DB_URL;

  if (!url) {
    throw new MaisterError(
      "CONFIG",
      "DB_URL env is required (postgres://... or file:./dev.db)",
    );
  }

  return url;
}

export function maskUrl(url: string): string {
  return url.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3");
}

export function buildClient() {
  const url = resolveDbUrl();

  log.info({ url: maskUrl(url) }, "db client init");

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.MAISTER_DB_POOL_MAX ?? 10),
    });

    return drizzlePg(pool, { schema });
  }

  if (url.startsWith("file:")) {
    const sqlitePath = url.replace(/^file:/, "");
    const sqlite = new Database(sqlitePath);

    return drizzleSqlite(sqlite, { schema });
  }

  throw new MaisterError(
    "CONFIG",
    `Unsupported DB_URL prefix: ${maskUrl(url)} (expected postgres:// or file:)`,
  );
}

let cached: ReturnType<typeof buildClient> | null = null;

export function getDb(): ReturnType<typeof buildClient> {
  if (cached === null) {
    cached = buildClient();
  }

  return cached;
}

export { schema };
