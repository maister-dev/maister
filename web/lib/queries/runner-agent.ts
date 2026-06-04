import "server-only";

import type { RunnerSnapshot } from "@/lib/db/schema";

import { MaisterError } from "@/lib/errors";

export type QueryRunnerAgent = "claude" | "codex";

export function runnerAgentFromFields(input: {
  readonly capabilityAgent: string | null;
  readonly runnerSnapshot: RunnerSnapshot | null;
  readonly context: string;
}): QueryRunnerAgent {
  const agent = input.capabilityAgent ?? input.runnerSnapshot?.capabilityAgent;

  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new MaisterError(
    "PRECONDITION",
    `Run ${input.context} has no capability agent in runner snapshot`,
  );
}
