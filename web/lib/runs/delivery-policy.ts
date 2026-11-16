import { z } from "zod";

export type DeliveryPolicyStrategy = z.infer<
  typeof deliveryPolicyStrategySchema
>;

export type DeliveryPolicyPush = "never" | "on_success";

export type DeliveryPolicyTrigger = "manual" | "auto_on_ready";

export type DeliveryPolicy = {
  strategy: DeliveryPolicyStrategy;
  push: DeliveryPolicyPush;
  trigger: DeliveryPolicyTrigger;
  targetBranch: string;
  // ADR-207: run-snapshot only (never project/flow config) — whether a
  // confirmed merge of this Run's PR may complete its task.
  resolvesTask?: boolean;
};

export type StoredDeliveryPolicy = Omit<
  DeliveryPolicy,
  "targetBranch" | "resolvesTask"
> & {
  targetBranch: string | null;
};

export type DeliveryPolicyOverride = Partial<StoredDeliveryPolicy>;

export type LegacyPromotionMode =
  "local_merge" | "rebase_merge" | "pull_request";

export type EffectivePromotionMode = DeliveryPolicyStrategy;

export const deliveryPolicyStrategySchema = z.enum([
  "merge",
  "rebase_merge",
  "pull_request",
  "ai_rebase_merge",
  "publish_branch",
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

/** Absent on legacy snapshots: every PR delivery before ADR-207 resolved its task. */
export function snapshotResolvesTask(snapshot: unknown): boolean {
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    return (snapshot as { resolvesTask?: unknown }).resolvesTask !== false;
  }

  return true;
}

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
): "merge" | "rebase_merge" | "pull_request" {
  return mode === "pull_request"
    ? "pull_request"
    : mode === "rebase_merge"
      ? "rebase_merge"
      : "merge";
}

export function legacyPromotionModeFromStrategy(
  strategy: DeliveryPolicyStrategy,
): LegacyPromotionMode {
  return strategy === "pull_request"
    ? "pull_request"
    : strategy === "rebase_merge" || strategy === "ai_rebase_merge"
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

export function deliveryPolicyForLaunch(
  policy: DeliveryPolicy,
): DeliveryPolicy {
  return policy.strategy === "publish_branch"
    ? { ...policy, push: "on_success", trigger: "auto_on_ready" }
    : policy;
}
