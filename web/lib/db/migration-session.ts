import type { PoolClient } from "pg";

import pino from "pino";

import { declareWriterCapability } from "./writer-capability";

const log = pino({
  name: "migration-session",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Ledger preparation and the pending transaction must share these awaited session settings. */
export async function configureMigrationSession(
  client: PoolClient,
): Promise<void> {
  await client.query("SET lock_timeout = '5s'; SET statement_timeout = '120s'");
  await declareWriterCapability(client);
  log.debug(
    { lockTimeoutMs: 5_000, statementTimeoutMs: 120_000 },
    "[FIX:migration-session] bounded migration writer configured",
  );
}
