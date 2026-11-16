import "server-only";

import type {
  LegacySourceClassification,
  LegacySourceCandidate,
} from "./legacy-markers";

import { asc, eq } from "drizzle-orm";
import pino from "pino";

import { classifyLegacyGithubSources } from "./legacy-markers";
import { insertTaskSourceInTx } from "./service";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches services/tasks.ts).
const { projects, taskExternalSources, taskStatementRevisions, tasks } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "task-source-backfill",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TaskSourceBackfillReport = {
  mode: "dry-run" | "apply";
  applied: number;
  counts: Partial<Record<LegacySourceClassification, number>>;
  tasks: { taskKey: string; classification: LegacySourceClassification }[];
};

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }

  return [];
}

async function loadCandidates(db: Db): Promise<LegacySourceCandidate[]> {
  const taskRows = await db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      number: tasks.number,
      title: tasks.title,
      prompt: tasks.prompt,
      taskKey: projects.taskKey,
      boundKind: taskExternalSources.sourceKind,
      boundInstance: taskExternalSources.sourceInstance,
      boundExternalId: taskExternalSources.externalId,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(taskExternalSources, eq(taskExternalSources.taskId, tasks.id))
    .orderBy(asc(projects.taskKey), asc(tasks.number));
  const history = new Map<string, string[]>();

  for (const row of await db
    .select({
      taskId: taskStatementRevisions.taskId,
      statement: taskStatementRevisions.statement,
    })
    .from(taskStatementRevisions)) {
    history.set(row.taskId, [
      ...(history.get(row.taskId) ?? []),
      ...stringLeaves(row.statement),
    ]);
  }

  return taskRows.map((row: Record<string, any>) => ({
    taskId: row.taskId,
    taskKey: `${row.taskKey}-${row.number}`,
    projectId: row.projectId,
    title: row.title,
    texts: [row.prompt, ...(history.get(row.taskId) ?? [])],
    bound: row.boundKind
      ? {
          kind: row.boundKind,
          instance: row.boundInstance,
          externalId: row.boundExternalId,
        }
      : null,
  }));
}

/**
 * ADR-206 legacy backfill. Dry-run by default; `apply` binds only `bindable`
 * tasks, one transaction each. Never edits tasks, runs, relations or history,
 * and never reports prompt text.
 */
export async function runTaskSourceBackfill(
  options: { apply: boolean },
  db: Db = getDb(),
): Promise<TaskSourceBackfillReport> {
  const candidates = await loadCandidates(db);
  const projectOf = new Map(candidates.map((c) => [c.taskId, c.projectId]));
  const titleOf = new Map(candidates.map((c) => [c.taskId, c.title]));
  const results = classifyLegacyGithubSources(candidates);
  const counts: TaskSourceBackfillReport["counts"] = {};
  let applied = 0;

  for (const result of results) {
    counts[result.classification] = (counts[result.classification] ?? 0) + 1;

    if (
      result.classification === "conflicting" ||
      result.classification === "duplicate"
    ) {
      log.warn(
        { taskKey: result.taskKey, classification: result.classification },
        "[taskSource.backfill] needs an operator decision",
      );
    }
    if (!options.apply || result.classification !== "bindable") continue;

    try {
      await db.transaction((tx: Db) =>
        insertTaskSourceInTx(tx, {
          projectId: projectOf.get(result.taskId)!,
          taskId: result.taskId,
          source: result.source!,
          origin: "backfill",
          actor: { type: "system", id: null },
        }),
      );
      applied += 1;
    } catch (err) {
      // A concurrent writer bound the identity or the task first; the next run
      // reclassifies it, so this is a skip, never a guess.
      if (!(isMaisterError(err) && err.code === "CONFLICT")) throw err;
      log.warn(
        { taskKey: result.taskKey },
        "[taskSource.backfill] bind lost a race",
      );
    }
  }

  const report: TaskSourceBackfillReport = {
    mode: options.apply ? "apply" : "dry-run",
    applied,
    counts,
    tasks: results
      .filter(
        (r) =>
          r.classification !== "no_markers" ||
          titleOf.get(r.taskId)?.startsWith("[GitHub #"),
      )
      .map(({ taskKey, classification }) => ({ taskKey, classification })),
  };

  log.info(
    { mode: report.mode, applied, counts },
    "[taskSource.backfill] summary",
  );

  return report;
}
