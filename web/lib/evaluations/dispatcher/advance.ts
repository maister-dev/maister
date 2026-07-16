import "server-only";

import type { EvaluationExecutionStatus } from "@/lib/evaluations/types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { appendEvaluationEvent } from "./events";
import { assertTransition, eventTypeForTransition } from "./fsm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const { evaluationExecutions } = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-advance",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface AdvanceArgs {
  studyId: string;
  executionId: string;
  from: EvaluationExecutionStatus;
  to: EvaluationExecutionStatus;
  expectedVersion: number;
  // Extra columns to write atomically with the terminal/step transition
  // (terminalReason, snapshot ids, seed) — never a separate post-transition
  // UPDATE (no write is sequenced after a terminal flip).
  patch?: Record<string, unknown>;
  // Bounded event payload (ids/status/counts only).
  payload?: Record<string, unknown>;
}

// Intent-first CAS state advance (D4/D17): the transition is claimed with an
// exact-value CAS on (status, version); the loser gets a mapped CONFLICT (409),
// never a raw unique/version error. The durable event is appended in the SAME
// transaction as the state change (exactly-once, replayable). Returns the new
// version + emitted sequence.
export async function advanceExecution(
  args: AdvanceArgs,
  db?: Db,
): Promise<{ version: number; sequence: number }> {
  const d = db ?? getDb();

  assertTransition(args.from, args.to);

  return d.transaction(async (tx: Db) => {
    const updated = await tx
      .update(evaluationExecutions)
      .set({
        status: args.to,
        version: args.expectedVersion + 1,
        ...(args.patch ?? {}),
        ...(isTerminal(args.to) ? { terminalAt: new Date() } : {}),
        ...(args.to === "capturing" ? { startedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(evaluationExecutions.id, args.executionId),
          eq(evaluationExecutions.status, args.from),
          eq(evaluationExecutions.version, args.expectedVersion),
        ),
      )
      .returning({ version: evaluationExecutions.version });

    if (updated.length === 0) {
      // Distinguish a missing row from a lost CAS race for an actionable code.
      const [exists] = await tx
        .select({ status: evaluationExecutions.status })
        .from(evaluationExecutions)
        .where(eq(evaluationExecutions.id, args.executionId));

      if (!exists) {
        throw new MaisterError(
          "PRECONDITION",
          `evaluation execution not found: ${args.executionId}`,
        );
      }

      throw new MaisterError(
        "CONFLICT",
        `evaluation execution ${args.executionId} is ${exists.status}, not ${args.from}@v${args.expectedVersion}`,
      );
    }

    const { sequence } = await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      executionId: args.executionId,
      eventType: eventTypeForTransition(args.from, args.to),
      payload: args.payload,
    });

    log.info(
      {
        executionId: args.executionId,
        from: args.from,
        to: args.to,
        version: updated[0].version,
        sequence,
      },
      "evaluation execution advanced",
    );

    return { version: updated[0].version, sequence };
  });
}

function isTerminal(status: EvaluationExecutionStatus): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled"
  );
}

// A retry never re-enters a terminal row — it creates a NEW execution with
// retry_of lineage starting at queued (D4). This inserts the successor and emits
// the queued event; the caller re-resolves the effective profile for the new row.
export async function createRetryExecution(
  args: {
    studyId: string;
    retryOf: string;
    methodRevisionId?: string | null;
    effectiveProfileSnapshot?: Record<string, unknown> | null;
    requestedByUserId?: string | null;
  },
  db?: Db,
): Promise<{ executionId: string; sequence: number }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [prior] = await tx
      .select({ status: evaluationExecutions.status })
      .from(evaluationExecutions)
      .where(eq(evaluationExecutions.id, args.retryOf));

    if (!prior) {
      throw new MaisterError(
        "PRECONDITION",
        `evaluation execution not found: ${args.retryOf}`,
      );
    }
    if (!isTerminal(prior.status)) {
      throw new MaisterError(
        "CONFLICT",
        `cannot retry a non-terminal execution (${args.retryOf} is ${prior.status})`,
      );
    }

    const [row] = await tx
      .insert(evaluationExecutions)
      .values({
        studyId: args.studyId,
        status: "queued",
        retryOf: args.retryOf,
        methodRevisionId: args.methodRevisionId ?? null,
        effectiveProfileSnapshot: args.effectiveProfileSnapshot ?? null,
        requestedByUserId: args.requestedByUserId ?? null,
      })
      .returning({ id: evaluationExecutions.id });

    const { sequence } = await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      executionId: row.id,
      eventType: "evaluation.queued",
      payload: { retryOf: args.retryOf },
    });

    return { executionId: row.id, sequence };
  });
}
