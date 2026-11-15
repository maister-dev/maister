import "server-only";

import type { SocialActor } from "@/lib/social/activity";
import type { TaskSource, TaskSourceIdentity, TaskSourceOrigin } from "./model";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import {
  githubClosingReference,
  projectGithubHost,
} from "./closing-reference";
import { parseTaskSourceInput } from "./validate";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { snapshotResolvesTask } from "@/lib/runs/delivery-policy";
import { recordTaskActivity } from "@/lib/social/activity";

// FIXME(any): dual drizzle-orm peer-dep variants (matches services/tasks.ts).
const { projects, runs, taskExternalSources, tasks } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "task-external-source",
  level: process.env.LOG_LEVEL ?? "info",
});

const sourceColumns = {
  taskId: taskExternalSources.taskId,
  kind: taskExternalSources.sourceKind,
  instance: taskExternalSources.sourceInstance,
  scope: taskExternalSources.scopeKey,
  externalId: taskExternalSources.externalId,
  externalKey: taskExternalSources.externalKey,
  url: taskExternalSources.externalUrl,
};

/** Service-seam validation: every caller (route, MCP, backfill) is covered. */
export function requireTaskSource(raw: unknown): TaskSource {
  const parsed = parseTaskSourceInput(raw);

  if (!parsed.ok) {
    throw new MaisterError("CONFIG", `invalid source: ${parsed.message}`);
  }

  return parsed.value;
}

function toSource(row: Record<string, unknown>): TaskSource {
  return {
    kind: row.kind as string,
    instance: row.instance as string,
    scope: row.scope as string,
    externalId: row.externalId as string,
    externalKey: (row.externalKey as string | null) ?? null,
    url: (row.url as string | null) ?? null,
  };
}

function identityWhere(projectId: string, identity: TaskSourceIdentity) {
  return and(
    eq(taskExternalSources.projectId, projectId),
    eq(taskExternalSources.sourceKind, identity.kind),
    eq(taskExternalSources.sourceInstance, identity.instance),
    eq(taskExternalSources.externalId, identity.externalId),
  );
}

async function alreadyBoundError(
  tx: Db,
  projectId: string,
  source: TaskSource,
): Promise<MaisterError> {
  const [owner] = await tx
    .select({
      taskId: tasks.id,
      number: tasks.number,
      taskKey: projects.taskKey,
    })
    .from(taskExternalSources)
    .innerJoin(tasks, eq(tasks.id, taskExternalSources.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(identityWhere(projectId, source));

  log.warn(
    {
      projectId,
      kind: source.kind,
      instance: source.instance,
      existingTaskId: owner?.taskId ?? null,
      reason: "source_already_bound",
    },
    "[taskSource.bind] refused",
  );

  return new MaisterError(
    "CONFLICT",
    "this external source is already bound to another task",
    {
      details: {
        reason: "source_already_bound",
        existingTaskId: owner?.taskId ?? null,
        existingTaskKey: owner ? `${owner.taskKey}-${owner.number}` : null,
      },
    },
  );
}

/**
 * Insert a binding inside the caller's transaction. A taken identity throws
 * `CONFLICT source_already_bound`, which rolls back the caller (the task insert
 * of create-with-source), so no orphan task survives a duplicate import.
 */
export async function insertTaskSourceInTx(
  tx: Db,
  input: {
    projectId: string;
    taskId: string;
    source: TaskSource;
    origin: TaskSourceOrigin;
    actor: SocialActor;
  },
): Promise<void> {
  const { projectId, taskId, source, origin, actor } = input;
  const inserted = await tx
    .insert(taskExternalSources)
    .values({
      projectId,
      taskId,
      sourceKind: source.kind,
      sourceInstance: source.instance,
      scopeKey: source.scope,
      externalId: source.externalId,
      externalKey: source.externalKey,
      externalUrl: source.url,
      origin,
      createdByActorType: actor.type,
      createdByActorId: actor.id,
    })
    .onConflictDoNothing({
      target: [
        taskExternalSources.projectId,
        taskExternalSources.sourceKind,
        taskExternalSources.sourceInstance,
        taskExternalSources.externalId,
      ],
    })
    .returning({ id: taskExternalSources.id });

  if (inserted.length === 0)
    throw await alreadyBoundError(tx, projectId, source);

  log.info(
    { projectId, taskId, kind: source.kind, instance: source.instance, origin },
    "[taskSource.bind] created",
  );
}

export async function bindTaskSource(
  input: {
    projectId: string;
    taskId: string;
    source: unknown;
    actor: SocialActor;
    expectedRevision?: number;
  },
  db: Db = getDb(),
): Promise<{ changed: boolean }> {
  const { projectId, taskId, actor } = input;
  const source = requireTaskSource(input.source);

  return db.transaction(async (tx: Db) => {
    const [task] = await tx
      .select({ id: tasks.id, revision: tasks.revision })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .for("update");

    if (!task)
      throw new MaisterError("PRECONDITION", `task not found: ${taskId}`);

    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== task.revision
    ) {
      throw new MaisterError(
        "CONFLICT",
        "task has changed; reload before binding",
        {
          details: { reason: "stale_revision", actualRevision: task.revision },
        },
      );
    }

    const [current] = await tx
      .select(sourceColumns)
      .from(taskExternalSources)
      .where(eq(taskExternalSources.taskId, taskId));

    if (!current) {
      await insertTaskSourceInTx(tx, {
        projectId,
        taskId,
        source,
        actor,
        origin: "manual",
      });

      return { changed: true };
    }

    const bound = toSource(current);

    if (
      bound.kind !== source.kind ||
      bound.instance !== source.instance ||
      bound.externalId !== source.externalId
    ) {
      log.warn(
        { projectId, taskId, reason: "source_conflict" },
        "[taskSource.bind] refused",
      );
      throw new MaisterError(
        "CONFLICT",
        "the task is already bound to a different external source",
        { details: { reason: "source_conflict" } },
      );
    }

    // Same identity: only a rename refresh of the display fields is allowed.
    const refresh = {
      scopeKey: source.scope,
      externalKey: source.externalKey ?? bound.externalKey,
      externalUrl: source.url ?? bound.url,
    };
    const changed =
      refresh.scopeKey !== bound.scope ||
      refresh.externalKey !== bound.externalKey ||
      refresh.externalUrl !== bound.url;

    if (changed) {
      await tx
        .update(taskExternalSources)
        .set({ ...refresh, updatedAt: new Date() })
        .where(eq(taskExternalSources.taskId, taskId));
      log.info(
        { projectId, taskId },
        "[taskSource.bind] display fields refreshed",
      );
    }

    return { changed };
  });
}

export async function detachTaskSource(
  input: { projectId: string; taskId: string; actor: SocialActor },
  db: Db = getDb(),
): Promise<void> {
  const { projectId, taskId, actor } = input;

  await db.transaction(async (tx: Db) => {
    const [removed] = await tx
      .delete(taskExternalSources)
      .where(
        and(
          eq(taskExternalSources.taskId, taskId),
          eq(taskExternalSources.projectId, projectId),
        ),
      )
      .returning(sourceColumns);

    if (!removed) {
      throw new MaisterError(
        "PRECONDITION",
        "the task has no external source",
        {
          details: { reason: "source_not_bound" },
        },
      );
    }

    await recordTaskActivity(tx, {
      taskId,
      projectId,
      actor,
      eventKind: "source_detached",
      payload: {
        kind: removed.kind,
        instance: removed.instance,
        externalId: removed.externalId,
        externalKey: removed.externalKey,
      },
    });
    log.info(
      { projectId, taskId, kind: removed.kind, actorType: actor.type },
      "[taskSource.detach] binding removed",
    );
  });
}

export async function findTaskIdBySource(
  projectId: string,
  identity: TaskSourceIdentity,
  db: Db = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ taskId: taskExternalSources.taskId })
    .from(taskExternalSources)
    .where(identityWhere(projectId, identity));

  return row?.taskId ?? null;
}

export async function loadTaskSources(
  db: Db,
  taskIds: readonly string[],
): Promise<Map<string, TaskSource>> {
  if (taskIds.length === 0) return new Map();

  const rows = await db
    .select(sourceColumns)
    .from(taskExternalSources)
    .where(inArray(taskExternalSources.taskId, [...taskIds]));

  return new Map(
    rows.map((row: Record<string, unknown>) => [
      row.taskId as string,
      toSource(row),
    ]),
  );
}

/** ADR-207: the closing reference a generated PR body for this Run carries. */
export async function closingReferenceForRun(
  db: Db,
  run: { id: string; taskId: string | null },
  project: { provider?: string | null; repoUrl?: string | null },
): Promise<string | null> {
  if (!run.taskId) return null;
  const sources = await loadTaskSources(db, [run.taskId]);
  const source = sources.get(run.taskId) ?? null;

  if (!source) return null;
  const [snapshot] = await db
    .select({ deliveryPolicySnapshot: runs.deliveryPolicySnapshot })
    .from(runs)
    .where(eq(runs.id, run.id));

  return githubClosingReference({
    source,
    projectGithubHost: projectGithubHost(project),
    resolvesTask: snapshotResolvesTask(snapshot?.deliveryPolicySnapshot),
  });
}
