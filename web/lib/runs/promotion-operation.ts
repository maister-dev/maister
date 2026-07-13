export type PromotionMode =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";

export interface PromotionDeliveryPolicy {
  strategy: PromotionMode;
  push: "never" | "on_success";
  trigger: "manual" | "auto_on_ready";
  targetBranch: string;
}

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
}

export type PromotionBlockReason =
  | "missing-target"
  | "not-authorized"
  | "review-not-ready"
  | "diff-truncated"
  | "missing-review-target"
  | "legacy-needs-relaunch";

export interface PromotionRequestBody {
  targetBranch: string;
  deliveryPolicyOverride: PromotionDeliveryPolicy;
  reviewedTargetCommit: string;
  allowTargetDrift?: true;
}

export function promotionBlockReason(
  input: PromotionOperationInput,
): PromotionBlockReason | null {
  if (!input.targetBranch) return "missing-target";
  if (input.legacyNeedsRelaunch) return "legacy-needs-relaunch";
  if (!input.canPromote) return "not-authorized";
  if (!input.reviewReady) return "review-not-ready";
  if (input.diffTruncated && !input.truncationAcknowledged) {
    return "diff-truncated";
  }
  if (!input.reviewedTargetCommit) return "missing-review-target";

  return null;
}

export function buildPromotionRequestBody(
  input: PromotionOperationInput,
  allowTargetDrift = false,
): PromotionRequestBody | null {
  if (promotionBlockReason(input) !== null) return null;

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
  };
}

export function isTargetDriftResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const response = value as { code?: unknown; message?: unknown };

  return (
    response.code === "PRECONDITION" &&
    typeof response.message === "string" &&
    /target advanced/i.test(response.message)
  );
}
