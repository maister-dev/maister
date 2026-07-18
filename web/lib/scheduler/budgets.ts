import "server-only";

export type SchedulerBudgetKey =
  | "system_sweep"
  | "command"
  | "agent"
  | "flow"
  | "run_schedule"
  | "webhook_delivery"
  | "domain_event_dispatch"
  | "auto_launch_triaged"
  | "auto_promote"
  | "repo_delivery_scan"
  | "pr_state_scan"
  | "evaluation_dispatch"
  | "evaluation_suite_scan";

export type SchedulerBudgetLimits = {
  systemSweep: number;
  command: number;
  agent: number;
  flow: number;
  runSchedule: number;
  webhookDelivery: number;
  domainEventDispatch: number;
  autoLaunchTriaged: number;
  autoPromote: number;
  repoDeliveryScan: number;
  prStateScan: number;
  evaluationDispatch: number;
  evaluationSuiteScan: number;
};

const UNBOUNDED_FLOW_DISPATCH_BUDGET = 2_147_483_647;

export function schedulerBudgetLimits(): SchedulerBudgetLimits {
  return {
    systemSweep: 1,
    command: positiveEnvInt("MAISTER_MAX_CONCURRENT_COMMANDS", 2),
    // M34 (ADR-089): agent_tick is the seeded singleton dispatcher — one
    // attempt at a time (run_schedule precedent). MAISTER_MAX_CONCURRENT_
    // AGENTS is repurposed as the agent-RUN budget at tryStartRun.
    agent: 1,
    flow: UNBOUNDED_FLOW_DISPATCH_BUDGET,
    runSchedule: 1,
    webhookDelivery: 1,
    domainEventDispatch: 1,
    // ADR-112: the seeded singleton tick — one attempt at a time (run_schedule
    // precedent). Idempotency rides the per-task live-flow-run guard.
    autoLaunchTriaged: 1,
    // ADR-126: the seeded singleton auto-promotion sweep — one attempt at a
    // time. The singleton lease prevents overlapping ticks during a long merge.
    autoPromote: 1,
    // ADR-134: project-scoped remote scans are network-bound and sequentially
    // bounded. This is deliberately not operator-configurable.
    repoDeliveryScan: 1,
    // ADR-140: per-project PR-state poll — provider CLI/REST only, network-bound,
    // sequentially bounded, not operator-configurable.
    prStateScan: 1,
    // T3.3 (ADR-142): the seeded singleton evaluation dispatcher — one attempt
    // at a time (run_schedule precedent). The singleton lease serializes ticks;
    // per-execution CAS + bounded per-tick scan bound the work inside a tick.
    evaluationDispatch: 1,
    // T7.2 (ADR-147): the seeded singleton suite-scan tick — one attempt at a
    // time (evaluation_dispatch precedent). Idempotency rides the per-round
    // (suite, task, scanKey) UNIQUE dedup; the per-tick cap bounds each scan.
    evaluationSuiteScan: 1,
  };
}

export function maxConcurrentAgents(): number {
  return schedulerBudgetLimits().agent;
}

export function maxConcurrentCommands(): number {
  return schedulerBudgetLimits().command;
}

function positiveEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : defaultValue;

  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;

  return parsed;
}
