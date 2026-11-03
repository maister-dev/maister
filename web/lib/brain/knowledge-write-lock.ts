import "server-only";

import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

/** Record/source graphs span owners; every existing record-update path uses this transaction lock. */
export function knowledgeWriteLockSql(): SQL {
  return sql`pg_advisory_xact_lock(hashtextextended('maister:native-knowledge-writes:v1',0))`;
}
