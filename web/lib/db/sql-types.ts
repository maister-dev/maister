import type { SQL } from "drizzle-orm";

/** Minimal transaction seam shared by native SQL domain services and the guarded database. */
export type SqlTransaction = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};
export type SqlDatabase = SqlTransaction & {
  transaction<T>(action: (tx: SqlTransaction) => Promise<T>): Promise<T>;
};
