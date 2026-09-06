import "server-only";

import type { PoolClient } from "pg";
import type { Db } from "@/lib/execution-host/db";
import type { FlowDriverClaim } from "./driver-claim";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";

import { drizzle } from "drizzle-orm/node-postgres";

import {
  assertFlowDriverClaim,
  assertFlowDriverCommit,
  FlowDriverClaimLost,
} from "./driver-claim";

import * as schema from "@/lib/db/schema";
import {
  boundedPostgresTransaction,
  projectionTransaction,
} from "@/lib/execution-host/events/projection-transaction";

/** Scope the existing graph's database operations to one traversal. Root
 * statements get their own bounded transaction; explicit transactions share
 * the same run lock and final lease check, including nested savepoints. The
 * original PostgreSQL query config preserves join row modes and type parsers.
 *
 * Only traversal work receives this handle. Host consumers, owner application,
 * renewal and other runs must retain their independent root database handle.
 */
export function flowDriverDatabase(
  root: Db,
  claim: FlowDriverClaim,
  signal?: AbortSignal,
): Db {
  const assertActive = (): void => {
    if (signal?.aborted) throw new FlowDriverClaimLost(claim);
  };
  const client = {
    query: (...args: unknown[]): Promise<unknown> =>
      boundedPostgresTransaction(root, async (tx, query) => {
        assertActive();
        await assertFlowDriverClaim(tx, claim);
        const result = await query(...args);

        assertActive();
        await assertFlowDriverCommit(tx, claim);

        return result;
      }),
  };
  // Drizzle's PostgreSQL prepared queries require only query(). Its root
  // transaction method is replaced below so it never issues BEGIN/COMMIT on
  // this query-only adapter or tries to acquire a connection from it.
  const database = drizzle(client as unknown as PoolClient, { schema });

  return new Proxy(database, {
    get(target, property, receiver): unknown {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);

      return <T>(
        work: (tx: Db) => Promise<T>,
        config?: PgTransactionConfig,
      ): Promise<T> =>
        projectionTransaction(
          root,
          async (tx) => {
            assertActive();
            await assertFlowDriverClaim(tx, claim);
            const result = await work(tx);

            assertActive();
            await assertFlowDriverCommit(tx, claim);

            return result;
          },
          config,
        );
    },
  });
}
