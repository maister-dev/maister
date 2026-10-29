import type { AgentFinalStatus } from "@/lib/agents/finalization";
import type { AgentWorkspace } from "@/lib/db/schema";

export type OperationalReference = {
  kind: "task" | "external_issue" | "operation_receipt" | "other";
  id: string;
  state: "confirmed" | "unresolved";
  url?: string;
};

export type OperationalDiagnostic = {
  code: string;
  severity: "warning" | "error";
  operation: string;
  message: string;
  retryable: boolean;
  remediation: string;
  referenceIds?: string[];
  service?: string;
  httpStatus?: number;
};

export type OperationalResultV1 = {
  schemaVersion: 1;
  outcome: "success" | "partial" | "blocked" | "failed";
  summary: string;
  coverage: {
    state: "complete" | "incomplete" | "not_started";
    remainingKnown: number | null;
  };
  counts: {
    scanned: number;
    attempted: number;
    completed: number;
    failed: number;
    skipped: number;
    created: number;
  };
  references: OperationalReference[];
  diagnostics: OperationalDiagnostic[];
};

export type OperationalIntegrityVerdict =
  "clean" | "changed" | "indeterminate" | "unchecked";
export type OperationalResourceKind =
  "worktree" | "ephemeral_checkout" | "plain_directory" | "shared_repository";

/** Hashes and metadata only; source bodies stay in execution evidence. */
export type OperationalIntegrityEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "absent";
  sha256: string;
  mode: number;
};

export type OperationalIntegrityBaseline = {
  version: 1;
  generation: number;
  resourceKind: OperationalResourceKind;
  capturedAt: string;
  head: string | null;
  branch: string | null;
  indexDigest: string | null;
  indexContentDigest: string | null;
  historyDigest: string | null;
  gitIdentity: string | null;
  gitConfigDigest?: string | null;
  refs: Array<{ ref: string; sha: string }>;
  source: OperationalIntegrityEntry[];
  platform: OperationalIntegrityEntry[];
  owner?: { cwd: string; repoPath: string; projectSlug: string };
};

export type OperationalTerminal = {
  version: 1;
  status: Exclude<AgentFinalStatus, "Review">;
  cause: string;
  effectiveOutcome: OperationalResultV1["outcome"] | "cancelled" | "crashed";
  successful: boolean;
  validation: "valid" | "invalid" | "unchecked";
  integrity: OperationalIntegrityVerdict;
  baselineGeneration: number | null;
  resultRevision: number | null;
  reasonCodes: string[];
  evidenceIds: string[];
};

export type OperationalCleanupState =
  | "retained"
  | "armed"
  | "preserving"
  | "removed"
  | "released"
  | "retry"
  | "exhausted";

export type OperationalCleanup = {
  version: 1;
  resourceKind: OperationalResourceKind;
  workspace: AgentWorkspace;
  state: OperationalCleanupState;
  revision: number;
  armedAt: string;
  attempts: number;
  dueAt: string | null;
  errorCode: string | null;
  evidenceIds: string[];
  removedAt: string | null;
  releasedAt: string | null;
  lease: { id: string; owner: string; expiresAt: string } | null;
  rearmReceipt: { expectedRevision: number; revision: number } | null;
};

export type OperationalAttentionReason =
  "operation_failure" | "cleanup_failure";

export type OperationalOutcome = {
  version: 1;
  state: "pending" | "terminal";
  reportedOutcome: OperationalResultV1["outcome"] | null;
  effectiveOutcome: OperationalTerminal["effectiveOutcome"] | null;
  successful: boolean;
  validation: "pending" | OperationalTerminal["validation"];
  integrity: "pending" | OperationalIntegrityVerdict;
  resultRevision: number | null;
  reportedResult: OperationalResultV1 | null;
  referenceLinks: Array<{
    kind: OperationalReference["kind"];
    id: string;
    href: string;
  }>;
  reasonCodes: string[];
  cleanup: Pick<
    OperationalCleanup,
    "state" | "revision" | "attempts" | "dueAt" | "errorCode" | "evidenceIds"
  > | null;
};
