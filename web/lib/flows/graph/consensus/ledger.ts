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

import { boundConsensusText, CONSENSUS_EXCERPT_CAP_BYTES } from "./text";

import {
  getArtifactsForRun,
  recordArtifact,
} from "@/lib/flows/graph/artifact-store";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "consensus-ledger",
  level: process.env.LOG_LEVEL ?? "info",
});

const { artifactInstances, consensusRoundVerdicts, domainEvents, runs } =
  schemaModule as unknown as Record<string, any>;

export const CONSENSUS_TEXT_CAP_BYTES = CONSENSUS_EXCERPT_CAP_BYTES;

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

function normalizeDisagreements(value: ConsensusRoundDisagreementStorage): {
  rows: ConsensusDisagreement[];
  truncated?: boolean;
  textBounds?: ConsensusTextBounds;
} {
  if (Array.isArray(value)) return { rows: value };
  if (
    value?.version !== 1 ||
    !Array.isArray(value.rows) ||
    typeof value.truncated !== "boolean"
  )
    throw new MaisterError(
      "CRASH",
      "invalid consensus verdict disagreement storage",
      {
        details: { reason: "consensus_verdict_storage_invalid" },
      },
    );

  return {
    rows: value.rows,
    truncated: value.truncated,
    ...(value.textBounds ? { textBounds: value.textBounds } : {}),
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
      const locator = artifact?.locator;
      const partial = locator?.kind === "inline" && locator.partial === true;

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
        stopReason:
          locator?.kind === "inline" ? (locator.stopReason ?? null) : null,
        reason: locator?.kind === "inline" ? (locator.reason ?? null) : null,
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

export async function recordConsensusVerdict(
  args: ConsensusVerdictWrite & { db: Db },
): Promise<ConsensusVerdictEvidence> {
  return args.db.transaction((tx: Db) => writeConsensusVerdict(tx, args));
}

/** DB-only; an owner application commits it with its command marker. */
export async function writeConsensusVerdict(
  tx: Db,
  args: ConsensusVerdictWrite,
): Promise<ConsensusVerdictEvidence> {
  const raw = boundConsensusText(args.rawOutput, CONSENSUS_EXCERPT_CAP_BYTES);

  if (raw.truncated)
    log.warn(
      {
        role: "verifier-raw-artifact",
        participantId: args.targetParticipantId,
        round: args.round,
        bytes: raw.bounds.bytes,
        cap: raw.bounds.cap,
        droppedBytes: raw.bounds.droppedBytes,
        artifactId: consensusVerdictArtifactId(args),
      },
      "consensus-text-truncated",
    );
  const rawOutputText = raw.text;
  const rawOutputArtifactId = consensusVerdictArtifactId(args);
  const id = consensusVerdictLedgerId(args);
  const rawOutputArtifact = {
    id: rawOutputArtifactId,
    runId: args.runId,
    nodeAttemptId: args.nodeAttemptId,
    nodeId: args.nodeId,
    attempt: args.attempt,
    artifactDefId: "default:consensus-verdict",
    kind: "ai_judgment",
    producer: "runner",
    locator: {
      kind: "inline",
      text: rawOutputText,
      ...(raw.truncated ? { truncated: true, textBounds: raw.bounds } : {}),
    },
    validity: "current",
    visibility: "internal",
    retention: "run",
  } satisfies Omit<ArtifactInstanceInsert, "createdAt">;
  const row = {
    id,
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
  } satisfies ConsensusRoundVerdictInsert;

  await recordArtifact(rawOutputArtifact, tx);
  const inserted = await tx
    .insert(consensusRoundVerdicts)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: consensusRoundVerdicts.id });

  if (inserted.length === 0)
    throw new MaisterError(
      "CONFLICT",
      `consensus verdict cell already exists for ${args.nodeAttemptId} round ${args.round} ${args.verifierId} -> ${args.targetParticipantId}`,
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
