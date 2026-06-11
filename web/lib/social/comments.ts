import "server-only";

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity, type SocialActor } from "@/lib/social/activity";
import {
  actorDTO,
  resolveActorLabels,
  type ActorDTO,
} from "@/lib/social/actors";
import { fanoutToSubscribers } from "@/lib/social/inbox";
import { expandMentions } from "@/lib/social/mentions";
import { subscribe } from "@/lib/social/subscriptions";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { projects, taskComments, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "social-comments",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TaskCommentRecord = {
  id: string;
  taskId: string;
  body: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  createdAt: Date;
};

// ADR-075 D7: the full comment pipeline runs in ONE db.transaction — mention
// expansion, comment insert, comment_added + task_mentioned activity,
// subscription upserts (first reason wins), and inbox fanout excluding the
// acting pair. No external side-effect ever runs inside the tx.
export async function addTaskComment(
  input: {
    taskId: string;
    body: string;
    actor: SocialActor;
    activityPayloadExtra?: Record<string, unknown>;
  },
  db?: Db,
): Promise<TaskCommentRecord> {
  const _db = (db ?? getDb()) as unknown as { transaction: any };

  const result = await _db.transaction(async (tx: any) => {
    const taskRows = (await tx
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        number: tasks.number,
        taskKey: projects.taskKey,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, input.taskId))) as Array<{
      id: string;
      projectId: string;
      number: number;
      taskKey: string;
    }>;
    const task = taskRows[0];

    if (!task) {
      throw new MaisterError(
        "PRECONDITION",
        `task not found: ${input.taskId}`,
      );
    }

    const { expanded, mentioned } = await expandMentions(input.body, tx);
    // A task mentioning itself stays an expanded link but produces no extra
    // activity/subscription/fanout — the comment itself already notifies.
    const mentionedOthers = mentioned.filter((m) => m.taskId !== task.id);

    const commentId = randomUUID();
    const inserted = (await tx
      .insert(taskComments)
      .values({
        id: commentId,
        taskId: task.id,
        projectId: task.projectId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        body: expanded,
      })
      .returning()) as TaskCommentRecord[];

    const commentActivityId = await recordTaskActivity(tx, {
      taskId: task.id,
      projectId: task.projectId,
      actor: input.actor,
      eventKind: "comment_added",
      payload: { commentId, ...input.activityPayloadExtra },
    });

    if (input.actor.type === "user") {
      await subscribe(tx, {
        taskId: task.id,
        subscriber: { type: "user", id: input.actor.id },
        reason: "commenter",
      });
    }

    // Mention rule (ADR-075 D8): mentioning task B in a comment on task A
    // subscribes B's CREATOR to task A — the owner of the referenced work
    // joins the discussion. Creator-less tasks (project-token automation)
    // simply have no one to subscribe.
    if (mentionedOthers.length > 0) {
      const creatorRows = (await tx
        .select({
          id: tasks.id,
          createdByUserId: tasks.createdByUserId,
        })
        .from(tasks)
        .where(
          inArray(
            tasks.id,
            mentionedOthers.map((m) => m.taskId),
          ),
        )) as Array<{ id: string; createdByUserId: string | null }>;
      const creatorByTask = new Map(
        creatorRows.map((r) => [r.id, r.createdByUserId]),
      );

      for (const mention of mentionedOthers) {
        const mentionActivityId = await recordTaskActivity(tx, {
          taskId: mention.taskId,
          projectId: mention.projectId,
          actor: input.actor,
          eventKind: "task_mentioned",
          payload: {
            fromTaskId: task.id,
            fromKey: `${task.taskKey}-${task.number}`,
            commentId,
          },
        });

        const creatorId = creatorByTask.get(mention.taskId) ?? null;

        if (creatorId) {
          await subscribe(tx, {
            taskId: task.id,
            subscriber: { type: "user", id: creatorId },
            reason: "mentioned",
          });
        }

        await fanoutToSubscribers(tx, {
          taskId: mention.taskId,
          projectId: mention.projectId,
          eventKind: "task_mentioned",
          sourceRef: {
            kind: "mention",
            taskId: mention.taskId,
            commentId,
            activityId: mentionActivityId,
          },
          excludeActor: input.actor,
        });
      }
    }

    const fanout = await fanoutToSubscribers(tx, {
      taskId: task.id,
      projectId: task.projectId,
      eventKind: "comment_added",
      sourceRef: {
        kind: "comment",
        taskId: task.id,
        commentId,
        activityId: commentActivityId,
      },
      excludeActor: input.actor,
    });

    return { comment: inserted[0], mentions: mentionedOthers.length, fanout };
  });

  log.info(
    {
      taskId: input.taskId,
      commentId: result.comment.id,
      mentions: result.mentions,
      fanout: result.fanout,
    },
    "comment added",
  );

  return result.comment;
}

export async function listTaskComments(
  taskId: string,
  paging?: { limit?: number; offset?: number },
  db?: Db,
): Promise<TaskCommentRecord[]> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const limit = Math.min(Math.max(paging?.limit ?? 100, 1), 200);
  const offset = Math.max(paging?.offset ?? 0, 0);

  const rows = (await _db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt, taskComments.id)
    .limit(limit)
    .offset(offset)) as TaskCommentRecord[];

  return rows;
}

export type TaskCommentDTO = {
  id: string;
  taskId: string;
  body: string;
  actor: ActorDTO;
  createdAt: Date;
};

// Explicit DTO projection at the boundary — rows never serialize verbatim.
export async function toCommentDTOs(
  rows: TaskCommentRecord[],
  db?: Db,
): Promise<TaskCommentDTO[]> {
  const labels = await resolveActorLabels(rows, db);

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    body: row.body,
    actor: actorDTO(row, labels),
    createdAt: row.createdAt,
  }));
}
