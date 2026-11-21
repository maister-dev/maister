import "server-only";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { requireActiveSession, requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runWaits } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

function hiddenWait(): MaisterError {
  return new MaisterError("PRECONDITION", "Wait not found", {
    details: { reason: "wait_not_found" },
  });
}

export async function readWaitForSession(runId: string, waitId: string) {
  const user = await requireActiveSession();
  const [wait] = await getDb()
    .select()
    .from(runWaits)
    .where(and(eq(runWaits.id, waitId), eq(runWaits.runId, runId)));

  if (!wait) throw hiddenWait();

  try {
    const access = await requireProjectActionForUser(
      user.id,
      wait.projectId,
      "readBoard",
    );

    return { wait, access };
  } catch (error: unknown) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw hiddenWait();
    throw error;
  }
}

export async function latestRunWaitId(runId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: runWaits.id })
    .from(runWaits)
    .where(and(eq(runWaits.runId, runId), isNotNull(runWaits.openedAt)))
    .orderBy(desc(runWaits.openedAt), desc(runWaits.id))
    .limit(1);

  return row?.id ?? null;
}
