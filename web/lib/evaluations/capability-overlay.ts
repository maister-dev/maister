import { z } from "zod";

// The controlled-launch capability overlay (ADR-146 D16 / ADR-149). This is the
// canonical home for the overlay schema — byte-identical to the legacy
// experiment overlay it supersedes. `lib/experiments/variant-config.ts`
// re-exports these under their historical `experiment*` names until that module
// is deleted (Phase 5). Pure zod, no `server-only` deps: recipe-schema.ts and
// its client importers parse this in the browser bundle.

function firstDuplicate(values: readonly string[] | undefined): string | null {
  if (!values) return null;

  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return null;
}

export const evaluationOverlayDeltaSchema = z
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

export const evaluationCapabilityOverlaySchema = z
  .object({
    rules: evaluationOverlayDeltaSchema.optional(),
    skills: evaluationOverlayDeltaSchema.optional(),
    mcps: evaluationOverlayDeltaSchema.optional(),
    subagents: evaluationOverlayDeltaSchema.optional(),
  })
  .strict();
