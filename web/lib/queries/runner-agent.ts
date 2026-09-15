import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/db/schema";

import pino from "pino";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";

export type QueryRunnerAgent = AdapterId;

const log = pino({
  name: "query-runner-agent",
  level: process.env.LOG_LEVEL ?? "info",
});

// The adapter identity behind a run's ACTIVE session, for the icon/label a card
// renders. DISPLAY-ONLY: the invariant that a spawned session carries a runner
// lives on the write path (launch refuses before any worktree/DB write), so a
// row that reaches here without one is already-persisted history — a substep
// session written before its runner was recorded, or a legacy row. Returning
// null degrades that to an "unknown adapter" placeholder; throwing would turn
// one incomplete column into a 500 on the portfolio, board, run and inbox
// screens that all read it. Same contract as `hitl-stage.ts`, whose unresolved
// step_id degrades to a null type so the inbox always renders.
export function runnerAgentFromFields(input: {
  readonly capabilityAgent: string | null;
  readonly runnerSnapshot: RunnerSnapshot | null;
  readonly context: string;
}): QueryRunnerAgent | null {
  const agent = input.capabilityAgent ?? input.runnerSnapshot?.capabilityAgent;

  if (agent && (ADAPTER_IDS as readonly string[]).includes(agent)) {
    return agent as QueryRunnerAgent;
  }

  log.warn(
    { context: input.context, capabilityAgent: agent ?? null },
    "run session has no capability agent — rendering unknown adapter",
  );

  return null;
}
