import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";

import { maskDbUrl, resolvePostgresDbUrl } from "./postgres-url";
import * as schema from "./schema";

import { MaisterError } from "@/lib/errors";

const log = pino({ name: "db" });

export function maskUrl(url: string): string {
  return maskDbUrl(url);
}

export function buildClient(): ReturnType<typeof drizzle<typeof schema>> {
  const url = resolvePostgresDbUrl();

  log.info({ driver: "postgres", url: maskDbUrl(url) }, "db client init");

  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.MAISTER_DB_POOL_MAX ?? 10),
  });

  return drizzle(pool, { schema });
}

let cached: ReturnType<typeof buildClient> | null = null;
let closing = false;

export function beginDbShutdown(): void {
  closing = true;
}

export function getDb(): ReturnType<typeof buildClient> {
  if (closing) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "web database is shutting down",
    );
  }
  if (cached === null) {
    cached = buildClient();
  }

  return cached;
}

export async function closeDb(): Promise<void> {
  if (cached === null) return;

  const client = cached.$client;

  cached = null;
  await client.end();
}

export { schema };
