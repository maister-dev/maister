import "server-only";

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import pino from "pino";

import { launchAgentRun, type LaunchAgentRunResult } from "@/lib/agents/launch";
import { MENTION_SUPPRESSION_STATUSES } from "@/lib/agents/summonability";
import { getDb } from "@/lib/db/client";
import { isGraphOnlyCutoverFailure } from "@/lib/domain-events/cutover";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { nextFireAt } from "@/lib/run-schedules/cron";
import { promoteNextPending } from "@/lib/scheduler";
import { recordTaskActivityOnce } from "@/lib/social/activity";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, agentProjectLinks, agentSchedules, runs } =
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

type AgentScheduleOutcome =
  | "launched"
  | "queued"
  | "refused"
  | "deduplicated"
  | "suppressed"
  | "failed";

async function claimAgentScheduleTelemetry(input: {
  db: Db;
  scheduleId: string;
  now: Date;
}): Promise<number | null> {
  const claimed = await input.db
    .update(agentSchedules)
    .set({
      lastAttemptAt: input.now,
      lastAttemptFence: sql`COALESCE(${agentSchedules.lastAttemptFence}, 0) + 1`,
      updatedAt: input.now,
    })
    .where(eq(agentSchedules.id, input.scheduleId))
    .returning({ fence: agentSchedules.lastAttemptFence });

  return (claimed[0]?.fence as number | undefined) ?? null;
}

async function recordAgentScheduleOutcome(input: {
  db: Db;
  scheduleId: string;
  fence: number | null;
  outcome: AgentScheduleOutcome;
  runId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now: Date;
}): Promise<void> {
  if (input.fence === null) return;

  await input.db
    .update(agentSchedules)
    .set({
      lastOutcome: input.outcome,
      lastRunId: input.runId ?? null,
      lastErrorCode: input.errorCode ?? null,
      lastErrorMessage: input.errorMessage ?? null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agentSchedules.id, input.scheduleId),
        eq(agentSchedules.lastAttemptFence, input.fence),
      ),
    );
}

function outcomeForLaunch(result: LaunchAgentRunResult): {
  outcome: AgentScheduleOutcome;
  runId: string | null;
} {
  if ("deduped" in result) {
    return { outcome: "deduplicated", runId: null };
  }

  return {
    outcome: result.status === "Running" ? "launched" : "queued",
    runId: result.runId,
  };
}

// The agent_tick.dispatcher handler (ADR-089): claim due cron rows with the
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
      .set({
        nextFireAt: next,
        lastFiredAt: now,
        lastAttemptAt: now,
        lastAttemptFence: sql`COALESCE(${agentSchedules.lastAttemptFence}, 0) + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentSchedules.id, row.id),
          lte(agentSchedules.nextFireAt, now),
          eq(agentSchedules.enabled, true),
        ),
      )
      .returning({
        id: agentSchedules.id,
        fence: agentSchedules.lastAttemptFence,
      });

    if (claimed.length === 0) continue;
    summary.claimed += 1;
    const fence = (claimed[0]?.fence as number | undefined) ?? null;

    try {
      const result = await launch({
        agentId: row.agentId,
        projectId: row.projectId,
        trigger: { source: "cron" },
        agentScheduleId: row.id,
        db: _db,
      });

      const outcome = outcomeForLaunch(result);
      await recordAgentScheduleOutcome({
        db: _db,
        scheduleId: row.id,
        fence,
        outcome: outcome.outcome,
        runId: outcome.runId,
        now,
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
      await recordAgentScheduleOutcome({
        db: _db,
        scheduleId: row.id,
        fence,
        outcome: isMaisterError(err) ? "refused" : "failed",
        errorCode: isMaisterError(err) ? err.code : "CRASH",
        errorMessage: "Agent schedule launch was refused",
        now,
      });
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

type ClarificationAnswerTarget = {
  clarificationId: string;
  hitlRequestId: string;
  requestingAgentId: string;
};

type EligibleTargetAgentRow = {
  agentId: string;
  projectId: string;
};

type MentionBindingRow = {
  scheduleId: string;
  agentId: string;
  projectId: string;
};

// ADR-151: deduped resolved agent ids the comment write recorded. All of them,
// including ones that were not summonable at write time — eligibility is
// re-checked here, so enabling a binding during the dispatch window still
// summons and revoking one still refuses.
function mentionedAgentIds(event: DomainEventRow): string[] {
  if (event.kind !== "task.comment_added") return [];

  const raw = (event.payload as Record<string, unknown>).mentionedAgentIds;

  if (!Array.isArray(raw)) return [];

  return [
    ...new Set(
      raw.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

function clarificationAnswerTarget(
  event: DomainEventRow,
): ClarificationAnswerTarget | null {
  if (event.kind !== "task.clarification_answered") return null;
  if (typeof event.taskId !== "string" || event.taskId.length === 0) return null;

  const payload = event.payload as Record<string, unknown>;
  const clarificationId = payload.clarificationId;
  const hitlRequestId = payload.hitlRequestId;
  const requestingAgentId = payload.requestingAgentId;

  if (
    typeof clarificationId !== "string" ||
    clarificationId.length === 0 ||
    typeof hitlRequestId !== "string" ||
    hitlRequestId.length === 0 ||
    typeof requestingAgentId !== "string" ||
    requestingAgentId.length === 0
  ) {
    return null;
  }

  return { clarificationId, hitlRequestId, requestingAgentId };
}

/**
 * The ADR-151 summon fan-out. Orchestration only — eligibility comes from the
 * binding query, the busy predicate from `MENTION_SUPPRESSION_STATUSES`, and
 * the claim from `launchAgentRun`'s existing partial unique. Never throws:
 * every per-agent decision lands as a binding outcome or a log line, and one
 * agent's failure never blocks the others named in the same comment.
 */
async function summonMentionedAgents(input: {
  db: Db;
  launch: LaunchFn;
  event: DomainEventRow;
  agentIds: string[];
}): Promise<void> {
  const { db: _db, launch, event } = input;

  if (typeof event.taskId !== "string" || event.taskId.length === 0) {
    log.warn(
      { eventId: event.id, reason: "no-task-id" },
      "agent mention summon skipped",
    );

    return;
  }

  const taskId = event.taskId;
  const bindings: MentionBindingRow[] = await _db
    .select({
      scheduleId: agentSchedules.id,
      agentId: agentSchedules.agentId,
      projectId: agentSchedules.projectId,
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
        eq(agentSchedules.triggerType, "mention"),
        eq(agentSchedules.enabled, true),
        eq(agentSchedules.projectId, event.projectId),
        inArray(agentSchedules.agentId, input.agentIds),
        eq(agents.enabled, true),
        sql`${agents.quarantinedAt} IS NULL`,
        eq(agentProjectLinks.enabled, true),
      ),
    );
  const bindingByAgent = new Map(bindings.map((row) => [row.agentId, row]));

  for (const agentId of input.agentIds) {
    const binding = bindingByAgent.get(agentId);

    // No operator grant → nothing happened, and the comment's write-time
    // footnote already explains why. Deliberately no record.
    if (!binding) continue;

    // Self-exclusion (ADR-089 rule, ADR-151 row 3): checked BEFORE the
    // telemetry claim so a self-mention leaves no misleading attempt marker.
    if (event.actorType === "agent" && event.actorId === agentId) {
      log.debug(
        { eventId: event.id, agentId, reason: "self-mention" },
        "agent mention summon skipped",
      );
      continue;
    }

    const fence = await claimAgentScheduleTelemetry({
      db: _db,
      scheduleId: binding.scheduleId,
      now: new Date(),
    });

    try {
      const busy = await _db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, agentId),
            eq(runs.taskId, taskId),
            inArray(runs.status, [...MENTION_SUPPRESSION_STATUSES]),
            // A REDELIVERY of this same event must not see the run its own
            // first delivery created and report it as "already busy" — that
            // would write a false suppression note for a summon that actually
            // succeeded. Excluding it lets the launch dedup claim answer
            // instead. `IS DISTINCT FROM` because trigger_event_id is nullable
            // (a manual run would otherwise be dropped by NULL logic).
            sql`${runs.triggerEventId} IS DISTINCT FROM ${Number(event.id)}`,
          ),
        )
        .limit(1);

      if (busy.length > 0) {
        // Idempotent by construction: task_activity_agent_summon_uq collapses
        // a redelivered event, so no read-then-write window exists.
        await recordTaskActivityOnce(_db, {
          taskId,
          projectId: event.projectId,
          actor: { type: "system", id: null },
          eventKind: "agent_summon_suppressed",
          payload: {
            agentId,
            triggerEventId: String(event.id),
            runId: busy[0].id,
            commentId:
              (event.payload as Record<string, unknown>).commentId ?? null,
          },
        });
        await recordAgentScheduleOutcome({
          db: _db,
          scheduleId: binding.scheduleId,
          fence,
          outcome: "suppressed",
          runId: busy[0].id,
          errorCode: "CONFLICT",
          errorMessage: "The agent already has an active run on this task",
          now: new Date(),
        });
        log.info(
          { eventId: event.id, agentId, decision: "suppressed" },
          "agent mention summon settled",
        );
        continue;
      }

      const result = await launch({
        agentId,
        projectId: binding.projectId,
        taskId,
        trigger: {
          source: "domain_event",
          eventId: Number(event.id),
          payload: {
            kind: event.kind,
            payload: event.payload as Record<string, unknown>,
            mentionedBy: {
              actorType: event.actorType,
              actorId: event.actorId,
            },
          },
        },
        agentScheduleId: binding.scheduleId,
        db: _db,
      });
      const outcome = outcomeForLaunch(result);

      await recordAgentScheduleOutcome({
        db: _db,
        scheduleId: binding.scheduleId,
        fence,
        outcome: outcome.outcome,
        runId: outcome.runId,
        now: new Date(),
      });
      log.info(
        {
          eventId: event.id,
          agentId,
          decision: outcome.outcome,
          runId: outcome.runId,
        },
        "agent mention summon settled",
      );
    } catch (err) {
      await recordAgentScheduleOutcome({
        db: _db,
        scheduleId: binding.scheduleId,
        fence,
        outcome: isMaisterError(err) ? "refused" : "failed",
        errorCode: isMaisterError(err) ? err.code : "CRASH",
        errorMessage: "Agent mention summon was refused",
        now: new Date(),
      });
      log.warn(
        {
          eventId: event.id,
          agentId,
          code: isMaisterError(err) ? err.code : "CRASH",
          err: err instanceof Error ? err.message : String(err),
        },
        "agent mention summon refused",
      );
    }
  }
}

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
        if (isGraphOnlyCutoverFailure(event)) {
          log.debug(
            { eventId: event.id, runId: event.runId, reason: "graph-cutover" },
            "agent trigger skipped terminal upgrade cut-over",
          );
          continue;
        }

        // A Human-ask answer is a directed handoff, not a public event
        // subscription. It bypasses schedules and checks only the original
        // requester is still attached, enabled, and not quarantined. `continue`
        // deliberately prevents any other event subscriber from observing the
        // answer payload.
        if (event.kind === "task.clarification_answered") {
          const target = clarificationAnswerTarget(event);

          if (!target) {
            log.warn(
              { eventId: event.id, reason: "invalid-clarification-target" },
              "clarification answer trigger refused",
            );
            continue;
          }

          const targetRows: EligibleTargetAgentRow[] = await _db
            .select({
              agentId: agents.id,
              projectId: agentProjectLinks.projectId,
            })
            .from(agents)
            .innerJoin(
              agentProjectLinks,
              and(
                eq(agentProjectLinks.agentId, agents.id),
                eq(agentProjectLinks.projectId, event.projectId),
              ),
            )
            .where(
              and(
                eq(agents.id, target.requestingAgentId),
                eq(agents.enabled, true),
                sql`${agents.quarantinedAt} IS NULL`,
                eq(agentProjectLinks.enabled, true),
              ),
            );
          const targetAgent = targetRows[0];

          if (!targetAgent) {
            log.warn(
              {
                eventId: event.id,
                agentId: target.requestingAgentId,
                reason: "requester-not-eligible",
              },
              "clarification answer trigger refused",
            );
            continue;
          }

          try {
            const result = await launch({
              agentId: targetAgent.agentId,
              projectId: targetAgent.projectId,
              taskId: event.taskId,
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
                { eventId: event.id, agentId: targetAgent.agentId },
                "clarification answer trigger already claimed — dedup",
              );
            } else {
              log.info(
                {
                  eventId: event.id,
                  agentId: targetAgent.agentId,
                  runId: result.runId,
                  status: result.status,
                },
                "clarification-answer agent run",
              );
            }
          } catch (err) {
            log.warn(
              {
                eventId: event.id,
                agentId: targetAgent.agentId,
                code: isMaisterError(err) ? err.code : "UNKNOWN",
                err: err instanceof Error ? err.message : String(err),
              },
              "clarification-answer agent launch refused",
            );
          }

          continue;
        }

        // ADR-151 — directed summons. This branch is ADDITIVE: it never
        // `continue`s, so generic `eventMatch.kinds` subscribers to the same
        // comment keep firing exactly as before (the (agent, event) partial
        // unique makes an agent holding BOTH bindings converge on one run).
        const mentioned = mentionedAgentIds(event);

        if (mentioned.length > 0) {
          await summonMentionedAgents({
            db: _db,
            launch,
            event,
            agentIds: mentioned,
          });
        }

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

        const matchingRows = rows
          .filter((row) => (row.eventMatch?.kinds ?? []).includes(event.kind))
          .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
        let ownerRunId: string | null = null;
        let ownerSelected = false;

        for (const row of matchingRows) {
          const fence = await claimAgentScheduleTelemetry({
            db: _db,
            scheduleId: row.scheduleId,
            now: new Date(),
          });

          // Self-exclusion (ADR-089): an event actored by the matched agent
          // never re-triggers it — structural loop termination for the
          // triage Q&A loop. Its telemetry still explains why no launch occurred.
          if (event.actorType === "agent" && event.actorId === row.agentId) {
            await recordAgentScheduleOutcome({
              db: _db,
              scheduleId: row.scheduleId,
              fence,
              outcome: "suppressed",
              errorCode: "PRECONDITION",
              errorMessage: "Self-actored event is not eligible for this binding",
              now: new Date(),
            });
            continue;
          }

          if (ownerSelected) {
            await recordAgentScheduleOutcome({
              db: _db,
              scheduleId: row.scheduleId,
              fence,
              outcome: "suppressed",
              runId: ownerRunId,
              errorCode: "CONFLICT",
              errorMessage: "A lower-id matching binding owns this event",
              now: new Date(),
            });
            continue;
          }

          ownerSelected = true;
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
              agentScheduleId: row.scheduleId,
              db: _db,
            });
            const outcome = outcomeForLaunch(result);
            ownerRunId = outcome.runId;
            await recordAgentScheduleOutcome({
              db: _db,
              scheduleId: row.scheduleId,
              fence,
              outcome: outcome.outcome,
              runId: outcome.runId,
              now: new Date(),
            });
            log.info(
              {
                eventId: event.id,
                agentId: row.agentId,
                scheduleId: row.scheduleId,
                outcome: outcome.outcome,
              },
              "event-triggered agent schedule settled",
            );
          } catch (err) {
            await recordAgentScheduleOutcome({
              db: _db,
              scheduleId: row.scheduleId,
              fence,
              outcome: isMaisterError(err) ? "refused" : "failed",
              errorCode: isMaisterError(err) ? err.code : "CRASH",
              errorMessage: "Agent schedule launch was refused",
              now: new Date(),
            });
            log.warn(
              {
                eventId: event.id,
                agentId: row.agentId,
                scheduleId: row.scheduleId,
                code: isMaisterError(err) ? err.code : "CRASH",
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
