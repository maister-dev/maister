import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
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
  | "requires"
  | "duplicate_of";

export type KeyRef = { taskId: string; key: string; number: number };

// ADR-121 §4.6: only these kinds gate execution, so only they can deadlock — a
// cycle among them is refused at write time. `parent_of`/`duplicate_of` are
// non-gating and never checked.
export const GATING_RELATION_KINDS = [
  "blocks",
  "depends_on",
  "requires",
] as const;

function isGatingKind(kind: TaskRelationKind): boolean {
  return (GATING_RELATION_KINDS as readonly string[]).includes(kind);
}

// Normalize a gating relation to a single directed PRECEDENCE edge `pred → succ`
// (pred must finish before succ). `blocks(from,to)` ⇒ from precedes to; both
// `depends_on(from,to)` and `requires(from,to)` ⇒ to precedes from. This collapses
// `blocks` and its inverse `depends_on` onto one directed graph (§4.6).
function precedenceEdge(
  kind: TaskRelationKind,
  fromTaskId: string,
  toTaskId: string,
): { pred: string; succ: string } {
  if (kind === "blocks") return { pred: fromTaskId, succ: toTaskId };

  return { pred: toTaskId, succ: fromTaskId };
}

function dbIsPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

// Per-project advisory lock so two transactions racing to insert inverse gating
// edges are serialized — the second waits, re-reads the now-committed first edge,
// and its cycle check rejects (INV-6, no TOCTOU). Held until the top-level tx ends.
// Skipped on sqlite (single-writer already serializes). The namespace constant
// keeps this lock space disjoint from the scheduler's (`0x6d616973`).
const RELATION_LOCK_NAMESPACE = 0x7461736b;

async function takeProjectRelationLock(
  tx: any,
  projectId: string,
): Promise<void> {
  if (!dbIsPostgres()) return;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${RELATION_LOCK_NAMESPACE}, hashtext(${projectId}))`,
  );
}

// Does adding the precedence edge `pred → succ` close a cycle? It does iff `succ`
// can ALREADY reach `pred` over the existing project-scoped gating graph. Portable
// BFS over the drizzle query builder (works on PG + sqlite); run INSIDE the insert
// tx after the advisory lock so the read sees a serialized, committed graph.
async function wouldCloseGatingCycle(
  tx: any,
  projectId: string,
  pred: string,
  succ: string,
): Promise<boolean> {
  const visited = new Set<string>();
  let frontier: string[] = [succ];

  while (frontier.length > 0) {
    if (frontier.includes(pred)) return true;

    const fresh = frontier.filter((n) => !visited.has(n));

    for (const n of fresh) visited.add(n);
    if (fresh.length === 0) break;

    // Precedence successors: blocks(from→to) advances from→to; depends_on/requires
    // (from→to) advance to→from.
    const forward = (await tx
      .select({ succ: taskRelations.toTaskId })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.projectId, projectId),
          eq(taskRelations.kind, "blocks"),
          inArray(taskRelations.fromTaskId, fresh),
        ),
      )) as Array<{ succ: string }>;

    const reverse = (await tx
      .select({ succ: taskRelations.fromTaskId })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.projectId, projectId),
          inArray(taskRelations.kind, ["depends_on", "requires"]),
          inArray(taskRelations.toTaskId, fresh),
        ),
      )) as Array<{ succ: string }>;

    frontier = [...forward, ...reverse]
      .map((r) => r.succ)
      .filter((n) => !visited.has(n));
  }

  return false;
}

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
    // ADR-121 §4.6: refuse a gating-kind edge that would close a cycle, evaluated
    // INSIDE the tx under a per-project advisory lock (no TOCTOU, INV-6).
    if (isGatingKind(input.kind)) {
      await takeProjectRelationLock(tx, input.projectId);

      const { pred, succ } = precedenceEdge(
        input.kind,
        input.fromTaskId,
        input.toTaskId,
      );

      if (await wouldCloseGatingCycle(tx, input.projectId, pred, succ)) {
        log.warn(
          { from: input.fromTaskId, kind: input.kind, to: input.toTaskId },
          "relation cycle refused",
        );
        throw new MaisterError(
          "CONFLICT",
          `relation would close a dependency cycle (${input.kind})`,
        );
      }

      log.debug(
        { from: input.fromTaskId, kind: input.kind, to: input.toTaskId },
        "relation cycle-check passed",
      );
    }

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
// M37 (ADR-098): (T requires Y) is SUCCESS-GATED — Y blocks T unless Y is Done
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

  // M37 (ADR-098): success-gated `requires` — (T requires Y) blocks T while Y
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

export async function getTaskRelationsByTaskIds(
  taskIds: string[],
  db?: Db,
): Promise<Map<string, TaskRelationView[]>> {
  const relationsByTask = new Map<string, TaskRelationView[]>();

  if (taskIds.length === 0) return relationsByTask;

  const _db = (db ?? getDb()) as unknown as { select: any };

  const outgoing = (await _db
    .select({
      taskId: taskRelations.fromTaskId,
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
    .where(inArray(taskRelations.fromTaskId, taskIds))) as Array<any>;

  const incoming = (await _db
    .select({
      taskId: taskRelations.toTaskId,
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
    .where(inArray(taskRelations.toTaskId, taskIds))) as Array<any>;

  function pushRelation(
    row: any,
    direction: TaskRelationView["direction"],
  ): void {
    const list = relationsByTask.get(row.taskId) ?? [];

    list.push({
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
    relationsByTask.set(row.taskId, list);
  }

  for (const row of outgoing) pushRelation(row, "out");
  for (const row of incoming) pushRelation(row, "in");

  return relationsByTask;
}
