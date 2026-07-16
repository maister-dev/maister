// Slot-keyed runner resolution + immutable materialization snapshot for a
// controlled Evaluation Recipe (M47, ADR-143 D16 §slotBindings + D8 snapshot).
//
// This is the PURE resolution core. Given a recipe's slot bindings, the Flow's
// DECLARED stable session/consensus slots, and the live runner catalog, it
// resolves EVERY declared slot to a concrete runner snapshot — never just the
// primary session (the "no primary-session-only false claim" invariant). A
// typed-intent slot resolves to an exact host runner (model+provider match) or
// records an explicit soft mismatch; it NEVER persists an unenforced modelId
// claim (the resolved snapshot always carries the LAUNCHED model, plus the
// requested-vs-launched delta when they differ). The immutable snapshot + its
// digests are what a launch persists to run_sessions (T6.3 threads them in).
//
// Client-safe (no `server-only`): the creation UI (T6.4) reuses this to preview
// the effective per-slot runner/model before launch.

import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { runnerIntentCandidates } from "@/lib/acp-runners/resolve";
import { contentDigest } from "@/lib/evaluations/digest";

// A stable slot the Flow declares (compiled from its graph). `capabilityAgent` is
// the slot's declared capability requirement, if the Flow pins one.
export interface RecipeSlotDeclaration {
  slotKey: string;
  capabilityAgent?: string;
  required: boolean;
}

export type RecipeSlotResolutionSource =
  | "recipe_runner"
  | "recipe_intent_exact"
  | "recipe_intent_soft"
  | "default_chain";

// A resolved slot — the concrete host runner a launched participant will use for
// this slot, plus the audited source and any recorded soft mismatch. `model` is
// always the LAUNCHED model (enforced), never the requested one.
export interface RecipeResolvedSlot {
  slotKey: string;
  runnerId: string;
  capabilityAgent: string;
  model: string;
  providerKind: string;
  resolutionSource: RecipeSlotResolutionSource;
  softMismatch?: {
    requestedModel?: string;
    requestedProviderKind?: string;
    launchedModel: string;
    launchedProviderKind: string;
  };
}

export const RECIPE_SLOT_REFUSAL_CODES = [
  "slot_unknown",
  "slot_unbound",
  "slot_runner_unavailable",
  "slot_runner_capability_mismatch",
  "slot_intent_unsatisfiable",
] as const;
export type RecipeSlotRefusalCode = (typeof RECIPE_SLOT_REFUSAL_CODES)[number];

export interface RecipeSlotRefusal {
  code: RecipeSlotRefusalCode;
  slotKey: string;
  message: string;
}

export interface SlotResolutionResult {
  resolved: RecipeResolvedSlot[];
  refusals: RecipeSlotRefusal[];
}

// The default chain for an unbound OPTIONAL/implicit slot (the config-less
// `default` session). A required slot with no binding is a refusal, not a
// default-chain resolution.
export interface SlotDefaultChain {
  projectDefaultRunnerId?: string | null;
  platformDefaultRunnerId: string;
}

function readyRunner(
  runnerId: string,
  runners: readonly RunnerCatalogEntry[],
): RunnerCatalogEntry | null {
  const runner = runners.find((r) => r.id === runnerId);

  if (!runner || !runner.enabled || !runner.ready) return null;

  return runner;
}

function snapshotSlot(
  slotKey: string,
  runner: RunnerCatalogEntry,
  resolutionSource: RecipeSlotResolutionSource,
  softMismatch?: RecipeResolvedSlot["softMismatch"],
): RecipeResolvedSlot {
  return {
    slotKey,
    runnerId: runner.id,
    capabilityAgent: runner.capabilityAgent,
    model: runner.model,
    providerKind: runner.providerKind,
    resolutionSource,
    ...(softMismatch ? { softMismatch } : {}),
  };
}

function resolveOneSlot(
  decl: RecipeSlotDeclaration,
  binding: EvaluationControlledRecipeDefinition["slotBindings"][string] | undefined,
  runners: readonly RunnerCatalogEntry[],
  defaultChain: SlotDefaultChain,
): { resolved?: RecipeResolvedSlot; refusal?: RecipeSlotRefusal } {
  const slotKey = decl.slotKey;

  if (!binding) {
    if (decl.required) {
      return {
        refusal: {
          code: "slot_unbound",
          slotKey,
          message: `required slot "${slotKey}" has no runner binding`,
        },
      };
    }
    // Optional / implicit slot: resolve via the default chain.
    const chainId =
      defaultChain.projectDefaultRunnerId ?? defaultChain.platformDefaultRunnerId;
    const runner = readyRunner(chainId, runners);

    if (!runner) {
      return {
        refusal: {
          code: "slot_runner_unavailable",
          slotKey,
          message: `default-chain runner "${chainId}" for slot "${slotKey}" is missing, disabled, or not ready`,
        },
      };
    }

    return { resolved: snapshotSlot(slotKey, runner, "default_chain") };
  }

  if (binding.mode === "runner") {
    const runner = readyRunner(binding.runnerId, runners);

    if (!runner) {
      return {
        refusal: {
          code: "slot_runner_unavailable",
          slotKey,
          message: `slot "${slotKey}" pins runner "${binding.runnerId}" which is missing, disabled, or not ready`,
        },
      };
    }
    if (decl.capabilityAgent && runner.capabilityAgent !== decl.capabilityAgent) {
      return {
        refusal: {
          code: "slot_runner_capability_mismatch",
          slotKey,
          message: `slot "${slotKey}" requires capability ${decl.capabilityAgent} but runner "${runner.id}" is ${runner.capabilityAgent}`,
        },
      };
    }

    return { resolved: snapshotSlot(slotKey, runner, "recipe_runner") };
  }

  // Typed intent: exact host runner wins; same-capability is a recorded soft
  // mismatch; none is a refusal (never an unenforced modelId claim).
  const candidates = runnerIntentCandidates(
    binding.config,
    runners as RunnerCatalogEntry[],
  );

  if (candidates.exact.length > 0) {
    return {
      resolved: snapshotSlot(
        slotKey,
        candidates.exact[0],
        "recipe_intent_exact",
      ),
    };
  }
  if (candidates.sameCapability.length > 0) {
    const runner = candidates.sameCapability[0];

    return {
      resolved: snapshotSlot(slotKey, runner, "recipe_intent_soft", {
        requestedModel: binding.config.model,
        requestedProviderKind: binding.config.provider?.kind,
        launchedModel: runner.model,
        launchedProviderKind: runner.providerKind,
      }),
    };
  }

  return {
    refusal: {
      code: "slot_intent_unsatisfiable",
      slotKey,
      message: `slot "${slotKey}" intent has no enabled+ready host runner with capability ${binding.config.capability_agent}`,
    },
  };
}

// Resolve EVERY declared slot against the recipe bindings. Also refuses any
// recipe binding that targets a slot the Flow does not declare (a stale slot
// key). Aggregates all refusals; `resolved` is only complete when refusals is
// empty (a launch never proceeds on a partial slot map).
export function resolveRecipeSlotBindings(args: {
  slotBindings: EvaluationControlledRecipeDefinition["slotBindings"];
  declaredSlots: RecipeSlotDeclaration[];
  runners: readonly RunnerCatalogEntry[];
  defaultChain: SlotDefaultChain;
}): SlotResolutionResult {
  const declaredKeys = new Set(args.declaredSlots.map((s) => s.slotKey));
  const resolved: RecipeResolvedSlot[] = [];
  const refusals: RecipeSlotRefusal[] = [];

  // Stale slot keys — a recipe binding for a slot the Flow no longer declares.
  for (const slotKey of Object.keys(args.slotBindings)) {
    if (!declaredKeys.has(slotKey)) {
      refusals.push({
        code: "slot_unknown",
        slotKey,
        message: `recipe binds slot "${slotKey}" which the Flow does not declare`,
      });
    }
  }

  for (const decl of args.declaredSlots) {
    const { resolved: slot, refusal } = resolveOneSlot(
      decl,
      args.slotBindings[decl.slotKey],
      args.runners,
      args.defaultChain,
    );

    if (slot) resolved.push(slot);
    if (refusal) refusals.push(refusal);
  }

  return { resolved, refusals };
}

// The immutable materialization snapshot persisted when a controlled participant
// launches (D8/D16). Captures the resolved slot→runner map, the capability
// overlay + materialization intent, and stable digests so a launched
// participant's runtime truth is reproducible and drift-detectable.
export interface MaterializationSnapshot {
  slots: RecipeResolvedSlot[];
  capabilityOverlay: EvaluationControlledRecipeDefinition["capabilityOverlay"];
  materializationIntent: EvaluationControlledRecipeDefinition["materializationIntent"];
  digests: {
    slotsDigest: string;
    capabilityDigest: string;
    materializationDigest: string;
  };
}

// Build the immutable snapshot from the resolved slots + recipe overlay/intent.
// The slots digest is over the RESOLVED runner snapshots (launched truth), not
// the requested intent — so two recipes that resolve to identical runners share
// a materialization digest, and any resolution change is detectable.
export function buildMaterializationSnapshot(
  recipe: EvaluationControlledRecipeDefinition,
  resolved: RecipeResolvedSlot[],
): MaterializationSnapshot {
  const slots = [...resolved].sort((a, b) =>
    a.slotKey < b.slotKey ? -1 : a.slotKey > b.slotKey ? 1 : 0,
  );
  const slotsDigest = contentDigest(
    slots.map((s) => ({
      slotKey: s.slotKey,
      runnerId: s.runnerId,
      capabilityAgent: s.capabilityAgent,
      model: s.model,
      providerKind: s.providerKind,
    })),
  );
  const capabilityDigest = contentDigest(recipe.capabilityOverlay ?? {});
  const materializationDigest = contentDigest({
    slotsDigest,
    capabilityDigest,
    materializationIntent: recipe.materializationIntent,
  });

  return {
    slots,
    capabilityOverlay: recipe.capabilityOverlay,
    materializationIntent: recipe.materializationIntent,
    digests: { slotsDigest, capabilityDigest, materializationDigest },
  };
}
