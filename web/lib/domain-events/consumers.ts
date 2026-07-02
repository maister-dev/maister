import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";

import pino from "pino";

import { agentTriggersConsumer } from "@/lib/agents/triggers";
import { autoLaunchRunPlanConsumer } from "@/lib/domain-events/auto-launch";
import { costRollupReconcileConsumer } from "@/lib/domain-events/cost-rollup-reconcile";
import { memoryHarvestConsumer } from "@/lib/domain-events/memory-harvest";
import { orchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { ralphLoopConsumer } from "@/lib/runs/ralph-loop";

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
// insert, so at-least-once redelivery converges to exactly one run. M37
// (ADR-098) adds auto_launch_run_plan: a child terminal releases the
// orchestrator's as-plan siblings whose success-gated `requires` blockers
// have all cleared (the per-task has-any-run guard ⇒ exactly-once launch,
// safe for one event fanning out to several same-agent dependents). M37
// (ADR-098) ALSO adds orchestrator_resume: a SIBLING consumer that wakes the
// PARKED flow coordinator (WaitingOnChildren → Running) on a child terminal —
// kept separate from the auto-launcher so "launch the next tasks" and "wake the
// coordinator" stay independent.
export const DOMAIN_EVENT_CONSUMERS: DomainEventConsumer[] = [
  noopConsumer,
  agentTriggersConsumer,
  autoLaunchRunPlanConsumer,
  orchestratorResumeConsumer,
  // A.2/A1 (execution-policy axis A2): auto-relaunches a fresh attempt on
  // run.failed when the failed run's snapshotted policy is ralph_loop, bounded
  // by MAISTER_RALPH_MAX_ATTEMPTS. Idempotent via tasks.attempt_number.
  ralphLoopConsumer,
  // ADR-117: low-latency fast-path that reconciles run_cost_rollups on a
  // run-terminal event (run.done|failed|crashed|abandoned). Poison-safe; the
  // system_sweep ended_at backstop is the completeness guarantee.
  costRollupReconcileConsumer,
  // ADR-122: the Project Brain harvest consumer — distills run-terminal +
  // gate.failed events into lessons (guarded by projects.brain_enabled),
  // transient failures hold the cursor, schema-invalid distill skips+advances.
  memoryHarvestConsumer,
];
