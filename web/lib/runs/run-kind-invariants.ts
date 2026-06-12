import type { RunKind } from "@/lib/db/schema";

import { MaisterError } from "@/lib/errors";

export type RunKindInvariantInput = {
  id?: string;
  runKind: RunKind;
  taskId: string | null;
  flowId: string | null;
  flowRevisionId: string | null;
  flowVersion: string;
  flowRevision: string;
  agentId?: string | null;
};

export type RunScratchMetadataInvariantInput = {
  runKind: RunKind;
  scratchRunId: string | null;
};

export function assertRunKindInvariant(input: RunKindInvariantInput): void {
  if (input.runKind === "flow") {
    assertFlowRunInvariant(input);

    return;
  }

  if (input.runKind === "agent") {
    assertAgentRunInvariant(input);

    return;
  }

  assertScratchRunInvariant(input);
}

export function assertRunScratchMetadataInvariant(
  input: RunScratchMetadataInvariantInput,
): void {
  if (input.runKind === "scratch" && !input.scratchRunId) {
    throw new MaisterError(
      "CONFIG",
      "scratch run requires scratch_runs metadata",
    );
  }

  if (input.runKind === "flow" && input.scratchRunId) {
    throw new MaisterError(
      "CONFIG",
      "flow run must not have scratch_runs metadata",
    );
  }
}

function assertFlowRunInvariant(input: RunKindInvariantInput): void {
  if (!input.taskId || !input.flowId) {
    throw new MaisterError("CONFIG", "flow run requires taskId and flowId");
  }
}

// M33 (ADR-088): agent runs carry the catalog identity instead of a flow;
// taskId is optional (task-bound triage/commentary vs standalone monitors).
function assertAgentRunInvariant(input: RunKindInvariantInput): void {
  if (!input.agentId) {
    throw new MaisterError("CONFIG", "agent run requires agentId");
  }

  if (input.flowId || input.flowRevisionId) {
    throw new MaisterError(
      "CONFIG",
      "agent run must not store flowId or flowRevisionId on runs",
    );
  }

  if (input.flowVersion !== "agent" || input.flowRevision !== "manual") {
    throw new MaisterError(
      "CONFIG",
      "agent run requires flowVersion=agent and flowRevision=manual",
    );
  }
}

function assertScratchRunInvariant(input: RunKindInvariantInput): void {
  if (input.taskId || input.flowId || input.flowRevisionId) {
    throw new MaisterError(
      "CONFIG",
      "scratch run must not store taskId, flowId, or flowRevisionId on runs",
    );
  }

  if (input.flowVersion !== "scratch" || input.flowRevision !== "manual") {
    throw new MaisterError(
      "CONFIG",
      "scratch run requires flowVersion=scratch and flowRevision=manual",
    );
  }
}
