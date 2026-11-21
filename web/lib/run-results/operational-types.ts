import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { AgentFinalStatus } from "@/lib/agents/finalization";
import type {
  OperationalFailureDiagnostic,
  WorkspaceIntegrityLimit,
} from "@/lib/agents/operational-diagnostics";
import type { AgentWorkspace } from "@/lib/db/schema";
import type { EvidenceFindingsV1 } from "./findings-types";

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

export type OperationalEvidenceV2 = Omit<
  OperationalResultV1,
  "schemaVersion"
> & {
  schemaVersion: 2;
  findings: EvidenceFindingsV1;
  operationIds: string[];
  verificationIds: string[];
};

export type OperationalResult = OperationalResultV1 | OperationalEvidenceV2;

export type OperationalValidationCode =
  | "result_missing"
  | "malformed_json"
  | "oversize"
  | "unsupported_version"
  | "field_required"
  | "invalid_type"
  | "invalid_value"
  | "unknown_fields"
  | "invalid_structure"
  | "attempted_count_mismatch"
  | "scanned_count_exceeded"
  | "created_count_exceeded"
  | "complete_coverage_remaining"
  | "not_started_has_scanned"
  | "duplicate_reference"
  | "operation_receipt_requires_server_reference"
  | "evidence_reference_unavailable"
  | "undeclared_diagnostic_reference"
  | "success_inconsistent"
  | "partial_requires_progress"
  | "partial_requires_incomplete_work"
  | "error_diagnostic_required"
  | "failed_work_requires_error"
  | "creation_reference_missing";

/** At most 20 safe rules; paths contain only schema-known fields and indices. */
export type OperationalValidationDiagnostic = {
  code: OperationalValidationCode;
  path: string;
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
  version: 1 | 2;
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
  worktreeConfigDigest?: string | null;
  refs: Array<{ ref: string; sha: string }>;
  source: OperationalIntegrityEntry[];
  platform: OperationalIntegrityEntry[];
  /** Immutable sibling checkout descriptors and full source witnesses. */
  contextMounts?: Array<{
    mount: ContextMountSnapshot;
    baseline: Omit<OperationalIntegrityBaseline, "contextMounts">;
  }>;
  owner?:
    | { cwd: string; repoPath: string; projectSlug: string }
    | {
        kind: "company";
        companyId: string;
        runId: string;
        cwd: string;
        runtimePath: string;
      };
};

export type OperationalTerminal = {
  version: 1;
  status: Exclude<AgentFinalStatus, "Review">;
  cause: string;
  effectiveOutcome: OperationalResultV1["outcome"] | "cancelled" | "crashed";
  successful: boolean;
  validation: "valid" | "invalid" | "unchecked";
  validationDiagnostics?: OperationalValidationDiagnostic[];
  integrity: OperationalIntegrityVerdict;
  integrityLimit?: WorkspaceIntegrityLimit;
  baselineGeneration: number | null;
  resultRevision: number | null;
  reasonCodes: string[];
  evidenceIds: string[];
  infrastructureFailure?: OperationalFailureDiagnostic;
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
  integrityLimit?: WorkspaceIntegrityLimit;
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
  validationDiagnostics?: OperationalValidationDiagnostic[];
  infrastructureFailure?: OperationalFailureDiagnostic;
  continuationAttention?: {
    assignmentEpoch: number;
    reason: string;
    blockedReason: string;
    observation: string;
    integrityLimit?: WorkspaceIntegrityLimit;
  };
  integrity: "pending" | OperationalIntegrityVerdict;
  integrityLimit?: WorkspaceIntegrityLimit;
  cleanupIntegrityLimit?: WorkspaceIntegrityLimit;
  resultRevision: number | null;
  reportedResult: OperationalResult | null;
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
