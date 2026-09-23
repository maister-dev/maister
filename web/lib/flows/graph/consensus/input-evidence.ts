import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { ConsensusTextBounds } from "./text";

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  artifactInstances,
  executionHosts,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { readPromptRequest } from "@/lib/execution-host/command-request";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

type ConsensusInputEvidence = Readonly<{
  version: 1;
  runId: string;
  nodeAttemptId: string;
  round: number;
  generationId: string;
  role: "verifier" | "synthesis";
  sourceId: string;
  valueSha256: string;
  promptSha256: string;
  textBounds: ConsensusTextBounds;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function consensusInputEvidenceId(generationId: string): string {
  return `${generationId}:input`;
}

function decodeEvidence(value: unknown): ConsensusInputEvidence {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== "inline"
  )
    throw new PromptOwnerInvariantError("consensus_input_evidence_locator");
  const text = (value as { text?: unknown }).text;

  if (typeof text !== "string")
    throw new PromptOwnerInvariantError("consensus_input_evidence_text");
  const parsed: unknown = JSON.parse(text);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1
  )
    throw new PromptOwnerInvariantError("consensus_input_evidence_schema");

  return parsed as ConsensusInputEvidence;
}

/** A deterministic preparation record; replay compares instead of overwriting. */
export async function prepareConsensusInputEvidence(
  db: Db,
  input: {
    runId: string;
    nodeId: string;
    nodeAttemptId: string;
    attempt: number;
    round: number;
    generationId: string;
    role: "verifier" | "synthesis";
    sourceId: string;
    value: string;
    renderedPrompt: string;
    textBounds: ConsensusTextBounds;
  },
): Promise<void> {
  const evidence: ConsensusInputEvidence = {
    version: 1,
    runId: input.runId,
    nodeAttemptId: input.nodeAttemptId,
    round: input.round,
    generationId: input.generationId,
    role: input.role,
    sourceId: input.sourceId,
    valueSha256: digest(input.value),
    promptSha256: digest(input.renderedPrompt),
    textBounds: input.textBounds,
  };
  const serialized = JSON.stringify(evidence);
  const artifactId = consensusInputEvidenceId(input.generationId);

  await db.transaction(async (tx: Db) => {
    const [run] = await tx
      .select({ currentStepId: runs.currentStepId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [attempt] = await tx
      .select({ status: nodeAttempts.status, runId: nodeAttempts.runId })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update");

    if (
      run?.currentStepId !== input.nodeId ||
      run.status !== "Running" ||
      attempt?.runId !== input.runId ||
      attempt.status !== "Running"
    )
      throw new PromptOwnerInvariantError("consensus_input_owner_not_current");

    await tx
      .insert(artifactInstances)
      .values({
        id: artifactId,
        runId: input.runId,
        nodeId: input.nodeId,
        nodeAttemptId: input.nodeAttemptId,
        attempt: input.attempt,
        artifactDefId: "default:consensus-input",
        kind: "human_note",
        producer: "runner",
        locator: { kind: "inline", text: serialized },
        validity: "current",
        visibility: "internal",
        retention: "run",
      })
      .onConflictDoNothing();
    const [stored] = await tx
      .select({ locator: artifactInstances.locator })
      .from(artifactInstances)
      .where(eq(artifactInstances.id, artifactId));

    if (JSON.stringify(decodeEvidence(stored?.locator)) !== serialized)
      throw new PromptOwnerInvariantError("consensus_input_evidence_conflict");
  });
}

/** Legacy commands have no preparation row; new commands verify stored bytes. */
export async function verifyConsensusInputEvidence(
  db: Db,
  command: ExecutionCommand,
  generationId: string,
): Promise<ConsensusInputEvidence | null> {
  const [artifact] = await db
    .select({ locator: artifactInstances.locator })
    .from(artifactInstances)
    .where(eq(artifactInstances.id, consensusInputEvidenceId(generationId)));

  if (!artifact) return null;
  const evidence = decodeEvidence(artifact.locator);
  const [host] = await db
    .select({ hostKey: executionHosts.hostKey })
    .from(executionHosts)
    .where(eq(executionHosts.id, command.executionHostId));

  if (!host)
    throw new PromptOwnerInvariantError("consensus_input_host_missing");
  const request = readPromptRequest(command, host.hostKey);

  if (
    evidence.runId !== command.runId ||
    evidence.generationId !== generationId ||
    evidence.promptSha256 !== digest(request.payload.prompt)
  )
    throw new PromptOwnerInvariantError("consensus_input_request_mismatch");

  return evidence;
}
