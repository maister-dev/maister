import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, exists, ne } from "drizzle-orm";

import { runs, webhookEvents } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { tryStartRun, type TryStartRunResult } from "@/lib/scheduler";

/** A queue promotion can commit between allocation and the launcher's own dispatch. */
export async function startAllocatedRun(
  db: Pick<Db, "select" | "transaction">,
  runId: string,
): Promise<TryStartRunResult | "already_started"> {
  async function hasStartReceipt(): Promise<boolean> {
    const [row] = await db
      .select({
        started: exists(
          db
            .select({ id: webhookEvents.id })
            .from(webhookEvents)
            .where(
              and(
                eq(webhookEvents.runId, runs.id),
                eq(webhookEvents.type, "run.started"),
              ),
            ),
        ),
      })
      .from(runs)
      .where(and(eq(runs.id, runId), ne(runs.status, "Pending")));

    return row?.started === true;
  }

  try {
    const result = await tryStartRun(runId, { db });

    return !result.started && (await hasStartReceipt())
      ? "already_started"
      : result;
  } catch (error) {
    if (
      isMaisterError(error) &&
      error.code === "CONFLICT" &&
      error.details?.reason === "run_state_changed" &&
      error.details.runId === runId &&
      (await hasStartReceipt())
    )
      return "already_started";

    throw error;
  }
}
