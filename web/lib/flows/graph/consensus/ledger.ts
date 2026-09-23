import "server-only";

import type {
  ArtifactInstance,
  ArtifactInstanceInsert,
  ConsensusRoundVerdictInsert,
} from "@/lib/db/schema";
import type { Db } from "@/lib/flows/graph/runner-core";
import type {
  ConsensusDisagreement,
  ConsensusParseStatus,
  ConsensusVerdictValue,
  ParsedConsensusVerdict,
} from "./verdict";
import type { ConsensusTextBounds } from "./text";
import type { ConsensusRoundDisagreementStorage } from "@/lib/db/schema";

import { and, desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { CONSENSUS_VERDICT_ARTIFACT_DEF } from "./artifact-defs";
import { boundConsensusText, CONSENSUS_EXCERPT_CAP_BYTES } from "./text";
import {
  decodeConsensusLocatorMeta,
  decodeConsensusTextBounds,
} from "./locator-meta";

import { getArtifactsForRun } from "@/lib/flows/graph/artifact-store";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "consensus-ledger",
  level: process.env.LOG_LEVEL ?? "info",
});

const { artifactInstances, consensusRoundVerdicts, domainEvents, runs } =
  schemaModule as unknown as Record<string, any>;

export type ConsensusDraftEvidence = {
  participantId: string;
  participantKind: "agent" | "runner";
  runId: string;
  round: number;
  status: string;
  artifactId: string | null;
  artifactText: string | null;
  classification: "complete" | "partial" | "unavailable";
  stopReason: string | null;
  reason: string | null;
};

export type ConsensusVerdictEvidence = ParsedConsensusVerdict & {
  verifierId: string;
  targetParticipantId: string;
  round: number;
  rawOutputArtifactId: string | null;
  errorCode?: string;
  truncated?: boolean;
  textBounds?: ConsensusTextBounds;
};

function isDisagreementRow(value: unknown): value is ConsensusDisagreement {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ConsensusDisagreement).axis === "string" &&
    typeof (value as ConsensusDisagreement).claim === "string" &&
    typeof (value as ConsensusDisagreement).counterEvidence === "string"
  );
}

function invalidStorage(): MaisterError {
  return new MaisterError(
    "CRASH",
    "invalid consensus verdict disagreement storage",
    { details: { reason: "consensus_verdict_storage_invalid" } },
  );
}

// A legacy array means "no truncation recorded", never "complete", and is read
// as before. A version-1 envelope (every new writer) is validated field by
// field: its rows feed critique prompts.
function normalizeDisagreements(value: ConsensusRoundDisagreementStorage): {
  rows: ConsensusDisagreement[];
  truncated?: boolean;
  textBounds?: ConsensusTextBounds;
} {
  if (Array.isArray(value)) return { rows: value };
  if (
    value?.version !== 1 ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isDisagreementRow) ||
    typeof value.truncated !== "boolean"
  )
    throw invalidStorage();
  const textBounds =
    value.textBounds === undefined
      ? undefined
      : decodeConsensusTextBounds(value.textBounds);

  if (value.textBounds !== undefined && !textBounds) throw invalidStorage();

  return {
    rows: value.rows,
    truncated: value.truncated,
    ...(textBounds ? { textBounds } : {}),
  };
}

type UnknownDraftPayload = {
  kind?: unknown;
  nodeAttemptId?: unknown;
  participantId?: unknown;
  participantKind?: unknown;
  round?: unknown;
};

type ParsedDraftPayload = {
  kind: "consensus_draft";
  nodeAttemptId: string;
  participantId: string;
  participantKind: "agent" | "runner";
  round: number;
};

function inlineArtifactText(
  artifact: ArtifactInstance | undefined,
): string | null {
  if (!artifact || artifact.locator.kind !== "inline") return null;

  return artifact.locator.text;
}

function draftArtifactId(args: {
  runId: string;
  nodeAttemptId: string;
  participantId: string;
  round: number;
}): string {
  return `run:${args.runId}:consensus-draft:${args.nodeAttemptId}:${args.participantId}:r${args.round}`;
}

function isDraftPayload(
  payload: unknown,
  nodeAttemptId: string,
): payload is ParsedDraftPayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return false;
  }

  const p = payload as UnknownDraftPayload;

  return (
    p.kind === "consensus_draft" &&
    p.nodeAttemptId === nodeAttemptId &&
    typeof p.participantId === "string" &&
    (p.participantKind === "agent" || p.participantKind === "runner") &&
    typeof p.round === "number"
  );
}

type ConsensusDraftRunRow = {
  id: string;
  status: string;
  triggerPayload: ParsedDraftPayload;
};

export async function loadConsensusDraftEvidence(args: {
  db: Db;
  parentRunId: string;
  nodeAttemptId: string;
  round?: number;
}): Promise<ConsensusDraftEvidence[]> {
  const childRows = await args.db
    .select({
      id: runs.id,
      status: runs.status,
      triggerPayload: runs.triggerPayload,
    })
    .from(runs)
    .where(eq(runs.parentRunId, args.parentRunId));

  const draftRows: ConsensusDraftRunRow[] = childRows
    .filter((row: { triggerPayload: unknown }) =>
      isDraftPayload(row.triggerPayload, args.nodeAttemptId),
    )
    .filter((row: ConsensusDraftRunRow) =>
      args.round === undefined ? true : row.triggerPayload.round === args.round,
    );

  const artifacts = new Map<string, ArtifactInstance>();

  for (const row of draftRows) {
    const payload = row.triggerPayload;
    const expectedId = draftArtifactId({
      runId: row.id,
      nodeAttemptId: args.nodeAttemptId,
      participantId: payload.participantId,
      round: payload.round,
    });
    const rows = await args.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, expectedId));
    const artifact = rows[0] as ArtifactInstance | undefined;

    if (artifact) artifacts.set(expectedId, artifact);
  }

  return draftRows
    .map((row: ConsensusDraftRunRow): ConsensusDraftEvidence => {
      const payload = row.triggerPayload;
      const artifactId = draftArtifactId({
        runId: row.id,
        nodeAttemptId: args.nodeAttemptId,
        participantId: payload.participantId,
        round: payload.round,
      });
      const artifact = artifacts.get(artifactId);

      const artifactText = inlineArtifactText(artifact);
      const meta = decodeConsensusLocatorMeta(artifact?.locator);
      const partial = meta?.partial === true;

      return {
        participantId: payload.participantId,
        participantKind: payload.participantKind,
        runId: row.id,
        round: payload.round,
        status: row.status,
        artifactId: artifact?.id ?? null,
        artifactText,
        classification:
          !artifactText?.trim() || (row.status !== "Done" && !partial)
            ? "unavailable"
            : partial
              ? "partial"
              : "complete",
        stopReason: meta?.stopReason ?? null,
        reason: meta?.reason ?? null,
      };
    })
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
}

// The terminal `reason` an agent child's finalization recorded — it lives only
// on the child's terminal domain event (`run.failed` / `run.crashed` /
// `run.abandoned` payload), never on the runs row. Newest event per run wins.
export async function loadConsensusDraftFailureReasons(args: {
  db: Db;
  runIds: readonly string[];
}): Promise<Record<string, string>> {
  if (args.runIds.length === 0) return {};
  const rows: Array<{ runId: string | null; payload: unknown }> = await args.db
    .select({ runId: domainEvents.runId, payload: domainEvents.payload })
    .from(domainEvents)
    .where(
      and(
        inArray(domainEvents.runId, [...args.runIds]),
        inArray(domainEvents.kind, [
          "run.failed",
          "run.crashed",
          "run.abandoned",
        ]),
      ),
    )
    .orderBy(desc(domainEvents.occurredAt));
  const reasons: Record<string, string> = {};

  for (const row of rows) {
    const reason =
      row.payload && typeof row.payload === "object"
        ? (row.payload as { reason?: unknown }).reason
        : undefined;

    if (row.runId && typeof reason === "string" && !(row.runId in reasons))
      reasons[row.runId] = reason;
  }

  return reasons;
}

export async function latestConsensusRound(args: {
  db: Db;
  parentRunId: string;
  nodeAttemptId: string;
}): Promise<number> {
  const drafts = await loadConsensusDraftEvidence(args);

  return drafts.reduce((max, draft) => Math.max(max, draft.round), 0);
}

export async function loadConsensusVerdicts(args: {
  db: Db;
  nodeAttemptId: string;
  round: number;
}): Promise<ConsensusVerdictEvidence[]> {
  const rows = await args.db
    .select()
    .from(consensusRoundVerdicts)
    .where(
      and(
        eq(consensusRoundVerdicts.nodeAttemptId, args.nodeAttemptId),
        eq(consensusRoundVerdicts.round, args.round),
      ),
    );

  return rows.map((row: Record<string, unknown>) => {
    const storage = normalizeDisagreements(
      row.disagreements as ConsensusRoundDisagreementStorage,
    );

    return {
      verifierId: row.verifierKey as string,
      targetParticipantId: row.targetKey as string,
      round: row.round as number,
      parseStatus: row.parseStatus as ConsensusParseStatus,
      verdict: row.verdict as ConsensusVerdictValue,
      axes: row.axes as Record<string, boolean>,
      disagreements: storage.rows,
      ...(storage.truncated !== undefined
        ? { truncated: storage.truncated }
        : {}),
      ...(storage.textBounds ? { textBounds: storage.textBounds } : {}),
      ...(typeof row.confidence === "number"
        ? { confidence: row.confidence }
        : {}),
      rawOutputArtifactId:
        typeof row.rawOutputArtifactId === "string"
          ? row.rawOutputArtifactId
          : null,
      ...(typeof row.errorCode === "string"
        ? { errorCode: row.errorCode }
        : {}),
    };
  });
}

export type ConsensusVerdictCell = Readonly<{
  nodeAttemptId: string;
  round: number;
  verifierId: string;
  targetParticipantId: string;
}>;

/** One matrix cell has exactly one ledger row and one raw-output artifact, so
 * an owned verification command can key on the cell it was paid for. */
export function consensusVerdictLedgerId(cell: ConsensusVerdictCell): string {
  return `run:${cell.nodeAttemptId}:consensus-verdict-ledger:r${cell.round}:${cell.verifierId}:${cell.targetParticipantId}`;
}

export function consensusVerdictArtifactId(cell: ConsensusVerdictCell): string {
  return `run:${cell.nodeAttemptId}:consensus-verdict:r${cell.round}:${cell.verifierId}:${cell.targetParticipantId}`;
}

export type ConsensusVerdictWrite = ConsensusVerdictCell &
  Readonly<{
    runId: string;
    nodeId: string;
    attempt: number;
    result: ParsedConsensusVerdict;
    rawOutput: string;
    errorCode?: string;
    inputTextBounds?: ConsensusTextBounds;
    // Bytes the generation lost past its 1 MiB retention budget; recorded on
    // the raw-output artifact, which is otherwise only an excerpt of `rawOutput`.
    outputDroppedBytes?: number;
  }>;

export async function loadConsensusVerdictCell(
  args: ConsensusVerdictCell & { db: Db },
): Promise<ConsensusVerdictEvidence | null> {
  const verdicts = await loadConsensusVerdicts({
    db: args.db,
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
  });

  return (
    verdicts.find(
      (verdict) =>
        verdict.verifierId === args.verifierId &&
        verdict.targetParticipantId === args.targetParticipantId,
    ) ?? null
  );
}

/** The runtime's unpaid fail-closed write. An immutable cell that already
 * exists wins (an owner applied it first); either way the caller gets the cell
 * as stored, so a first pass and a replay serialize identical evidence. */
export async function recordConsensusVerdict(
  args: ConsensusVerdictWrite & { db: Db },
): Promise<ConsensusVerdictEvidence> {
  const written = await args.db.transaction((tx: Db) =>
    writeConsensusVerdict(tx, args),
  );

  if (!written)
    log.warn(
      {
        runId: args.runId,
        nodeAttemptId: args.nodeAttemptId,
        round: args.round,
        verifierId: args.verifierId,
        targetParticipantId: args.targetParticipantId,
        errorCode: args.errorCode ?? null,
      },
      "consensus-verdict-cell-exists",
    );
  const stored = await loadConsensusVerdictCell({ ...args, db: args.db });

  if (!stored)
    throw new MaisterError(
      "CRASH",
      `consensus verdict cell for ${args.nodeAttemptId} round ${args.round} ${args.verifierId} -> ${args.targetParticipantId} vanished after its write`,
      { details: { reason: "consensus_verdict_cell_missing" } },
    );

  return stored;
}

/** DB-only; an owner application commits it with its command marker. The
 * cell's FK needs its raw-output artifact first, so both inserts are
 * insert-if-absent: a writer that loses the immutable cell to an earlier one
 * leaves that winner's artifact untouched and gets null back. */
export async function writeConsensusVerdict(
  tx: Db,
  args: ConsensusVerdictWrite,
): Promise<ConsensusVerdictEvidence | null> {
  const rawOutputArtifactId = consensusVerdictArtifactId(args);
  const raw = boundConsensusText(args.rawOutput, CONSENSUS_EXCERPT_CAP_BYTES);
  const outputDropped = args.outputDroppedBytes ?? 0;
  const rawBounds = {
    bytes: raw.bounds.bytes + outputDropped,
    retainedBytes: raw.bounds.retainedBytes,
    droppedBytes: raw.bounds.droppedBytes + outputDropped,
    cap: raw.bounds.cap,
  };

  await tx
    .insert(artifactInstances)
    .values({
      id: rawOutputArtifactId,
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      nodeId: args.nodeId,
      attempt: args.attempt,
      artifactDefId: CONSENSUS_VERDICT_ARTIFACT_DEF,
      kind: "ai_judgment",
      producer: "runner",
      locator: {
        kind: "inline",
        text: raw.text,
        ...(rawBounds.droppedBytes > 0
          ? { truncated: true, textBounds: rawBounds }
          : {}),
        ...(outputDropped > 0 ? { reason: "output_cap_exceeded" } : {}),
      },
      validity: "current",
      visibility: "internal",
      retention: "run",
    } satisfies Omit<ArtifactInstanceInsert, "createdAt">)
    .onConflictDoNothing();
  const inserted = await tx
    .insert(consensusRoundVerdicts)
    .values({
      id: consensusVerdictLedgerId(args),
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      round: args.round,
      verifierKey: args.verifierId,
      targetKey: args.targetParticipantId,
      parseStatus: args.result.parseStatus,
      verdict: args.result.verdict,
      axes: args.result.axes,
      disagreements: {
        version: 1,
        rows: args.result.disagreements,
        truncated: !!args.inputTextBounds?.droppedBytes,
        ...(args.inputTextBounds ? { textBounds: args.inputTextBounds } : {}),
      },
      confidence: args.result.confidence,
      rawOutputArtifactId,
      errorCode: args.errorCode ?? args.result.technicalDetail,
    } satisfies ConsensusRoundVerdictInsert)
    .onConflictDoNothing()
    .returning({ id: consensusRoundVerdicts.id });

  if (inserted.length === 0) return null;
  if (rawBounds.droppedBytes > 0)
    log.warn(
      {
        role: "verifier-raw-artifact",
        runId: args.runId,
        nodeAttemptId: args.nodeAttemptId,
        participantId: args.targetParticipantId,
        round: args.round,
        artifactId: rawOutputArtifactId,
        ...rawBounds,
      },
      "consensus-text-truncated",
    );

  return {
    verifierId: args.verifierId,
    targetParticipantId: args.targetParticipantId,
    round: args.round,
    ...args.result,
    rawOutputArtifactId,
    ...(args.inputTextBounds?.droppedBytes
      ? { truncated: true, textBounds: args.inputTextBounds }
      : {}),
    ...(args.errorCode || args.result.technicalDetail
      ? { errorCode: args.errorCode ?? args.result.technicalDetail }
      : {}),
  };
}

export async function currentConsensusArtifacts(args: {
  db: Db;
  runId: string;
}): Promise<ArtifactInstance[]> {
  return getArtifactsForRun(args.runId, args.db);
}
