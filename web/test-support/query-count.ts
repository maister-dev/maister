import type * as schema from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Counts the statements a read model issues against one handle.
 *
 * The Observatory's contract is a FIXED query count regardless of project
 * count (ADR-134, ADR-178) — an N+1 there is invisible in every assertion
 * about the returned DTO, so it needs its own instrument. Both `select` and
 * `execute` are intercepted: a read model may use the query builder, raw SQL,
 * or both, and a count that only sees one of them silently under-reports.
 */
export function withQueryCount(database: NodePgDatabase<typeof schema>): {
  db: NodePgDatabase<typeof schema>;
  count: () => number;
} {
  let statements = 0;

  return {
    db: new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "select" || prop === "execute") {
          const method = Reflect.get(target, prop, receiver) as unknown as (
            ...args: unknown[]
          ) => unknown;

          return (...args: unknown[]) => {
            statements += 1;

            return method.apply(target, args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    }) as NodePgDatabase<typeof schema>,
    count: () => statements,
  };
}
