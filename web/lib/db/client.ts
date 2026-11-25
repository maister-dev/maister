import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import pino from "pino";

import { maskDbUrl, resolvePostgresDbUrl } from "./postgres-url";
import { closePostgresPool, createPostgresPool } from "./pool-lifecycle";
import * as schema from "./schema";
import { declareWriterCapability } from "./writer-capability";

import { MaisterError } from "@/lib/errors";

const log = pino({ name: "db" });

export function maskUrl(url: string): string {
  return maskDbUrl(url);
}

export function buildClient(): ReturnType<typeof drizzle<typeof schema>> {
  const url = resolvePostgresDbUrl();
  const max = Number(process.env.MAISTER_DB_POOL_MAX ?? 25);
  const connectionTimeoutMillis = 10_000;
  const idleTimeoutMillis = 30_000;

  log.info(
    {
      driver: "postgres",
      url: maskDbUrl(url),
      max,
      connectionTimeoutMillis,
      idleTimeoutMillis,
    },
    "db client init",
  );

  const pool = createPostgresPool({
    connectionString: url,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    // Complete the writer declaration before lending the connection; hook
    // failures reject the caller instead of publishing an undeclared session.
    onConnect: declareWriterCapability,
  });

  return drizzle(pool, { schema });
}

// Next bundles instrumentation and route handlers in separate runtimes.
const KEY = Symbol.for("maister.postgres-db-lifecycle.v1");

type DbLifecycle = {
  cached: ReturnType<typeof buildClient> | null;
  closing: boolean;
  shutdownCallbacks: Set<() => Promise<void>>;
};
const scope = globalThis as typeof globalThis & { [KEY]?: DbLifecycle };
const lifecycle = (scope[KEY] ??= {
  cached: null,
  closing: false,
  shutdownCallbacks: new Set<() => Promise<void>>(),
});

export function beginDbShutdown(): void {
  lifecycle.closing = true;
}

export function getDb(): ReturnType<typeof buildClient> {
  if (lifecycle.closing) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "web database is shutting down",
    );
  }

  return (lifecycle.cached ??= buildClient());
}

/** Notification clients are autocommit and never borrow a query-pool slot. */
export function createDbNotificationClient(): Client {
  if (lifecycle.closing)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "web database is shutting down",
    );

  return new Client({
    connectionString: resolvePostgresDbUrl(),
    application_name: "maister-run-peek",
  });
}

export function registerDbShutdown(callback: () => Promise<void>): () => void {
  lifecycle.shutdownCallbacks.add(callback);

  return () => {
    lifecycle.shutdownCallbacks.delete(callback);
  };
}

export async function closeDb(): Promise<void> {
  await Promise.all(
    [...lifecycle.shutdownCallbacks].map((callback) => callback()),
  );
  if (lifecycle.cached === null) return;

  const client = lifecycle.cached.$client;

  lifecycle.cached = null;
  await closePostgresPool(client);
}

export { schema };
