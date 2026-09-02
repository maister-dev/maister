import "server-only";

import { and, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { platformAcpRunners } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

/**
 * Whether at least one enabled platform ACP runner is Ready — the launch
 * precondition the board projection, the portfolio onboarding count and the
 * delegation trust resolver share (ADR-163: delegation trust equals board
 * launchability).
 */
export async function hasReadyPlatformRunner(db: Db): Promise<boolean> {
  const rows = (await db
    .select({ id: platformAcpRunners.id })
    .from(platformAcpRunners)
    .where(
      and(
        eq(platformAcpRunners.enabled, true),
        eq(platformAcpRunners.readinessStatus, "Ready"),
      ),
    )
    .limit(1)) as { id: string }[];

  return rows.length > 0;
}
