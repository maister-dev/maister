// M19 Phase 5: pure mapping from the POST /api/runs/[runId]/recover HTTP status
// to the client UI state RunRecoverActions branches on. The single source of
// truth so the component never string-matches.

export type RecoverUiState =
  | "resumed"
  | "queued"
  | "conflict"
  | "busy"
  | "gone"
  | "retry"
  | "error";

// `reason` is the refusal's typed `details.reason` token, never its message.
export function recoverHttpToUiState(
  status: number,
  reason: string | null = null,
): RecoverUiState {
  switch (status) {
    case 200:
      return "resumed";
    case 202:
      return "queued";
    case 409:
      // ADR-181: a workbench operation owns the worktree — the one 409 that is
      // a "retry once it finishes", not a dead end.
      return reason === "busy" ? "busy" : "conflict";
    case 410:
      return "gone";
    case 503:
      return "retry";
    default:
      return "error";
  }
}
