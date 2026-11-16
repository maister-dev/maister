import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { maxAgentChainDepth } from "@/lib/instance-config";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { domainEvents, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "agent-chain-depth",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ChainDepth = {
  depth: number;
  // True when this launch would spend a hop the budget no longer has. The
  // caller SKIPS the candidate; it never throws, because the domain-event
  // consumer's idempotent contract means a throw redelivers the whole window
  // forever.
  atCap: boolean;
  reason?:
    "company_event_chain_unclassified" | "project_event_chain_unclassified";
};

/** Native coordinator terminal facts are system-authored but still spend their producing Run's event-chain budget. */
export async function resolveCompanyEventChainDepth(
  db: SqlTransaction,
  eventId: number,
): Promise<ChainDepth> {
  const row = (
    await db.execute(sql`
    SELECT event.actor_type,producing.agent_chain_depth,
      (producing.trigger_source IN ('manual','cron','webhook') OR (producing.trigger_source='domain_event' AND EXISTS (
        SELECT 1 FROM agent_trigger_attempts invocation WHERE invocation.reserved_run_id=coalesce(producing.retry_of_run_id,producing.id)
          AND invocation.company_id=producing.company_id AND invocation.project_id IS NULL
          AND invocation.trigger_source='domain_event' AND invocation.trigger_event_id=producing.trigger_event_id
          AND invocation.schedule_id=producing.agent_schedule_id
          AND (producing.retry_of_run_id IS NULL OR company_event_retry_still_authorized(producing.id))
      ))) AS chain_classified
    FROM domain_events event JOIN runs producing ON producing.id=event.run_id
      AND producing.company_id=event.company_id AND producing.project_id IS NULL
      AND producing.company_execution_snapshot IS NOT NULL
    WHERE event.id=${eventId} AND event.company_id IS NOT NULL AND event.project_id IS NULL
    FOR SHARE OF event,producing
  `)
  ).rows[0];

  if (row?.actor_type === "user")
    return resolveAgentChainDepth({
      db,
      trigger: { source: "domain_event", eventId },
    });
  const cap = maxAgentChainDepth();

  if (
    row?.chain_classified !== true ||
    typeof row.agent_chain_depth !== "number" ||
    !Number.isSafeInteger(row.agent_chain_depth) ||
    row.agent_chain_depth < 0
  ) {
    log.warn(
      { eventId, reason: "company_event_chain_unclassified" },
      "company event has no classified producing chain; admission refused",
    );

    return {
      depth: cap,
      atCap: true,
      reason: "company_event_chain_unclassified",
    };
  }
  const depth = row.agent_chain_depth + 1;

  return { depth, atCap: depth > cap };
}

/** Project professional events retain the producing chain even for system-authored Flow terminal facts. */
export async function resolveProjectEventChainDepth(
  db: SqlTransaction,
  projectId: string,
  eventId: number,
): Promise<ChainDepth> {
  const row = (
    await db.execute(sql`
    SELECT event.actor_type,event.run_id,producing.agent_chain_depth,
      (producing.knowledge_access->>'state'='complete' AND EXISTS (
        SELECT 1 FROM specialist_run_links appointment WHERE appointment.run_id=producing.id
      ) AND (producing.trigger_source IN ('manual','cron','webhook') OR (producing.trigger_source='domain_event' AND EXISTS (
        SELECT 1 FROM agent_trigger_attempts invocation WHERE invocation.reserved_run_id=coalesce(producing.retry_of_run_id,producing.id)
          AND invocation.project_id=producing.project_id AND invocation.company_id IS NULL
          AND invocation.trigger_source='domain_event' AND invocation.trigger_event_id=producing.trigger_event_id
          AND invocation.schedule_id=producing.agent_schedule_id
          AND (producing.retry_of_run_id IS NULL OR EXISTS (
            SELECT 1 FROM agent_retry_intents retry WHERE retry.created_run_id=producing.id
              AND retry.source_run_id=producing.retry_of_run_id AND retry.state='launched'
              AND (project_event_retry_source_matches(retry.source_run_id,retry.actor_user_id,retry.recipe->'replacement'->'event')
                OR project_comment_retry_source_matches(retry.source_run_id,retry.actor_user_id,retry.recipe->'replacement'->'comment'))))
      )))) AS chain_classified
    FROM domain_events event LEFT JOIN runs producing ON producing.id=event.run_id
      AND producing.project_id=event.project_id AND producing.company_id IS NULL
    WHERE event.id=${eventId} AND event.project_id=${projectId} AND event.company_id IS NULL
    FOR SHARE OF event
  `)
  ).rows[0];
  const cap = maxAgentChainDepth();

  if (row?.actor_type === "user" && row.run_id === null)
    return { depth: 0, atCap: cap <= 0 };
  if (
    row?.chain_classified !== true ||
    typeof row.agent_chain_depth !== "number" ||
    !Number.isSafeInteger(row.agent_chain_depth) ||
    row.agent_chain_depth < 0
  )
    return {
      depth: cap,
      atCap: true,
      reason: "project_event_chain_unclassified",
    };
  const depth = row.agent_chain_depth + 1;

  return { depth, atCap: depth > cap };
}

// ADR-156: `boundRunId` is parsed from the run-bound token NAME, so it is
// server-derived but NOT guaranteed to reference a live `runs` row — a token can
// outlive its run row, or be minted by a path other than `issueAgentRunToken`.
// Stamping it blindly violates `domain_events_run_id_runs_id_fk` and turns an
// ordinary create into a 500.
//
// Degrading to null is the FAIL-CLOSED direction, not a loss: an agent-authored
// event with a NULL `run_id` is treated as already AT the cap by
// `resolveAgentChainDepth`, so an unattributable action can never extend a chain.
export async function resolveProducingRunId(
  boundRunId: string | null | undefined,
  db?: Db,
): Promise<string | null> {
  if (!boundRunId) return null;

  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = (await _db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, boundRunId))) as Array<{ id: string }>;

  if (rows.length > 0) return boundRunId;

  log.warn(
    { boundRunId },
    "token-bound run does not exist — emitting without run provenance (treated as chain-exhausted)",
  );

  return null;
}

// ADR-156 D7: how deep an agent→agent trigger chain this launch would be.
//
// A run launched from a domain event whose actor_type='agent' inherits the
// PRODUCING run's depth + 1; every other trigger source (manual, cron, webhook,
// flow-node binding) starts a fresh chain at 0. This bounds two loops with one
// counter: cross-project ping-pong (an A-agent acts in B, B's event triggers a
// B-agent, which acts in A…) and the same-project one that `tasks:create`
// opens, which existing self-exclusion cannot see because it only filters an
// agent's OWN events — an A↔B pair loops freely without this.
export async function resolveAgentChainDepth(input: {
  trigger: { source: string; eventId?: number | null };
  db?: Db;
}): Promise<ChainDepth> {
  const cap = maxAgentChainDepth();

  if (
    input.trigger.source !== "domain_event" ||
    input.trigger.eventId == null
  ) {
    return { depth: 0, atCap: cap <= 0 };
  }

  const _db = (input.db ?? getDb()) as unknown as { select: any };

  const events = (await _db
    .select({
      actorType: domainEvents.actorType,
      runId: domainEvents.runId,
    })
    .from(domainEvents)
    .where(eq(domainEvents.id, input.trigger.eventId))) as Array<{
    actorType: string | null;
    runId: string | null;
  }>;
  const event = events[0];

  // Not agent-authored → this is the head of a chain, not a continuation.
  if (!event || event.actorType !== "agent") {
    return { depth: 0, atCap: cap <= 0 };
  }

  // An agent-authored event with no producing run cannot be placed in a chain.
  // Treat it as ALREADY at the cap — fail closed. Seeding 0 here is the
  // fail-open that reopens the loop, and pre-0123 rows are exactly this shape.
  if (!event.runId) {
    log.warn(
      { eventId: input.trigger.eventId },
      "agent-authored domain event has no run_id — treating the chain as exhausted",
    );

    return { depth: cap, atCap: true };
  }

  const parents = (await _db
    .select({ depth: runs.agentChainDepth })
    .from(runs)
    .where(eq(runs.id, event.runId))) as Array<{ depth: number | null }>;
  const parentDepth = parents[0]?.depth;

  if (parentDepth === null || parentDepth === undefined) {
    log.warn(
      { eventId: input.trigger.eventId, producingRunId: event.runId },
      "producing run for an agent-authored event is missing — treating the chain as exhausted",
    );

    return { depth: cap, atCap: true };
  }

  const depth = parentDepth + 1;

  return { depth, atCap: depth > cap };
}
