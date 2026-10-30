import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";
import { assertAgentId, qualifyAgentId } from "@/lib/agents/definition";
import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import { settleAgentTriggerAttempt } from "@/lib/agents/trigger-attempts";
import {
  agents,
  agentActivityCutovers,
  agentIncidentOccurrences,
  agentIncidentOccurrenceReaders,
  agentSchedules,
  agentTriggerAttempts,
  domainEvents,
  operationalRunAcknowledgements,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import { loadOperationalOutcomes } from "@/lib/run-results/operational-projection";
import {
  applyAgentCleanupIncident,
  applyAgentTerminalIncidents,
} from "@/lib/runs/agent-incidents";

const log = pino({
  name: "agent-activity-backfill",
  level: process.env.LOG_LEVEL ?? "info",
});
const AGENT_ORIGIN = sql`(${runs.runKind} = 'agent' OR ${runs.agentId} IS NOT NULL OR ${runs.delegationSnapshot}->>'agentDefinitionId' IS NOT NULL)`;

type Cutover = typeof agentActivityCutovers.$inferSelect;

function delegatedAgentId(run: Run): string | null {
  const snapshot = run.delegationSnapshot;

  return snapshot && "agentDefinitionId" in snapshot
    ? snapshot.agentDefinitionId
    : null;
}

async function identityPage(
  tx: Db,
  state: Cutover,
  limit: number,
): Promise<number> {
  const rows = await tx
    .select()
    .from(runs)
    .where(
      and(
        AGENT_ORIGIN,
        state.afterRunId ? gt(runs.id, state.afterRunId) : undefined,
      ),
    )
    .orderBy(asc(runs.id))
    .limit(limit)
    .for("update");
  let unresolved = 0;

  for (const run of rows) {
    if (run.sourceAgentId) continue;
    const frozen = frozenOperationalDefinition(run);
    const [catalog] = run.agentId
      ? await tx
          .select({ packageName: agents.packageName })
          .from(agents)
          .where(eq(agents.id, run.agentId))
          .limit(1)
      : [];
    const candidates = [
      run.agentId,
      frozen?.parsed.id,
      delegatedAgentId(run),
    ].flatMap((candidate) => {
      if (!candidate) return [];
      if (candidate.includes(":")) return [assertAgentId(candidate)];
      const packageName = frozen?.packageName ?? catalog?.packageName;

      return packageName
        ? [assertAgentId(qualifyAgentId(packageName, candidate))]
        : [];
    });
    const identities = [...new Set(candidates)];

    if (identities.length > 1)
      throw new MaisterError(
        "CONFLICT",
        "Legacy agent identity has conflicting evidence",
        {
          details: {
            reason: "agent_activity_identity_conflict",
            runId: run.id,
            candidates: identities,
          },
        },
      );
    const sourceAgentId = identities[0];

    if (!sourceAgentId) {
      unresolved++;
      continue;
    }
    await tx
      .update(runs)
      .set({
        sourceAgentId,
        activitySortAt: run.startedAt ?? state.startedAt,
        activityTimestampProvenance: run.startedAt
          ? "legacy_estimate"
          : "migration_estimate",
        agentActivitySnapshot: frozen
          ? buildAgentActivitySnapshot(sourceAgentId, frozen)
          : null,
      })
      .where(and(eq(runs.id, run.id), isNull(runs.sourceAgentId)));
  }
  await tx
    .update(agentActivityCutovers)
    .set({
      afterRunId: rows.at(-1)?.id ?? null,
      phase: rows.length < limit ? "facts" : "identity",
      processed: state.processed + rows.length,
      unresolved: state.unresolved + unresolved,
    })
    .where(eq(agentActivityCutovers.version, 1));
  if (rows.length < limit)
    await tx
      .update(agentActivityCutovers)
      .set({ afterRunId: null })
      .where(eq(agentActivityCutovers.version, 1));

  return rows.length;
}

/** Preserve old per-run acknowledgements only for the exact occurrences they covered. */
export async function mirrorLegacyAgentAcknowledgement(
  tx: Db,
  input: {
    runId: string;
    userId: string;
    reason: "operation_failure" | "cleanup_failure";
    revision: number;
    acknowledgedAt: Date;
  },
): Promise<void> {
  const condition =
    input.reason === "cleanup_failure"
      ? and(
          eq(agentIncidentOccurrences.channel, "cleanup"),
          eq(
            agentIncidentOccurrences.sourceFactKey,
            `cleanup:${input.runId}:${input.revision}`,
          ),
        )
      : eq(agentIncidentOccurrences.channel, "operational_terminal");

  if (input.reason === "operation_failure" && input.revision !== 1) return;
  const occurrences = await tx
    .select({ id: agentIncidentOccurrences.id })
    .from(agentIncidentOccurrences)
    .where(
      and(eq(agentIncidentOccurrences.originalRunId, input.runId), condition),
    );

  if (occurrences.length)
    await tx
      .insert(agentIncidentOccurrenceReaders)
      .values(
        occurrences.map((item) => ({
          occurrenceId: item.id,
          userId: input.userId,
          acknowledgedAt: input.acknowledgedAt,
        })),
      )
      .onConflictDoNothing();
}

async function factsPage(
  tx: Db,
  state: Cutover,
  limit: number,
): Promise<number> {
  const rows = await tx
    .select()
    .from(runs)
    .where(
      and(
        isNotNull(runs.sourceAgentId),
        state.afterRunId ? gt(runs.id, state.afterRunId) : undefined,
      ),
    )
    .orderBy(asc(runs.id))
    .limit(limit)
    .for("update");
  const outcomes = await loadOperationalOutcomes(
    tx,
    rows.map((run) => run.id),
  );

  for (const run of rows) {
    const events = await tx
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, run.id),
          inArray(domainEvents.kind, ["run.failed", "run.crashed", "run.done"]),
        ),
      )
      .orderBy(asc(domainEvents.id))
      .limit(1001);

    if (events.length > 1000)
      throw new MaisterError(
        "PRECONDITION",
        "Agent terminal history exceeds the bounded cutover page",
        {
          details: {
            reason: "agent_activity_terminal_history_limit",
            runId: run.id,
          },
        },
      );
    const facts = events.length
      ? events.map((event) => ({
          status:
            event.kind === "run.failed"
              ? ("Failed" as const)
              : event.kind === "run.crashed"
                ? ("Crashed" as const)
                : ("Done" as const),
          endedAt: event.occurredAt,
          transitionId:
            typeof event.payload.terminalTransitionId === "string"
              ? event.payload.terminalTransitionId
              : `event:${event.id}`,
          reason:
            typeof event.payload.reason === "string"
              ? event.payload.reason
              : undefined,
        }))
      : run.endedAt &&
          (run.status === "Failed" ||
            run.status === "Crashed" ||
            run.status === "Done")
        ? [
            {
              status: run.status,
              endedAt: run.endedAt,
              transitionId: `legacy:${run.id}:${run.endedAt.toISOString()}`,
              reason: undefined,
            },
          ]
        : [];

    for (const fact of facts)
      await applyAgentTerminalIncidents(tx, {
        run,
        ...fact,
        terminal: run.operationalTerminal,
        reported: outcomes.get(run.id)?.reportedResult ?? null,
      });
    if (run.operationalCleanup?.state === "exhausted")
      await applyAgentCleanupIncident(
        tx,
        run,
        run.operationalCleanup,
        state.startedAt,
      );
    const acknowledgements = await tx
      .select()
      .from(operationalRunAcknowledgements)
      .where(eq(operationalRunAcknowledgements.runId, run.id));

    for (const acknowledgement of acknowledgements)
      await mirrorLegacyAgentAcknowledgement(tx, acknowledgement);
  }
  await tx
    .update(agentActivityCutovers)
    .set({
      afterRunId: rows.at(-1)?.id ?? null,
      phase: rows.length < limit ? "schedules" : "facts",
      processed: state.processed + rows.length,
    })
    .where(eq(agentActivityCutovers.version, 1));

  return rows.length;
}

async function schedulesPage(
  tx: Db,
  state: Cutover,
  limit: number,
): Promise<number> {
  const rows = await tx
    .select()
    .from(agentSchedules)
    .where(
      and(
        isNotNull(agentSchedules.lastAttemptAt),
        state.afterScheduleId
          ? gt(agentSchedules.id, state.afterScheduleId)
          : undefined,
      ),
    )
    .orderBy(asc(agentSchedules.id))
    .limit(limit);

  for (const binding of rows) {
    if (!binding.lastAttemptAt || !binding.lastAttemptFence) continue;
    const [existing] = await tx
      .select({ id: agentTriggerAttempts.id })
      .from(agentTriggerAttempts)
      .where(
        and(
          eq(agentTriggerAttempts.scheduleId, binding.id),
          eq(agentTriggerAttempts.fence, binding.lastAttemptFence),
        ),
      )
      .limit(1);

    if (existing) continue;
    const [attempt] = await tx
      .insert(agentTriggerAttempts)
      .values({
        projectId: binding.projectId,
        sourceAgentId: binding.agentId,
        scheduleId: binding.id,
        bindingSnapshot: {
          version: 1,
          scheduleId: binding.id,
          triggerType: binding.triggerType,
          cronExpr: binding.cronExpr,
          timezone: binding.timezone,
          eventKinds: binding.eventMatch?.kinds ?? [],
        },
        fence: binding.lastAttemptFence,
        deliveryKey: `legacy:${binding.lastAttemptFence}`,
        triggerSource: binding.triggerType === "cron" ? "cron" : "domain_event",
        provenance: "legacy_latest",
        reservedRunId: randomUUID(),
        claimedAt: binding.lastAttemptAt,
        dueAt: state.startedAt,
      })
      .returning();

    await settleAgentTriggerAttempt(tx, attempt, {
      outcome: binding.lastOutcome ?? "unknown",
      runId: binding.lastRunId,
      reasonCode: binding.lastErrorCode,
      now: binding.lastAttemptAt,
    });
  }
  await tx
    .update(agentActivityCutovers)
    .set({
      afterRunId: null,
      afterScheduleId: rows.at(-1)?.id ?? null,
      phase: rows.length < limit ? "baseline" : "schedules",
      processed: state.processed + rows.length,
    })
    .where(eq(agentActivityCutovers.version, 1));

  return rows.length;
}

async function baselinePage(
  tx: Db,
  state: Cutover,
  limit: number,
): Promise<number> {
  const result = await tx.execute<{ id: string }>(
    sql`SELECT id FROM agent_incident_episodes WHERE (${state.afterEpisodeId}::text IS NULL OR id > ${state.afterEpisodeId}) ORDER BY id LIMIT ${limit}`,
  );

  for (const episode of result.rows)
    await tx.execute(sql`INSERT INTO agent_incident_reader_states(user_id,episode_id,attention_revision,notification_recorded_at,notification_mode)
    SELECT u.id,e.id,e.attention_revision,${state.startedAt},'baseline' FROM users u CROSS JOIN agent_incident_episodes e
    WHERE e.id=${episode.id} AND (u.role='admin' OR EXISTS(SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_id=e.project_id))
    ON CONFLICT DO NOTHING`);
  const complete = result.rows.length < limit;

  await tx
    .update(agentActivityCutovers)
    .set({
      afterEpisodeId: result.rows.at(-1)?.id ?? null,
      phase: complete ? "complete" : "baseline",
      completedAt: complete ? new Date() : null,
      processed: state.processed + result.rows.length,
    })
    .where(eq(agentActivityCutovers.version, 1));

  return result.rows.length;
}

/** One bounded transaction is the restart checkpoint; an invalid row rolls back its whole page. */
export async function backfillAgentActivityPage(
  db: Db,
  limit: number,
): Promise<{ complete: boolean; processed: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new MaisterError(
      "CONFIG",
      "Agent activity cutover limit must be 1..500",
    );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('agent_activity_cutover:v1',0))`,
    );
    await tx
      .insert(agentActivityCutovers)
      .values({ version: 1, phase: "identity" })
      .onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(agentActivityCutovers)
      .where(eq(agentActivityCutovers.version, 1))
      .for("update");

    if (state.phase === "complete") return { complete: true, processed: 0 };
    if (!upgradeMaintenanceEngaged()) {
      const [legacy] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(AGENT_ORIGIN, isNull(runs.sourceAgentId)))
        .limit(1);

      if (legacy)
        throw new MaisterError(
          "PRECONDITION",
          "Enable upgrade maintenance before migrating existing agent history",
          {
            details: { reason: "agent_activity_cutover_requires_maintenance" },
          },
        );
    }
    const processed =
      state.phase === "identity"
        ? await identityPage(tx, state, limit)
        : state.phase === "facts"
          ? await factsPage(tx, state, limit)
          : state.phase === "schedules"
            ? await schedulesPage(tx, state, limit)
            : await baselinePage(tx, state, limit);
    const [updated] = await tx
      .select({ phase: agentActivityCutovers.phase })
      .from(agentActivityCutovers)
      .where(eq(agentActivityCutovers.version, 1));

    log.info(
      {
        version: 1,
        phase: updated.phase,
        processed,
        cumulative: state.processed + processed,
      },
      "agent-activity-cutover-page",
    );

    return { complete: updated.phase === "complete", processed };
  });
}
