import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionCommand,
  GateResult,
  NodeAttempt,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { TURN_LOST_DECISION } from "./attempt-decisions";
import { appendNodeAttempt } from "./ledger";

import {
  executionCommands,
  gateResults,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { gateParentActionDigest } from "@/lib/execution-host/permission-handoff-source";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

const log = pino({
  name: "flow-gate-crash-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

export type GateCrashRecoveryWitness = Readonly<{
  sourceAttempt: NodeAttempt;
  evaluation: GateResult;
  command: ExecutionCommand;
  continuationAttempt: NodeAttempt | null;
}>;

/** A closed gate park is recoverable only when the action, gate, command and
 * crashed incarnation still agree. The attempt decision is the durable record
 * that the owner classified the failure as a child crash rather than a task
 * failure or an intentional checkpoint. */
export async function loadGateCrashRecoveryWitness(
  db: Db,
  input: Readonly<{
    runId: string;
    nodeId: string | null;
    assignmentId?: string | null;
  }>,
): Promise<GateCrashRecoveryWitness | null> {
  if (!input.nodeId) return null;
  const attempts = await db
    .select()
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(2);
  const continuationAttempt =
    attempts[0]?.status === "Reworked" ? null : (attempts[0] ?? null);
  const sourceAttempt = continuationAttempt ? attempts[1] : attempts[0];

  if (
    !sourceAttempt ||
    sourceAttempt.status !== "Reworked" ||
    sourceAttempt.decision !== TURN_LOST_DECISION ||
    sourceAttempt.errorCode !== "CRASH" ||
    sourceAttempt.endedAt === null ||
    sourceAttempt.actionCompletion?.result.ok !== true ||
    !gateParentActionDigest(sourceAttempt.actionCompletion)
  )
    return null;

  if (
    continuationAttempt &&
    (continuationAttempt.attempt !== sourceAttempt.attempt + 1 ||
      !["Pending", "Running", "NeedsInput"].includes(
        continuationAttempt.status,
      ) ||
      continuationAttempt.endedAt !== null ||
      continuationAttempt.executionAssignmentId !== input.assignmentId ||
      gateParentActionDigest(continuationAttempt.actionCompletion) !==
        gateParentActionDigest(sourceAttempt.actionCompletion))
  )
    return null;

  const evaluations = await db
    .select()
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, input.runId),
        eq(gateResults.nodeAttemptId, sourceAttempt.id),
        eq(gateResults.status, "stale"),
      ),
    );
  const crashed = evaluations.filter(
    (evaluation) =>
      evaluation.kind === "ai_judgment" || evaluation.kind === "skill_check",
  );

  if (crashed.length !== 1) return null;
  const evaluation = crashed[0];
  const sourceGates = await db
    .select({ id: gateResults.id, status: gateResults.status })
    .from(gateResults)
    .where(eq(gateResults.nodeAttemptId, sourceAttempt.id));

  if (
    sourceGates.some(
      (gate) =>
        gate.id !== evaluation.id &&
        !["passed", "failed", "skipped", "overridden"].includes(gate.status),
    )
  )
    return null;
  const commands = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.kind, "session.prompt"),
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${sourceAttempt.id}`,
        sql`${executionCommands.ownerRef}->>'evaluationId' = ${evaluation.id}`,
        sql`${executionCommands.ownerRef}->>'promptOrdinal' = ${String(evaluation.promptOrdinal)}`,
      ),
    );

  if (commands.length !== 1) return null;
  const command = commands[0];
  const ref = command.ownerRef;

  // Reattachment can close the attempt before the application worker gets
  // its turn. That worker later marks the old command superseded; neither
  // state weakens the already-committed crash boundary on the source attempt.
  if (
    !ref ||
    (ref.variant !== "gate_ai" && ref.variant !== "gate_skill") ||
    ref.gateId !== evaluation.gateId ||
    command.state !== "failed" ||
    !["applied", "pending", "superseded"].includes(command.applicationState) ||
    !command.terminalEventId ||
    !command.targetSessionId ||
    !ref.incarnationId
  )
    return null;

  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, ref.incarnationId));

  if (
    !incarnation ||
    incarnation.runId !== input.runId ||
    incarnation.state !== "crashed" ||
    incarnation.executionAssignmentId !== command.executionAssignmentId ||
    incarnation.hostSessionId !== command.targetSessionId
  )
    return null;

  return { sourceAttempt, evaluation, command, continuationAttempt };
}

/** The run row is locked before this function is called. Admission and the
 * action-copy happen in the same transaction, so a process death leaves a
 * continuation attempt that the ordinary graph worker can re-enter. */
export async function authorizeGateCrashRecovery(
  tx: Db,
  input: Readonly<{ runId: string; nodeId: string; assignmentId: string }>,
): Promise<string> {
  const [run] = await tx
    .select({ status: runs.status, assignmentId: runs.executionAssignmentId })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .for("update");
  const witness = await loadGateCrashRecoveryWitness(tx, input);

  if (
    run?.status !== "Running" ||
    run.assignmentId !== input.assignmentId ||
    !witness
  )
    throw new PromptOwnerInvariantError("gate_crash_recovery_witness_missing");
  if (witness.continuationAttempt) return witness.continuationAttempt.id;

  const appended = await appendNodeAttempt({
    runId: input.runId,
    nodeId: input.nodeId,
    nodeType: witness.sourceAttempt.nodeType,
    executionAssignmentId: input.assignmentId,
    db: tx,
  });

  await tx
    .update(nodeAttempts)
    .set({
      actionPromptOrdinal: witness.sourceAttempt.actionPromptOrdinal,
      actionCompletion: witness.sourceAttempt.actionCompletion,
    })
    .where(eq(nodeAttempts.id, appended.id));
  const inheritedGates = await tx
    .select()
    .from(gateResults)
    .where(eq(gateResults.nodeAttemptId, witness.sourceAttempt.id));

  for (const gate of inheritedGates) {
    if (gate.id === witness.evaluation.id) continue;
    await tx.insert(gateResults).values({
      id: randomUUID(),
      runId: input.runId,
      nodeAttemptId: appended.id,
      gateId: gate.gateId,
      kind: gate.kind,
      mode: gate.mode,
      status: gate.status,
      promptOrdinal: gate.promptOrdinal,
      permissionResume: gate.permissionResume,
      verdict: gate.verdict,
      inputArtifactRefs: gate.inputArtifactRefs,
      outputArtifactRef: gate.outputArtifactRef,
      staleFrom: gate.staleFrom,
      overriddenBy: gate.overriddenBy,
      endedAt: gate.endedAt,
    });
  }
  log.info(
    {
      runId: input.runId,
      nodeAttemptId: appended.id,
      sourceAttemptId: witness.sourceAttempt.id,
      evaluationId: witness.evaluation.id,
      commandId: witness.command.id,
      assignmentId: input.assignmentId,
      inheritedGateCount: inheritedGates.length - 1,
    },
    "gate-crash-recovery-authorized",
  );

  return appended.id;
}
