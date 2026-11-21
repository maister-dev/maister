import { z } from "zod";

export const AUTONOMOUS_COMPLETION_ENGINE_MIN = "3.15.0";
export const autonomousFailureReason = z.enum([
  "wait_timeout",
  "rework_exhausted",
]);

const gateReference = z.strictObject({
  node: z.string().min(1).max(128),
  gate: z.string().min(1).max(128),
});

export const flowCompletionDeclaration = z
  .strictObject({
    ci: z.string().min(1).max(128),
    gates: z.array(gateReference).min(1).max(32),
    review: gateReference,
    failure_reasons: z.array(autonomousFailureReason).max(2).optional(),
  })
  .refine(
    ({ gates, review }) =>
      new Set(
        [...gates, review].map(({ node, gate }) =>
          JSON.stringify([node, gate]),
        ),
      ).size ===
      gates.length + 1,
    "Completion evidence references must be distinct",
  );

export const completionRisk = z.enum(["low", "medium", "high"]);

const completionLimits = z.strictObject({
  riskMax: completionRisk,
  confidenceMin: z.number().min(0).max(1),
  changedFilesMax: z.number().int().positive(),
  changedLinesMax: z.number().int().positive(),
  approvedCiSources: z.array(z.string().trim().min(1).max(256)).min(1).max(64),
});

const expectedRevision = z.number().int().nonnegative().lt(2147483647);

export const projectCompletionPatchSchema = completionLimits.partial().extend({
  enabled: z.boolean(),
  expectedRevision,
});

export const completionSettingsSchema = z.discriminatedUnion("enabled", [
  completionLimits.extend({ enabled: z.literal(true) }),
  completionLimits.partial().extend({ enabled: z.literal(false) }),
]);
export type CompletionSettings = z.infer<typeof completionSettingsSchema>;
export type EnabledCompletionSettings = Extract<
  CompletionSettings,
  { enabled: true }
>;

export const completionGrantSchema = z.strictObject({
  flowRevisionId: z.string().min(1),
  projectRevision: z.number().int().nonnegative(),
  platformRevision: z.number().int().nonnegative(),
  bounds: completionLimits.extend({ enabled: z.literal(true) }),
  declaration: flowCompletionDeclaration,
});
export type CompletionGrant = z.infer<typeof completionGrantSchema>;
export type CompletionGitAnchor = Readonly<{
  head: string;
  base: string;
  state: "captured" | "verified" | "invalid";
}>;

export const platformCompletionPatchSchema = z.strictObject({
  enabled: z.boolean(),
  expectedRevision,
});

export const DEFAULT_COMPLETION_LIMITS = {
  riskMax: "low",
  confidenceMin: 0.9,
  changedFilesMax: 10,
  changedLinesMax: 300,
} as const;
