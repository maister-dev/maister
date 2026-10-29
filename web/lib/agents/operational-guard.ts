import "server-only";

import type { AgentKind } from "@/lib/agents/kind";
import type { RunResultContract } from "@/lib/run-results/types";

import { MaisterError } from "@/lib/errors";

export function assertCodeDeliveryAllowed(
  run: {
    id: string;
    agentKind?: AgentKind | null;
    resultContract?: RunResultContract | null;
  },
  operation: string,
): void {
  if (
    run.agentKind === "operational" ||
    run.resultContract?.kind === "agent_operational"
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `operational run ${run.id} cannot perform ${operation}`,
      {
        details: {
          reason: "operational_delivery_forbidden",
          runId: run.id,
          operation,
        },
      },
    );
  }
}
