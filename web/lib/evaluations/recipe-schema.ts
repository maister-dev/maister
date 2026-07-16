// Typed controlled Evaluation Recipe contract (M47, ADR-146 D16). M46 stored a
// Study recipe as an opaque `EvaluationRecipeDefinition` (legacy variant configs
// from the Experiment migration). M47 gives the CONTROLLED recipe a strict,
// immutable, digest-addressed shape: it references an explicit Flow/package
// revision and pins every stable session/consensus slot, so a launched
// participant is reproducible and its provenance is unambiguous.
//
// This module is client-safe (no `server-only`): the controlled-creation UI
// (T6.4) reuses the schema to validate a draft before submission, and the
// preflight/launch services (T6.1–T6.3) reuse it server-side. It reuses the
// existing platform contracts (execution policy, capability overlay, budget
// axis, runner config) rather than inventing parallel shapes.

import { z } from "zod";

import {
  budgetAxisSchema,
  executionPolicySchema,
} from "@/lib/runs/execution-policy";
import { experimentCapabilityOverlaySchema } from "@/lib/experiments/variant-config";
import { flowRunnerConfigSchema } from "@/lib/config.schema";

// The forced promotion hold source. A launched Evaluation participant ALWAYS
// carries `promotionHold.source = evaluation_study` (D3/D15) and a recipe cannot
// remove it — even an unattended-within-policy recipe cannot auto-promote.
export const EVALUATION_RECIPE_HOLD_SOURCE = "evaluation_study" as const;

// A stable slot key resolves either to a concrete runner id (a hard pin) or to a
// typed runner intent (capability agent + optional model/provider/effort). The
// intent form reuses `flowRunnerConfigSchema` so a recipe never introduces a
// parallel runner contract. Resolution persists the actual run_sessions snapshot
// and any permitted soft mismatch (T6.2).
export const recipeSlotTargetSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("runner"),
      runnerId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("intent"),
      // The typed runner intent — capability agent is required, everything else
      // (model/provider/effort) is an optional requirement resolved at launch.
      config: flowRunnerConfigSchema,
    })
    .strict(),
]);
export type RecipeSlotTarget = z.infer<typeof recipeSlotTargetSchema>;

// D16 `flow`: the explicit, immutable Flow/package revision reference plus the
// input- and output/artifact-contract digests captured at recipe-freeze time.
// Later package/flow drift never silently changes what a launched participant
// ran — the recipe pins the revision and the contract digests.
const recipeFlowRefSchema = z
  .object({
    flowRefId: z.string().min(1),
    flowRevisionId: z.string().min(1),
    packageInstallId: z.string().min(1).optional(),
    versionLabel: z.string().min(1).optional(),
    resolvedRevision: z.string().min(1).optional(),
    inputContractDigest: z.string().min(1),
    artifactContractDigest: z.string().min(1),
  })
  .strict();

// D16 `inputs`: a reference to the task snapshot plus form/input values validated
// against the selected Flow. M47 permits NO arbitrary transform script — a
// forbidden `transform`/`script`/`mapping` key is rejected by `.strict()`.
const recipeInputsSchema = z
  .object({
    taskSnapshotRef: z.string().min(1),
    formValues: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .strict();

// D16 `nodeAgentBindings`: optional nodeId → package-qualified agent definition
// binding, kept DISTINCT from host runner resolution (an agent persona is not a
// runner). `agentId` is `agents.id` (`<packageName>:<stem>`).
const recipeNodeAgentBindingSchema = z
  .object({
    nodeId: z.string().min(1),
    agentId: z.string().min(1),
  })
  .strict();

// D16 `materializationIntent`: package pins/version choices, capability/MCP
// requirements, and allowed project overlays — DECLARATIVE only. No path,
// credential, environment value, or executable hook (`.strict()` blocks any
// unknown key; the fields themselves carry only refs/labels).
const recipeMaterializationIntentSchema = z
  .object({
    packagePins: z
      .array(
        z
          .object({
            packageInstallId: z.string().min(1),
            versionLabel: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    capabilityRequirements: z.array(z.string().min(1)).default([]),
    allowedProjectOverlays: z.array(z.string().min(1)).default([]),
  })
  .strict();

// D16 `replicatePolicy`: group key and requested count. Each launched
// participant stores its ordinal + recipe digest at fan-out (T6.3).
const recipeReplicatePolicySchema = z
  .object({
    groupKey: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();

// The forced promotion hold — always `evaluation_study` and unremovable by a
// recipe. `.default` supplies it when absent; the literal rejects any other
// source, so a recipe author cannot weaken the hold.
const recipePromotionHoldSchema = z
  .object({
    source: z.literal(EVALUATION_RECIPE_HOLD_SOURCE),
  })
  .strict()
  .default({ source: EVALUATION_RECIPE_HOLD_SOURCE });

// The full immutable controlled Evaluation Recipe definition (D16). `.strict()`
// at every level so an unknown key — including an arbitrary transform/mapping
// script — is a loud CONFIG failure, never a silent drop.
export const evaluationRecipeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    flow: recipeFlowRefSchema,
    inputs: recipeInputsSchema,
    nodeAgentBindings: z.array(recipeNodeAgentBindingSchema).default([]),
    // Every stable session/consensus slot key → concrete runner override or
    // typed runner intent. The `default` session may be omitted (it resolves via
    // the project/platform default chain).
    slotBindings: z
      .record(z.string().min(1), recipeSlotTargetSchema)
      .default({}),
    executionPolicy: executionPolicySchema,
    capabilityOverlay: experimentCapabilityOverlaySchema.optional(),
    budgets: budgetAxisSchema.optional(),
    materializationIntent: recipeMaterializationIntentSchema.default({
      packagePins: [],
      capabilityRequirements: [],
      allowedProjectOverlays: [],
    }),
    replicatePolicy: recipeReplicatePolicySchema.optional(),
    promotionHold: recipePromotionHoldSchema,
  })
  .strict();

export type EvaluationControlledRecipeDefinition = z.infer<
  typeof evaluationRecipeDefinitionSchema
>;
