import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskQualificationValue } from "@/lib/tasks/qualification-types";
import type { TaskQualificationReceipt } from "@/lib/tasks/qualification";
import type { ActivityPage } from "@/lib/agents/activity-queries";

import { sql } from "drizzle-orm";
import { eq, and, desc } from "drizzle-orm";

import { taskQualificationReceipt } from "@/lib/tasks/qualification";
import { taskQualifications } from "@/lib/db/schema";
import {
  encodeAgentActivityCursor,
  decodeAgentActivityCursor,
} from "@/lib/agents/activity-cursor";
import { MaisterError } from "@/lib/errors";

export type TaskQualificationSummary = {
  required: boolean;
  mode: "legacy" | "required" | "execution_child";
  inputRevision: number;
  qualificationRevision: number | null;
  qualificationId: string | null;
  decision: TaskQualificationValue["decision"] | null;
  publicationState: "candidate" | "accepted" | "rejected" | null;
  freshness: "current" | "stale" | "unassessed";
  blockedReason: string | null;
  nextActions: string[];
  candidate: TaskQualificationReceipt | null;
};

/** One bounded batch supplies task_get/list and all Incoming partitions; assessment bodies remain behind a separate grant. */
export async function getTaskQualificationSummaries(
  db: Db,
  taskIds: readonly string[],
): Promise<Map<string, TaskQualificationSummary>> {
  if (!taskIds.length) return new Map();
  const result = await db.execute<{
    id: string;
    mode: TaskQualificationSummary["mode"];
    input_revision: number;
    qualification_id: string | null;
    qualification_revision: number | null;
    decision: TaskQualificationSummary["decision"];
    state: TaskQualificationSummary["publicationState"];
    assessment_input_revision: number | null;
    next_actions: string[] | null;
    candidate: TaskQualificationReceipt | null;
  }>(sql`
    SELECT t.id,t.qualification_mode mode,t.qualification_input_revision input_revision,
      q.id qualification_id,q.revision qualification_revision,q.value->>'decision' decision,
      q.publication_state state,q.input_revision assessment_input_revision,q.value->'nextActions' next_actions,
      (SELECT jsonb_build_object('qualificationId',c.id,'inputRevision',c.input_revision,
        'qualificationRevision',c.revision,'publicationState',c.publication_state,
        'decision',c.value->>'decision','publicationReason',c.publication_reason)
       FROM task_qualifications c WHERE c.task_id=t.id AND c.input_revision=t.qualification_input_revision
         AND c.author_kind='agent_run' AND c.publication_state IN ('candidate','rejected')
       ORDER BY c.revision DESC LIMIT 1) candidate
    FROM tasks t LEFT JOIN task_qualifications q ON q.id=t.current_qualification_id AND q.task_id=t.id
    WHERE t.id IN ${[...taskIds]}`);

  return new Map(
    result.rows.map((row) => {
      const current =
        row.state === "accepted" &&
        row.assessment_input_revision === row.input_revision;
      const ready = current && row.decision === "ready";
      const required = row.mode === "required";

      return [
        row.id,
        {
          required,
          mode: row.mode,
          inputRevision: row.input_revision,
          qualificationId: row.qualification_id,
          qualificationRevision: row.qualification_revision,
          decision: current ? row.decision : null,
          publicationState:
            row.state ?? row.candidate?.publicationState ?? null,
          freshness:
            current || row.mode === "execution_child"
              ? "current"
              : row.qualification_id
                ? "stale"
                : "unassessed",
          blockedReason:
            !required || ready
              ? null
              : current
                ? row.decision
                : (row.candidate?.publicationReason ??
                  "qualification_required"),
          nextActions: current ? (row.next_actions ?? []) : [],
          candidate: row.candidate,
        } satisfies TaskQualificationSummary,
      ];
    }),
  );
}

export type TaskQualificationHistoryItem = TaskQualificationReceipt & {
  assessedAt: string;
  authorKind: "user" | "project_token" | "agent_run";
  runId: string | null;
  evidenceTarget: string;
  evidenceSha: string | null;
  qualification: TaskQualificationValue;
};

export async function getTaskQualificationHistory(
  db: Db,
  input: { projectId: string; taskId: string; cursor?: string; limit?: number },
): Promise<ActivityPage<TaskQualificationHistoryItem>> {
  const limit = input.limit ?? 25;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new MaisterError(
      "CONFIG",
      "Qualification history limit must be 1–100",
    );
  const scope = JSON.stringify([
    "task-qualifications",
    input.projectId,
    input.taskId,
  ]);
  const cursor = input.cursor
    ? decodeAgentActivityCursor(scope, input.cursor)
    : null;
  const now = cursor
    ? null
    : await db.execute<{ at: string }>(
        sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`,
      );
  const asOf = cursor?.upper ?? now!.rows[0].at;
  const rows = await db
    .select({
      assessment: taskQualifications,
      at: sql<string>`to_char(${taskQualifications.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.taskId, input.taskId),
        eq(taskQualifications.projectId, input.projectId),
        sql`${taskQualifications.createdAt}<=${asOf}::timestamptz`,
        ...(cursor
          ? [
              sql`(${taskQualifications.createdAt},${taskQualifications.id})<(${cursor.at}::timestamptz,${cursor.id})`,
            ]
          : []),
      ),
    )
    .orderBy(desc(taskQualifications.createdAt), desc(taskQualifications.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(({ assessment: row, at }) => ({
    ...taskQualificationReceipt(row),
    assessedAt: at,
    authorKind: row.authorKind,
    runId: row.authorRunId,
    evidenceTarget: row.evidenceTarget,
    evidenceSha: row.evidenceSha,
    qualification: row.value,
  }));
  const last = rows[Math.min(rows.length, limit) - 1];

  return {
    items,
    asOf,
    nextCursor:
      rows.length > limit && last
        ? encodeAgentActivityCursor(scope, {
            upper: asOf,
            at: last.at,
            id: last.assessment.id,
          })
        : null,
  };
}
