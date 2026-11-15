import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { SpecialistAssignment, SpecialistAssignmentStatus } from "./types";
import type { KnowledgePrincipalIdentity } from "@/lib/brain/knowledge-access";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  beginAssignmentTransaction,
  getVisibleSpecialistAssignmentInTransaction,
  isReadableAssignmentRun,
} from "./store";
import { exactCollectedWorkResult, isWorkDecisionState } from "./work-result";

import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { isSettledRunStatus } from "@/lib/runs/run-status-sets";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { knowledgeSourceReadPolicy } from "@/lib/brain/knowledge-query-policy";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

const assignmentCursorNamespace = "maister.specialist-assignments.v1";
const workCursorNamespace = "maister.specialist-work.v1";

type AssignmentReader = Extract<KnowledgePrincipalIdentity, { kind: "user" }>;

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
  canAccept: boolean;
  canReject: boolean;
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

async function assignmentReader(
  tx: SqlTransaction,
  userId: string,
): Promise<AssignmentReader> {
  const identity = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:read",
  );

  if (identity.kind !== "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Assignment lists require a current user",
    );

  return identity;
}

function readableAssignmentInput(
  identity: AssignmentReader,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  return knowledgeSourceReadPolicy(
    identity,
    sql`jsonb_build_object(
    'kind','assignment_input','assignmentId',${assignmentId},
    'inputRevision',${revision},'inputSha256',${digest})`,
  );
}

function readableRestrictions(
  identity: AssignmentReader,
  restrictions: SQL,
): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM native_knowledge_source_restrictions(${restrictions}) source
    WHERE NOT (${knowledgeSourceReadPolicy(identity, sql`source`)})
  )`;
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
 * Apply current source access before computing the page boundary.
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
      const identity = await assignmentReader(tx, userId);

      await tx.execute(sql`SET LOCAL jit=off`);
      const after = cursor
        ? decodeKeysetCursor(assignmentCursorNamespace, cursor, scope)
        : null;
      const upper = after?.upper ?? (await upperBound(tx));
      const candidates = (
        await tx.execute(sql`
          SELECT head.id,to_char(head.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
          FROM specialist_assignments head
          JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=head.input_revision
          WHERE head.created_at<=${upper}::timestamptz
            AND (${readableAssignmentInput(identity, sql`head.id`, sql`input.revision`, sql`input.digest`)})
            ${projectId ? sql`AND head.project_id=${projectId}` : sql``}
            ${status ? sql`AND head.status=${status}` : sql``}
            ${owner === "company" ? sql`AND head.project_id IS NULL` : owner === "project" ? sql`AND head.project_id IS NOT NULL` : sql``}
            ${requestedBy ? sql`AND head.requester->>'kind'='user' AND head.requester->>'id'=${requestedBy}` : sql``}
            ${after ? sql`AND (head.created_at,head.id)<(${after.at}::timestamptz,${after.id})` : sql``}
          ORDER BY head.created_at DESC,head.id DESC
          LIMIT ${limit + 1}
        `)
      ).rows as { id: string; at: string }[];
      const items: SpecialistAssignment[] = [];
      let last: { id: string; at: string } | undefined;

      for (const candidate of candidates.slice(0, limit)) {
        try {
          items.push(
            await getVisibleSpecialistAssignmentInTransaction(
              tx,
              userId,
              candidate.id,
            ),
          );
          last = candidate;
        } catch (error) {
          if (!refusedRead(error)) throw error;
        }
      }

      return {
        items,
        nextCursor:
          last && candidates.length > limit
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
      const assignment = await getVisibleSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const identity = await assignmentReader(tx, userId);

      await tx.execute(sql`SET LOCAL jit=off`);
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
              WHERE result.run_id=work.child_run_id
                AND ${exactCollectedWorkResult(
                  sql`work.definition#>>'{objectiveInput,expectedResult,schemaRef}'`,
                  sql`work.definition#>>'{objectiveInput,expectedResult,schemaVersion}'`,
                  sql`work.definition#>>'{objectiveInput,expectedResult,sha256}'`,
                )}) AS result_revision,
            work.definition#>>'{objectiveInput,expectedResult,required}'='true'
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(work.definition#>'{objectiveInput,verification}') obligation
                WHERE obligation->>'required'='true' AND obligation->>'kind'<>'result'
              ) AS verification_eligible,
            to_char(work.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
          FROM specialist_work work
          JOIN specialist_input_revisions input ON input.assignment_id=work.assignment_id AND input.revision=work.input_revision
          LEFT JOIN runs child ON child.id=work.child_run_id
          WHERE work.assignment_id=${assignmentId} AND work.created_at<=${upper}::timestamptz
            AND ${readableAssignmentInput(identity, sql`work.assignment_id`, sql`input.revision`, sql`input.digest`)}
            AND ${readableRestrictions(identity, sql`work.source_restrictions`)}
            AND (work.child_run_id IS NULL OR (
              child.knowledge_access IS NULL AND child.result_contract->>'nativeContract' IS DISTINCT FROM ${FINDINGS_CONTRACT}
              OR child.workspace_mode IS DISTINCT FROM 'shared'
                AND child.knowledge_access->>'state'='complete'
                AND jsonb_typeof(child.knowledge_access->'restrictions')='array'
                AND ${readableRestrictions(identity, sql`CASE WHEN jsonb_typeof(child.knowledge_access->'restrictions')='array' THEN child.knowledge_access->'restrictions' END`)}
            ))
            ${after ? sql`AND (work.created_at,work.id,work.work_revision)>(${after.at}::timestamptz,${afterId},${afterRevision}::int)` : sql``}
          ORDER BY work.created_at,work.id,work.work_revision
          LIMIT ${limit + 1}
        `)
      ).rows as (WorkRow & { at: string })[];
      const selected: typeof rows = [];

      for (const row of rows) {
        if (
          row.child_run_id === null ||
          (await isReadableAssignmentRun(
            tx,
            userId,
            assignment.owner.kind,
            row.child_run_id,
          ))
        )
          selected.push(row);
      }
      const hasNext = selected.length > limit;

      if (hasNext) selected.pop();
      const last = selected.at(-1);

      return {
        items: selected.map((row) => workItem(row, assignment)),
        nextCursor:
          hasNext && last
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
  verification_eligible: boolean | null;
};

function workItem(
  row: WorkRow,
  assignment: SpecialistAssignment,
): SpecialistWorkItem {
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

  const canReject =
    row.decision_state === "open" &&
    state === "result_ready" &&
    row.input_revision === assignment.inputRevision &&
    row.revision < 2147483647 &&
    assignment.revision < 2147483647 &&
    assignment.contextRevision < 2147483647 &&
    !assignment.cancellationPending &&
    isWorkDecisionState(assignment.status);

  return {
    id: row.id,
    logicalWorkId: row.logical_work_id,
    revision: Number(row.revision),
    inputRevision: Number(row.input_revision),
    workRevision: Number(row.work_revision),
    state,
    childRunId: row.child_run_id,
    resultRevision,
    canAccept: canReject && row.verification_eligible === true,
    canReject,
    limitations,
  };
}
