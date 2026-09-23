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

import { CONSENSUS_PROMPT_TEXT_CAP_BYTES } from "./text";

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
  valueSpan: Readonly<{ start: number; end: number }>;
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
  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PromptOwnerInvariantError("consensus_input_evidence_json");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1
  )
    throw new PromptOwnerInvariantError("consensus_input_evidence_schema");

  const evidence = parsed as Record<string, unknown>;
  const span = evidence.valueSpan as Record<string, unknown> | null;
  const bounds = evidence.textBounds as Record<string, unknown> | null;

  if (
    typeof evidence.runId !== "string" ||
    typeof evidence.nodeAttemptId !== "string" ||
    !Number.isInteger(evidence.round) ||
    typeof evidence.generationId !== "string" ||
    (evidence.role !== "verifier" && evidence.role !== "synthesis") ||
    typeof evidence.sourceId !== "string" ||
    typeof evidence.valueSha256 !== "string" ||
    typeof evidence.promptSha256 !== "string" ||
    span === null ||
    typeof span !== "object" ||
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    bounds === null ||
    typeof bounds !== "object" ||
    !Number.isInteger(bounds.bytes) ||
    !Number.isInteger(bounds.retainedBytes) ||
    !Number.isInteger(bounds.droppedBytes) ||
    bounds.cap !== CONSENSUS_PROMPT_TEXT_CAP_BYTES
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
  const valueStart = input.renderedPrompt.indexOf(input.value);

  if (valueStart < 0)
    throw new PromptOwnerInvariantError("consensus_input_value_not_rendered");
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
    valueSpan: { start: valueStart, end: valueStart + input.value.length },
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
  owner: {
    generationId: string;
    nodeAttemptId: string;
    round: number;
    role: "verifier" | "synthesis";
  },
): Promise<ConsensusInputEvidence | null> {
  const [artifact] = await db
    .select({ locator: artifactInstances.locator })
    .from(artifactInstances)
    .where(
      eq(artifactInstances.id, consensusInputEvidenceId(owner.generationId)),
    );

  if (!artifact) return null;
  const evidence = decodeEvidence(artifact.locator);
  const [host] = await db
    .select({ hostKey: executionHosts.hostKey })
    .from(executionHosts)
    .where(eq(executionHosts.id, command.executionHostId));

  if (!host)
    throw new PromptOwnerInvariantError("consensus_input_host_missing");
  const request = readPromptRequest(command, host.hostKey);
  const value = request.payload.prompt.slice(
    evidence.valueSpan.start,
    evidence.valueSpan.end,
  );
  const bounds = evidence.textBounds;
  const marker = `\n[consensus text truncated: dropped ${bounds.droppedBytes} UTF-8 bytes; cap ${bounds.cap} bytes]`;

  if (
    evidence.runId !== command.runId ||
    evidence.nodeAttemptId !== owner.nodeAttemptId ||
    evidence.round !== owner.round ||
    evidence.role !== owner.role ||
    evidence.generationId !== owner.generationId ||
    evidence.valueSpan.start < 0 ||
    evidence.valueSpan.end < evidence.valueSpan.start ||
    evidence.valueSpan.end > request.payload.prompt.length ||
    evidence.promptSha256 !== digest(request.payload.prompt) ||
    evidence.valueSha256 !== digest(value) ||
    bounds.bytes < 0 ||
    bounds.retainedBytes < 0 ||
    bounds.droppedBytes < 0 ||
    bounds.bytes !== bounds.retainedBytes + bounds.droppedBytes ||
    (bounds.droppedBytes > 0
      ? !value.endsWith(marker) ||
        Buffer.byteLength(value, "utf8") > bounds.cap ||
        Buffer.byteLength(value.slice(0, -marker.length), "utf8") !==
          bounds.retainedBytes
      : Buffer.byteLength(value, "utf8") !== bounds.bytes)
  )
    throw new PromptOwnerInvariantError("consensus_input_request_mismatch");

  return evidence;
}
