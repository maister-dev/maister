import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import {
  artifactInstances,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type ConsensusHumanIntent = Readonly<{
  version: 1;
  hitlRequestId: string;
  nodeAttemptId: string;
  sourceRound: number;
  targetRound: number;
  decision: "re-run-round";
  responseDigest: string;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function intentId(nodeAttemptId: string, hitlRequestId: string): string {
  return `run:${nodeAttemptId}:consensus-human-intent:${hitlRequestId}`;
}

function appliedId(nodeAttemptId: string, hitlRequestId: string): string {
  return `${intentId(nodeAttemptId, hitlRequestId)}:applied`;
}

function inlineText(locator: unknown): string {
  if (
    locator === null ||
    typeof locator !== "object" ||
    (locator as { kind?: unknown }).kind !== "inline" ||
    typeof (locator as { text?: unknown }).text !== "string"
  )
    throw new MaisterError(
      "CRASH",
      "consensus human intent has an invalid artifact locator",
    );

  return (locator as { text: string }).text;
}

/** Resolve the delivered request rather than inferring its source from a later round. */
export async function resolveConsensusHumanRequest(
  db: Db,
  input: {
    runId: string;
    nodeId: string;
    nodeAttemptId: string;
    decision: string;
    resolution?: string;
  },
): Promise<{
  hitlRequestId: string;
  sourceRound: number;
  responseDigest: string;
}> {
  const rows = await db
    .select({
      id: hitlRequests.id,
      schema: hitlRequests.schema,
      response: hitlRequests.response,
      respondedAt: hitlRequests.respondedAt,
    })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, input.runId),
        eq(hitlRequests.stepId, input.nodeId),
        eq(hitlRequests.kind, "human"),
        isNotNull(hitlRequests.respondedAt),
      ),
    )
    .orderBy(desc(hitlRequests.respondedAt), desc(hitlRequests.createdAt));
  const matches = rows.filter((row) => {
    const schema = row.schema as Record<string, unknown> | null;
    const response = row.response as Record<string, unknown> | null;

    return (
      schema?.kind === "consensus_resolution" &&
      (schema.nodeAttemptId === undefined ||
        schema.nodeAttemptId === input.nodeAttemptId) &&
      response?.decision === input.decision &&
      (input.resolution === undefined ||
        response.resolution === input.resolution) &&
      typeof schema.round === "number" &&
      schema.round > 0
    );
  });
  const match = matches[0];

  if (!match)
    throw new MaisterError(
      "CONFLICT",
      "consensus human input has no matching delivered request",
    );
  if (
    matches.length > 1 &&
    matches[1]?.respondedAt?.getTime() === match.respondedAt?.getTime()
  )
    throw new MaisterError(
      "CONFLICT",
      "consensus human input matches multiple delivered requests",
    );

  return {
    hitlRequestId: match.id,
    sourceRound: (match.schema as { round: number }).round,
    responseDigest: digest(match.response),
  };
}

/** Freeze a single target round. An interrupted fan-out reuses this record. */
export async function prepareConsensusHumanIntent(
  db: Db,
  input: {
    runId: string;
    nodeId: string;
    nodeAttemptId: string;
    attempt: number;
    hitlRequestId: string;
    sourceRound: number;
    responseDigest: string;
  },
): Promise<ConsensusHumanIntent> {
  const intent: ConsensusHumanIntent = {
    version: 1,
    hitlRequestId: input.hitlRequestId,
    nodeAttemptId: input.nodeAttemptId,
    sourceRound: input.sourceRound,
    targetRound: input.sourceRound + 1,
    decision: "re-run-round",
    responseDigest: input.responseDigest,
  };
  const text = JSON.stringify(intent);

  await db.transaction(async (tx: Db) => {
    const [run] = await tx
      .select({ status: runs.status, currentStepId: runs.currentStepId })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [attempt] = await tx
      .select({ runId: nodeAttempts.runId, status: nodeAttempts.status })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update");

    if (
      run?.status !== "Running" ||
      run.currentStepId !== input.nodeId ||
      attempt?.runId !== input.runId ||
      attempt.status !== "Running"
    )
      throw new MaisterError(
        "CONFLICT",
        "consensus human decision owner is no longer current",
      );

    await tx
      .insert(artifactInstances)
      .values({
        id: intentId(input.nodeAttemptId, input.hitlRequestId),
        runId: input.runId,
        nodeId: input.nodeId,
        nodeAttemptId: input.nodeAttemptId,
        attempt: input.attempt,
        artifactDefId: "consensus-human-intent",
        kind: "human_note",
        producer: "runner",
        locator: { kind: "inline", text },
        validity: "current",
        visibility: "internal",
        retention: "run",
      })
      .onConflictDoNothing();
    const [stored] = await tx
      .select({ locator: artifactInstances.locator })
      .from(artifactInstances)
      .where(
        eq(
          artifactInstances.id,
          intentId(input.nodeAttemptId, input.hitlRequestId),
        ),
      );

    if (inlineText(stored?.locator) !== text)
      throw new MaisterError(
        "CONFLICT",
        "consensus human decision intent changed on replay",
      );
  });

  return intent;
}

export async function isConsensusHumanIntentApplied(
  db: Db,
  intent: ConsensusHumanIntent,
): Promise<boolean> {
  const [row] = await db
    .select({ id: artifactInstances.id })
    .from(artifactInstances)
    .where(
      eq(
        artifactInstances.id,
        appliedId(intent.nodeAttemptId, intent.hitlRequestId),
      ),
    );

  return row !== undefined;
}

export async function markConsensusHumanIntentApplied(
  db: Db,
  input: {
    runId: string;
    nodeId: string;
    attempt: number;
    intent: ConsensusHumanIntent;
  },
): Promise<void> {
  await db
    .insert(artifactInstances)
    .values({
      id: appliedId(input.intent.nodeAttemptId, input.intent.hitlRequestId),
      runId: input.runId,
      nodeId: input.nodeId,
      nodeAttemptId: input.intent.nodeAttemptId,
      attempt: input.attempt,
      artifactDefId: "consensus-human-intent-applied",
      kind: "human_note",
      producer: "runner",
      locator: { kind: "inline", text: JSON.stringify(input.intent) },
      validity: "current",
      visibility: "internal",
      retention: "run",
    })
    .onConflictDoNothing();
}
