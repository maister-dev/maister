import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
  PromptOwnerRegistry,
} from "@/lib/execution-host/prompt-owners";
import type { LibrarianTurnEnd } from "./turn-end";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import {
  afterLibrarianTurnFinished,
  finishLibrarianTurnInTransaction,
  type LibrarianTurnFinish,
} from "./turn-end";

import {
  librarianTurns,
  runSessionIncarnations,
  runSessions,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";
import {
  ADMISSIBLE_PROMPT_INCARNATION_STATES,
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { agentMessageText } from "@/lib/run-transcript/agent-text";

const log = pino({
  name: "librarian.prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

type LibrarianRef = Extract<PromptOwner, { kind: "librarian_turn" }>["ref"];
export type LibrarianPromptVariant = LibrarianRef["variant"];

// The reply a model gives is text; this bound keeps one runaway reply from
// becoming an unbounded row.
export const LIBRARIAN_REPLY_MAX_CHARS = 60_000;

export function librarianPromptOperationKey(
  variant: LibrarianPromptVariant,
  assignmentId: string,
  promptOrdinal: number,
): string {
  return `librarian_turn:${variant}:${assignmentId}:${promptOrdinal}`;
}

/** ADR-167 S2.12: the turn's prompt is admitted only while its assignment is
 * current, the run is `Running`, the turn is `running` and the session is this
 * assignment's live incarnation. */
export async function admitLibrarianPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  input: { turnId: string; variant: LibrarianPromptVariant },
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx
    .select({ runKind: runs.runKind, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));
  const [turn] = await tx
    .select({ status: librarianTurns.status })
    .from(librarianTurns)
    .where(eq(librarianTurns.id, input.turnId))
    .for("update");

  if (
    run?.runKind !== "librarian" ||
    run.status !== "Running" ||
    turn?.status !== "running"
  )
    throw new PromptOwnerInvariantError("librarian_admission_turn");
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
        inArray(runSessionIncarnations.state, [
          ...ADMISSIBLE_PROMPT_INCARNATION_STATES,
        ]),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("librarian_admission_incarnation");
  const ref: LibrarianRef = {
    version: 1,
    variant: input.variant,
    runId,
    runSessionId: binding.session.id,
    incarnationId: binding.incarnation.id,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    turnId: input.turnId,
    promptOrdinal: 0,
  };

  return {
    owner: { kind: "librarian_turn", ref },
    logicalOperationKey: librarianPromptOperationKey(
      input.variant,
      assignment.id,
      0,
    ),
  };
}

/** Reads the turn's reply and whether the supervisor halted the session. */
async function readTurnOutcome(
  outcome: PromptOwnerOutcome,
): Promise<LibrarianTurnEnd> {
  // Every failure the host reports — a lost turn, a crashed adapter — ends the
  // turn the same way for the owner: the host lost it (D19's closed reasons).
  if (outcome.state === "failed")
    return { status: "failed", reason: "host_lost" };
  if (outcome.state !== "succeeded") return { status: "stopped" };
  let reply = "";
  let halted = false;

  for await (const event of outcome.events) {
    if (
      event.eventType === "session.hook_trip" &&
      event.payload?.disposition === "halt"
    )
      halted = true;
    if (event.eventType !== "session.update") continue;
    const text = agentMessageText(event.payload?.update);

    if (text !== null && reply.length < LIBRARIAN_REPLY_MAX_CHARS)
      reply += text;
  }
  // D5: a guard halt fails the turn — never a HITL row; the run has no inbox.
  if (halted) return { status: "failed", reason: "capability_trip" };
  if (outcome.response.stopReason === "cancelled") return { status: "stopped" };

  return {
    status: "completed",
    reply: reply.slice(0, LIBRARIAN_REPLY_MAX_CHARS).trim() || "…",
  };
}

/** The turn's session is closed as soon as its one prompt settles; the next
 * turn resumes the ACP context in a fresh process (D3). Best-effort: a close
 * that fails leaves a process the supervisor reaps, never a wrong answer. */
async function closeTurnSession(
  db: Db,
  ref: LibrarianRef,
  hostSessionId: string | null,
): Promise<void> {
  if (!hostSessionId) return;
  const [run] = await db
    .select({ assignmentId: runs.executionAssignmentId })
    .from(runs)
    .where(eq(runs.id, ref.runId));

  if (run?.assignmentId !== ref.assignmentId) return;
  try {
    const client = await createExecutionHosts({ db }).forAssignment({
      id: ref.assignmentId,
    });

    await client.deleteSession(hostSessionId);
  } catch (err) {
    log.warn(
      {
        runId: ref.runId,
        turnId: ref.turnId,
        err: err instanceof Error ? err.message : String(err),
      },
      "librarian turn session close failed",
    );
  }
}

export async function prepareLibrarianPrompt(input: {
  db: Db;
  ref: LibrarianRef;
  hostSessionId: string | null;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { db, ref, outcome } = input;

  // A fenced prompt belongs to a newer generation: this turn has already been
  // ended by whichever path superseded it.
  if (outcome.state === "fenced")
    return { apply: async () => "superseded" as const };
  const end = await readTurnOutcome(outcome);

  await closeTurnSession(db, ref, input.hostSessionId);
  let finish: LibrarianTurnFinish | null = null;

  return {
    apply: async (tx) => {
      finish = await finishLibrarianTurnInTransaction(tx, {
        turnId: ref.turnId,
        end,
      });

      return finish ? "applied" : "superseded";
    },
    afterCommit: () => afterLibrarianTurnFinished(db, finish),
  };
}

export const librarianPromptOwners: PromptOwnerRegistry =
  createPromptOwnerRegistry([
    definePromptOwnerAdapter("librarian_turn", async (context) =>
      prepareLibrarianPrompt({
        db: context.db,
        ref: context.owner.ref,
        hostSessionId: context.command.targetSessionId,
        outcome: context.outcome,
      }),
    ),
  ]);
