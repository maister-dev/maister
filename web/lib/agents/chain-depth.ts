import "server-only";

import { eq } from "drizzle-orm";
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
};

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
