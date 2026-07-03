import type { CapabilityAgent } from "@/lib/config.schema";
import type { ExperimentCapabilityOverlay } from "@/lib/experiments/types";
import {
  OVERLAY_CLASS_SUPPORT_BY_AGENT,
  type OverlayCapabilityClass,
} from "@/lib/flows/enforcement";
import { MaisterError } from "@/lib/errors-core";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

import { z } from "zod";

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

function firstDuplicate(values: readonly string[] | undefined): string | null {
  if (!values) return null;

  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return null;
}

export const experimentOverlayDeltaSchema = z
  .object({
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((delta, ctx) => {
    const duplicateAdd = firstDuplicate(delta.add);
    const duplicateRemove = firstDuplicate(delta.remove);

    if (duplicateAdd) {
      ctx.addIssue({
        code: "custom",
        path: ["add"],
        message: `duplicate add ref "${duplicateAdd}"`,
      });
    }
    if (duplicateRemove) {
      ctx.addIssue({
        code: "custom",
        path: ["remove"],
        message: `duplicate remove ref "${duplicateRemove}"`,
      });
    }

    const remove = new Set(delta.remove ?? []);
    const duplicateAcross = (delta.add ?? []).find((ref) => remove.has(ref));

    if (duplicateAcross) {
      ctx.addIssue({
        code: "custom",
        message: `overlay ref "${duplicateAcross}" cannot be both added and removed`,
      });
    }
  });

export const experimentCapabilityOverlaySchema = z
  .object({
    rules: experimentOverlayDeltaSchema.optional(),
    skills: experimentOverlayDeltaSchema.optional(),
    mcps: experimentOverlayDeltaSchema.optional(),
    subagents: experimentOverlayDeltaSchema.optional(),
  })
  .strict();

export const experimentVariantConfigSchema = z
  .object({
    runnerId: z.string().min(1).optional(),
    executionPolicy: executionPolicySchema.optional(),
    capabilityOverlay: experimentCapabilityOverlaySchema.optional(),
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
    if (
      (delta.add?.length ?? 0) === 0 &&
      (delta.remove?.length ?? 0) === 0
    ) {
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
