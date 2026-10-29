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
