import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PoolClient, QueryConfig } from "pg";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";

import { performance } from "node:perf_hooks";

import { NodePgDatabase, NodePgSession } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm/relations";
import { Client, Pool } from "pg";

import * as schema from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";

const TRANSACTION_BUDGET_MS = 5_000;
const CLEANUP_BUDGET_MS = 500;
// Only immutable table metadata is shared; sessions and query results are not.
const tables = extractTablesRelationalConfig<
  ExtractTablesWithRelations<typeof schema>
>(schema, createTableRelationsHelpers);
const relationalSchema = {
  fullSchema: schema,
  schema: tables.tables,
  tableNamesMap: tables.tableNamesMap,
};

type Transaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type TransactionSession = NodePgSession<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** SQL-only projection work does not allocate a query builder for every table.
 * Relational reads and nested savepoints retain the same guarded connection.
 */
function withLazyRelationalQueries(
  transaction: Transaction,
  session: TransactionSession,
  dialect: PgDialect,
): Transaction {
  let queries: Db["query"] | undefined;

  return new Proxy(transaction, {
    get(target, property, receiver): unknown {
      if (property === "query") {
        queries ??= new NodePgDatabase<typeof schema>(
          dialect,
          session,
          relationalSchema,
        ).query;

        return queries;
      }
      if (property === "transaction")
        return <T>(work: (nested: Transaction) => Promise<T>): Promise<T> =>
          target.transaction((nested) =>
            work(withLazyRelationalQueries(nested, session, dialect)),
          );

      return Reflect.get(target, property, receiver);
    },
  });
}

function deadlineError(): MaisterError {
  return new MaisterError(
    "ACP_PROTOCOL",
    "projection transaction exceeded its deadline",
    {
      details: { reason: "projection_transaction_deadline" },
    },
  );
}

export function isProjectionTransactionUnavailable(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;

  while (current instanceof Error && !visited.has(current)) {
    if (
      isMaisterError(current) &&
      (current.details?.reason === "projection_transaction_deadline" ||
        current.details?.reason === "projection_connection_timeout" ||
        current.details?.reason ===
          "projection_transaction_cleanup_unconfirmed")
    )
      return true;
    visited.add(current);
    current = current.cause;
  }

  return false;
}

function queryText(argument: unknown): string {
  if (typeof argument === "string") return argument;
  if (
    argument &&
    typeof argument === "object" &&
    "text" in argument &&
    typeof argument.text === "string"
  )
    return argument.text;
  throw new MaisterError(
    "ACP_PROTOCOL",
    "projection query must have explicit SQL text",
  );
}

async function cancelBackend(pool: Pool, backendPid: number): Promise<void> {
  // A separate connection avoids waiting behind the exhausted application
  // pool. PostgreSQL 16 has no transaction_timeout setting.
  const cancellation = new Client({
    ...pool.options,
    connectionTimeoutMillis: CLEANUP_BUDGET_MS,
    query_timeout: CLEANUP_BUDGET_MS,
  });

  try {
    await cancellation.connect();
    await cancellation.query("SELECT pg_cancel_backend($1)", [backendPid]);
  } finally {
    await cancellation.end();
  }
}

async function settleWithinCleanup(
  operation: Promise<unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), CLEANUP_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireClient(pool: Pool): Promise<PoolClient> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquisition = pool.connect().then((client) => {
    if (expired) {
      client.release();
      throw deadlineError();
    }

    return client;
  });

  try {
    return await Promise.race([
      acquisition,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(
            new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "projection database connection acquisition timed out",
              { details: { reason: "projection_connection_timeout" } },
            ),
          );
        }, TRANSACTION_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs DB-only projection work with a cumulative deadline and fenced COMMIT.
 * Query timeouts shrink with the remaining transaction budget. Deadline
 * cancellation cannot silently return an unconfirmed connection to the pool.
 */
export async function projectionTransaction<T>(
  db: Db,
  work: (tx: Db) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return boundedPostgresTransaction(db, (tx) => work(tx), config);
}

/** The query bridge preserves the caller's PostgreSQL row mode and parsers.
 * It is valid only inside this bounded transaction and uses the same guarded
 * connection as the Drizzle handle; it must not escape the callback.
 */
export async function boundedPostgresTransaction<T>(
  db: Db,
  work: (tx: Db, query: (...args: unknown[]) => Promise<unknown>) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  if (!("$client" in db) || !(db.$client instanceof Pool)) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "projection transactions require the root PostgreSQL pool",
    );
  }
  const pool = db.$client;
  const deadline = performance.now() + TRANSACTION_BUDGET_MS;
  const client = await acquireClient(pool);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let committed = false;
  let rolledBack = false;
  let cancellation: Promise<void> | undefined;
  let cancellationFailed = false;
  let operation: Promise<T> | undefined;
  let connectionBroken = false;
  const onConnectionError = (): void => {
    connectionBroken = true;
    expired = true;
  };

  // A server idle-timeout can terminate a checked-out client between queries.
  // pg emits an EventEmitter error in that case; it must remain producer-local.
  client.on("error", onConnectionError);

  const remaining = (): number => {
    const ms = Math.floor(deadline - performance.now());

    if (expired || ms < 1) throw deadlineError();

    return ms;
  };
  const guarded = new Proxy(client, {
    get(target, property, receiver): unknown {
      if (property !== "query") return Reflect.get(target, property, receiver);

      return async (...args: unknown[]): Promise<unknown> => {
        const text = queryText(args[0]).trim().toLowerCase();
        const rollback = text === "rollback";

        if (!rollback) {
          const budget = remaining();

          if (!text.startsWith("begin")) {
            await target.query(
              "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)",
              [String(budget)],
            );
            remaining();
          }
        }
        const result: unknown = await Reflect.apply(target.query, target, args);

        if (text === "commit") committed = true;
        if (rollback) rolledBack = true;

        return result;
      };
    },
  });

  try {
    // pg supports a per-query read timeout; its current declaration omits it.
    const pidQuery: QueryConfig & { query_timeout: number } = {
      text: "SELECT pg_backend_pid() AS pid",
      query_timeout: remaining(),
    };
    const pidResult = await client.query<{ pid: number }>(pidQuery);
    const backendPid = pidResult.rows[0]?.pid;

    if (!Number.isSafeInteger(backendPid) || backendPid <= 0) {
      throw new MaisterError(
        "ACP_PROTOCOL",
        "PostgreSQL did not return a valid projection backend identity",
      );
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        cancellation = cancelBackend(pool, backendPid).catch(() => {
          cancellationFailed = true;
        });
        reject(deadlineError());
      }, remaining());
    });

    const dialect = new PgDialect();
    const session = new NodePgSession<
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >(guarded, dialect, undefined);

    operation = session.transaction(async (tx) => {
      let callbackActive = true;

      try {
        const result = await work(
          withLazyRelationalQueries(tx, session, dialect),
          async (...args: unknown[]): Promise<unknown> => {
            if (!callbackActive) throw deadlineError();

            return Reflect.apply(guarded.query, guarded, args);
          },
        );

        remaining();

        return result;
      } finally {
        callbackActive = false;
      }
    }, config);

    return await Promise.race([operation, timeout]);
  } catch (error) {
    const code = pgErrorOf(error)?.code;

    if (code === "55P03" || code === "57014") throw deadlineError();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    const settled = operation ? await settleWithinCleanup(operation) : false;

    const cancellationSettled = cancellation
      ? await settleWithinCleanup(cancellation)
      : true;
    const discard =
      !settled ||
      connectionBroken ||
      (!committed && !rolledBack) ||
      cancellationFailed ||
      !cancellationSettled;

    client.release(discard);
    if (discard)
      client.once("end", () => client.off("error", onConnectionError));
    else client.off("error", onConnectionError);
    if (discard) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "projection transaction cleanup could not be confirmed; connection discarded",
        {
          details: { reason: "projection_transaction_cleanup_unconfirmed" },
        },
      );
    }
  }
}
