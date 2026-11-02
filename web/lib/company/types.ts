import { z } from "zod";

export const ownerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("company"),
      companyId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: z.string().min(1).max(128),
    })
    .strict(),
]);

export type Owner = z.infer<typeof ownerSchema>;

/** Server-captured source restrictions on an existing run; NULL remains unknown. */
export type KnowledgeAccessRestriction =
  Owner | Readonly<{ kind: "record"; recordId: string }>;
export type KnowledgeAccessCapture = Readonly<{
  schemaVersion: 1;
  state: "capturing" | "complete" | "unknown";
  generation: number;
  restrictions: readonly KnowledgeAccessRestriction[];
}>;

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
