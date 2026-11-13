import type { DeliveryPolicy, DeliveryPolicyStrategy } from "./delivery-policy";

export type PromotionMode = DeliveryPolicyStrategy;

export type PromotionDeliveryPolicy = DeliveryPolicy;

export interface PromotionOperationInput {
  targetBranch: string | null;
  deliveryPolicy: PromotionDeliveryPolicy;
  mode: PromotionMode;
  reviewedTargetCommit: string | null;
  canPromote: boolean;
  reviewReady: boolean;
  diffTruncated: boolean;
  legacyNeedsRelaunch: boolean;
  truncationAcknowledged?: boolean;
  // ADR-141 (Task 13/16): opt-in one-click chaining for a resolver-backed
  // ai_rebase_merge conflict. Only carried into the body when mode is
  // `ai_rebase_merge` (ignored for every other mode). Default OFF.
  autoFinalize?: boolean;
}

export type PromotionBlockReason =
  | "missing-target"
  | "not-authorized"
  | "review-not-ready"
  | "diff-truncated"
  | "missing-review-target"
  | "legacy-needs-relaunch";

export interface PromotionRequestBody {
  targetBranch?: string;
  deliveryPolicyOverride?: PromotionDeliveryPolicy;
  reviewedTargetCommit?: string;
  allowTargetDrift?: true;
  autoFinalize?: true;
}

export function promotionBlockReason(
  input: PromotionOperationInput,
): PromotionBlockReason | null {
  const publishesBranch = input.mode === "publish_branch";

  if (!publishesBranch && !input.targetBranch) return "missing-target";
  if (input.legacyNeedsRelaunch) return "legacy-needs-relaunch";
  if (!input.canPromote) return "not-authorized";
  if (!input.reviewReady) return "review-not-ready";
  if (input.diffTruncated && !input.truncationAcknowledged) {
    return "diff-truncated";
  }
  if (!publishesBranch && !input.reviewedTargetCommit)
    return "missing-review-target";

  return null;
}

export function buildPromotionRequestBody(
  input: PromotionOperationInput,
  allowTargetDrift = false,
): PromotionRequestBody | null {
  if (promotionBlockReason(input) !== null) return null;
  if (input.mode === "publish_branch") return {};

  return {
    targetBranch: input.targetBranch as string,
    deliveryPolicyOverride: {
      ...input.deliveryPolicy,
      strategy: input.mode,
      trigger: "manual",
      targetBranch: input.targetBranch as string,
    },
    reviewedTargetCommit: input.reviewedTargetCommit as string,
    ...(allowTargetDrift ? { allowTargetDrift: true } : {}),
    ...(input.mode === "ai_rebase_merge" && input.autoFinalize
      ? { autoFinalize: true }
      : {}),
  };
}

export function isTargetDriftResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const response = value as {
    code?: unknown;
    message?: unknown;
    details?: { reason?: unknown };
  };

  if (response.code !== "PRECONDITION") return false;
  // ADR-181: the typed token first; the message match serves a body without one.
  if (response.details?.reason === "target_drift") return true;

  return (
    typeof response.message === "string" &&
    /target advanced/i.test(response.message)
  );
}

// ADR-181 (C): a squashing PR promotion refused because the PR branch holds
// commits the run does not. It is a CONFLICT, but no merge conflict — the way
// out is updating onto the publication, not resolving a merge.
export function isPublicationDivergedResponse(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { details?: { reason?: unknown } }).details?.reason ===
      "publication_diverged"
  );
}

export function isPublicationPushRejectedResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const response = value as { code?: unknown; details?: { reason?: unknown } };

  return (
    response.code === "CONFLICT" &&
    response.details?.reason === "non_fast_forward"
  );
}

export function githubPrErrorText(
  response: {
    code?: string;
    message?: string;
    details?: { reason?: string };
  } | null,
  labels: { authRequired: string; cliFailed: string },
): string | null {
  const reason = response?.details?.reason;

  if (response?.code === "PRECONDITION" && reason === "github_auth_required")
    return labels.authRequired;
  if (
    response?.code === "EXECUTOR_UNAVAILABLE" &&
    reason === "github_cli_failed"
  )
    return typeof response.message === "string" && response.message
      ? response.message
      : labels.cliFailed;

  return null;
}

// ADR-181 (Codex F4): the recorded PR was merged on the provider without the
// run's later commits. Nothing was changed; they need a PR of their own.
export function isMergedPrBehindResponse(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { details?: { reason?: unknown } }).details?.reason ===
      "merged_pr_behind"
  );
}
