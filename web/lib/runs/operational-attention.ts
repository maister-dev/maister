import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  OperationalAttentionReason,
  OperationalCleanup,
  OperationalTerminal,
} from "@/lib/run-results/operational-types";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  runs,
  operationalRunAcknowledgements,
  agentIncidentOccurrences,
  agentIncidentEpisodes,
  agentIncidentReaderStates,
} from "@/lib/db/schema";
import { mirrorLegacyAgentAcknowledgement } from "@/lib/runs/agent-activity-backfill";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";

export type OperationalAttention = {
  runId: string;
  projectId: string;
  taskId: string | null;
  reason: OperationalAttentionReason;
  revision: number;
  since: Date | null;
  code: string;
};

export function operationalAttentionReasons(
  terminal: OperationalTerminal | null,
  cleanup: OperationalCleanup | null,
): Array<{
  reason: OperationalAttentionReason;
  revision: number;
  code: string;
}> {
  return [
    ...(terminal && ["Failed", "Crashed"].includes(terminal.status)
      ? [
          {
            reason: "operation_failure" as const,
            revision: 1,
            code: terminal.reasonCodes[0] ?? terminal.effectiveOutcome,
          },
        ]
      : []),
    ...(cleanup?.state === "exhausted"
      ? [
          {
            reason: "cleanup_failure" as const,
            revision: cleanup.revision,
            code: cleanup.errorCode ?? "operational_cleanup_exhausted",
          },
        ]
      : []),
  ];
}

export async function listOperationalAttention(
  db: Db,
  userId: string,
  projectIds: readonly string[],
): Promise<OperationalAttention[]> {
  if (!projectIds.length) return [];
  const [rows, acknowledgements] = await Promise.all([
    db
      .select({
        runId: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        terminal: runs.operationalTerminal,
        cleanup: runs.operationalCleanup,
        endedAt: runs.endedAt,
      })
      .from(runs)
      .where(
        and(
          inArray(runs.projectId, [...projectIds]),
          eq(runs.agentKind, "operational"),
        ),
      ),
    db
      .select()
      .from(operationalRunAcknowledgements)
      .where(eq(operationalRunAcknowledgements.userId, userId)),
  ]);
  const acknowledged = new Set(
    acknowledgements.map((row) => `${row.runId}:${row.reason}:${row.revision}`),
  );

  const explicit = rows.length
    ? await db
        .select({
          runId: agentIncidentOccurrences.runId,
          channel: agentIncidentOccurrences.channel,
          sourceFactKey: agentIncidentOccurrences.sourceFactKey,
          acknowledgedAt: agentIncidentReaderStates.acknowledgedAt,
        })
        .from(agentIncidentOccurrences)
        .innerJoin(
          agentIncidentEpisodes,
          eq(agentIncidentEpisodes.id, agentIncidentOccurrences.episodeId),
        )
        .leftJoin(
          agentIncidentReaderStates,
          and(
            eq(agentIncidentReaderStates.episodeId, agentIncidentEpisodes.id),
            eq(agentIncidentReaderStates.userId, userId),
            eq(
              agentIncidentReaderStates.attentionRevision,
              agentIncidentEpisodes.attentionRevision,
            ),
          ),
        )
        .where(
          and(
            inArray(
              agentIncidentOccurrences.runId,
              rows.map((row) => row.runId),
            ),
            inArray(agentIncidentOccurrences.channel, [
              "operational_terminal",
              "cleanup",
            ]),
          ),
        )
    : [];

  const explicitlySeen = new Map<string, boolean>();

  for (const occurrence of explicit) {
    if (!occurrence.runId) continue;
    const revision =
      occurrence.channel === "cleanup" &&
      occurrence.sourceFactKey.startsWith(`cleanup:${occurrence.runId}:`)
        ? Number(
            occurrence.sourceFactKey.slice(
              `cleanup:${occurrence.runId}:`.length,
            ),
          )
        : 1;
    const reason =
      occurrence.channel === "cleanup"
        ? "cleanup_failure"
        : "operation_failure";
    const key = JSON.stringify([occurrence.runId, reason, revision]);

    explicitlySeen.set(
      key,
      (explicitlySeen.get(key) ?? true) && occurrence.acknowledgedAt !== null,
    );
  }

  return rows.flatMap((row) =>
    operationalAttentionReasons(row.terminal, row.cleanup)
      .filter(
        (reason) =>
          !acknowledged.has(`${row.runId}:${reason.reason}:${reason.revision}`),
      )
      .filter(
        (reason) =>
          explicitlySeen.get(
            JSON.stringify([row.runId, reason.reason, reason.revision]),
          ) !== true,
      )
      .map((reason) => ({
        runId: row.runId,
        projectId: row.projectId!,
        taskId: row.taskId,
        since: row.endedAt,
        ...reason,
      })),
  );
}

/** Unassociated legacy diagnostics remain individual; ingested facts belong to their canonical agent group. */
export async function listUngroupedOperationalAttention(
  db: Db,
  userId: string,
  projectIds: readonly string[],
): Promise<OperationalAttention[]> {
  if (!projectIds.length) return [];
  const failureCovered = sql<boolean>`EXISTS (SELECT 1 FROM agent_incident_occurrences o WHERE o.run_id=${runs.id} AND o.channel='operational_terminal')`;
  const cleanupCovered = sql<boolean>`EXISTS (SELECT 1 FROM agent_incident_occurrences o WHERE o.run_id=${runs.id} AND o.channel='cleanup' AND o.source_fact_key='cleanup:'||${runs.id}||':'||(${runs.operationalCleanup}->>'revision'))`;
  const rows = await db
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      taskId: runs.taskId,
      terminal: runs.operationalTerminal,
      cleanup: runs.operationalCleanup,
      endedAt: runs.endedAt,
      failureCovered,
      cleanupCovered,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.projectId, [...projectIds]),
        eq(runs.agentKind, "operational"),
        sql`((${runs.operationalTerminal}->>'status' IN ('Failed','Crashed') AND NOT (${failureCovered}))
        OR (${runs.operationalCleanup}->>'state'='exhausted' AND NOT (${cleanupCovered})))`,
      ),
    );

  if (!rows.length) return [];
  const acknowledged = await db
    .select()
    .from(operationalRunAcknowledgements)
    .where(
      and(
        eq(operationalRunAcknowledgements.userId, userId),
        inArray(
          operationalRunAcknowledgements.runId,
          rows.map((row) => row.runId),
        ),
      ),
    );
  const seen = new Set(
    acknowledged.map((row) =>
      JSON.stringify([row.runId, row.reason, row.revision]),
    ),
  );

  return rows.flatMap((row) =>
    operationalAttentionReasons(row.terminal, row.cleanup)
      .filter(
        (reason) =>
          (reason.reason === "operation_failure"
            ? !row.failureCovered
            : !row.cleanupCovered) &&
          !seen.has(
            JSON.stringify([row.runId, reason.reason, reason.revision]),
          ),
      )
      .map((reason) => ({
        runId: row.runId,
        projectId: row.projectId!,
        taskId: row.taskId,
        since: row.endedAt,
        ...reason,
      })),
  );
}

export async function acknowledgeOperationalAttention(
  db: Db,
  args: {
    runId: string;
    userId: string;
    reason: OperationalAttentionReason;
    revision: number;
  },
): Promise<{ acknowledged: true; revision: number }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, args.runId))
      .for("update");

    if (
      run?.agentKind !== "operational" ||
      !operationalAttentionReasons(
        run.operationalTerminal,
        run.operationalCleanup,
      ).some(
        (item) =>
          item.reason === args.reason && item.revision === args.revision,
      )
    )
      throw new MaisterError(
        "CONFLICT",
        "operational attention reason or revision is stale",
      );
    const inserted = await tx
      .insert(operationalRunAcknowledgements)
      .values({
        userId: args.userId,
        runId: args.runId,
        reason: args.reason,
        revision: args.revision,
      })
      .onConflictDoNothing()
      .returning({ runId: operationalRunAcknowledgements.runId });

    await mirrorLegacyAgentAcknowledgement(tx, {
      ...args,
      acknowledgedAt: new Date(),
    });

    if (inserted.length)
      await emitDomainEvent({
        db: tx,
        kind: "run.operational_attention_acknowledged",
        projectId: run.projectId!,
        taskId: run.taskId,
        runId: run.id,
        actor: { type: "user", id: args.userId },
        payload: {
          runId: run.id,
          ownerUserId: args.userId,
          reason: args.reason,
          revision: args.revision,
        },
      });

    return { acknowledged: true, revision: args.revision };
  });
}

export async function retryOperationalCleanup(
  db: Db,
  args: { runId: string; userId: string; expectedRevision: number },
): Promise<OperationalCleanup> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, args.runId))
      .for("update");
    const cleanup = run?.operationalCleanup;

    if (run?.agentKind !== "operational" || !cleanup)
      throw new MaisterError(
        "CONFLICT",
        "run has no operational cleanup intent",
      );
    if (cleanup.rearmReceipt?.expectedRevision === args.expectedRevision)
      return cleanup;
    if (
      cleanup.state !== "exhausted" ||
      cleanup.revision !== args.expectedRevision
    )
      throw new MaisterError(
        "CONFLICT",
        "operational cleanup revision is stale or not exhausted",
      );
    const revision = cleanup.revision + 1;
    const next: OperationalCleanup = {
      ...cleanup,
      state: cleanup.removedAt ? "removed" : "armed",
      revision,
      attempts: 0,
      dueAt: new Date().toISOString(),
      errorCode: null,
      lease: null,
      rearmReceipt: { expectedRevision: args.expectedRevision, revision },
    };

    await tx
      .update(runs)
      .set({ operationalCleanup: next })
      .where(eq(runs.id, run.id));
    await emitDomainEvent({
      db: tx,
      kind: "run.operational_cleanup_changed",
      projectId: run.projectId!,
      taskId: run.taskId,
      runId: run.id,
      actor: { type: "user", id: args.userId },
      payload: { runId: run.id, state: next.state, revision },
    });

    return next;
  });
}
