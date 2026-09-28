import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import {
  librarianTaskLinks,
  taskStatementRevisions,
  tasks,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { updateTask } from "@/lib/services/tasks";
import { recordTaskActivity, type SocialActor } from "@/lib/social/activity";

export const taskStatementSchema = z.object({
  context: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  acceptance: z.array(z.string().trim().min(1)),
  constraints: z.array(z.string().trim().min(1)),
  outOfScope: z.array(z.string().trim().min(1)),
  links: z.array(z.string().trim().min(1)),
  openQuestions: z.array(z.string().trim().min(1)),
}).strict();

export type TaskStatement = z.infer<typeof taskStatementSchema>;

const log = pino({
  name: "task.statement",
  level: process.env.LOG_LEVEL ?? "info",
});

function section(title: string, items: readonly string[]): string {
  return `## ${title}\n${items.length === 0 ? "None" : items.map((item) => `- ${item}`).join("\n")}`;
}

export function renderStatementPrompt(statement: TaskStatement): string {
  return [
    "# Task statement",
    `## Context\n${statement.context}`,
    `## Goal\n${statement.goal}`,
    section("Acceptance criteria", statement.acceptance),
    section("Constraints", statement.constraints),
    section("Out of scope", statement.outOfScope),
    section("Links", statement.links),
    section("Open questions", statement.openQuestions),
  ].join("\n\n");
}

export async function acceptStatement(
  input: {
    projectId: string;
    taskId: string;
    conversationId: string;
    statement: TaskStatement;
    expectedRevision: number;
    actor: SocialActor;
    viaOperationId?: string;
    fromMessageId?: string | null;
    toMessageId?: string | null;
  },
  db: ReturnType<typeof getDb> = getDb(),
): Promise<{ taskId: string; revision: number; statementRevision: number }> {
  const statement = taskStatementSchema.parse(input.statement);

  return db.transaction(async (tx) => {
    const [current] = await tx.select({
      id: tasks.id,
      status: tasks.status,
      revision: tasks.revision,
      statementRevision: tasks.statementRevision,
    }).from(tasks).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.projectId, input.projectId),
    )).for("update");

    if (!current) {
      throw new MaisterError("PRECONDITION", "task not found");
    }
    if (current.revision !== input.expectedRevision) {
      throw new MaisterError("CONFLICT", "task has changed; reload the statement", {
        details: { reason: "stale_revision", actualRevision: current.revision },
      });
    }
    if (current.status !== "Backlog") {
      throw new MaisterError(
        "PRECONDITION",
        "task is not in Backlog; send an operator message to the run or request rework",
        { details: { reason: "task_not_backlog", nextActions: ["run_operator_message", "run_rework"] } },
      );
    }

    const statementRevision = (current.statementRevision ?? 0) + 1;
    const updated = await updateTask(input.taskId, input.projectId, {
      prompt: renderStatementPrompt(statement),
      expectedRevision: input.expectedRevision,
    }, tx);

    await tx.update(tasks)
      .set({ statementRevision })
      .where(eq(tasks.id, input.taskId));
    await tx.insert(taskStatementRevisions).values({
      taskId: input.taskId,
      revision: statementRevision,
      statement: { ...statement },
      authorActorType: input.actor.type,
      authorActorId: input.actor.id,
      viaOperationId: input.viaOperationId ?? null,
    });
    await tx.insert(librarianTaskLinks).values({
      conversationId: input.conversationId,
      taskId: input.taskId,
      meaning: "refined_in",
      fromMessageId: input.fromMessageId ?? null,
      toMessageId: input.toMessageId ?? null,
      statementRevision,
    });
    await recordTaskActivity(tx, {
      taskId: input.taskId,
      projectId: input.projectId,
      actor: input.actor,
      eventKind: "statement_accepted",
      payload: { statementRevision, viaOperationId: input.viaOperationId ?? null },
    });

    log.info({ taskId: input.taskId, revision: updated.revision, operationId: input.viaOperationId ?? null }, "task statement accepted");

    return { taskId: input.taskId, revision: updated.revision, statementRevision };
  });
}
