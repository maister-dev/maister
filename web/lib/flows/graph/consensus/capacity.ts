import "server-only";

import pino from "pino";

import { maxConcurrentAgentRunsCap } from "@/lib/scheduler";

const log = pino({
  name: "consensus-capacity",
  level: process.env.LOG_LEVEL ?? "info",
});

type Waiter = {
  resolve: (release: () => void) => void;
};

let activeConsensusSessions = 0;
const waiters: Waiter[] = [];

function releaseConsensusAgentCapacity(): void {
  activeConsensusSessions = Math.max(0, activeConsensusSessions - 1);
  const next = waiters.shift();

  if (!next) return;

  activeConsensusSessions += 1;
  next.resolve(releaseConsensusAgentCapacity);
}

export async function acquireConsensusAgentCapacity(args: {
  runId: string;
  nodeId: string;
  phase: "verify" | "synthesize";
  actorId: string;
}): Promise<() => void> {
  const cap = maxConcurrentAgentRunsCap();

  if (activeConsensusSessions < cap) {
    activeConsensusSessions += 1;
    log.debug(
      {
        runId: args.runId,
        nodeId: args.nodeId,
        phase: args.phase,
        actorId: args.actorId,
        active: activeConsensusSessions,
        cap,
      },
      "consensus ephemeral ACP capacity acquired",
    );

    return releaseConsensusAgentCapacity;
  }

  log.info(
    {
      runId: args.runId,
      nodeId: args.nodeId,
      phase: args.phase,
      actorId: args.actorId,
      active: activeConsensusSessions,
      cap,
    },
    "consensus ephemeral ACP capacity queued",
  );

  return new Promise((resolve) => {
    waiters.push({ resolve });
  });
}
