import type { TriageFlagOrigin } from "@/lib/tasks/manual-launch-hold";

import { isManualTriageHold } from "@/lib/tasks/manual-launch-hold";

export type BoardTaskGate =
  | "flagged"
  | "queue_paused"
  | "clarification_pending"
  | "blocked"
  | "launchable";

export function boardTaskGate(input: {
  triageStatus: "triaged" | "flagged" | null;
  triageFlagOrigin?: TriageFlagOrigin | null;
  queuePaused?: boolean;
  clarificationPending: boolean;
  blockedByCount: number;
}): BoardTaskGate {
  if (input.queuePaused) return "queue_paused";
  if (isManualTriageHold(input)) return "flagged";
  if (input.clarificationPending) return "clarification_pending";
  if (input.blockedByCount > 0) return "blocked";

  return "launchable";
}
