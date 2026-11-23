import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 5 * 60 * 1_000;
const RETRY_DELAY_MS = 50;

function isSqliteBusy(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    err instanceof Error &&
    /database is locked/i.test(err.message)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes an operation on a private filesystem resource. SQLite releases
 * the transaction lock if its owner exits.
 */
export async function withSqliteFileLock<T>(
  cachePath: string,
  effect: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(cachePath), { recursive: true });

  const mutexPath = `${cachePath}.mutex.sqlite`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    const connection = new DatabaseSync(mutexPath);
    let acquired = false;

    try {
      connection.exec("PRAGMA busy_timeout = 0");
      connection.exec("BEGIN IMMEDIATE");
      acquired = true;

      try {
        return await effect();
      } finally {
        connection.exec("ROLLBACK");
      }
    } catch (err) {
      if (acquired || !isSqliteBusy(err)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out waiting for the private filesystem resource lock",
        );
      }
      await delay(RETRY_DELAY_MS);
    } finally {
      connection.close();
    }
  }
}
