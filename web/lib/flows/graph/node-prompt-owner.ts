import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { ExecutionCommand } from "@/lib/db/schema";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
} from "@/lib/execution-host/prompt-owners";
import type { FlowOwnerRef } from "./prompt-owner-authority";
import type { FlowActionCompletion } from "./action-completion";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { lockFlowPromptOwner } from "./prompt-owner-authority";
import {
  appendSentinelOutput,
  emptySentinelOutput,
  finishSentinelOutput,
} from "./node-output-stream";

import {
  nodeAttempts,
  runSessionIncarnations,
  runSessions,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { appendCapped } from "@/lib/flows/capped-text";
import { isMaisterErrorCode } from "@/lib/errors-core";
import { nodeOutputMaxBytes } from "@/lib/instance-config";

export type NodePromptOwner = Readonly<{
  nodeAttemptId: string;
  promptOrdinal: number;
}> &
  (
    | Readonly<{ variant: "node" }>
    | Readonly<{
        variant: "permission_resume";
        hitlRequestId: string;
      }>
  );

const log = pino({
  name: "flow-node-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

export function nodePromptOperationKey(owner: NodePromptOwner): string {
  return `flow_node_attempt:${owner.variant}:${owner.nodeAttemptId}:${owner.promptOrdinal}`;
}

export async function admitNodePrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: NodePromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, owner.nodeAttemptId))
    .for("update");
  const resume = attempt?.actionResume;
  const permissionResume =
    resume?.kind === "permission" &&
    resume.assignmentId === assignment.id &&
    resume.promptOrdinal === owner.promptOrdinal
      ? resume
      : null;

  if (
    run?.runKind !== "flow" ||
    !(
      run.status === "Running" ||
      (run.status === "NeedsInput" && permissionResume)
    ) ||
    !attempt ||
    attempt.runId !== runId ||
    attempt.executionAssignmentId !== assignment.id ||
    !["ai_coding", "judge", "orchestrator"].includes(attempt.nodeType) ||
    attempt.status !== "Running" ||
    run.currentStepId !== attempt.nodeId ||
    attempt.actionPromptOrdinal !== owner.promptOrdinal ||
    attempt.actionCompletion !== null ||
    (owner.variant === "permission_resume"
      ? permissionResume?.hitlRequestId !== owner.hitlRequestId
      : permissionResume !== null)
  )
    throw new PromptOwnerInvariantError("node_admission_generation");
  const [binding] = await tx
    .select({ session: runSessions, incarnation: runSessionIncarnations })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.runId, runId),
        eq(runSessions.executionAssignmentId, assignment.id),
        eq(runSessions.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.executionHostId, client.host.id),
        eq(runSessionIncarnations.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("node_admission_incarnation");

  return {
    owner: {
      kind: "flow_node_attempt",
      ref: {
        version: 1,
        nodeAttemptId: owner.nodeAttemptId,
        promptOrdinal: owner.promptOrdinal,
        ...(permissionResume
          ? {
              variant: "permission_resume" as const,
              hitlRequestId: permissionResume.hitlRequestId,
            }
          : { variant: "node" as const }),
        runId,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
      },
    },
    logicalOperationKey: nodePromptOperationKey(owner),
  };
}

export async function prepareNodePrompt(input: {
  db: Db;
  ref: Extract<FlowOwnerRef, { variant: "node" | "permission_resume" }>;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { db, ref, command, outcome } = input;
  const [originalRun] = await db
    .select({ flowRevisionId: runs.flowRevisionId, runKind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, ref.runId));

  if (originalRun?.runKind !== "flow")
    throw new PromptOwnerInvariantError("node_owner_run_missing");
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, ref.incarnationId));

  if (!incarnation)
    throw new PromptOwnerInvariantError("node_owner_incarnation_missing");
  const maxBytes = nodeOutputMaxBytes();
  let stdout = "";
  let sentinel = emptySentinelOutput();

  if (outcome.state === "succeeded") {
    for await (const event of outcome.events) {
      const update = event.payload?.update;

      if (
        event.eventType !== "session.update" ||
        typeof update !== "object" ||
        update === null ||
        !("sessionUpdate" in update) ||
        update.sessionUpdate !== "agent_message_chunk" ||
        !("content" in update)
      )
        continue;
      const content = update.content;

      if (
        typeof content !== "object" ||
        content === null ||
        !("type" in content) ||
        content.type !== "text" ||
        !("text" in content) ||
        typeof content.text !== "string"
      )
        continue;
      stdout = appendCapped(stdout, content.text, 1_048_576);
      sentinel = appendSentinelOutput(sentinel, content.text, maxBytes);
    }
  }
  const ok =
    outcome.state === "succeeded" && outcome.response.stopReason === "end_turn";
  const errorCode =
    outcome.state === "succeeded" ? "ACP_PROTOCOL" : outcome.error.code;

  if (!ok && !isMaisterErrorCode(errorCode))
    throw new PromptOwnerInvariantError("node_terminal_error_code");
  const completion: FlowActionCompletion = {
    version: 1,
    commandId: command.id,
    promptOrdinal: ref.promptOrdinal,
    result: {
      ok,
      stdout,
      vars: {},
      ...(incarnation.acpSessionId
        ? { acpSessionId: incarnation.acpSessionId }
        : {}),
      ...(!ok && isMaisterErrorCode(errorCode) ? { errorCode } : {}),
    },
    originalOutput: finishSentinelOutput(sentinel, maxBytes),
  };

  return {
    apply: async (tx) => {
      if (!(await lockFlowPromptOwner(tx, ref, command.targetSessionId)))
        return "superseded";
      const [run] = await tx.select().from(runs).where(eq(runs.id, ref.runId));
      const [attempt] = await tx
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.id, ref.nodeAttemptId))
        .for("update");

      if (
        !attempt ||
        run?.runKind !== "flow" ||
        !["Running", "NeedsInput"].includes(run.status) ||
        run.flowRevisionId !== originalRun.flowRevisionId ||
        !["ai_coding", "judge", "orchestrator"].includes(attempt.nodeType) ||
        run.currentStepId !== attempt.nodeId ||
        attempt.runId !== ref.runId ||
        attempt.executionAssignmentId !== ref.assignmentId ||
        !["Running", "NeedsInput"].includes(attempt.status) ||
        attempt.actionPromptOrdinal !== ref.promptOrdinal ||
        attempt.actionCompletion !== null
      )
        return "superseded";
      await tx
        .update(nodeAttempts)
        .set({ actionCompletion: completion })
        .where(eq(nodeAttempts.id, attempt.id));
      log.info(
        {
          runId: ref.runId,
          nodeAttemptId: ref.nodeAttemptId,
          commandId: command.id,
          promptOrdinal: ref.promptOrdinal,
          ok,
        },
        "node-action-output-applied",
      );

      return "applied";
    },
  };
}
