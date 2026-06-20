import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity, type SocialActor } from "@/lib/social/activity";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { projects, taskRelations, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "social-relations",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TaskRelationKind =
  | "blocks"
  | "depends_on"
  | "parent_of"
  | "requires";

export type KeyRef = { taskId: string; key: string; number: number };

type RelationEnd = {
  id: string;
  projectId: string;
  number: number;
  taskKey: string;
};

async function resolveEnds(
  db: any,
  fromTaskId: string,
  toTaskId: string,
): Promise<{ from: RelationEnd; to: RelationEnd }> {
  const rows = (await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      number: tasks.number,
      taskKey: projects.taskKey,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.id, [fromTaskId, toTaskId]))) as RelationEnd[];

  const from = rows.find((r) => r.id === fromTaskId);
  const to = rows.find((r) => r.id === toTaskId);

  if (!from || !to) {
    throw new MaisterError(
      "PRECONDITION",
      `relation endpoint task not found: ${!from ? fromTaskId : toTaskId}`,
    );
  }

  return { from, to };
}

export async function addTaskRelation(
  input: {
    projectId: string;
    fromTaskId: string;
    kind: TaskRelationKind;
    toTaskId: string;
    actor: SocialActor;
  },
  db?: Db,
): Promise<{ created: boolean }> {
  const _db = db ?? getDb();

  if (input.fromTaskId === input.toTaskId) {
    throw new MaisterError("CONFIG", "a task cannot relate to itself");
  }

  const { from, to } = await resolveEnds(_db, input.fromTaskId, input.toTaskId);

  // Same-project only in Stage 1 (ADR-078 D4) — a cross-table CHECK cannot
  // express this, so the domain layer enforces it.
  if (from.projectId !== input.projectId || to.projectId !== input.projectId) {
    throw new MaisterError(
      "CONFIG",
      "relations are same-project only in Stage 1",
    );
  }

  const created = await (_db as any).transaction(async (tx: any) => {
    const inserted = await tx
      .insert(taskRelations)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        fromTaskId: input.fromTaskId,
        kind: input.kind,
        toTaskId: input.toTaskId,
        actorType: input.actor.type,
        actorId: input.actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: taskRelations.id });

    if (inserted.length === 0) {
      // Duplicate — idempotent no-op, existing state returned, no activity.
      return false;
    }

    await recordTaskActivity(tx, {
      taskId: input.fromTaskId,
      projectId: input.projectId,
      actor: input.actor,
      eventKind: "relation_added",
      payload: {
        kind: input.kind,
        fromTaskId: from.id,
        toTaskId: to.id,
        fromRef: `${from.taskKey}-${from.number}`,
        toRef: `${to.taskKey}-${to.number}`,
      },
    });

    return true;
  });

  log.info(
    {
      fromTaskId: input.fromTaskId,
      kind: input.kind,
      toTaskId: input.toTaskId,
      actor: input.actor.type,
      created,
    },
    "relation added",
  );

  return { created };
}

export async function removeTaskRelation(
  input: {
    projectId: string;
    fromTaskId: string;
    kind: TaskRelationKind;
    toTaskId: string;
    actor: SocialActor;
  },
  db?: Db,
): Promise<{ removed: boolean }> {
  const _db = db ?? getDb();
  const { from, to } = await resolveEnds(_db, input.fromTaskId, input.toTaskId);

  const removed = await (_db as any).transaction(async (tx: any) => {
    const deleted = await tx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.fromTaskId, input.fromTaskId),
          eq(taskRelations.kind, input.kind),
          eq(taskRelations.toTaskId, input.toTaskId),
        ),
      )
      .returning({ id: taskRelations.id });

    if (deleted.length === 0) {
      return false;
    }

    await recordTaskActivity(tx, {
      taskId: input.fromTaskId,
      projectId: input.projectId,
      actor: input.actor,
      eventKind: "relation_removed",
      payload: {
        kind: input.kind,
        fromTaskId: from.id,
        toTaskId: to.id,
        fromRef: `${from.taskKey}-${from.number}`,
        toRef: `${to.taskKey}-${to.number}`,
      },
    });

    return true;
  });

  log.info(
    {
      fromTaskId: input.fromTaskId,
      kind: input.kind,
      toTaskId: input.toTaskId,
      actor: input.actor.type,
      removed,
    },
    "relation removed",
  );

  return { removed };
}

// Blocking predicate (ADR-078 D5): task T is relation-blocked iff there is a
// relation (X blocks T) or (T depends_on Y) whose counterpart task status is
// Backlog or InFlight — Done AND Abandoned both release. parent_of never gates.
// M36 (ADR-095): (T requires Y) is SUCCESS-GATED — Y blocks T unless Y is Done
// (Failed/Abandoned keep T blocked, unlike depends_on), so an auto-DAG only
// releases a dependent on a successful dependency.
export async function getOpenRelationBlockers(
  taskIds: string[],
  db?: Db,
): Promise<Map<string, KeyRef[]>> {
  const blockers = new Map<string, KeyRef[]>();

  if (taskIds.length === 0) return blockers;

  const _db = (db ?? getDb()) as unknown as { select: any };

  const incoming = (await _db
    .select({
      taskId: taskRelations.toTaskId,
      blockerId: tasks.id,
      number: tasks.number,
      key: projects.taskKey,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.fromTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(taskRelations.kind, "blocks"),
        inArray(taskRelations.toTaskId, taskIds),
        or(eq(tasks.status, "Backlog"), eq(tasks.status, "InFlight")),
      ),
    )) as Array<{
    taskId: string;
    blockerId: string;
    number: number;
    key: string;
  }>;

  const outgoing = (await _db
    .select({
      taskId: taskRelations.fromTaskId,
      blockerId: tasks.id,
      number: tasks.number,
      key: projects.taskKey,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.toTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(taskRelations.kind, "depends_on"),
        inArray(taskRelations.fromTaskId, taskIds),
        or(eq(tasks.status, "Backlog"), eq(tasks.status, "InFlight")),
      ),
    )) as Array<{
    taskId: string;
    blockerId: string;
    number: number;
    key: string;
  }>;

  // M36 (ADR-095): success-gated `requires` — (T requires Y) blocks T while Y
  // is NOT Done. Unlike depends_on, an Abandoned/Failed Y keeps T blocked, so a
  // dependent in an auto-DAG only releases on a SUCCESSFUL dependency.
  const requiresOutgoing = (await _db
    .select({
      taskId: taskRelations.fromTaskId,
      blockerId: tasks.id,
      number: tasks.number,
      key: projects.taskKey,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.toTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(taskRelations.kind, "requires"),
        inArray(taskRelations.fromTaskId, taskIds),
        ne(tasks.status, "Done"),
      ),
    )) as Array<{
    taskId: string;
    blockerId: string;
    number: number;
    key: string;
  }>;

  for (const row of [...incoming, ...outgoing, ...requiresOutgoing]) {
    const list = blockers.get(row.taskId) ?? [];

    if (!list.some((b) => b.taskId === row.blockerId)) {
      list.push({ taskId: row.blockerId, key: row.key, number: row.number });
    }
    blockers.set(row.taskId, list);
  }

  return blockers;
}

export type TaskRelationView = {
  id: string;
  direction: "out" | "in";
  kind: TaskRelationKind;
  other: {
    taskId: string;
    key: string;
    number: number;
    title: string;
    status: string;
  };
};

export async function getTaskRelations(
  taskId: string,
  db?: Db,
): Promise<TaskRelationView[]> {
  const _db = (db ?? getDb()) as unknown as { select: any };

  const outgoing = (await _db
    .select({
      id: taskRelations.id,
      kind: taskRelations.kind,
      otherId: tasks.id,
      number: tasks.number,
      key: projects.taskKey,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.toTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(taskRelations.fromTaskId, taskId))) as Array<any>;

  const incoming = (await _db
    .select({
      id: taskRelations.id,
      kind: taskRelations.kind,
      otherId: tasks.id,
      number: tasks.number,
      key: projects.taskKey,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.fromTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(taskRelations.toTaskId, taskId))) as Array<any>;

  const view =
    (direction: "out" | "in") =>
    (row: any): TaskRelationView => ({
      id: row.id,
      direction,
      kind: row.kind,
      other: {
        taskId: row.otherId,
        key: row.key,
        number: row.number,
        title: row.title,
        status: row.status,
      },
    });

  return [...outgoing.map(view("out")), ...incoming.map(view("in"))];
}
