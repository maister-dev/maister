import type { CapabilityAgent } from "@/lib/config.schema";
import type { ExperimentCapabilityOverlay } from "@/lib/experiments/types";

import { z } from "zod";

import {
  OVERLAY_CLASS_SUPPORT_BY_AGENT,
  type OverlayCapabilityClass,
} from "@/lib/flows/enforcement";
import {
  evaluationCapabilityOverlaySchema,
  evaluationOverlayDeltaSchema,
} from "@/lib/evaluations/capability-overlay";
import { MaisterError } from "@/lib/errors-core";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

const OVERLAY_CLASSES = ["rules", "skills", "mcps", "subagents"] as const;

type OverlayClass = (typeof OVERLAY_CLASSES)[number];

export type CapabilitySelection = {
  selectedMcpIds: string[];
  selectedSkillIds: string[];
  selectedRuleIds: string[];
  selectedAgentDefinitionIds: string[];
};

export type OverlayRefCatalog = Record<OverlayClass, Set<string>>;

export const OVERLAY_SELECTION_KEY_BY_CLASS = {
  rules: "selectedRuleIds",
  skills: "selectedSkillIds",
  mcps: "selectedMcpIds",
  subagents: "selectedAgentDefinitionIds",
} as const satisfies Record<OverlayClass, keyof CapabilitySelection>;

// ADR-149 T3.5: the overlay schema moved to the evaluations module (its
// canonical home, which outlives this file's Phase-5 deletion). Re-exported here
// under the historical `experiment*` names so http-schemas.ts and the variant
// config below keep resolving until the legacy module is removed.
export const experimentOverlayDeltaSchema = evaluationOverlayDeltaSchema;
export const experimentCapabilityOverlaySchema =
  evaluationCapabilityOverlaySchema;

export const experimentVariantConfigSchema = z
  .object({
    runnerId: z.string().min(1).optional(),
    executionPolicy: executionPolicySchema.optional(),
    capabilityOverlay: experimentCapabilityOverlaySchema.optional(),
    // ADR-132: ephemeral per-run package pin — the variant's runs resolve the
    // task-flow's revision from this install; the attachment never moves.
    // Batch-validated at create AND re-validated at launch fan-out.
    packagePin: z
      .object({ packageInstallId: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict();

export function applyCapabilityOverlay(
  base: CapabilitySelection,
  overlay: ExperimentCapabilityOverlay | undefined,
): CapabilitySelection {
  const next: CapabilitySelection = {
    selectedMcpIds: [...base.selectedMcpIds],
    selectedSkillIds: [...base.selectedSkillIds],
    selectedRuleIds: [...base.selectedRuleIds],
    selectedAgentDefinitionIds: [...base.selectedAgentDefinitionIds],
  };

  for (const cls of OVERLAY_CLASSES) {
    const delta = overlay?.[cls];

    if (!delta) continue;

    const key = OVERLAY_SELECTION_KEY_BY_CLASS[cls];
    const remove = new Set(delta.remove ?? []);
    const selected = next[key].filter((id) => !remove.has(id));

    for (const id of delta.add ?? []) {
      if (!selected.includes(id)) selected.push(id);
    }

    next[key] = selected;
  }

  return next;
}

export function assertOverlayRefsKnown(
  overlay: ExperimentCapabilityOverlay | undefined,
  refs: OverlayRefCatalog,
): void {
  for (const cls of OVERLAY_CLASSES) {
    const delta = overlay?.[cls];

    if (!delta) continue;

    for (const ref of [...(delta.add ?? []), ...(delta.remove ?? [])]) {
      if (refs[cls].has(ref)) continue;

      throw new MaisterError("CONFIG", `unknown ${cls} overlay ref "${ref}"`);
    }
  }
}

export function assertVariantOverlaySupported(args: {
  capabilityAgent: CapabilityAgent;
  variantKey: string;
  overlay: ExperimentCapabilityOverlay | undefined;
}): void {
  for (const cls of OVERLAY_CLASSES) {
    const delta = args.overlay?.[cls];

    if (!delta) continue;
    if ((delta.add?.length ?? 0) === 0 && (delta.remove?.length ?? 0) === 0) {
      continue;
    }

    if (
      OVERLAY_CLASS_SUPPORT_BY_AGENT[args.capabilityAgent][
        cls as OverlayCapabilityClass
      ]
    ) {
      continue;
    }

    throw new MaisterError(
      "CONFIG",
      `variant "${args.variantKey}" overlay "${cls}" is not supported by ${args.capabilityAgent}`,
    );
  }
}
