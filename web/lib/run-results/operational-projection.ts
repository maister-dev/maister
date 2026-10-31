import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  OperationalCleanup,
  OperationalTerminal,
  OperationalOutcome,
} from "@/lib/run-results/operational-types";

import { and, eq, inArray, sql } from "drizzle-orm";

import { runs, runResults, tasks, projects } from "@/lib/db/schema";
import { operationalResultV1Schema } from "@/lib/run-results/operational-schema";

/** Diagnostic plane: a failed operation never becomes an ordinary usable result. */
export async function loadOperationalOutcome(
  db: Db,
  runId: string,
): Promise<OperationalOutcome | null> {
  return (await loadOperationalOutcomes(db, [runId])).get(runId) ?? null;
}

/** One batch for all surfaces; reference lookup never crosses the run's project. */
export async function loadOperationalOutcomes(
  db: Db,
  runIds: readonly string[],
): Promise<Map<string, OperationalOutcome>> {
  if (!runIds.length) return new Map();
  const rows = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      terminal: runs.operationalTerminal,
      cleanup: runs.operationalCleanup,
      value: runResults.value,
    })
    .from(runs)
    .leftJoin(
      runResults,
      and(
        eq(runResults.runId, runs.id),
        sql`${runResults.revision}::text = ${runs.operationalTerminal}->>'resultRevision'`,
      ),
    )
    .where(
      and(inArray(runs.id, [...runIds]), eq(runs.agentKind, "operational")),
    );
  const projected = rows.map((row) => ({
    row,
    outcome: projectOperationalOutcome(
      { terminal: row.terminal, cleanup: row.cleanup },
      row.value,
    ),
  }));
  const taskIds = [
    ...new Set(
      projected.flatMap(
        ({ outcome }) =>
          outcome.reportedResult?.references
            .filter((reference) => reference.kind === "task")
            .map((reference) => reference.id) ?? [],
      ),
    ),
  ];
  const projectIds = [
    ...new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : []))),
  ];
  const taskRows =
    taskIds.length && projectIds.length
      ? await db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            number: tasks.number,
            slug: projects.slug,
          })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.projectId))
          .where(
            and(
              inArray(tasks.id, taskIds),
              inArray(tasks.projectId, projectIds),
            ),
          )
      : [];
  const links = new Map(
    taskRows.map((task) => [
      `${task.projectId}:${task.id}`,
      `/projects/${encodeURIComponent(task.slug)}/tasks/${task.number}`,
    ]),
  );

  return new Map(
    projected.map(({ row, outcome }) => [
      row.id,
      {
        ...outcome,
        referenceLinks:
          outcome.reportedResult?.references.flatMap((reference) => {
            const href =
              reference.kind === "task"
                ? links.get(`${row.projectId}:${reference.id}`)
                : reference.url;

            return href
              ? [{ kind: reference.kind, id: reference.id, href }]
              : [];
          }) ?? [],
      },
    ]),
  );
}

function projectOperationalOutcome(
  run: {
    terminal: OperationalTerminal | null;
    cleanup: OperationalCleanup | null;
  },
  value: unknown,
): OperationalOutcome {
  const receipt = run.terminal;
  const parsed =
    receipt?.validation === "valid"
      ? operationalResultV1Schema.safeParse(value)
      : null;
  const result = parsed?.success ? parsed.data : null;

  return {
    version: 1,
    state: receipt ? "terminal" : "pending",
    reportedOutcome: result?.outcome ?? null,
    effectiveOutcome: receipt?.effectiveOutcome ?? null,
    successful: receipt?.successful ?? false,
    validation: receipt?.validation ?? "pending",
    integrity: receipt?.integrity ?? "pending",
    resultRevision: receipt?.resultRevision ?? null,
    reportedResult: result,
    reasonCodes: receipt?.reasonCodes ?? [],
    referenceLinks: [],
    cleanup: run.cleanup
      ? {
          state: run.cleanup.state,
          revision: run.cleanup.revision,
          attempts: run.cleanup.attempts,
          dueAt: run.cleanup.dueAt,
          errorCode: run.cleanup.errorCode,
          evidenceIds: run.cleanup.evidenceIds,
        }
      : null,
  };
}
