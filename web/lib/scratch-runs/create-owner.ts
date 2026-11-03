import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScratchCreateOwner } from "@/lib/execution-host/create-owner-contract";

import { eq, sql } from "drizzle-orm";

import { lockScratchRunRows } from "./turn-completion";

import { localPackages, runs, scratchRuns } from "@/lib/db/schema";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

export type ScratchSessionCreateOwner = ScratchCreateOwner;

/** A placement owns its pre-incarnation scratch create; no session binding is invented. */
export async function lockScratchCreateOwner(
  tx: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    owner: ScratchSessionCreateOwner;
  }>,
  check: "create" | "ack",
): Promise<boolean> {
  const assignment = await lockCurrentSessionAssignment(tx, input);

  if (!assignment) return false;
  await lockScratchRunRows(tx, input.runId);
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
  const [scratch] = await tx
    .select()
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, input.runId));

  if (
    run?.runKind !== "scratch" ||
    !(
      run.status === "Running" ||
      (check === "ack" && ["NeedsInput", "NeedsInputIdle"].includes(run.status))
    ) ||
    !scratch ||
    ["Done", "Abandoned"].includes(scratch.dialogStatus) ||
    input.owner.scratchRunId !== run.id ||
    input.owner.turnId !== assignment.id ||
    input.owner.promptOrdinal !== 0
  )
    return false;
  if (input.owner.variant === "scratch") return scratch.localPackageId === null;
  if (
    scratch.localPackageId !== input.owner.localPackageId ||
    !scratch.createdByUserId ||
    (run.createdByUserId !== null &&
      run.createdByUserId !== scratch.createdByUserId)
  )
    return false;
  const [pkg] = await tx
    .select({
      id: localPackages.id,
      status: localPackages.status,
      userId: localPackages.lockedByUserId,
      generation: localPackages.lockedBySession,
      live: sql<boolean>`${localPackages.lockExpiresAt} > clock_timestamp()`,
    })
    .from(localPackages)
    .where(eq(localPackages.id, input.owner.localPackageId))
    .for("update");

  return Boolean(
    pkg?.status === "active" &&
    pkg.userId === scratch.createdByUserId &&
    pkg.generation === input.owner.lockGeneration &&
    pkg.live,
  );
}
