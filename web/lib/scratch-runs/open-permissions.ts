import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { hitlRequests } from "@/lib/db/schema";

const log = pino({
  name: "scratch-open-permissions",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

/** Closes every open permission request of a scratch run, a stored answer or
 * not — the close-out every terminal writer of a scratch dialog shares. The
 * terminal owns an answer its dead session never received (ADR-177
 * 2026-09-26), so a Recover's fresh session asks again instead of inheriting a
 * choice made for a request that no longer exists. */
export async function closeOpenScratchPermissions(
  tx: Db,
  runId: string,
  at: Date,
): Promise<number> {
  const closed = await tx
    .update(hitlRequests)
    .set({ respondedAt: at })
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
      ),
    )
    .returning({ id: hitlRequests.id });

  if (closed.length > 0)
    log.info(
      { runId, count: closed.length },
      "scratch-open-permissions-closed",
    );

  return closed.length;
}
