import "server-only";

import type { BrainSourceRef } from "@/lib/brain/schema";
import type {
  BrainIndexJobReason,
  BrainIndexJobStatus,
} from "@/types/scheduler";

import { sql, type SQL } from "drizzle-orm";

import { listBrainSources, type BrainSourceDto } from "@/lib/brain/sources";

export type BrainUiDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface BrainMemorySearchRow {
  id: string;
  tier: "owned" | "indexed";
  kind: string;
  title: string;
  preview: string;
  confidence: number;
  pointer: BrainSourceRef | null;
}

export interface BrainProposalEvidenceRow {
  id: string;
  title: string;
  pointer: BrainSourceRef | null;
}

export interface BrainProposalReviewRow {
  id: string;
  kind: string;
  status: string;
  blastRadius: string;
  autonomyDecision: string;
  draft: Record<string, unknown>;
  evidence: BrainProposalEvidenceRow[];
  createdAt: Date | string;
}

export interface ProjectBrainPanelData {
  indexStatus: BrainIndexPanelStatus;
  memory: BrainMemorySearchRow[];
  proposals: BrainProposalReviewRow[];
  sources: BrainSourceDto[];
}

export interface BrainIndexPanelJobRow {
  id: string;
  sourceId: string | null;
  sourcePath: string | null;
  reason: BrainIndexJobReason;
  status: BrainIndexJobStatus;
  progress: number;
  createdAt: Date | string;
}

export interface BrainIndexPanelStatus {
  activeJobs: BrainIndexPanelJobRow[];
  completed: number;
  failed: number;
  failedSourceCount: number;
  enabledSourceCount: number;
  indexedChunkCount: number;
  indexedFileCount: number;
  latestSourceIndexedAt: Date | string | null;
  queued: number;
  running: number;
  sourceCount: number;
}

type BrainIndexSummaryDbRow = {
  completed: number | string | null;
  enabled_source_count: number | string | null;
  failed: number | string | null;
  failed_source_count: number | string | null;
  indexed_chunk_count: number | string | null;
  indexed_file_count: number | string | null;
  latest_source_indexed_at: Date | string | null;
  queued: number | string | null;
  running: number | string | null;
  source_count: number | string | null;
};

type BrainIndexJobDbRow = {
  created_at: Date | string;
  id: string;
  progress: number;
  reason: BrainIndexJobReason;
  source_id: string | null;
  source_path: string | null;
  status: BrainIndexJobStatus;
};

function previewOf(content: unknown): string {
  const value = String(content ?? "");

  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function pointerOf(value: unknown): BrainSourceRef | null {
  return value && typeof value === "object" ? (value as BrainSourceRef) : null;
}

function coerceCount(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toMemoryRow(row: Record<string, unknown>): BrainMemorySearchRow {
  return {
    id: String(row.id),
    tier: row.tier as "owned" | "indexed",
    kind: String(row.kind),
    title: String(row.title),
    preview: previewOf(row.content),
    confidence: Number(row.confidence ?? 0),
    pointer: pointerOf(row.pointer),
  };
}

async function listMemoryRows(
  db: BrainUiDb,
  projectId: string,
  query: string,
): Promise<BrainMemorySearchRow[]> {
  const trimmed = query.trim();
  const like = `%${trimmed}%`;
  const ownedWhere =
    trimmed.length === 0
      ? sql``
      : sql`AND (i.tsv @@ plainto_tsquery('english', ${trimmed})
             OR i.title ILIKE ${like}
             OR i.content ILIKE ${like})`;
  const indexedWhere =
    trimmed.length === 0
      ? sql``
      : sql`AND (c.tsv @@ plainto_tsquery('english', ${trimmed})
             OR c.title ILIKE ${like}
             OR c.content ILIKE ${like}
             OR c.path ILIKE ${like})`;

  const rows = await db.execute(sql`
    WITH owned AS (
      SELECT i.id, 'owned' AS tier, i.kind, i.title, i.content,
             i.confidence::float8 AS confidence,
             i.source_ref AS pointer,
             i.updated_at AS touched_at
      FROM brain_items i
      WHERE i.project_id = ${projectId}
        AND i.status = 'active'
        AND (i.expires_at IS NULL OR i.expires_at > now())
        ${ownedWhere}
      ORDER BY i.updated_at DESC
      LIMIT 8
    ),
    indexed AS (
      SELECT c.id, 'indexed' AS tier, c.kind, c.title, c.content,
             1::float8 AS confidence,
             jsonb_build_object(
               'sourcePath', c.path,
               'stableId', c.stable_id,
               'sourceRange', c.source_range
             ) AS pointer,
             c.updated_at AS touched_at
      FROM brain_chunks c
      JOIN brain_sources s ON s.id = c.source_id AND s.enabled = true
      WHERE c.project_id = ${projectId}
        ${indexedWhere}
      ORDER BY c.updated_at DESC
      LIMIT 8
    )
    SELECT id, tier, kind, title, content, confidence, pointer
    FROM (
      SELECT * FROM owned
      UNION ALL
      SELECT * FROM indexed
    ) hits
    ORDER BY confidence DESC, touched_at DESC
    LIMIT 12
  `);

  return rows.rows.map(toMemoryRow);
}

function evidenceIds(rows: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();

  for (const row of rows) {
    const raw = row.evidence_item_ids;

    if (!Array.isArray(raw)) continue;
    for (const id of raw) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  return [...ids];
}

async function evidenceById(
  db: BrainUiDb,
  projectId: string,
  ids: string[],
): Promise<Map<string, BrainProposalEvidenceRow>> {
  if (ids.length === 0) return new Map();

  const rows = await db.execute(sql`
    SELECT id, title, source_ref
    FROM brain_items
    WHERE project_id = ${projectId}
      AND id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);

  return new Map(
    rows.rows.map((row) => [
      String(row.id),
      {
        id: String(row.id),
        title: String(row.title),
        pointer: pointerOf(row.source_ref),
      },
    ]),
  );
}

async function listProposalRows(
  db: BrainUiDb,
  projectId: string,
): Promise<BrainProposalReviewRow[]> {
  const rows = await db.execute(sql`
    SELECT id, kind, status, blast_radius, autonomy_decision,
           evidence_item_ids, draft, created_at
    FROM brain_proposals
    WHERE project_id = ${projectId}
    ORDER BY
      CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 25
  `);
  const byId = await evidenceById(db, projectId, evidenceIds(rows.rows));

  return rows.rows.map((row) => {
    const rawEvidence = Array.isArray(row.evidence_item_ids)
      ? row.evidence_item_ids
      : [];
    const evidence = rawEvidence
      .map((id) => (typeof id === "string" ? byId.get(id) : undefined))
      .filter((item): item is BrainProposalEvidenceRow => item !== undefined);

    return {
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status),
      blastRadius: String(row.blast_radius),
      autonomyDecision: String(row.autonomy_decision),
      draft: (row.draft as Record<string, unknown>) ?? {},
      evidence,
      createdAt: row.created_at as Date | string,
    };
  });
}

async function loadIndexStatus(
  db: BrainUiDb,
  projectId: string,
): Promise<BrainIndexPanelStatus> {
  const [summary, jobs] = await Promise.all([
    db.execute(sql`
      WITH job_counts AS (
        SELECT
          count(*) FILTER (WHERE status = 'queued')::int AS queued,
          count(*) FILTER (WHERE status = 'running')::int AS running,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM brain_index_jobs
        WHERE project_id = ${projectId}
      ),
      source_summary AS (
        SELECT
          count(*)::int AS source_count,
          count(*) FILTER (WHERE enabled = true)::int AS enabled_source_count,
          count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed_source_count,
          max(last_indexed_at) AS latest_source_indexed_at
        FROM brain_sources
        WHERE project_id = ${projectId}
      ),
      chunk_summary AS (
        SELECT
          count(DISTINCT c.path)::int AS indexed_file_count,
          count(c.id)::int AS indexed_chunk_count
        FROM brain_chunks c
        JOIN brain_sources s ON s.id = c.source_id AND s.enabled = true
        WHERE c.project_id = ${projectId}
      )
      SELECT
        job_counts.queued,
        job_counts.running,
        job_counts.failed,
        job_counts.completed,
        source_summary.source_count,
        source_summary.enabled_source_count,
        source_summary.failed_source_count,
        chunk_summary.indexed_file_count,
        chunk_summary.indexed_chunk_count,
        source_summary.latest_source_indexed_at
      FROM job_counts
      CROSS JOIN source_summary
      CROSS JOIN chunk_summary
    `),
    db.execute(sql`
      SELECT
        j.id,
        j.source_id,
        s.path AS source_path,
        j.reason,
        j.status,
        j.progress,
        j.created_at
      FROM brain_index_jobs j
      LEFT JOIN brain_sources s ON s.id = j.source_id
      WHERE j.project_id = ${projectId}
        AND j.status IN ('running', 'queued', 'failed')
      ORDER BY
        CASE j.status
          WHEN 'running' THEN 0
          WHEN 'queued' THEN 1
          ELSE 2
        END ASC,
        j.created_at DESC,
        j.id ASC
      LIMIT 8
    `),
  ]);
  const row = (summary.rows[0] ?? {}) as BrainIndexSummaryDbRow;

  return {
    activeJobs: jobs.rows.map((job) =>
      toBrainIndexPanelJob(job as BrainIndexJobDbRow),
    ),
    completed: coerceCount(row.completed),
    failed: coerceCount(row.failed),
    failedSourceCount: coerceCount(row.failed_source_count),
    enabledSourceCount: coerceCount(row.enabled_source_count),
    indexedChunkCount: coerceCount(row.indexed_chunk_count),
    indexedFileCount: coerceCount(row.indexed_file_count),
    latestSourceIndexedAt: row.latest_source_indexed_at ?? null,
    queued: coerceCount(row.queued),
    running: coerceCount(row.running),
    sourceCount: coerceCount(row.source_count),
  };
}

function toBrainIndexPanelJob(row: BrainIndexJobDbRow): BrainIndexPanelJobRow {
  return {
    createdAt: row.created_at,
    id: row.id,
    progress: row.progress,
    reason: row.reason,
    sourceId: row.source_id,
    sourcePath: row.source_path,
    status: row.status,
  };
}

export async function loadProjectBrainPanelData(
  db: BrainUiDb,
  projectId: string,
  query: string,
): Promise<ProjectBrainPanelData> {
  const trimmedQuery = query.trim();
  const [indexStatus, memory, proposals, sources] = await Promise.all([
    loadIndexStatus(db, projectId),
    trimmedQuery.length > 0
      ? listMemoryRows(db, projectId, trimmedQuery)
      : Promise.resolve([]),
    listProposalRows(db, projectId),
    listBrainSources(db, projectId),
  ]);

  return { indexStatus, memory, proposals, sources };
}
