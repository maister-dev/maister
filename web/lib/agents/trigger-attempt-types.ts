import { z } from "zod";

import { projectSourceReviewSchema } from "./project-source-review-types";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { ownerSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors-core";
import { postgresTextSchema } from "@/lib/text-schema";

export type AgentTriggerAttemptOutcome =
  | "launched"
  | "queued"
  | "refused"
  | "deduplicated"
  | "suppressed"
  | "failed"
  | "unknown";

const identity = postgresTextSchema.min(1).max(128);
const legacyBindingSchema = z
  .object({
    version: z.literal(1),
    scheduleId: z.string().min(1),
    triggerType: z.enum(["cron", "event", "mention"]),
    cronExpr: z.string().nullable(),
    timezone: z.string().nullable(),
    eventKinds: z.array(z.string()),
  })
  .strict();

/** References bind immutable accepted configuration bytes, not provider definitions or authority by themselves. */
export const companyConfigurationReferenceSchema = z
  .object({
    id: identity,
    revision: knowledgeRevisionSchema,
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const companyTriggerBindingSnapshotSchema = legacyBindingSchema
  .extend({
    version: z.literal(2),
    scheduleId: identity,
    triggerType: z.enum(["cron", "event"]),
    owner: ownerSchema.options[0],
    sourceRevision: knowledgeRevisionSchema,
    specialistBinding: companyConfigurationReferenceSchema,
    coordinatorFlowBinding: companyConfigurationReferenceSchema.nullable(),
    cronExpr: postgresTextSchema.min(1).max(128).nullable(),
    timezone: postgresTextSchema.min(1).max(64).nullable(),
    eventKinds: z
      .array(postgresTextSchema.min(1).max(128))
      .max(32)
      .refine(
        (kinds) => new Set(kinds).size === kinds.length,
        "Company event kinds must be distinct",
      ),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const valid =
      snapshot.triggerType === "cron"
        ? snapshot.cronExpr !== null &&
          snapshot.timezone !== null &&
          snapshot.eventKinds.length === 0
        : snapshot.cronExpr === null &&
          snapshot.timezone === null &&
          snapshot.eventKinds.length > 0;

    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message:
          "Company trigger snapshot must retain its exact cron or event selector",
      });
  });
/** Reviewed project automation adds current source approval without rewriting legacy project or company bytes. */
export const projectTriggerBindingSnapshotSchema = legacyBindingSchema
  .extend({
    version: z.literal(3),
    scheduleId: identity,
    triggerType: z.enum(["cron", "event"]),
    owner: ownerSchema.options[1],
    review: projectSourceReviewSchema,
    cronExpr: postgresTextSchema.min(1).max(255).nullable(),
    timezone: postgresTextSchema.min(1).max(64).nullable(),
    eventKinds: z
      .array(postgresTextSchema.min(1).max(128))
      .max(16)
      .refine(
        (kinds) => new Set(kinds).size === kinds.length,
        "Project event kinds must be distinct",
      ),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const valid =
      snapshot.triggerType === "cron"
        ? snapshot.cronExpr !== null &&
          snapshot.timezone !== null &&
          snapshot.eventKinds.length === 0
        : snapshot.cronExpr === null &&
          snapshot.timezone === null &&
          snapshot.eventKinds.length > 0 &&
          snapshot.eventKinds.length <= 16;

    if (
      !valid ||
      (snapshot.review.schemaVersion === 2 && snapshot.triggerType !== "event")
    )
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message:
          "Reviewed project invocation must retain its actual cron or event selector and review kind",
      });
  });

export const agentTriggerBindingSnapshotSchema = z.union([
  legacyBindingSchema,
  companyTriggerBindingSnapshotSchema,
  projectTriggerBindingSnapshotSchema,
]);
export type AgentTriggerBindingSnapshot = z.infer<
  typeof agentTriggerBindingSnapshotSchema
>;
export type CompanyConfigurationReference = z.infer<
  typeof companyConfigurationReferenceSchema
>;

/** Legacy project snapshots stay v1, company snapshots stay v2 and reviewed project invocations use v3. */
export function parseAgentTriggerBindingSnapshot(
  value: unknown,
): AgentTriggerBindingSnapshot {
  const parsed = agentTriggerBindingSnapshotSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The agent trigger binding snapshot has an invalid or unsupported version",
    );

  return parsed.data;
}
