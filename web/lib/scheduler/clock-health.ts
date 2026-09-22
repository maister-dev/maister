import "server-only";

import { randomUUID } from "node:crypto";

export type SchedulerTickSource = "timer" | "cron" | "manual";
export type SchedulerTickOutcome =
  | "completed"
  | "partial"
  | "failed"
  | "maintenance_noop";

export type SchedulerTickInvocation = {
  invocationId: string;
  source: SchedulerTickSource;
  startedAt: string;
  monotonicStartedAt: number;
};

export type SchedulerCompletedTick = {
  invocationId: string;
  source: SchedulerTickSource;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: SchedulerTickOutcome;
};

export type SchedulerClockHealth = {
  processId: number;
  observedAt: string;
  activeCount: number;
  lastStarted: Pick<
    SchedulerTickInvocation,
    "invocationId" | "source" | "startedAt"
  > | null;
  lastCompleted: SchedulerCompletedTick | null;
  skippedOverlapTotal: number;
  skippedOverlapCurrentStreak: number;
  skippedOverlapLastStreak: number;
};

type ClockHealthState = Omit<
  SchedulerClockHealth,
  "observedAt" | "activeCount"
> & {
  active: Map<string, SchedulerTickInvocation>;
};

const CLOCK_HEALTH_KEY = Symbol.for("maister.scheduler-clock-health.v1");

export function schedulerTickStarted(
  source: SchedulerTickSource,
  now: Date = new Date(),
): SchedulerTickInvocation {
  const invocation = {
    invocationId: randomUUID(),
    source,
    startedAt: now.toISOString(),
    monotonicStartedAt: performance.now(),
  };
  const state = globalState();

  state.active.set(invocation.invocationId, invocation);
  state.lastStarted = {
    invocationId: invocation.invocationId,
    source: invocation.source,
    startedAt: invocation.startedAt,
  };

  return invocation;
}

export function schedulerTickFinished(
  invocation: SchedulerTickInvocation,
  outcome: SchedulerTickOutcome,
  now: Date = new Date(),
): SchedulerCompletedTick | null {
  const state = globalState();
  const owned = state.active.get(invocation.invocationId);

  if (!owned) return null;
  state.active.delete(invocation.invocationId);
  state.lastCompleted = {
    invocationId: owned.invocationId,
    source: owned.source,
    startedAt: owned.startedAt,
    finishedAt: now.toISOString(),
    durationMs: Math.max(0, performance.now() - owned.monotonicStartedAt),
    outcome,
  };

  return state.lastCompleted;
}

export function noteSchedulerTimerOverlap(): {
  currentStreak: number;
  total: number;
} {
  const state = globalState();

  state.skippedOverlapCurrentStreak += 1;
  state.skippedOverlapTotal += 1;

  return {
    currentStreak: state.skippedOverlapCurrentStreak,
    total: state.skippedOverlapTotal,
  };
}

export function settleSchedulerTimerOverlap(): number {
  const state = globalState();
  const settled = state.skippedOverlapCurrentStreak;

  if (settled > 0) state.skippedOverlapLastStreak = settled;
  state.skippedOverlapCurrentStreak = 0;

  return settled;
}

export function getSchedulerClockHealth(
  now: Date = new Date(),
): SchedulerClockHealth {
  const state = globalState();

  return {
    processId: state.processId,
    observedAt: now.toISOString(),
    activeCount: state.active.size,
    lastStarted: state.lastStarted ? { ...state.lastStarted } : null,
    lastCompleted: state.lastCompleted ? { ...state.lastCompleted } : null,
    skippedOverlapCurrentStreak: state.skippedOverlapCurrentStreak,
    skippedOverlapLastStreak: state.skippedOverlapLastStreak,
    skippedOverlapTotal: state.skippedOverlapTotal,
  };
}

function globalState(): ClockHealthState {
  const globalRecord = globalThis as unknown as Record<
    symbol,
    ClockHealthState
  >;

  globalRecord[CLOCK_HEALTH_KEY] ??= {
    processId: process.pid,
    active: new Map(),
    lastStarted: null,
    lastCompleted: null,
    skippedOverlapCurrentStreak: 0,
    skippedOverlapLastStreak: 0,
    skippedOverlapTotal: 0,
  };

  return globalRecord[CLOCK_HEALTH_KEY];
}
