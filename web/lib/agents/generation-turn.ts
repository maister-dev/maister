import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn, ExecutionAssignment } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { agentTurns, runs, runSessions } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

type GenerationVariant = Extract<
  AgentTurn["variant"],
  "initial" | "resume" | "rework"
>;

const placementReasons: Readonly<
  Record<GenerationVariant, readonly ExecutionAssignment["placementReason"][]>
> = {
  initial: ["launch", "legacy_backfill"],
  resume: ["resume", "recover", "wait_resume"],
  rework: ["rework_return"],
};

/** Retain generation-owned input in the caller's placement/admission transaction. */
export async function admitAgentGenerationTurn(
  tx: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    variant: GenerationVariant;
    prompt: string;
  }>,
): Promise<AgentTurn> {
  const assignment = await lockCurrentSessionAssignment(tx, input);
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));

  if (
    !assignment ||
    run?.runKind !== "agent" ||
    run.status !== "Running" ||
    !placementReasons[input.variant].includes(assignment.placementReason)
  )
    throw new MaisterError(
      "CONFLICT",
      "agent turn requires its current admitted generation",
      {
        details: {
          runId: input.runId,
          assignmentId: input.assignmentId,
          variant: input.variant,
        },
      },
    );
  if (input.prompt.length === 0 || input.prompt.length > 1_000_000)
    throw new MaisterError(
      "CONFIG",
      "agent prompt must contain 1 to 1000000 characters",
    );
  const logicalKey = `generation:${input.assignmentId}:${input.variant}`;
  const [existing] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, input.runId),
        eq(agentTurns.logicalKey, logicalKey),
      ),
    );

  if (existing) {
    if (existing.prompt !== input.prompt)
      throw new MaisterError(
        "CONFLICT",
        "agent generation already owns different input",
        {
          details: { runId: input.runId, turnId: existing.id },
        },
      );

    return existing;
  }
  const [session] = await tx
    .select()
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, input.runId),
        eq(runSessions.sessionName, "default"),
      ),
    );

  if (!session)
    throw new MaisterError(
      "PRECONDITION",
      "agent turn requires its logical session",
      {
        details: { runId: input.runId },
      },
    );
  const [sequence] = await tx
    .select({
      ordinal: sql<number>`coalesce(max(${agentTurns.ordinal}), 0) + 1`,
    })
    .from(agentTurns)
    .where(eq(agentTurns.runId, input.runId));
  const [turn] = await tx
    .insert(agentTurns)
    .values({
      id: input.variant === "initial" ? assignment.id : randomUUID(),
      runId: input.runId,
      ordinal: input.variant === "initial" ? 0 : sequence.ordinal,
      variant: input.variant,
      logicalKey,
      prompt: input.prompt,
      state: "claimed",
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId: session.id,
    })
    .returning();

  return turn;
}
