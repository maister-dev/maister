import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";

import pino from "pino";

import { agentTriggersConsumer } from "@/lib/agents/triggers";

const log = pino({
  name: "domain-events-noop",
  level: process.env.LOG_LEVEL ?? "info",
});

// A consumer's `handle` MUST be idempotent: delivery is at-least-once (a crash
// after handle but before the cursor advance redelivers the same window).
export interface DomainEventConsumer {
  // Cursor-row key in domain_event_consumers.
  id: string;
  // First-registration cursor seed: "beginning" = 0 (full replay),
  // "now" = MAX(domain_events.id) at registration.
  startFrom: "beginning" | "now";
  handle(events: DomainEventRow[]): Promise<void>;
}

// Permanently registered (owner decision 2026-06-11): proves the dispatch seam
// live in prod and doubles as an ops liveness signal — one cheap cursor row.
export const noopConsumer: DomainEventConsumer = {
  id: "noop",
  startFrom: "now",
  async handle(events) {
    log.debug(
      {
        count: events.length,
        fromId: events[0]?.id,
        toId: events.at(-1)?.id,
      },
      "[domain-events.noop] observed",
    );
  },
};

// Code-owned registry (ADR-086): future consumers (the re-pointed webhooks
// fanout, notifiers) register here. Removing an entry leaves its cursor row
// dormant — cleanup is deferred until pruning lands. M34 (ADR-089) adds
// agent_triggers — the first real consumer: it matches event kind + project
// against enabled agent_schedules event rows (with the self-exclusion
// anti-loop guard) and claims spawns via the partial-unique Pending run
// insert, so at-least-once redelivery converges to exactly one run.
export const DOMAIN_EVENT_CONSUMERS: DomainEventConsumer[] = [
  noopConsumer,
  agentTriggersConsumer,
];
