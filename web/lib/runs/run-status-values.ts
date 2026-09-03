// The `runs.status` enum, in the schema's own order.
//
// Deliberately its OWN module with NO `server-only`: the run-status sets live in
// a server-only module, but the result plane's `deriveResultStatus` is pure and
// client-safe by contract. Both need this list, and duplicating it is exactly
// how a partition over it silently stops being exhaustive.
export const RUN_STATUS_VALUES = [
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

export type RunStatusValue = (typeof RUN_STATUS_VALUES)[number];
