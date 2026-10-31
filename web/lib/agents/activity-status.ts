import type { RunStatusValue } from "@/lib/runs/run-status-values";

/** Execution visibility is independent of scheduler slot ownership and retention. */
export const AGENT_EXECUTION_STATUS = {
  Pending: "active",
  Running: "active",
  NeedsInput: "active",
  NeedsInputIdle: "active",
  HumanWorking: "active",
  WaitingOnChildren: "active",
  Review: "settled",
  Crashed: "settled",
  Done: "settled",
  Abandoned: "settled",
  Failed: "settled",
} as const satisfies Record<RunStatusValue, "active" | "settled">;

export const ACTIVE_AGENT_RUN_STATUSES = (
  Object.keys(AGENT_EXECUTION_STATUS) as RunStatusValue[]
).filter((status) => AGENT_EXECUTION_STATUS[status] === "active");
