import "server-only";

import { MaisterError } from "@/lib/errors";

export type AgentTickLauncher = (
  target: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export async function runAgentTickJob(args: {
  target: Record<string, unknown>;
  launcher?: AgentTickLauncher;
}): Promise<Record<string, unknown>> {
  if (!args.launcher) {
    throw new MaisterError(
      "PRECONDITION",
      "agent_tick scheduler handler is not configured",
    );
  }

  return args.launcher(args.target);
}
