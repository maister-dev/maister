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
// `deny`/`denied` (a verdict reject-to-fail) join the failure bucket; forward
// verdict branches (`approve`/`review`/`pass`/`default`) stay in the calm green
// default bucket.
const BACK_EDGE_KEYS = new Set(["rework", "takeover", "reject"]);
const FAILURE_KEYS = new Set(["failure", "fail", "failed", "deny", "denied"]);

export function isBackEdgeOutcome(outcome: string): boolean {
  return BACK_EDGE_KEYS.has(outcome.trim().toLowerCase());
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
