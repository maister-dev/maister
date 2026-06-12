import { z } from "zod";

export type DeliveryPolicyStrategy =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";

export type DeliveryPolicyPush = "never" | "on_success";

export type DeliveryPolicyTrigger = "manual" | "auto_on_ready";

export type DeliveryPolicy = {
  strategy: DeliveryPolicyStrategy;
  push: DeliveryPolicyPush;
  trigger: DeliveryPolicyTrigger;
  targetBranch: string;
};

export type StoredDeliveryPolicy = Omit<DeliveryPolicy, "targetBranch"> & {
  targetBranch: string | null;
};

export type DeliveryPolicyOverride = Partial<StoredDeliveryPolicy>;

export type LegacyPromotionMode =
  | "local_merge"
  | "rebase_merge"
  | "pull_request";

export type EffectivePromotionMode =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";

export const deliveryPolicyStrategySchema = z.enum([
  "merge",
  "rebase_merge",
  "pull_request",
  "ai_rebase_merge",
]);

export const deliveryPolicyPushSchema = z.enum(["never", "on_success"]);

export const deliveryPolicyTriggerSchema = z.enum(["manual", "auto_on_ready"]);

export const storedDeliveryPolicySchema = z
  .object({
    strategy: deliveryPolicyStrategySchema,
    push: deliveryPolicyPushSchema,
    trigger: deliveryPolicyTriggerSchema,
    targetBranch: z.string().min(1).nullable(),
  })
  .strict();

export const deliveryPolicyOverrideSchema = storedDeliveryPolicySchema
  .partial()
  .strict();

export function defaultDeliveryPolicy(
  projectMainBranch: string,
): DeliveryPolicy {
  return {
    strategy: "merge",
    push: "never",
    trigger: "manual",
    targetBranch: projectMainBranch,
  };
}

export function deliveryPolicyFromLegacyPromotionMode(args: {
  projectPromotionMode?: string | null;
  projectMainBranch: string;
}): DeliveryPolicy {
  return {
    ...defaultDeliveryPolicy(args.projectMainBranch),
    strategy:
      args.projectPromotionMode === "pull_request"
        ? "pull_request"
        : args.projectPromotionMode === "rebase_merge"
          ? "rebase_merge"
          : "merge",
  };
}

export function strategyFromLegacyPromotionMode(
  mode: LegacyPromotionMode,
): Exclude<DeliveryPolicyStrategy, "ai_rebase_merge"> {
  return mode === "pull_request"
    ? "pull_request"
    : mode === "rebase_merge"
      ? "rebase_merge"
      : "merge";
}

export function legacyPromotionModeFromStrategy(
  strategy: Exclude<DeliveryPolicyStrategy, "ai_rebase_merge">,
): LegacyPromotionMode {
  return strategy === "pull_request"
    ? "pull_request"
    : strategy === "rebase_merge"
      ? "rebase_merge"
      : "local_merge";
}

export function effectivePromotionModeFromPolicy(
  policy: DeliveryPolicy,
): EffectivePromotionMode {
  return policy.strategy;
}

export function resolveDeliveryPolicy(args: {
  projectDefault?: StoredDeliveryPolicy | null;
  projectPromotionMode?: string | null;
  projectMainBranch: string;
  launchOverride?: DeliveryPolicyOverride | null;
}): DeliveryPolicy {
  const base = args.projectDefault
    ? {
        ...args.projectDefault,
        targetBranch:
          args.projectDefault.targetBranch ?? args.projectMainBranch,
      }
    : deliveryPolicyFromLegacyPromotionMode({
        projectPromotionMode: args.projectPromotionMode,
        projectMainBranch: args.projectMainBranch,
      });
  const override = args.launchOverride ?? {};

  return {
    strategy: override.strategy ?? base.strategy,
    push: override.push ?? base.push,
    trigger: override.trigger ?? base.trigger,
    targetBranch:
      override.targetBranch === undefined || override.targetBranch === null
        ? base.targetBranch
        : override.targetBranch,
  };
}

export function switchDeliveryPolicyToManual(
  policy: DeliveryPolicy,
): DeliveryPolicy {
  return { ...policy, trigger: "manual" };
}
