import { z } from "zod";

import { postgresTextSchema } from "@/lib/text-schema";

export const ownerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("company"),
      companyId: postgresTextSchema.min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: postgresTextSchema.min(1).max(128),
    })
    .strict(),
]);

export type Owner = z.infer<typeof ownerSchema>;

export const knowledgeAccessRestrictionSchema = z.union([
  ownerSchema,
  z
    .object({
      kind: z.literal("record"),
      recordId: postgresTextSchema.min(1).max(128),
    })
    .strict(),
]);
export const knowledgeRestrictionsSchema = z
  .array(knowledgeAccessRestrictionSchema)
  .max(256);
export type KnowledgeAccessRestriction = z.infer<
  typeof knowledgeAccessRestrictionSchema
>;
/** Server-captured source restrictions on an existing run; NULL remains unknown. */
export const knowledgeAccessCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["capturing", "complete", "unknown"]),
    generation: z.number().int().positive().max(2147483647),
    restrictions: knowledgeRestrictionsSchema,
  })
  .strict();
export type KnowledgeAccessCapture = Readonly<
  z.infer<typeof knowledgeAccessCaptureSchema>
>;

export const COMPANY_ACTIONS = [
  "knowledge:read",
  "knowledge:propose",
  "knowledge:review",
  "knowledge:confirm",
  "knowledge:manage",
  "specialists:read",
  "specialists:manage",
  "assignments:read",
  "assignments:submit",
  "assignments:update",
  "assignments:answer",
  "assignments:accept",
  "assignments:cancel",
  "assignments:recover",
  "assignments:delegate",
  "targets:read",
  "targets:logs",
  "targets:restart",
  "targets:recover",
  "targets:manage",
] as const;

export type CompanyAction = (typeof COMPANY_ACTIONS)[number];
export const CONFIRMATION_CLASSES = [
  "assertion",
  "observation",
  "decision",
  "procedure",
] as const;
export type ConfirmationClass = (typeof CONFIRMATION_CLASSES)[number];
