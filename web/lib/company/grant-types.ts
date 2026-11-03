import { z } from "zod";

import { COMPANY_ACTIONS, CONFIRMATION_CLASSES } from "./types";

import { postgresTextSchema } from "@/lib/text-schema";

const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const identity = postgresTextSchema.min(1).max(128);
const uniqueActions = z
  .array(z.enum(COMPANY_ACTIONS))
  .min(1)
  .max(20)
  .refine(
    (actions) => new Set(actions).size === actions.length,
    "Company actions must be distinct",
  );

export const companyGrantInputSchema = z
  .object({
    principalKind: z.enum(["user", "agent"]),
    principalId: identity,
    actions: uniqueActions,
    confirmationClasses: z
      .array(z.enum(CONFIRMATION_CLASSES))
      .max(4)
      .optional(),
    idempotencyKey: key,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.confirmationClasses !== undefined &&
      !value.actions.includes("knowledge:confirm")
    )
      ctx.addIssue({
        code: "custom",
        path: ["confirmationClasses"],
        message: "Confirmation classes require a confirmation grant",
      });
    if (
      value.confirmationClasses !== undefined &&
      new Set(value.confirmationClasses).size !==
        value.confirmationClasses.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["confirmationClasses"],
        message: "Confirmation classes must be distinct",
      });
    if (
      value.principalKind === "agent" &&
      value.actions.includes("knowledge:confirm") &&
      (value.confirmationClasses?.length ?? 0) === 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["confirmationClasses"],
        message: "An agent verifier requires an explicit confirmation class",
      });
  });
export const companyGrantRevokeSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(2147483647),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: key,
  })
  .strict();
export const companyGrantSchema = z
  .object({
    id: identity,
    principalKind: z.enum(["user", "agent", "system"]),
    principalId: identity,
    action: z.enum(COMPANY_ACTIONS),
    revision: z.number().int().min(1).max(2147483647),
    confirmationClasses: z.array(z.enum(CONFIRMATION_CLASSES)).max(4),
    createdBy: identity,
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    revokedBy: identity.nullable(),
    revocationReason: postgresTextSchema.min(1).max(2000).nullable(),
  })
  .strict();
export const companyGrantPageInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type CompanyGrantInput = z.infer<typeof companyGrantInputSchema>;
export type CompanyGrantRevoke = z.infer<typeof companyGrantRevokeSchema>;
export type CompanyGrantDto = z.infer<typeof companyGrantSchema>;
export type CompanyGrantPageInput = z.infer<typeof companyGrantPageInputSchema>;
export type CompanyGrantPage = Readonly<{
  companyId: string;
  items: readonly CompanyGrantDto[];
  nextCursor: string | null;
}>;
