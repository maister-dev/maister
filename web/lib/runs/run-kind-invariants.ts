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
