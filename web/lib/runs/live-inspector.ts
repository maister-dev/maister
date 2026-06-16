// Client-safe helpers for the live-refreshing run inspector (M35 T5.4).

// Terminal runs no longer mutate their worktree, so the inspector skips the SSE
// subscription for them (no change-summary re-fetch). Everything else (Running,
// NeedsInput, NeedsInputIdle, HumanWorking, Review, Pending) is treated as live.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "Done",
  "Abandoned",
  "Failed",
  "Crashed",
]);

export function isLiveRunStatus(status: string): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

// Debounce window for collapsing a burst of SSE ticks into one change-summary
// re-fetch.
export const CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS = 400;

export function changeSummaryRefreshUrl(runId: string, scope: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/change-summary?scope=${encodeURIComponent(scope)}`;
}
