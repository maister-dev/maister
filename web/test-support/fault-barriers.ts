import type { Pool } from "pg";

import { randomInt, randomUUID } from "node:crypto";

import { poll } from "./durable-workers-ledger";
import { FaultBarrierError, recordFaultEvent } from "./supervisor-fault-proxy";

export type DatabaseFaultBarrier = {
  awaitReached(timeoutMs?: number): Promise<number>;
  release(): Promise<void>;
  terminateWriter(): Promise<number>;
  close(): Promise<void>;
};

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new FaultBarrierError(`invalid fixture SQL identifier: ${value}`);

  return `"${value}"`;
}

/** A row-scoped, disposable-database trigger; a visible pg_locks waiter is the reached witness. */
export async function holdDatabaseWrite(input: {
  pool: Pool;
  caseId: string;
  table: string;
  matches: Readonly<Record<string, string>>;
}): Promise<DatabaseFaultBarrier> {
  const table = identifier(input.table);
  const name = identifier(`s52_${randomUUID().replaceAll("-", "")}`);
  const key = randomInt(1, 2_000_000_000);
  const namespace = 5252;
  const entries = Object.entries(input.matches);

  if (!entries.length)
    throw new FaultBarrierError("database fault requires a row predicate");
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const predicate = entries
    .map(
      ([column, value]) =>
        `NEW.${identifier(column)}::text = ${literal(value)}`,
    )
    .join(" AND ");
  const owner = await input.pool.connect();
  let reached: number | null = null;
  let disposed = false;
  let closed = false;

  try {
    await owner.query("SELECT pg_advisory_lock($1::int, $2::int)", [
      namespace,
      key,
    ]);
    await input.pool
      .query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $s52$
      BEGIN IF ${predicate} THEN PERFORM pg_advisory_xact_lock(${namespace}, ${key}); END IF; RETURN NEW; END $s52$`);
    await input.pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    recordFaultEvent(input.caseId, "database-barrier-armed", {
      table: input.table,
      key,
    });
  } catch (error) {
    await owner.query("SELECT pg_advisory_unlock_all()");
    owner.release();
    await input.pool.query(`DROP FUNCTION IF EXISTS ${name}() CASCADE`);
    throw error;
  }
  async function release(): Promise<void> {
    if (disposed || reached === null)
      throw new FaultBarrierError(
        `${input.caseId}: database barrier unreached/already released`,
      );
    disposed = true;
    await owner.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
      namespace,
      key,
    ]);
    recordFaultEvent(input.caseId, "database-barrier-released", {
      backendPid: reached,
      key,
    });
  }

  return {
    async awaitReached(timeoutMs = 30_000) {
      reached = await poll(
        async () => {
          const result = await input.pool.query<{ pid: number }>(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND NOT granted ORDER BY pid",
            [namespace, key],
          );

          return result.rows[0]?.pid ?? null;
        },
        timeoutMs,
        `${input.caseId}: scoped database writer waiter`,
        25,
      );

      recordFaultEvent(input.caseId, "database-barrier-reached", {
        backendPid: reached,
        key,
      });

      return reached;
    },
    release,
    async terminateWriter() {
      if (reached === null || disposed)
        throw new FaultBarrierError(
          `${input.caseId}: no blocked writer to terminate`,
        );
      const result = await input.pool.query<{ killed: boolean }>(
        "SELECT pg_terminate_backend(pid) AS killed FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND classid = $2::oid AND objid = $3::oid AND NOT granted",
        [reached, namespace, key],
      );

      if (result.rows[0]?.killed !== true)
        throw new FaultBarrierError(
          `${input.caseId}: writer no longer owns the reached window`,
        );
      recordFaultEvent(input.caseId, "database-writer-terminated", {
        backendPid: reached,
        key,
      });

      return reached;
    },
    async close() {
      if (closed) return;
      closed = true;
      const incomplete = !disposed;

      try {
        await owner.query("SELECT pg_advisory_unlock_all()");
      } finally {
        owner.release();
        await input.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await input.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
      }
      if (incomplete)
        throw new FaultBarrierError(
          `${input.caseId}: database barrier closed without disposition`,
        );
    },
  };
}
