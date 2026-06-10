import "server-only";

export type SchedulerBudgetKey =
  | "system_sweep"
  | "command"
  | "agent"
  | "flow"
  | "run_schedule"
  | "webhook_delivery";

export type SchedulerBudgetLimits = {
  systemSweep: number;
  command: number;
  agent: number;
  flow: number;
  runSchedule: number;
  webhookDelivery: number;
};

const UNBOUNDED_FLOW_DISPATCH_BUDGET = 2_147_483_647;

export function schedulerBudgetLimits(): SchedulerBudgetLimits {
  return {
    systemSweep: 1,
    command: positiveEnvInt("MAISTER_MAX_CONCURRENT_COMMANDS", 2),
    agent: positiveEnvInt("MAISTER_MAX_CONCURRENT_AGENTS", 1),
    flow: UNBOUNDED_FLOW_DISPATCH_BUDGET,
    runSchedule: 1,
    webhookDelivery: 1,
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
