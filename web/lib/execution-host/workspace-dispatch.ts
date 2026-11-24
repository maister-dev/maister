import "server-only";

import type { Db } from "./db";

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { executionCommands, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

import { defaultTransport } from "./default-transport";
import {
  recoverWorkspaceInputCaptures,
  recoverWorkspaceRequirementProbes,
} from "./workspace-input-recovery";
import { recoverWorkspacePreparation } from "./workspace-prepare-delivery";

/** Drive newly reserved work through its existing ledger claim. Recovery owns any uncertain attempt. */
export async function dispatchQueuedWorkspaceCommand(
  db: Db,
  selector: Readonly<{ runId: string; commandId?: string }>,
): Promise<void> {
  const at = new Date();
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, selector.runId),
        selector.commandId
          ? eq(executionCommands.id, selector.commandId)
          : undefined,
        inArray(executionCommands.kind, [
          "workspace.prepare",
          "workspace.materialize",
          "workspace.run",
          "workspace.cancel",
        ]),
        eq(executionCommands.state, "queued"),
        eq(executionCommands.attempts, 0),
        or(
          isNull(executionCommands.nextAttemptAt),
          lte(executionCommands.nextAttemptAt, at),
        ),
      ),
    )
    .orderBy(asc(executionCommands.createdAt), asc(executionCommands.id))
    .limit(1);
  if (command)
    await recoverWorkspacePreparation(db, command, defaultTransport(), at);
}

/** A board Run stays pending while the canonical receipt opens each preparation phase. */
export async function advanceAddressedWorkspaceAdmission(
  db: Db,
  runId: string,
): Promise<void> {
  const [refused] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .innerJoin(
      runs,
      eq(runs.executionAssignmentId, executionCommands.executionAssignmentId),
    )
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "Pending"),
        eq(executionCommands.runId, runId),
        inArray(executionCommands.kind, [
          "workspace.prepare",
          "workspace.materialize",
          "workspace.run",
        ]),
        eq(executionCommands.state, "failed"),
      ),
    )
    .limit(1);
  if (refused)
    throw new MaisterError(
      "PRECONDITION",
      "The selected supervisor refused workspace preparation",
      {
        details: {
          reason: "workspace_preparation_refused",
          commandId: refused.id,
        },
      },
    );

  const fail = (_runId: string, error: unknown): never => {
    throw error;
  };
  await recoverWorkspaceInputCaptures(db, defaultTransport(), fail, runId);
  await recoverWorkspaceRequirementProbes(db, fail, runId);
  await dispatchQueuedWorkspaceCommand(db, { runId });
}
