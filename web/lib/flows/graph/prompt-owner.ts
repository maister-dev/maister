import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { GateVerdict, GateResult } from "@/lib/db/schema";
import type { GateDef } from "@/lib/config.schema";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { compileManifest } from "./compile";
import { loadRun } from "./runner-core";
import {
  appendGateOutput,
  emptyGateOutput,
  calibrateVerdict,
  isPassVerdict,
} from "./gate-verdict";
import { createGateResult, markGateFailed, markGatePassed } from "./gate-store";
import { lockFlowPromptOwner } from "./prompt-owner-authority";
import { prepareNodePrompt } from "./node-prompt-owner";

import {
  gateResults,
  executionCommands,
  nodeAttempts,
  runs,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";

export type GatePromptOwner = Readonly<{
  variant: "gate_skill" | "gate_ai";
  nodeAttemptId: string;
  gateId: string;
  evaluationId: string;
}>;

/** A persisted command still owns the work. Only its application worker may
 * resolve it; an unavailable reader must not manufacture a failed gate.
 */
export class FlowPromptContinuationPending extends MaisterError {
  constructor(commandId: string, cause: unknown) {
    super("PRECONDITION", "Flow prompt awaits durable owner application", {
      details: { reason: "flow_prompt_continuation_pending", commandId },
      ...(cause instanceof Error ? { cause } : {}),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function gatePromptOperationKey(owner: GatePromptOwner): string {
  return `flow_node_attempt:${owner.variant}:${owner.evaluationId}:0`;
}

export async function waitForGateApplication(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.waitForPrompt(
      { commandId },
      { owners: flowPromptOwners, signal },
    );
  } catch (cause) {
    // A failed host turn can already have applied its failed gate verdict.
    // The caller consumes that domain row, never the transport exception.
    try {
      const [command] = await db
        .select({ applicationState: executionCommands.applicationState })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId));

      if (command?.applicationState === "applied") return;
    } catch (readCause) {
      throw new FlowPromptContinuationPending(commandId, readCause);
    }
    throw new FlowPromptContinuationPending(commandId, cause);
  }
}

const log = pino({
  name: "flow-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Re-entering the same attempt reuses its evaluation. Only an explicitly stale
 * evaluation admits a replacement; a restart is not a new paid gate check.
 */
export async function getOrCreateGateEvaluation(
  db: Db,
  input: { runId: string; nodeAttemptId: string; gate: GateDef },
): Promise<GateResult & { commandId?: string }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update")
      .limit(1);

    if (
      !run ||
      run.runKind !== "flow" ||
      !["Running", "NeedsInput"].includes(run.status) ||
      !attempt ||
      attempt.runId !== input.runId ||
      run.currentStepId !== attempt.nodeId ||
      !["Running", "Succeeded"].includes(attempt.status)
    )
      throw new PromptOwnerInvariantError("gate_evaluation_attempt");
    const [existing] = await tx
      .select()
      .from(gateResults)
      .where(
        and(
          eq(gateResults.runId, input.runId),
          eq(gateResults.nodeAttemptId, input.nodeAttemptId),
          eq(gateResults.gateId, input.gate.id),
        ),
      )
      .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
      .limit(1);

    if (existing && existing.kind !== input.gate.kind)
      throw new PromptOwnerInvariantError("gate_evaluation_kind");
    if (existing && existing.status !== "stale") {
      const [command] = await tx
        .select({
          id: executionCommands.id,
          assignmentId: executionCommands.executionAssignmentId,
        })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, run.id),
            eq(
              executionCommands.logicalOperationKey,
              gatePromptOperationKey({
                variant:
                  input.gate.kind === "skill_check" ? "gate_skill" : "gate_ai",
                nodeAttemptId: attempt.id,
                gateId: existing.gateId,
                evaluationId: existing.id,
              }),
            ),
          ),
        )
        .limit(1);

      if (
        command &&
        !(await lockCurrentSessionAssignment(tx, {
          runId: run.id,
          assignmentId: command.assignmentId,
        }))
      )
        throw staleSessionBinding(run.id, command.assignmentId);

      if (run.status === "NeedsInput" && !command)
        throw new PromptOwnerInvariantError("gate_permission_command_missing");

      return { ...existing, ...(command ? { commandId: command.id } : {}) };
    }
    if (run.status !== "Running")
      throw new PromptOwnerInvariantError("gate_permission_new_evaluation");
    const { id } = await createGateResult({
      runId: input.runId,
      nodeAttemptId: input.nodeAttemptId,
      gateId: input.gate.id,
      kind: input.gate.kind,
      mode: input.gate.mode,
      inputArtifactRefs: input.gate.inputArtifacts,
      status: "running",
      db: tx,
    });
    const [created] = await tx
      .select()
      .from(gateResults)
      .where(eq(gateResults.id, id));

    return created;
  });
}

/** The create ACK can precede lifecycle projection. Wait for its exact durable
 * incarnation before admitting a v2 prompt; never guess the latest session.
 */
export async function waitForPromptIncarnation(
  db: Db,
  client: BoundClient,
  hostSessionId: string,
): Promise<void> {
  const deadline = performance.now() + 30_000;

  while (performance.now() < deadline) {
    const [incarnation] = await db
      .select({ state: runSessionIncarnations.state })
      .from(runSessionIncarnations)
      .where(
        and(
          eq(runSessionIncarnations.executionHostId, client.host.id),
          eq(runSessionIncarnations.hostSessionId, hostSessionId),
          eq(
            runSessionIncarnations.executionAssignmentId,
            client.assignment.id,
          ),
        ),
      )
      .limit(1);

    if (incarnation?.state === "active") return;
    if (incarnation)
      throw staleSessionBinding(client.assignment.runId, client.assignment.id);
    await runEventWakeBus.wait(
      client.assignment.runId,
      Math.min(250, deadline - performance.now()),
    );
  }
  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "session incarnation projection is not ready for prompt admission",
    {
      details: {
        reason: "prompt_incarnation_pending",
        runId: client.assignment.runId,
        assignmentId: client.assignment.id,
      },
    },
  );
}

export async function admitGatePrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: GatePromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, owner.nodeAttemptId))
    .for("update")
    .limit(1);
  const [evaluation] = await tx
    .select()
    .from(gateResults)
    .where(eq(gateResults.id, owner.evaluationId))
    .for("update")
    .limit(1);

  if (
    run?.runKind !== "flow" ||
    run.status !== "Running" ||
    !attempt ||
    attempt.runId !== runId ||
    attempt.executionAssignmentId !== assignment.id ||
    run.currentStepId !== attempt.nodeId ||
    !["Running", "Succeeded"].includes(attempt.status) ||
    !evaluation ||
    evaluation.runId !== runId ||
    evaluation.nodeAttemptId !== attempt.id ||
    evaluation.gateId !== owner.gateId ||
    evaluation.kind !==
      (owner.variant === "gate_skill" ? "skill_check" : "ai_judgment") ||
    evaluation.status !== "running"
  )
    throw new PromptOwnerInvariantError("gate_admission_generation");
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
    throw new PromptOwnerInvariantError("gate_admission_incarnation");

  return {
    owner: {
      kind: "flow_node_attempt",
      ref: {
        version: 1,
        ...owner,
        runId,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        promptOrdinal: 0,
      },
    },
    logicalOperationKey: gatePromptOperationKey(owner),
  };
}

/** Gate evidence is decoded outside the application transaction. The immutable
 * command retains the complete output; the domain stores its verdict once.
 */
export const flowPromptOwnerAdapter = definePromptOwnerAdapter(
  "flow_node_attempt",
  async ({ db, owner, command, outcome }) => {
    const ref = owner.ref;

    if (ref.variant === "node" || ref.variant === "permission_resume")
      return prepareNodePrompt({ db, ref, command, outcome });

    if (ref.variant !== "gate_ai" && ref.variant !== "gate_skill")
      throw new PromptOwnerInvariantError("flow_owner_variant_unimplemented");
    const loaded = await loadRun(db, ref.runId);
    const [attempt] = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, ref.nodeAttemptId))
      .limit(1);

    if (!attempt || attempt.runId !== ref.runId)
      throw new PromptOwnerInvariantError("gate_owner_attempt_missing");
    const node = compileManifest(loaded.manifest).nodes.get(attempt.nodeId);
    const gate = node?.gates.find((candidate) => candidate.id === ref.gateId);

    if (
      !node ||
      !gate ||
      gate.kind !==
        (ref.variant === "gate_skill" ? "skill_check" : "ai_judgment")
    )
      throw new PromptOwnerInvariantError("gate_owner_definition_missing");

    let output = emptyGateOutput();

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
          typeof content === "object" &&
          content !== null &&
          "type" in content &&
          content.type === "text" &&
          "text" in content &&
          typeof content.text === "string"
        )
          output = appendGateOutput(output, content.text);
      }
    }
    const parsed =
      outcome.state === "succeeded" &&
      outcome.response.stopReason === "end_turn"
        ? output.verdict
        : null;
    let verdict: GateVerdict = parsed ?? {
      verdict: "unparseable",
      reasons: [output.evidence],
    };
    let passed = parsed !== null && node.decide?.from === "verdict";

    if (parsed && !passed && isPassVerdict(parsed.verdict ?? "")) {
      const calibrated = calibrateVerdict(parsed, gate.calibration);

      passed = calibrated.pass;
      if (calibrated.calibration)
        verdict = { ...parsed, calibration: calibrated.calibration };
    }

    return {
      apply: async (tx) => {
        if (!(await lockFlowPromptOwner(tx, ref, command.targetSessionId)))
          return "superseded";
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, ref.runId))
          .limit(1);
        const [currentAttempt] = await tx
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, ref.nodeAttemptId))
          .for("update")
          .limit(1);
        const [evaluation] = await tx
          .select()
          .from(gateResults)
          .where(eq(gateResults.id, ref.evaluationId))
          .for("update")
          .limit(1);

        if (!currentAttempt || !evaluation) return "superseded";
        if (
          run?.runKind !== "flow" ||
          !["Running", "NeedsInput"].includes(run.status) ||
          run.currentStepId !== currentAttempt.nodeId ||
          run.flowRevisionId !== loaded.run.flowRevisionId ||
          currentAttempt.runId !== ref.runId ||
          currentAttempt.executionAssignmentId !== ref.assignmentId ||
          !["Running", "Succeeded"].includes(currentAttempt.status) ||
          evaluation.runId !== ref.runId ||
          evaluation.nodeAttemptId !== currentAttempt.id ||
          evaluation.gateId !== ref.gateId ||
          evaluation.kind !== gate.kind ||
          evaluation.status !== "running"
        )
          return "superseded";
        if (passed) await markGatePassed(evaluation.id, verdict, tx);
        else await markGateFailed(evaluation.id, verdict, tx);
        log.info(
          {
            runId: ref.runId,
            nodeAttemptId: ref.nodeAttemptId,
            gateId: ref.gateId,
            evaluationId: ref.evaluationId,
            commandId: command.id,
            status: passed ? "passed" : "failed",
          },
          "owned-gate-result-applied",
        );

        return "applied";
      },
    };
  },
);

export const flowPromptOwners = createPromptOwnerRegistry([
  flowPromptOwnerAdapter,
]);
