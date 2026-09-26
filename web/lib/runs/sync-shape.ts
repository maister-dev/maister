// ADR-181 C28: the run SHAPES branch sync can never take, whatever the status.
// Pure, so the git policy's fact loader and `assertSyncEligible` answer the one
// question with one function — a button the server always refuses is a lie.
export type SyncShapeRun = {
  runKind: string;
  parentRunId: string | null;
  workspaceMode: string | null;
  // A launched evaluation participant (ADR-150 launched-lineage membership).
  isLaunchedLineage: boolean;
};

export function syncShapeRefusal(run: SyncShapeRun): string | null {
  if (run.runKind !== "flow" && run.runKind !== "agent") {
    return `only flow and agent runs can sync (is ${run.runKind})`;
  }
  if (run.parentRunId !== null) {
    return "an orchestrator child run cannot sync its branch";
  }
  if (run.workspaceMode === "shared") {
    return "a shared-tree run cannot sync — the tree is one branch";
  }
  if (run.isLaunchedLineage) {
    return "a launched evaluation participant cannot sync — decide the study first";
  }

  return null;
}
