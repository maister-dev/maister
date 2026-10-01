import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import { and, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import {
  readScratchPromptIntent,
  scratchOwnerFromIntent,
  findScratchPromptObligation,
} from "./prompt-intent";
import { lockScratchRunRows } from "./turn-completion";
import { sendScratchPromptAndProjectEvents } from "./events";

import { executionCommands, runs, scratchRuns } from "@/lib/db/schema";

const log = pino({
  name: "scratch-dispatch-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Selection is merely a wake. The shared admission callback rechecks the
 * exact snapshot and current generation under the ledger's run lock. */
export async function redriveRunningScratchPrompt(
  db: Db,
  runId: string,
  hosts: ExecutionHosts,
): Promise<void> {
  const intent = await db.transaction(async (tx) => {
    await lockScratchRunRows(tx, runId);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    const [scratch] = await tx
      .select()
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    if (run?.status !== "Running" || scratch?.dialogStatus !== "Running")
      return null;
    if (scratch.activePromptIntent === null) {
      const [pending] = await tx
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
            eq(
              executionCommands.executionAssignmentId,
              run.executionAssignmentId!,
            ),
            notInArray(executionCommands.applicationState, [
              "applied",
              "superseded",
            ]),
          ),
        )
        .limit(1);

      if (pending) return null;
      await tx
        .update(scratchRuns)
        .set({ errorMetadata: { reason: "scratch_dispatch_unknown" } })
        .where(eq(scratchRuns.runId, runId));
      log.warn(
        { runId, assignmentId: run.executionAssignmentId },
        "scratch-dispatch-unknown-delivery",
      );

      return null;
    }
    const frozen = readScratchPromptIntent(scratch.activePromptIntent);

    if (frozen.owner.ref.assignmentId !== run.executionAssignmentId)
      return null;
    const [existing] = await tx
      .select({ id: executionCommands.id })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.prompt"),
          eq(executionCommands.logicalOperationKey, frozen.logicalOperationKey),
        ),
      )
      .limit(1);
    const blocker = await findScratchPromptObligation(tx, frozen);

    if (existing || blocker) {
      log.debug(
        {
          runId,
          commandId: existing?.id ?? blocker,
          operationKey: frozen.logicalOperationKey,
        },
        "scratch-dispatch-ledger-owned",
      );

      return null;
    }

    return frozen;
  });

  if (!intent) return;
  const execution = await hosts.executionFor(runId, {
    assignmentId: intent.owner.ref.assignmentId,
  });

  log.info(
    {
      runId,
      operationKey: intent.logicalOperationKey,
      variant: intent.owner.ref.variant,
      incarnationId: intent.owner.ref.incarnationId,
    },
    "scratch-dispatch-redriven",
  );
  await sendScratchPromptAndProjectEvents({
    db,
    runId,
    sessionId: intent.hostSessionId,
    ...intent.payload,
    execution,
    owner: scratchOwnerFromIntent(intent),
  });
  if ("localPackageId" in intent.owner.ref) {
    const { postProcessRecoveredPackageTurn } = await import("./service");

    await postProcessRecoveredPackageTurn(db, runId, intent.owner.ref);
  }
}
