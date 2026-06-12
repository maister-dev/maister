import "server-only";

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import { and, eq, lte, sql } from "drizzle-orm";
import pino from "pino";

import { launchAgentRun, type LaunchAgentRunResult } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { nextFireAt } from "@/lib/run-schedules/cron";
import { promoteNextPending } from "@/lib/scheduler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, agentProjectLinks, agentSchedules } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-triggers",
  level: process.env.LOG_LEVEL ?? "info",
});

const PER_TICK_LIMIT = 25;

export type AgentTickSummary = {
  due: number;
  claimed: number;
  launched: number;
  queued: number;
  refused: number;
  promotedPending: string | null;
};

type LaunchFn = (
  input: Parameters<typeof launchAgentRun>[0],
) => Promise<LaunchAgentRunResult>;

// The agent_tick.dispatcher handler (ADR-088): claim due cron rows with the
// M28-proven atomic UPDATE (one winner per row, one catch-up fire — the
// claim advances next_fire_at from NOW, so missed windows never backfill),
// then launch. The tick doubles as the sanctioned recovery sweep for agent
// runs stranded in Pending by a crash between claim and spawn.
export async function dispatchDueAgentSchedules(
  opts: { db?: Db; now?: Date; launch?: LaunchFn } = {},
): Promise<AgentTickSummary> {
  const _db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const launch = opts.launch ?? launchAgentRun;

  const due: Array<{
    id: string;
    agentId: string;
    projectId: string;
    cronExpr: string;
    timezone: string;
  }> = await _db
    .select({
      id: agentSchedules.id,
      agentId: agentSchedules.agentId,
      projectId: agentSchedules.projectId,
      cronExpr: agentSchedules.cronExpr,
      timezone: agentSchedules.timezone,
    })
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.triggerType, "cron"),
        eq(agentSchedules.enabled, true),
        lte(agentSchedules.nextFireAt, now),
      ),
    )
    .limit(PER_TICK_LIMIT);

  const summary: AgentTickSummary = {
    due: due.length,
    claimed: 0,
    launched: 0,
    queued: 0,
    refused: 0,
    promotedPending: null,
  };

  for (const row of due) {
    let next: Date;

    try {
      next = nextFireAt(row.cronExpr, row.timezone, now);
    } catch (err) {
      log.error(
        {
          scheduleId: row.id,
          cronExpr: row.cronExpr,
          err: err instanceof Error ? err.message : String(err),
        },
        "agent cron schedule has an unusable expression — skipped",
      );
      continue;
    }

    const claimed = await _db
      .update(agentSchedules)
      .set({ nextFireAt: next, lastFiredAt: now, updatedAt: new Date() })
      .where(
        and(
          eq(agentSchedules.id, row.id),
          lte(agentSchedules.nextFireAt, now),
          eq(agentSchedules.enabled, true),
        ),
      )
      .returning({ id: agentSchedules.id });

    if (claimed.length === 0) continue;
    summary.claimed += 1;

    try {
      const result = await launch({
        agentId: row.agentId,
        projectId: row.projectId,
        trigger: { source: "cron" },
        db: _db,
      });

      if ("deduped" in result) {
        summary.refused += 1;
      } else if (result.status === "Running") {
        summary.launched += 1;
      } else {
        summary.queued += 1;
      }
    } catch (err) {
      // A refusal (quarantined/disabled/runner unavailable) must not fail
      // the tick — the fire is recorded by the claim; the reason is logged.
      summary.refused += 1;
      log.warn(
        {
          scheduleId: row.id,
          agentId: row.agentId,
          code: isMaisterError(err) ? err.code : "UNKNOWN",
          err: err instanceof Error ? err.message : String(err),
        },
        "agent cron fire refused",
      );
    }
  }

  const promoted = await promoteNextPending({ db: _db, pool: "agent" });

  summary.promotedPending = promoted.promotedRunId;

  log.info(summary, "[agent_tick.dispatcher] summary");

  return summary;
}

type EventMatchRow = {
  scheduleId: string;
  agentId: string;
  projectId: string;
  eventMatch: { kinds?: string[] } | null;
};

// The agent_triggers outbox consumer (ADR-086/087): at-least-once delivery;
// the claim is the Pending run INSERT under the partial unique
// (agent_id, trigger_event_id) — redelivery converges to exactly one run.
// The self-exclusion guard keeps the triage Q&A loop from feeding itself.
export function buildAgentTriggersConsumer(
  opts: { db?: Db; launch?: LaunchFn } = {},
): DomainEventConsumer {
  return {
    id: "agent_triggers",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const _db = opts.db ?? getDb();
      const launch = opts.launch ?? launchAgentRun;

      for (const event of events) {
        const rows: EventMatchRow[] = await _db
          .select({
            scheduleId: agentSchedules.id,
            agentId: agentSchedules.agentId,
            projectId: agentSchedules.projectId,
            eventMatch: agentSchedules.eventMatch,
          })
          .from(agentSchedules)
          .innerJoin(agents, eq(agents.id, agentSchedules.agentId))
          .innerJoin(
            agentProjectLinks,
            and(
              eq(agentProjectLinks.agentId, agentSchedules.agentId),
              eq(agentProjectLinks.projectId, agentSchedules.projectId),
            ),
          )
          .where(
            and(
              eq(agentSchedules.triggerType, "event"),
              eq(agentSchedules.enabled, true),
              eq(agentSchedules.projectId, event.projectId),
              eq(agents.enabled, true),
              sql`${agents.quarantinedAt} IS NULL`,
              eq(agentProjectLinks.enabled, true),
            ),
          );

        for (const row of rows) {
          const kinds = row.eventMatch?.kinds ?? [];

          if (!kinds.includes(event.kind)) continue;

          // Self-exclusion (ADR-088): an event actored by the matched agent
          // never re-triggers it — structural loop termination for the
          // triage Q&A loop.
          if (event.actorType === "agent" && event.actorId === row.agentId) {
            log.debug(
              { eventId: event.id, agentId: row.agentId },
              "self-actored event skipped",
            );
            continue;
          }

          try {
            const result = await launch({
              agentId: row.agentId,
              projectId: row.projectId,
              taskId: event.taskId ?? null,
              trigger: {
                source: "domain_event",
                eventId: Number(event.id),
                payload: {
                  kind: event.kind,
                  payload: event.payload as Record<string, unknown>,
                },
              },
              db: _db,
            });

            if ("deduped" in result) {
              log.debug(
                { eventId: event.id, agentId: row.agentId },
                "event trigger already claimed — dedup",
              );
            } else {
              log.info(
                {
                  eventId: event.id,
                  agentId: row.agentId,
                  runId: result.runId,
                  status: result.status,
                },
                "event-triggered agent run",
              );
            }
          } catch (err) {
            // Idempotent contract: refusals are logged, never thrown — a
            // throw would redeliver the whole window forever.
            log.warn(
              {
                eventId: event.id,
                agentId: row.agentId,
                code: isMaisterError(err) ? err.code : "UNKNOWN",
                err: err instanceof Error ? err.message : String(err),
              },
              "event-triggered agent launch refused",
            );
          }
        }
      }
    },
  };
}

export const agentTriggersConsumer = buildAgentTriggersConsumer();
