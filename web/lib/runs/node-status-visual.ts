// Phase A (run-detail transparency): per-node-attempt status → visual map for
// the three run-detail render sites — the "Ноды" list, the canvas chip
// (FlowNodeBody), and the selected-node «СТАТУС» field. A sibling to
// run-status-tone.ts (which maps RUN status, not node status). Pure (no React,
// no DB) so it is unit-testable and usable from server components. `iconName`
// names a @heroicons/react/24/outline export the render site resolves; `tone`
// keys NODE_STATUS_TONE_CLASS for the icon color; `i18nKey` resolves the
// localized status label for the accessible tooltip name.

// Canonical node-attempt status vocabulary (node_attempts.status:
// Pending|Running|Succeeded|Failed|NeedsInput|Reworked|Stale) plus the legacy
// linear `Skipped` (step_runs) which RunNodeStatuses can surface.
export const NODE_STATUS_KEYS = [
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "NeedsInput",
  "Reworked",
  "Stale",
  "Skipped",
] as const;

export type NodeStatusKey = (typeof NODE_STATUS_KEYS)[number];

export type NodeStatusTone =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "needs"
  | "rework"
  | "stale"
  | "skipped";

export interface NodeStatusVisual {
  // @heroicons/react/24/outline export name resolved by the render site.
  iconName: string;
  tone: NodeStatusTone;
  // run.nodeStatus.<Status> — localized label = the icon's accessible name.
  i18nKey: string;
}

// Record (not a switch) so a new NODE_STATUS_KEYS entry is a COMPILE error
// until its visual is declared — exhaustiveness without a runtime default arm.
const NODE_STATUS_VISUALS: Record<
  NodeStatusKey,
  { iconName: string; tone: NodeStatusTone }
> = {
  Pending: { iconName: "ClockIcon", tone: "pending" },
  Running: { iconName: "ArrowPathIcon", tone: "running" },
  Succeeded: { iconName: "CheckCircleIcon", tone: "done" },
  Failed: { iconName: "XCircleIcon", tone: "failed" },
  NeedsInput: { iconName: "HandRaisedIcon", tone: "needs" },
  Reworked: { iconName: "ArrowUturnLeftIcon", tone: "rework" },
  Stale: { iconName: "ExclamationTriangleIcon", tone: "stale" },
  Skipped: { iconName: "MinusCircleIcon", tone: "skipped" },
};

// Unknown/absent status → neutral pending visual, never a throw.
const DEFAULT_VISUAL: { iconName: string; tone: NodeStatusTone } = {
  iconName: "QuestionMarkCircleIcon",
  tone: "pending",
};

export function nodeStatusVisual(status: string): NodeStatusVisual {
  const base = NODE_STATUS_VISUALS[status as NodeStatusKey] ?? DEFAULT_VISUAL;

  return {
    iconName: base.iconName,
    tone: base.tone,
    i18nKey: `run.nodeStatus.${status}`,
  };
}

// Icon text-color per tone — utility composition over existing forest/--cv
// tokens (matches run-status-tone.ts conventions). The canvas chip keeps its
// own colorForNodeStatus; this drives the list + selected-field icons.
export const NODE_STATUS_TONE_CLASS: Record<NodeStatusTone, string> = {
  pending: "text-mute",
  running: "text-accent-4",
  done: "text-accent-4",
  failed: "text-red-500",
  needs: "text-amber",
  rework: "text-amber",
  stale: "text-amber",
  skipped: "text-mute",
};
