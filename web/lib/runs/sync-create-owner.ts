import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SyncCreateOwner } from "@/lib/execution-host/create-owner-contract";

import { eq } from "drizzle-orm";

import { runSyncAttempts, runs, workspaces } from "@/lib/db/schema";

/** A resolver create belongs to the existing sync attempt and lifecycle claim. */
export async function lockSyncCreateOwner(
  tx: Db,
  input: Readonly<{ runId: string; owner: SyncCreateOwner }>,
): Promise<boolean> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
  const [attempt] = await tx
    .select()
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.id, input.owner.syncAttemptId))
    .for("update");
  const [workspace] = attempt
    ? await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, attempt.workspaceId))
        .for("update")
    : [];

  return (
    (run?.status === "Running" || run?.status === "NeedsInput") &&
    attempt?.runId === run.id &&
    attempt.mode === "agent" &&
    attempt.phase === "agent_running" &&
    input.owner.promptOrdinal === 0 &&
    workspace?.runId === run.id &&
    workspace.lifecycleOperationName === "sync" &&
    workspace.lifecycleOperationAttemptId === input.owner.operationAttemptId
  );
}
