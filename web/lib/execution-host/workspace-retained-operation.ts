import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { getCommand } from "./commands";
import { defaultTransport } from "./default-transport";
import { runEventWakeBus } from "./events/run-wake";
import {
  isAddressedRetainedWorkspaceCommand,
  recoverWorkspacePreparation,
} from "./workspace-prepare-delivery";

import { MaisterError } from "@/lib/errors";

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
  if (command.state === "queued" && command.attempts === 0)
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
    if (
      observed?.transportState === "reconciliation_required" ||
      observed?.state === "fenced"
    )
      break;
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
