export const QUALIFICATION_DIMENSIONS = [
  "goal_scope",
  "acceptance",
  "consistency",
  "constraints_dependencies",
  "duplicates",
  "relevance",
  "bug_evidence",
] as const;
export type TaskQualificationMode = "legacy" | "required";
export type TaskQualificationDecision =
  "ready" | "needs_information" | "needs_review" | "not_actionable";
export type TaskQualificationValue = {
  schemaVersion: 1;
  requestType: "bug" | "feature" | "maintenance" | "question";
  decision: TaskQualificationDecision;
  checks: Array<{
    dimension: (typeof QUALIFICATION_DIMENSIONS)[number];
    state: "pass" | "fail" | "unknown" | "not_applicable";
    rationale: string;
    evidenceIds: string[];
  }>;
  reasonCodes: string[];
  nextActions: string[];
  evidenceRefs: Array<{
    id: string;
    kind: "repository" | "task" | "run" | "source" | "human_attestation";
    reference: string;
  }>;
};
export type TaskQualificationRouting = {
  flowId: string | null;
  runnerId: string | null;
  baseBranch: string | null;
  enqueue: boolean;
  expected?: {
    flowId: string | null;
    runnerId: string | null;
    baseBranch: string | null;
  };
};
export type TaskExecutionChildProof = {
  version: 1;
  parentRunId: string;
  parentTaskId: string | null;
  parentAdmissionDigest: string;
  parentLegacy: boolean;
  planRevision: string;
  childInputDigest: string;
  relationId: string | null;
};
export type TaskAdmissionSnapshot = {
  version: 1;
  mode: "legacy" | "required" | "execution_child";
  policyVersion: 1;
  inputRevision: number;
  qualificationId: string | null;
  qualificationRevision: number | null;
  evidenceTarget: string | null;
  evidenceSha: string | null;
  parent: TaskExecutionChildProof | null;
};

export type TaskQualificationLaunchSnapshot = {
  version: 1;
  role: "intake" | "qualifier";
  taskId: string | null;
  target: string | null;
  sha: string | null;
};
