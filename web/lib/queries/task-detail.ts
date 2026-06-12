import "server-only";

import type { ActorDTO } from "@/lib/social/actors";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { actorDTO, resolveActorLabels } from "@/lib/social/actors";
import {
  getTaskRelations,
  type TaskRelationView,
} from "@/lib/social/relations";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs, taskActivity, taskComments, taskSubscribers } =
  schemaModule as unknown as Record<string, any>;

export type TimelineItem =
  | {
      kind: "comment";
      id: string;
      body: string;
      actor: ActorDTO;
      createdAt: Date;
    }
  | {
      kind: "activity";
      id: string;
      eventKind: string;
      payload: Record<string, unknown>;
      actor: ActorDTO;
      createdAt: Date;
    };

// Merge comments and activity ascending by (createdAt, id). `comment_added`
// activity rows are SKIPPED — the comment itself renders in their place; the
// duplicate row exists for the Log page and analytics, not the timeline.
export function interleaveTimeline(
  comments: Array<{
    id: string;
    body: string;
    actor: ActorDTO;
    createdAt: Date;
  }>,
  activity: Array<{
    id: string;
    eventKind: string;
    payload: Record<string, unknown>;
    actor: ActorDTO;
    createdAt: Date;
  }>,
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...comments.map((c) => ({ kind: "comment" as const, ...c })),
    ...activity
      .filter((a) => a.eventKind !== "comment_added")
      .map((a) => ({ kind: "activity" as const, ...a })),
  ];

  return items.sort((a, b) => {
    const delta = a.createdAt.getTime() - b.createdAt.getTime();

    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

export type TaskRunRow = {
  id: string;
  status: string;
  flowVersion: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type TaskDetailData = {
  project: { id: string; slug: string; name: string; taskKey: string };
  task: {
    id: string;
    number: number;
    title: string;
    prompt: string;
    status: string;
    // M33: the triager's verdict mark (nullable 'triaged').
    triageStatus: "triaged" | null;
  };
  keyRef: string;
  relations: TaskRelationView[];
  timeline: TimelineItem[];
  isFollowing: boolean;
  runs: TaskRunRow[];
  latestFlowRun: {
    id: string;
    status: string;
    currentStepId: string | null;
  } | null;
};

export async function getTaskDetail(
  slug: string,
  number: number,
  userId: string,
): Promise<TaskDetailData | null> {
  const db = getDb() as unknown as { select: any };
  const resolved = await resolveProjectTaskByNumber(slug, number);

  if (!resolved) return null;

  const taskId = resolved.task.id;

  const [projectRow] = (await db
    .select({ name: schemaModule.projects.name })
    .from(schemaModule.projects)
    .where(eq(schemaModule.projects.id, resolved.project.id))) as Array<{
    name: string;
  }>;

  const commentRows = (await db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt, taskComments.id)) as Array<{
    id: string;
    body: string;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
  }>;
  const activityRows = (await db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(taskActivity.createdAt, taskActivity.id)) as Array<{
    id: string;
    eventKind: string;
    payload: Record<string, unknown>;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
  }>;

  const labels = await resolveActorLabels([...commentRows, ...activityRows]);

  const timeline = interleaveTimeline(
    commentRows.map((c) => ({
      id: c.id,
      body: c.body,
      actor: actorDTO(c, labels),
      createdAt: c.createdAt,
    })),
    activityRows.map((a) => ({
      id: a.id,
      eventKind: a.eventKind,
      payload: a.payload,
      actor: actorDTO(a, labels),
      createdAt: a.createdAt,
    })),
  );

  const relations = await getTaskRelations(taskId);

  const following = (await db
    .select({ id: taskSubscribers.id })
    .from(taskSubscribers)
    .where(
      and(
        eq(taskSubscribers.taskId, taskId),
        eq(taskSubscribers.subscriberType, "user"),
        eq(taskSubscribers.subscriberId, userId),
      ),
    )) as Array<{ id: string }>;

  const runRows = (await db
    .select({
      id: runs.id,
      status: runs.status,
      flowVersion: runs.flowVersion,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt))) as Array<{
    id: string;
    status: string;
    flowVersion: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    currentStepId: string | null;
  }>;

  const latest = runRows[0] ?? null;

  return {
    project: {
      id: resolved.project.id,
      slug: resolved.project.slug,
      name: projectRow?.name ?? resolved.project.slug,
      taskKey: resolved.project.taskKey,
    },
    task: {
      id: taskId,
      number: resolved.task.number,
      title: resolved.task.title,
      ...(await taskExtrasOf(db, taskId)),
      status: resolved.task.status,
    },
    keyRef: `${resolved.project.taskKey}-${resolved.task.number}`,
    relations,
    timeline,
    isFollowing: following.length > 0,
    runs: runRows.map(({ currentStepId: _omit, ...row }) => row),
    latestFlowRun: latest
      ? {
          id: latest.id,
          status: latest.status,
          currentStepId: latest.currentStepId,
        }
      : null,
  };
}

async function taskExtrasOf(
  db: { select: any },
  taskId: string,
): Promise<{ prompt: string; triageStatus: "triaged" | null }> {
  const rows = (await db
    .select({
      prompt: schemaModule.tasks.prompt,
      triageStatus: schemaModule.tasks.triageStatus,
    })
    .from(schemaModule.tasks)
    .where(eq(schemaModule.tasks.id, taskId))) as Array<{
    prompt: string;
    triageStatus: "triaged" | null;
  }>;

  return {
    prompt: rows[0]?.prompt ?? "",
    triageStatus: rows[0]?.triageStatus ?? null,
  };
}
