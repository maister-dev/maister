export type BoardTaskGate =
  | "flagged"
  | "clarification_pending"
  | "blocked"
  | "launchable";

export function boardTaskGate(input: {
  triageStatus: "triaged" | "flagged" | null;
  clarificationPending: boolean;
  blockedByCount: number;
}): BoardTaskGate {
  if (input.triageStatus === "flagged") return "flagged";
  if (input.clarificationPending) return "clarification_pending";
  if (input.blockedByCount > 0) return "blocked";

  return "launchable";
}
