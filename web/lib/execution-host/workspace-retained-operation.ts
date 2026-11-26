import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getCommand } from "./commands";
import { defaultTransport } from "./default-transport";
import { runEventWakeBus } from "./events/run-wake";
import {
  isAddressedRetainedWorkspaceCommand,
  recoverWorkspacePreparation,
} from "./workspace-prepare-delivery";

import { MaisterError } from "@/lib/errors";
import { executionCommands } from "@/lib/db/schema";

/** The workspace row must be locked before calculating the next retained fence. */
export async function nextRetainedWorkspaceFence(
  db: Db,
  hostId: string,
  handle: string,
): Promise<number> {
  const [row] = await db
    .select({
      fence: sql<
        string | null
      >`max((${executionCommands.payload}->>'fence')::bigint)`,
    })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.executionHostId, hostId),
        eq(executionCommands.targetSessionId, handle),
        inArray(executionCommands.kind, [
          "workspace.sync",
          "workspace.publish",
          "workspace.preserve",
        ]),
      ),
    );
  const highest = Number(row?.fence ?? 0);
  if (!Number.isSafeInteger(highest + 1) || highest < 0)
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The retained workspace fence is invalid",
    );

  return highest + 1;
}

/** Wait for the canonical result while the original command remains recoverable. */
export async function settleRetainedWorkspaceCommand(
  db: Db,
  command: ExecutionCommand,
): Promise<ExecutionCommand> {
  if (!isAddressedRetainedWorkspaceCommand(command))
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Expected a retained workspace command",
    );
  if ((command.state === "queued" && command.attempts === 0) ||
    command.transportState === "reconciliation_required")
    await recoverWorkspacePreparation(
      db,
      command,
      defaultTransport(),
      new Date(),
    );

  const deadline = AbortSignal.timeout(20_000);
  while (!deadline.aborted) {
    const observed = await getCommand(db, command.id);
    if (observed?.state === "succeeded" || observed?.state === "failed")
      return observed;
    if (observed?.state === "fenced") break;
    await runEventWakeBus.wait(command.runId, 500, deadline);
  }
  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "The original supervisor has not confirmed the workspace operation",
    {
      details: { reason: "effect_unconfirmed", commandId: command.id },
    },
  );
}
