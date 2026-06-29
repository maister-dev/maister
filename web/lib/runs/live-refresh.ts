// Transition-detection for the run-detail live-refresh bridge. The run page is
// server-rendered; its live bridges (flow-graph-view, live-run-inspector) only
// patch their own local snapshots and never re-render the server tree, so a
// non-agent NeedsInput gate (human/form/review) never surfaces its review panel
// in an open tab. `RunLiveRefresh` calls `router.refresh()` — but ONLY when the
// run's status or current node actually changes, never on every streamed agent
// chunk, so an active turn does not trigger a full-tree refresh storm.

export interface RunViewSnapshot {
  runStatus?: string | null;
  currentStepId?: string | null;
}

export function runViewKey(snap: RunViewSnapshot): string {
  return `${snap.runStatus ?? ""}::${snap.currentStepId ?? ""}`;
}

export function shouldRefreshRunView(
  seenKey: string,
  snap: RunViewSnapshot,
): boolean {
  return runViewKey(snap) !== seenKey;
}
