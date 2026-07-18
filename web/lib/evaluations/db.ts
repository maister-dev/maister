import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/lib/db/schema";

// The injected database seam shared by every evaluations module. Drizzle's
// PgTransaction structurally satisfies NodePgDatabase (it adds no instance
// members over PgDatabase), so this one alias covers both the pooled client
// (getDb()) and the `tx` handle inside `db.transaction(...)`.
export type Db = NodePgDatabase<typeof schema>;
