import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/db/schema";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { MaisterError } from "@/lib/errors";

export type QueryRunnerAgent = AdapterId;

export function runnerAgentFromFields(input: {
  readonly capabilityAgent: string | null;
  readonly runnerSnapshot: RunnerSnapshot | null;
  readonly context: string;
}): QueryRunnerAgent {
  const agent = input.capabilityAgent ?? input.runnerSnapshot?.capabilityAgent;

  if (agent && (ADAPTER_IDS as readonly string[]).includes(agent)) {
    return agent as QueryRunnerAgent;
  }

  throw new MaisterError(
    "PRECONDITION",
    `Run ${input.context} has no capability agent in runner snapshot`,
  );
}
