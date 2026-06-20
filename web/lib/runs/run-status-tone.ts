// M37 Phase 6 (ADR-098): RUN-status → tone for the orchestrator run-tree and
// the inspector spawned-runs list. This maps the full runs.status union onto a
// small semantic tone set. It is a NEW sibling helper — the shared flow-graph
// node-status color logic (lib/board/flow-graph-view-layout.ts,
// lib/flows/node-visuals.ts) is untouched. Pure (no db / no React) so it is
// fully unit-testable and usable from server components.

export type RunStatusTone =
  | "running"
  | "needs"
  | "human"
  | "waiting"
  | "review"
  | "done"
  | "crashed"
  | "pending";

// The canonical run-status labels are keyed by status string; the consuming
// component supplies the localized text via these keys (no hardcoded display
// text lives here).
export const RUN_STATUS_KEYS = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
] as const;

export type RunStatusKey = (typeof RUN_STATUS_KEYS)[number];

export function runStatusTone(status: string): RunStatusTone {
  switch (status) {
    case "Running":
      return "running";
    case "NeedsInput":
    case "NeedsInputIdle":
      return "needs";
    case "HumanWorking":
      return "human";
    case "WaitingOnChildren":
      return "waiting";
    case "Review":
      return "review";
    case "Done":
      return "done";
    case "Crashed":
    case "Failed":
      return "crashed";
    case "Abandoned":
      return "pending";
    case "Pending":
    default:
      return "pending";
  }
}

// Tailwind classes for the colored status DOT (reused by both the subtree card
// and the decomposition/inspector mini-rows). Forest tokens only — no new color
// definitions, just utility composition over existing CSS variables.
export const RUN_STATUS_DOT_CLASS: Record<RunStatusTone, string> = {
  running: "bg-accent-4",
  needs: "bg-amber",
  human: "bg-accent-3",
  waiting: "bg-accent-2",
  review: "bg-amber",
  done: "bg-accent-4 opacity-60",
  crashed: "bg-red-500",
  pending: "bg-mute-2",
};

// Tone classes for the small status BADGE chip (dot + text variant).
export const RUN_STATUS_BADGE_CLASS: Record<RunStatusTone, string> = {
  running: "border-line bg-accent-4-soft text-accent-4",
  needs: "border-amber-line bg-amber-soft text-amber",
  human:
    "border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))] bg-accent-3-soft text-accent-3",
  waiting:
    "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-accent-2-soft text-accent-2",
  review: "border-amber-line bg-amber-soft text-amber",
  done: "border-line bg-ivory text-mute",
  crashed: "border-red-300 bg-red-50/60 text-red-600 dark:bg-red-950/30",
  pending: "border-line bg-ivory text-mute",
};
