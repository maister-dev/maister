// Shared edge-outcome styling for the flow graph, used by BOTH the read-only
// viewer (board/flow-graph-view-layout) and the editor (flows/flow-graph-editor)
// so an outcome/role paints the same everywhere:
//   - back-edges that loop the graph (rework / takeover / reject) → dashed +
//     animated in the warm `--attention` amber;
//   - failures → solid `--danger` red;
//   - forward / success / default → calm solid `--edge-success` green-gray.
// Keyed off a free-text string so it serves the editor's authored `outcome` and
// the read-only `GraphEdgeRole` alike. Pure — no canvas context needed.
//
// M38 (ADR-103): `decide`/verdict tables route on arbitrary outcome strings.
// `deny`/`denied` (a verdict reject-to-fail) join the failure bucket. Forward
// verdict branches (`approve`/`review`/`pass`/`default`) stay in the calm green
// default bucket — but `isConditionalOutcome` flags every decide-specific branch
// key so a renderer can mark conditional edges distinctly from a plain `success`.
const BACK_EDGE_KEYS = new Set(["rework", "takeover", "reject"]);
const FAILURE_KEYS = new Set(["failure", "fail", "failed", "deny", "denied"]);
const FORWARD_DECISION_KEYS = new Set([
  "approve",
  "approved",
  "review",
  "pass",
  "passed",
  "default",
]);

export function isBackEdgeOutcome(outcome: string): boolean {
  return BACK_EDGE_KEYS.has(outcome.trim().toLowerCase());
}

// True when the outcome names a `decide`/verdict branch (a back-edge, a failure,
// or a forward decision such as approve/review/default) rather than the plain
// linear `success`/empty edge. Used by the canvas to mark conditional edges.
export function isConditionalOutcome(outcome: string): boolean {
  const key = outcome.trim().toLowerCase();

  return (
    BACK_EDGE_KEYS.has(key) ||
    FAILURE_KEYS.has(key) ||
    FORWARD_DECISION_KEYS.has(key)
  );
}

export type EdgeOutcomeStyle = {
  animated: boolean;
  style: { stroke: string; strokeDasharray?: string };
};

export function edgeOutcomeStyle(outcome: string): EdgeOutcomeStyle {
  const key = outcome.trim().toLowerCase();

  if (BACK_EDGE_KEYS.has(key)) {
    return {
      animated: true,
      style: { stroke: "var(--attention)", strokeDasharray: "6 4" },
    };
  }

  if (FAILURE_KEYS.has(key)) {
    return { animated: false, style: { stroke: "var(--danger)" } };
  }

  return { animated: false, style: { stroke: "var(--edge-success)" } };
}
