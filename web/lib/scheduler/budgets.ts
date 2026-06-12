import "server-only";

export type SchedulerBudgetKey =
  | "system_sweep"
  | "command"
  | "agent"
  | "flow"
  | "run_schedule"
  | "webhook_delivery"
  | "domain_event_dispatch";

export type SchedulerBudgetLimits = {
  systemSweep: number;
  command: number;
  agent: number;
  flow: number;
  runSchedule: number;
  webhookDelivery: number;
  domainEventDispatch: number;
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
