import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { KnowledgeRecipient } from "@/lib/brain/knowledge-run-disclosure";
import type {
  OperationalCleanup,
  OperationalTerminal,
  OperationalOutcome,
} from "@/lib/run-results/operational-types";
import type { RunResultContract } from "@/lib/run-results/types";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  agentContinuationEpisodes,
  runs,
  runResults,
  tasks,
  projects,
} from "@/lib/db/schema";
import { continuationObservation } from "@/lib/agents/continuation-episode";
import { parseOperationalResult } from "@/lib/run-results/operational-schema";
import { authorizeRunsKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";

/** Diagnostic plane: a failed operation never becomes an ordinary usable result. */
export async function loadOperationalOutcome(
  db: Db,
  runId: string,
  recipient?: KnowledgeRecipient,
): Promise<OperationalOutcome | null> {
  return (
    (await loadOperationalOutcomes(db, [runId], recipient)).get(runId) ?? null
  );
}

/** One guarded read transaction for outward diagnostic pages; legacy NULL capture retains its existing caller gate. */
export async function loadOperationalOutcomes(
  db: Db,
  runIds: readonly string[],
  recipient?: KnowledgeRecipient,
): Promise<Map<string, OperationalOutcome>> {
  if (!runIds.length) return new Map();

  return db.transaction(async (tx) => {
    await authorizeRunsKnowledgeDisclosure(tx, recipient, runIds);

    return inspectOperationalOutcomes(tx, runIds);
  });
}

/** Server-only index maintenance or an already source-authorized transaction; never an outward admission substitute. */
export async function inspectOperationalOutcomes(
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
      contract: runs.resultContract,
      value: runResults.value,
      continuation: {
        assignmentEpoch: agentContinuationEpisodes.assignmentEpoch,
        failure: agentContinuationEpisodes.failure,
        observation: continuationObservation,
      },
    })
    .from(runs)
    .leftJoin(
      runResults,
      and(
        eq(runResults.runId, runs.id),
        sql`${runResults.revision}::text = ${runs.operationalTerminal}->>'resultRevision'`,
      ),
    )
    .leftJoin(
      agentContinuationEpisodes,
      and(
        eq(agentContinuationEpisodes.runId, runs.id),
        eq(agentContinuationEpisodes.state, "attention"),
        eq(runs.status, "Running"),
      ),
    )
    .where(
      and(inArray(runs.id, [...runIds]), eq(runs.agentKind, "operational")),
    );
  const projected = rows.map((row) => ({
    row,
    outcome: projectOperationalOutcome(
      { terminal: row.terminal, cleanup: row.cleanup, contract: row.contract },
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
        ...(row.continuation?.failure?.blockedReason
          ? {
              continuationAttention: {
                assignmentEpoch: row.continuation.assignmentEpoch,
                reason: row.continuation.failure.reason,
                blockedReason: row.continuation.failure.blockedReason,
                observation: row.continuation.observation,
              },
            }
          : {}),
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
    contract: RunResultContract | null;
  },
  value: unknown,
): OperationalOutcome {
  const receipt = run.terminal;
  const result =
    receipt?.validation === "valid"
      ? parseOperationalResult(
          value,
          run.contract?.kind === "agent_operational"
            ? run.contract.contractName
            : undefined,
        )
      : null;

  return {
    version: 1,
    state: receipt ? "terminal" : "pending",
    reportedOutcome: result?.outcome ?? null,
    effectiveOutcome: receipt?.effectiveOutcome ?? null,
    successful: receipt?.successful ?? false,
    validation: receipt?.validation ?? "pending",
    ...(receipt?.validationDiagnostics
      ? { validationDiagnostics: receipt.validationDiagnostics }
      : {}),
    ...(receipt?.infrastructureFailure
      ? { infrastructureFailure: receipt.infrastructureFailure }
      : {}),
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
