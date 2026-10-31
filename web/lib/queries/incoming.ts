import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { tasks, taskQualifications } from "@/lib/db/schema";
import { incomingWorkPredicate } from "@/lib/tasks/qualification-predicates";
import {
  getTaskQualificationSummaries,
  type TaskQualificationSummary,
} from "@/lib/tasks/qualification-queries";
import { MaisterError } from "@/lib/errors";

export type IncomingFilter =
  "unassessed" | "needs_information" | "needs_review" | "not_actionable";
export type IncomingRequest = {
  id: string;
  number: number;
  title: string;
  qualification: TaskQualificationSummary;
};
export async function getIncomingRequests(
  projectId: string,
  page: number,
  state?: IncomingFilter,
): Promise<{ items: IncomingRequest[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
    throw new MaisterError(
      "CONFIG",
      "Incoming page must be between 1 and 1000",
    );
  const db = getDb();
  const rows = await db
    .select({ id: tasks.id, number: tasks.number, title: tasks.title })
    .from(tasks)
    .leftJoin(
      taskQualifications,
      and(
        eq(taskQualifications.id, tasks.currentQualificationId),
        eq(taskQualifications.inputRevision, tasks.qualificationInputRevision),
        eq(taskQualifications.publicationState, "accepted"),
      ),
    )
    .where(
      and(
        eq(tasks.projectId, projectId),
        incomingWorkPredicate(),
        state === "unassessed"
          ? sql`${taskQualifications.id} IS NULL`
          : state
            ? sql`${taskQualifications.value}->>'decision'=${state}`
            : undefined,
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(26)
    .offset((page - 1) * 25);
  const summaries = await getTaskQualificationSummaries(
    db,
    rows.slice(0, 25).map((row) => row.id),
  );

  return {
    items: rows.slice(0, 25).map((row) => {
      const qualification = summaries.get(row.id);

      if (!qualification)
        throw new MaisterError(
          "PRECONDITION",
          "Incoming qualification is unavailable",
        );

      return { ...row, qualification };
    }),
    hasMore: rows.length > 25,
  };
}
