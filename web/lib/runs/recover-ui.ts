// M19 Phase 5: pure mapping from the POST /api/runs/[runId]/recover HTTP status
// to the client UI state RunRecoverActions branches on. The single source of
// truth so the component never string-matches.

export type RecoverUiState =
  | "resumed"
  | "queued"
  | "conflict"
  | "gone"
  | "retry"
  | "error";

export function recoverHttpToUiState(status: number): RecoverUiState {
  switch (status) {
    case 200:
      return "resumed";
    case 202:
      return "queued";
    case 409:
      return "conflict";
    case 410:
      return "gone";
    case 503:
      return "retry";
    default:
      return "error";
  }
}
