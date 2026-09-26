import "server-only";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-184: a resource-addressed ext route finds its project from the run, so a
// global token's owner RBAC is checked against the project that owns the
// resource. An unknown or project-less run resolves to null — an
// existence-hidden 404.
export function runProjectResolver(
  runId: string,
): (ctx: { db: Db }) => Promise<string | null> {
  return async ({ db }) => {
    const rows = await db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    return rows[0]?.projectId ?? null;
  };
}
