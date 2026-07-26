import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationExecutionJudgePolicySnapshot } from "@/lib/evaluations/types";
import type { TokenActor } from "@/lib/tokens/verify";

import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
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
  // Pairwise match identity (ADR-147). Non-null ⇒ this attempt judges a single
  // participant PAIR and submits a pick (a|b|tie); NULL ⇒ a scalar attempt.
  matchA: string | null;
  matchB: string | null;
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
      matchA: evaluationJudgeAttempts.matchA,
      matchB: evaluationJudgeAttempts.matchB,
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
    matchA: row.matchA,
    matchB: row.matchB,
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

// The attempt's real-id match scope for SQL filters — null for a scalar
// attempt. Never exposed to the judge; only blinded labels leave the facade.
function matchScope(bound: BoundAttempt): [string, string] | null {
  return bound.matchA !== null && bound.matchB !== null
    ? [bound.matchA, bound.matchB]
    : null;
}

// The blinded labels of a pairwise attempt's match sides (Codex-2). Fail-closed:
// a match side with no captured evidence in the bound snapshot has no label —
// the pair is un-judgeable and is refused, never served half-blind (an
// unresolved match stays explicit, D11).
function requirePairLabels(
  bound: BoundAttempt,
  blinding: BlindMap,
): { a: string; b: string } | null {
  if (bound.matchA === null || bound.matchB === null) return null;
  const a = blinding.labels[bound.matchA];
  const b = blinding.labels[bound.matchB];

  if (!a || !b) {
    throw new MaisterError(
      "PRECONDITION",
      `judge attempt ${bound.attemptId} match side has no captured evidence in the bound snapshot`,
    );
  }

  return { a, b };
}

// Evidence visibility for a pairwise attempt: the two match sides plus shared
// (null-participant) items. Scalar attempts see the whole snapshot.
function evidencePairFilter(scope: [string, string]): SQL | undefined {
  return or(
    inArray(evaluationEvidenceItems.participantId, [...scope]),
    isNull(evaluationEvidenceItems.participantId),
  );
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
  // Pairwise only (ADR-147): which blinded candidate is match side `a` and
  // which is `b` — the submitted `winner` pick refers to THESE sides, not to
  // candidate list position. Null for a scalar attempt.
  match: { a: string; b: string } | null;
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
  const match = requirePairLabels(bound, blinding);

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
    const scope = matchScope(bound);
    const [row] = await d
      .select({ value: count() })
      .from(evaluationEvidenceItems)
      .where(
        scope
          ? and(
              eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
              evidencePairFilter(scope),
            )
          : eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
      );

    itemCount = row?.value ?? 0;
  }

  return {
    attempt: { id: bound.attemptId, role: bound.role, ordinal: bound.ordinal },
    method,
    candidates: match
      ? blinding.order.filter((label) => label === match.a || label === match.b)
      : blinding.order,
    match,
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

  requirePairLabels(bound, blinding);
  const scope = matchScope(bound);
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? EVIDENCE_LIST_DEFAULT_LIMIT)),
    EVIDENCE_LIST_MAX_LIMIT,
  );

  const conditions: Array<SQL | undefined> = [
    eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
  ];

  if (scope) conditions.push(evidencePairFilter(scope));
  if (opts.cursor) conditions.push(gt(evaluationEvidenceItems.id, opts.cursor));

  const where = and(...conditions);

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

  const scope = matchScope(bound);

  if (scope) {
    requirePairLabels(bound, await deriveBlinding(bound, d));

    const [item] = await d
      .select({ participantId: evaluationEvidenceItems.participantId })
      .from(evaluationEvidenceItems)
      .where(
        and(
          eq(evaluationEvidenceItems.id, args.itemId),
          eq(evaluationEvidenceItems.snapshotId, bound.evidenceSnapshotId),
        ),
      );

    // One message for absent AND out-of-pair — the facade never confirms that
    // an item outside the attempt's match exists.
    if (
      !item ||
      (item.participantId !== null && !scope.includes(item.participantId))
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `evidence item not readable by this attempt: ${args.itemId}`,
      );
    }
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

  requirePairLabels(bound, blinding);
  const scope = matchScope(bound);

  const checks = await d
    .select({
      participantId: evaluationObjectiveCheckRuns.participantId,
      checkId: evaluationObjectiveCheckRuns.checkId,
      checkVersion: evaluationObjectiveCheckRuns.checkVersion,
      status: evaluationObjectiveCheckRuns.status,
      reason: evaluationObjectiveCheckRuns.reason,
    })
    .from(evaluationObjectiveCheckRuns)
    .where(
      scope
        ? and(
            eq(evaluationObjectiveCheckRuns.executionId, bound.executionId),
            or(
              inArray(evaluationObjectiveCheckRuns.participantId, [...scope]),
              isNull(evaluationObjectiveCheckRuns.participantId),
            ),
          )
        : eq(evaluationObjectiveCheckRuns.executionId, bound.executionId),
    );

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
    .where(
      scope
        ? and(
            eq(evaluationMetricResults.executionId, bound.executionId),
            or(
              inArray(evaluationMetricResults.participantId, [...scope]),
              isNull(evaluationMetricResults.participantId),
            ),
          )
        : eq(evaluationMetricResults.executionId, bound.executionId),
    );

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
