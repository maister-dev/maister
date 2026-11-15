import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { SpecialistAssignment, SpecialistAssignmentStatus } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  beginAssignmentTransaction,
  getVisibleSpecialistAssignmentInTransaction,
} from "./store";

import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { isSettledRunStatus } from "@/lib/runs/run-status-sets";

const assignmentCursorNamespace = "maister.specialist-assignments.v1";
const workCursorNamespace = "maister.specialist-work.v1";
/** Candidates inspected per page; access is decided per row by the store. */
const scanFactor = 4;

const pageInputSchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export type Page<T> = Readonly<{ items: T[]; nextCursor: string | null }>;

export type AssignmentListFilters = Readonly<{
  projectId?: string;
  status?: SpecialistAssignmentStatus;
  owner?: "company" | "project";
  requestedBy?: string;
}>;

export type SpecialistWorkItem = Readonly<{
  id: string;
  logicalWorkId: string;
  revision: number;
  inputRevision: number;
  workRevision: number;
  state:
    | "queued"
    | "running"
    | "needs_clarification"
    | "result_ready"
    | "accepted"
    | "rework_requested"
    | "interrupted"
    | "cancelled";
  childRunId: string | null;
  resultRevision: number | null;
  limitations: SpecialistWorkLimitation[];
}>;

/** Server-derived limitation codes; the receiving UI localizes them. */
export type SpecialistWorkLimitation = "rejected_without_rework";

function parsePage(raw: unknown): z.infer<typeof pageInputSchema> {
  const parsed = pageInputSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid assignment pagination query");

  return parsed.data;
}

function refusedRead(error: unknown): boolean {
  return (
    isMaisterError(error) &&
    (error.code === "UNAUTHORIZED" || error.code === "PRECONDITION")
  );
}

async function upperBound(tx: SqlTransaction): Promise<string> {
  return String(
    (
      await tx.execute(
        sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      )
    ).rows[0]!.at,
  );
}

/**
 * Lists assignments the user can currently read, newest first. The store's
 * per-row authorization decides access, so a page may hold fewer than `limit`
 * items while `nextCursor` is still non-null.
 */
export async function listAccessibleSpecialistAssignments(
  db: SqlDatabase,
  userId: string,
  raw: unknown,
  filters: AssignmentListFilters = {},
): Promise<Page<SpecialistAssignment>> {
  const { cursor, limit } = parsePage(raw);
  const { projectId, status, owner, requestedBy } = filters;
  const scope = contentDigest({
    userId,
    limit,
    projectId: projectId ?? null,
    status: status ?? null,
    owner: owner ?? null,
    requestedBy: requestedBy ?? null,
  });

  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const after = cursor
        ? decodeKeysetCursor(assignmentCursorNamespace, cursor, scope)
        : null;
      const upper = after?.upper ?? (await upperBound(tx));
      const candidates = (
        await tx.execute(sql`
          SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
          FROM specialist_assignments
          WHERE created_at<=${upper}::timestamptz
            ${projectId ? sql`AND project_id=${projectId}` : sql``}
            ${status ? sql`AND status=${status}` : sql``}
            ${owner === "company" ? sql`AND project_id IS NULL` : owner === "project" ? sql`AND project_id IS NOT NULL` : sql``}
            ${requestedBy ? sql`AND requester->>'kind'='user' AND requester->>'id'=${requestedBy}` : sql``}
            ${after ? sql`AND (created_at,id)<(${after.at}::timestamptz,${after.id})` : sql``}
          ORDER BY created_at DESC,id DESC
          LIMIT ${limit * scanFactor + 1}
        `)
      ).rows as { id: string; at: string }[];
      const items: SpecialistAssignment[] = [];
      let last: { id: string; at: string } | undefined;

      for (const candidate of candidates.slice(0, limit * scanFactor)) {
        if (items.length === limit) break;
        last = candidate;
        try {
          items.push(
            await getVisibleSpecialistAssignmentInTransaction(
              tx,
              userId,
              candidate.id,
            ),
          );
        } catch (error) {
          if (!refusedRead(error)) throw error;
        }
      }
      const exhausted =
        candidates.length <= limit * scanFactor && last === candidates.at(-1);

      return {
        items,
        nextCursor:
          last && !exhausted
            ? encodeKeysetCursor(assignmentCursorNamespace, {
                version: 1,
                scope,
                upper,
                at: last.at,
                id: last.id,
              })
            : null,
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/**
 * Lists delegated work under one readable assignment. State is derived from
 * the persisted decision plus the child Run and its validated results; no
 * second execution status exists.
 */
export async function listSpecialistAssignmentWork(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  raw: unknown,
): Promise<Page<SpecialistWorkItem>> {
  const { cursor, limit } = parsePage(raw);
  const scope = contentDigest({ userId, assignmentId, limit });

  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      await getVisibleSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const after = cursor
        ? decodeKeysetCursor(workCursorNamespace, cursor, scope)
        : null;
      const upper = after?.upper ?? (await upperBound(tx));
      const separator = after?.id.lastIndexOf("#") ?? -1;
      const afterId = after ? after.id.slice(0, separator) : "";
      const afterRevision = after ? Number(after.id.slice(separator + 1)) : 0;
      const rows = (
        await tx.execute(sql`
          SELECT work.id,work.logical_work_id,work.revision,work.input_revision,work.work_revision,
            work.decision_state,work.child_run_id,child.status AS child_status,
            (SELECT max(result.revision) FROM run_results result
              WHERE result.run_id=work.child_run_id AND result.validity='valid') AS result_revision,
            to_char(work.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
          FROM specialist_work work
          LEFT JOIN runs child ON child.id=work.child_run_id
          WHERE work.assignment_id=${assignmentId} AND work.created_at<=${upper}::timestamptz
            ${after ? sql`AND (work.created_at,work.id,work.work_revision)>(${after.at}::timestamptz,${afterId},${afterRevision}::int)` : sql``}
          ORDER BY work.created_at,work.id,work.work_revision
          LIMIT ${limit + 1}
        `)
      ).rows as (WorkRow & { at: string })[];
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);

      return {
        items: selected.map(workItem),
        nextCursor:
          rows.length > limit && last
            ? encodeKeysetCursor(workCursorNamespace, {
                version: 1,
                scope,
                upper,
                at: last.at,
                id: `${last.id}#${last.work_revision}`,
              })
            : null,
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

type WorkRow = {
  id: string;
  logical_work_id: string;
  revision: number;
  input_revision: number;
  work_revision: number;
  decision_state: string;
  child_run_id: string | null;
  child_status: string | null;
  result_revision: number | null;
};

function workItem(row: WorkRow): SpecialistWorkItem {
  const resultRevision =
    row.result_revision === null ? null : Number(row.result_revision);
  const limitations: SpecialistWorkLimitation[] = [];
  let state: SpecialistWorkItem["state"];

  switch (row.decision_state) {
    case "accepted":
    case "rework_requested":
    case "cancelled":
      state = row.decision_state;
      break;
    case "clarification_requested":
      state = "needs_clarification";
      break;
    case "rejected":
      state = "cancelled";
      limitations.push("rejected_without_rework");
      break;
    default:
      if (row.child_run_id === null) state = "queued";
      else if (!isSettledRunStatus(String(row.child_status))) state = "running";
      else if (resultRevision !== null) state = "result_ready";
      else state = "interrupted";
  }

  return {
    id: row.id,
    logicalWorkId: row.logical_work_id,
    revision: Number(row.revision),
    inputRevision: Number(row.input_revision),
    workRevision: Number(row.work_revision),
    state,
    childRunId: row.child_run_id,
    resultRevision,
    limitations,
  };
}
