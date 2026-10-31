import type { TaskQualificationValue } from "@/lib/tasks/qualification-types";

import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";

export function qualificationFixture(): TaskQualificationValue {
  return {
    schemaVersion: 1,
    requestType: "feature",
    decision: "ready",
    checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
      dimension,
      state: dimension === "bug_evidence" ? "not_applicable" : "pass",
      rationale:
        dimension === "bug_evidence"
          ? "This request adds a feature."
          : "Verified against the pinned implementation and requirements.",
      evidenceIds: ["repo"],
    })),
    reasonCodes: [],
    nextActions: [],
    evidenceRefs: [
      {
        id: "repo",
        kind: "repository",
        reference: "main@0123456789012345678901234567890123456789:source",
      },
    ],
  };
}
