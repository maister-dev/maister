import "server-only";

import pino from "pino";

import {
  dispatchDomainEvents,
  type DispatchSummary,
} from "@/lib/domain-events/dispatch";

const log = pino({
  name: "scheduler-domain-event-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

// Thin scheduler seam (ADR-086): the singleton `domain_event_dispatch.default`
// job advances every registered consumer's cursor over the domain_events
// outbox each tick. All mechanics live in lib/domain-events/dispatch.ts.
export async function runDomainEventDispatchJob(): Promise<DispatchSummary> {
  log.info({}, "[domain-event-dispatch] start");

  const summary = await dispatchDomainEvents();

  log.info(
    {
      consumers: summary.consumers,
      totalDispatched: summary.totalDispatched,
      failures: summary.failures,
      skipped: summary.skipped,
    },
    "[domain-event-dispatch] finish",
  );

  return summary;
}
