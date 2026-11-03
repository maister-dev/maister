export type TriageFlagOrigin =
  "qualification" | "explicit" | "dispatch_failure" | "unknown";

/** A machine assessment is advisory to a human launch; an independent hold needs its own decision. */
export function isManualTriageHold(task: {
  triageStatus: "triaged" | "flagged" | null;
  triageFlagOrigin?: TriageFlagOrigin | null;
}): boolean {
  return (
    task.triageStatus === "flagged" && task.triageFlagOrigin !== "qualification"
  );
}
