import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationExecutionJudgePolicySnapshot } from "@/lib/evaluations/types";
import type { TokenActor } from "@/lib/tokens/verify";

import { and, asc, count, eq, gt, isNotNull } from "drizzle-orm";
import pino from "pino";

import { assignBlindLabels } from "./blinding";

import { getDb } from "@/lib/db/client";
import {
  evaluationEvidenceItems,
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
  evaluationMetricResults,
  evaluationObjectiveCheckRuns,
  evaluationStudies,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { readSnapshotItem } from "@/lib/evaluations/evidence/snapshots";

const log = pino({
  name: "evaluations-judge-facade",
  level: process.env.LOG_LEVEL ?? "info",
});

// The default page size for the bounded evidence listing (D10). A judge may
// page with a cursor but never dump an unbounded snapshot in one call.
export const EVIDENCE_LIST_DEFAULT_LIMIT = 50;
export const EVIDENCE_LIST_MAX_LIMIT = 200;

// A judge attempt is live for retrieval/submit only while it is queued or
// running. A terminal attempt (completed/invalid/timed_out/cancelled/error) can
// no longer read its snapshot or submit — a late submit is refused, not silently
// accepted (D12).
const LIVE_ATTEMPT_STATUSES = new Set(["queued", "running"]);

export interface BoundAttempt {
  attemptId: string;
  executionId: string;
  studyId: string;
  projectId: string;
  role: string;
  ordinal: number;
  status: string;
  methodRevisionId: string | null;
  evidenceSnapshotId: string | null;
  randomizationSeed: string | null;
  judgePolicySnapshot: EvaluationExecutionJudgePolicySnapshot | null;
}

// Resolve the token-bound judge attempt WITHOUT trusting any client id (D10). The
// attempt is found by the token id stored on the attempt row at launch; the
// execution/study/project chain is server-derived and re-checked against the
// token's project. A revoked/terminal attempt yields a typed refusal.
export async function resolveBoundAttempt(
  actor: TokenActor,
  db?: Db,
): Promise<BoundAttempt> {
  const d = db ?? getDb();

  const rows = await d
    .select({
      attemptId: evaluationJudgeAttempts.id,
      executionId: evaluationJudgeAttempts.executionId,
      role: evaluationJudgeAttempts.role,
      ordinal: evaluationJudgeAttempts.ordinal,
      status: evaluationJudgeAttempts.status,
      studyId: evaluationExecutions.studyId,
      methodRevisionId: evaluationExecutions.methodRevisionId,
      evidenceSnapshotId: evaluationExecutions.evidenceSnapshotId,
      randomizationSeed: evaluationExecutions.randomizationSeed,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
      projectId: evaluationStudies.projectId,
    })
    .from(evaluationJudgeAttempts)
    .innerJoin(
      evaluationExecutions,
      eq(evaluationJudgeAttempts.executionId, evaluationExecutions.id),
    )
    .innerJoin(
      evaluationStudies,
      eq(evaluationExecutions.studyId, evaluationStudies.id),
    )
    .where(eq(evaluationJudgeAttempts.tokenId, actor.tokenId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    // No attempt binds this token — the caller is not a live judge attempt.
    throw new MaisterError(
      "UNAUTHORIZED",
      "token is not bound to a judge attempt",
    );
  }

  // Defense in depth: the judge token's project must own the study.
  if (actor.projectId !== null && actor.projectId !== row.projectId) {
    throw new MaisterError(
      "UNAUTHORIZED",
      "token project does not match the evaluation study",
    );
  }

  if (!LIVE_ATTEMPT_STATUSES.has(row.status)) {
    throw new MaisterError(
      "CONFLICT",
      `judge attempt ${row.attemptId} is ${row.status}, not live`,
    );
  }

  return {
    attemptId: row.attemptId,
    executionId: row.executionId,
    studyId: row.studyId,
    projectId: row.projectId,
    role: row.role,
    ordinal: row.ordinal,
    status: row.status,
    methodRevisionId: row.methodRevisionId,
    evidenceSnapshotId: row.evidenceSnapshotId,
    randomizationSeed: row.randomizationSeed,
    // The snapshot column is an opaque jsonb Record; startEvaluationExecution
    // is the only writer and it stores exactly this typed shape.
    judgePolicySnapshot:
      row.judgePolicySnapshot as EvaluationExecutionJudgePolicySnapshot | null,
  };
}

interface BlindMap {
  // realParticipantId -> blind label (Candidate A/B/...).
  labels: Record<string, string>;
  // blind labels in deterministic presentation order.
  order: string[];
}

// Deterministic blind labels over exactly the candidates present in the bound
// snapshot's evidence (distinct non-null participant ids). Reproducible from the
// execution's randomization seed — a judge never sees a real participant id.
async function deriveBlinding(bound: BoundAttempt, d: Db): Promise<BlindMap> {
  if (!bound.evidenceSnapshotId) return { labels: {}, order: [] };

  const rows = await d
    .selectDistinct({ participantId: evaluationEvidenceItems.participantId })
    .from(evaluationEvidenceItems)
    .where(
      and(
        eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
        isNotNull(evaluationEvidenceItems.participantId),
      ),
    );

  const participantIds = rows
    .map((r) => r.participantId)
    // isNotNull() in the WHERE guarantees non-null; the filter is the type proof.
    .filter((id): id is string => id !== null)
    .sort();
  // The writer (startEvaluationExecution) nests the resolved policy under
  // `.policy` — the typed snapshot shape shared with start.ts (types.ts).
  const randomize = bound.judgePolicySnapshot?.policy?.randomizeOrder ?? true;
  const seed = bound.randomizationSeed ?? bound.executionId;

  const { labels, order } = assignBlindLabels(participantIds, seed, {
    randomize,
  });

  return { labels, order: order.map((id) => labels[id]) };
}

export interface EvaluatorContext {
  attempt: { id: string; role: string; ordinal: number };
  method: {
    qualifiedId: string;
    criteria: Array<{
      id: string;
      name: string;
      scale: { min: number; max: number };
      weight: number;
    }>;
  } | null;
  candidates: string[];
  evidence: { itemCount: number; readMaxBytes: number };
  digests: { prompt: string | null; schema: string | null };
}

// Server-derived judge context (D10): the attempt identity, the method rubric,
// the blind candidate order, and evidence/digest summary. It carries NO real
// participant id, NO peer judge result, NO project/worktree/snapshot id, and no
// private path — everything the judge may act on is bound by the token.
export async function getEvaluatorContext(
  actor: TokenActor,
  db?: Db,
): Promise<EvaluatorContext> {
  const d = db ?? getDb();
  const bound = await resolveBoundAttempt(actor, d);
  const blinding = await deriveBlinding(bound, d);

  let method: EvaluatorContext["method"] = null;
  let promptDigest: string | null = null;
  let schemaDigest: string | null = null;

  if (bound.methodRevisionId) {
    // WHY a live revision read is acceptable HERE (and only here): the judge
    // context (rubric names/prompt digests) is presentational guidance for the
    // agent, not a validation/aggregation input — seal + worker read the
    // start-time execution snapshots instead. A registry upsert mid-execution
    // can therefore show a judge a slightly newer rubric wording (bounded
    // staleness), but can never change what its submission is validated or
    // aggregated against.
    const [rev] = await d
      .select({
        qualifiedId: evaluationMethodRevisions.qualifiedId,
        normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
        promptDigest: evaluationMethodRevisions.promptDigest,
        schemaDigest: evaluationMethodRevisions.schemaDigest,
      })
      .from(evaluationMethodRevisions)
      .where(eq(evaluationMethodRevisions.id, bound.methodRevisionId));

    if (rev) {
      promptDigest = rev.promptDigest;
      schemaDigest = rev.schemaDigest;
      const def = (rev.normalizedDefinition?.definition ?? {}) as {
        criteria?: Array<{
          id: string;
          name: string;
          scale: { min: number; max: number };
          weight: number;
        }>;
      };

      method = {
        qualifiedId: rev.qualifiedId,
        criteria: (def.criteria ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          scale: c.scale,
          weight: c.weight,
        })),
      };
    }
  }

  let itemCount = 0;

  if (bound.evidenceSnapshotId) {
    const [row] = await d
      .select({ value: count() })
      .from(evaluationEvidenceItems)
      .where(eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId));

    itemCount = row?.value ?? 0;
  }

  return {
    attempt: { id: bound.attemptId, role: bound.role, ordinal: bound.ordinal },
    method,
    candidates: blinding.order,
    evidence: { itemCount, readMaxBytes: 65_536 },
    digests: { prompt: promptDigest, schema: schemaDigest },
  };
}

export interface EvidenceListItem {
  id: string;
  candidate: string | null;
  kind: string;
  digest: string;
  bytes: number | null;
  coverageClass: string;
}

export interface EvidenceListPage {
  items: EvidenceListItem[];
  nextCursor: string | null;
}

// Cursor-paginated evidence metadata for the bound snapshot (D10). Each item's
// real participant id is replaced by its blind candidate label; the logical
// locator and host blob key are NEVER exposed. The cursor is the last item id.
export async function listBoundEvidence(
  actor: TokenActor,
  opts: { cursor?: string; limit?: number },
  db?: Db,
): Promise<EvidenceListPage> {
  const d = db ?? getDb();
  const bound = await resolveBoundAttempt(actor, d);

  if (!bound.evidenceSnapshotId) return { items: [], nextCursor: null };

  const blinding = await deriveBlinding(bound, d);
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? EVIDENCE_LIST_DEFAULT_LIMIT)),
    EVIDENCE_LIST_MAX_LIMIT,
  );

  const where = opts.cursor
    ? and(
        eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
        gt(evaluationEvidenceItems.id, opts.cursor),
      )
    : eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId);

  const rows = await d
    .select({
      id: evaluationEvidenceItems.id,
      participantId: evaluationEvidenceItems.participantId,
      kind: evaluationEvidenceItems.kind,
      digest: evaluationEvidenceItems.digest,
      bytes: evaluationEvidenceItems.bytes,
      coverageClass: evaluationEvidenceItems.coverageClass,
    })
    .from(evaluationEvidenceItems)
    .where(where)
    .orderBy(asc(evaluationEvidenceItems.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map((r) => ({
      id: r.id,
      candidate: r.participantId
        ? (blinding.labels[r.participantId] ?? null)
        : null,
      kind: r.kind,
      digest: r.digest,
      bytes: r.bytes,
      coverageClass: r.coverageClass,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export interface EvidenceReadResult {
  itemId: string;
  content: string;
  truncated: boolean;
  offset: number;
}

// Bounded read of one evidence item (D10). The item MUST belong to the token's
// bound snapshot (validated in readSnapshotItem); the read is server-capped.
export async function readBoundEvidenceItem(
  actor: TokenActor,
  args: { itemId: string; offset?: number; length?: number },
  db?: Db,
): Promise<EvidenceReadResult> {
  const d = db ?? getDb();
  const bound = await resolveBoundAttempt(actor, d);

  if (!bound.evidenceSnapshotId) {
    throw new MaisterError("PRECONDITION", "no evidence snapshot is bound");
  }

  const read = await readSnapshotItem(
    {
      snapshotId: bound.evidenceSnapshotId,
      itemId: args.itemId,
      offset: args.offset,
      length: args.length,
    },
    d,
  );

  return {
    itemId: args.itemId,
    content: read.bytes.toString("utf8"),
    truncated: read.truncated,
    offset: Math.max(0, Math.floor(args.offset ?? 0)),
  };
}

export interface ObjectiveResultsDto {
  checks: Array<{
    candidate: string | null;
    checkId: string;
    checkVersion: string;
    status: string;
    reason: string | null;
  }>;
  metrics: Array<{
    candidate: string | null;
    metricId: string;
    metricVersion: string;
    status: string;
    value: Record<string, unknown> | null;
    unit: string | null;
  }>;
}

// Structured objective facts for the bound execution (D11). A judge may
// reference these but never infer PASS from source appearance; a missing/absent
// status carries its reason verbatim, never converted to a pass or a zero.
export async function getBoundObjectiveResults(
  actor: TokenActor,
  db?: Db,
): Promise<ObjectiveResultsDto> {
  const d = db ?? getDb();
  const bound = await resolveBoundAttempt(actor, d);
  const blinding = await deriveBlinding(bound, d);

  const checks = await d
    .select({
      participantId: evaluationObjectiveCheckRuns.participantId,
      checkId: evaluationObjectiveCheckRuns.checkId,
      checkVersion: evaluationObjectiveCheckRuns.checkVersion,
      status: evaluationObjectiveCheckRuns.status,
      reason: evaluationObjectiveCheckRuns.reason,
    })
    .from(evaluationObjectiveCheckRuns)
    .where(eq(evaluationObjectiveCheckRuns.executionId, bound.executionId));

  const metrics = await d
    .select({
      participantId: evaluationMetricResults.participantId,
      metricId: evaluationMetricResults.metricId,
      metricVersion: evaluationMetricResults.metricVersion,
      status: evaluationMetricResults.status,
      value: evaluationMetricResults.value,
      unit: evaluationMetricResults.unit,
    })
    .from(evaluationMetricResults)
    .where(eq(evaluationMetricResults.executionId, bound.executionId));

  const toCandidate = (participantId: string | null): string | null =>
    participantId ? (blinding.labels[participantId] ?? null) : null;

  log.debug(
    {
      executionId: bound.executionId,
      checks: checks.length,
      metrics: metrics.length,
    },
    "evaluator objective results served",
  );

  return {
    checks: checks.map((c) => ({
      candidate: toCandidate(c.participantId),
      checkId: c.checkId,
      checkVersion: c.checkVersion,
      status: c.status,
      reason: c.reason,
    })),
    metrics: metrics.map((m) => ({
      candidate: toCandidate(m.participantId),
      metricId: m.metricId,
      metricVersion: m.metricVersion,
      status: m.status,
      value: m.value,
      unit: m.unit,
    })),
  };
}
