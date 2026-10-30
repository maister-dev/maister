import type { ConfigPersistState, ConfigPushState } from "./types";

export const CONFIG_PERSIST_REASONS = [
  "stale_preview",
  "preview_expired",
  "wrong_branch",
  "detached_head",
  "dirty_checkout",
  "operation_in_progress",
  "unsupported_checkout",
  "manifest_invalid",
  "manifest_too_large",
  "diff_too_large",
  "package_source_unexportable",
  "package_revision_mismatch",
  "missing_package_install",
  "repository_unavailable",
  "operation_busy",
  "recovery_required",
  "commit_failed",
  "push_failed",
  "push_review_stale",
  "not_committed",
  "authority_changed",
] as const;
export type ConfigPersistReason = (typeof CONFIG_PERSIST_REASONS)[number];
export type ConfigStatus = {
  exportState: "unverified" | "missing" | "in_sync" | "pending" | "blocked";
  repositoryState:
    | "ready"
    | "dirty"
    | "wrong_branch"
    | "detached"
    | "operation_in_progress"
    | "unavailable";
  observedAt: string | null;
  exportRevision: string;
  reason?: ConfigPersistReason;
  lastObservedExportState?: "missing" | "in_sync" | "pending" | "blocked";
  lastObservedAt?: string;
  operationId?: string;
};

export const CONFIG_CLEANUP_REASONS = [
  "unexpected_private_content",
  "cleanup_failed",
  "operation_busy",
  "recovery_required",
  "authority_changed",
] as const;
export type ConfigCleanupReason = (typeof CONFIG_CLEANUP_REASONS)[number];
export type ConfigCleanupState = "pending" | "complete" | "retained";

export type ConfigPreview =
  | {
      kind: "ready";
      previewId: string;
      digest: string;
      expiresAt: string;
      targetBranch: string;
      filename: "maister.yaml";
      message: "chore(maister): persist project config";
      diff: string;
      baseSha: string | null;
      exportRevision: string;
      usedDefaultAuthor: boolean;
    }
  | {
      kind: "noop";
      operationId: string;
      status: ConfigStatus;
    }
  | {
      kind: "blocked";
      status: ConfigStatus;
      reason: ConfigPersistReason;
      paths: string[];
    };

export type ConfigReceipt = {
  operationId: string;
  state: ConfigPersistState;
  baseSha: string | null;
  commitSha: string | null;
  targetBranch: string;
  usedDefaultAuthor: boolean;
  pushState: ConfigPushState | "not_requested";
  reason?: ConfigPersistReason;
  cleanupState: ConfigCleanupState;
  cleanupReason?: ConfigCleanupReason;
};

export type ConfigPushReview = {
  pushPreviewId: string;
  digest: string;
  expiresAt: string;
  remote: "origin";
  destination: string;
  url: string;
  commitSha: string;
  remoteBase: string | null;
  outgoingShas: string[];
};

export type ConfigPushResult = {
  operationId: string;
  pushIntentId: string;
  state: ConfigPushState;
  commitSha: string;
  localCommitPreserved: true;
  reason?: ConfigPersistReason;
  cleanupState: ConfigCleanupState;
  cleanupReason?: ConfigCleanupReason;
};
