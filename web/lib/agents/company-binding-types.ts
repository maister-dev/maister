import type { ParsedAgentDefinition } from "./definition";
import type { CompanyAction, CompanyGrantWitness } from "@/lib/company/types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { KnowledgeAttribution } from "@/lib/brain/record-types";
import type { InstallationAgentGrant } from "./installation-access-types";

import { z } from "zod";

import { AGENT_WORKSPACE_KINDS, capabilityProfileSchema } from "./definition";
import { AGENT_KINDS } from "./kind";
import { agentSpecialistSchema } from "./specialist";
import { installationAgentGrantSchema } from "./installation-access-types";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { COMPANY_ACTIONS, ownerSchema } from "@/lib/company/types";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

export const companySpecialistIdSchema = postgresTextSchema
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/);
export const bindingConfigurationSchema = z.record(
  postgresTextSchema
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/),
  z.union([postgresTextSchema, z.boolean(), z.number().finite()]),
);
export const bindingActionSubsetSchema = z
  .array(z.enum(COMPANY_ACTIONS))
  .max(20)
  .refine(
    (actions) => new Set(actions).size === actions.length,
    "Binding action limits must be distinct",
  );

/** A reviewed limit is configuration; every actual action also requires current principal and resource authority. */
export const companyBindingCreateSchema = z
  .object({
    owner: ownerSchema.options[0],
    packageInstallId: identity,
    packageRevision: identity,
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean().default(false),
    configuration: bindingConfigurationSchema,
    grantActions: bindingActionSubsetSchema,
    runnerId: identity.nullable().default(null),
    executionPolicy: executionPolicySchema.default({ preset: "supervised" }),
    coordinatorFlowRevisionId: identity.nullable().default(null),
    installationGrant: installationAgentGrantSchema.nullable().optional(),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export const companyBindingUpdateSchema = companyBindingCreateSchema
  .extend({
    enabled: companyBindingCreateSchema.shape.enabled.removeDefault(),
    runnerId: companyBindingCreateSchema.shape.runnerId.removeDefault(),
    executionPolicy:
      companyBindingCreateSchema.shape.executionPolicy.removeDefault(),
    coordinatorFlowRevisionId:
      companyBindingCreateSchema.shape.coordinatorFlowRevisionId.removeDefault(),
    expectedRevision: knowledgeRevisionSchema,
  })
  .strict();
export const companyBindingDetachSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export const companyBindingPageInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const companySpecialistSchema = z
  .object({
    id: companySpecialistIdSchema,
    bindingId: identity,
    owner: ownerSchema.options[0],
    name: postgresTextSchema.min(1),
    description: postgresTextSchema.min(1),
    responsibilities: agentSpecialistSchema.shape.responsibilities,
    targetClasses: agentSpecialistSchema.shape.targetClasses,
    kind: z.enum(AGENT_KINDS),
    workspace: z.enum(AGENT_WORKSPACE_KINDS),
    capabilityProfile: capabilityProfileSchema.nullable(),
    platformMcp: z.boolean(),
    packageInstallId: identity,
    packageRevision: identity,
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean(),
    detachedAt: z.string().datetime().nullable(),
    configRevision: knowledgeRevisionSchema,
    configuration: bindingConfigurationSchema,
    effectiveConfiguration: bindingConfigurationSchema,
    grantActions: bindingActionSubsetSchema,
    runnerId: identity.nullable(),
    executionPolicy: executionPolicySchema,
    coordinatorFlowRevisionId: identity.nullable(),
    installationGrant: installationAgentGrantSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type BindingConfiguration = z.infer<typeof bindingConfigurationSchema>;
export type CompanyBindingCreate = z.input<typeof companyBindingCreateSchema>;
export type CompanyBindingUpdate = z.input<typeof companyBindingUpdateSchema>;
export type CompanyBindingDetach = z.infer<typeof companyBindingDetachSchema>;
export type CompanyBindingPageInput = z.infer<
  typeof companyBindingPageInputSchema
>;
export type CompanySpecialist = z.infer<typeof companySpecialistSchema>;
export type CompanySpecialistPage = Readonly<{
  items: readonly CompanySpecialist[];
  nextCursor: string | null;
}>;

/** Self-contained accepted configuration; its action subset limits current grants and cannot replace them. */
export type CompanySpecialistBindingSnapshot = Readonly<{
  schemaVersion: 1;
  agentId: string;
  packageInstallId: string;
  packageName: string;
  packageVersion: string;
  packageRevision: string;
  definitionSha256: string;
  definition: ParsedAgentDefinition;
  enabled: boolean;
  detachedAt: string | null;
  detachmentReason: string | null;
  configuration: BindingConfiguration;
  effectiveConfiguration: BindingConfiguration;
  grantActions: readonly CompanyAction[];
  runnerId: string | null;
  executionPolicy: ExecutionPolicy;
  coordinatorFlowRevisionId: string | null;
  installationGrant?: InstallationAgentGrant;
}>;
export type CompanyBindingAuthoritySnapshot = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  actor: KnowledgeAttribution;
  witness: CompanyGrantWitness;
}>;
export type CompanyBindingRevision = Readonly<{
  bindingId: string;
  revision: number;
  snapshot: CompanySpecialistBindingSnapshot;
  authoritySnapshot: CompanyBindingAuthoritySnapshot;
  actor: KnowledgeAttribution;
  operation: "created" | "updated" | "detached";
  requestKey: string;
  requestDigest: string;
  snapshotDigest: string;
  createdAt: string;
}>;

export const companyBindingDetachReceiptSchema = z
  .object({
    id: identity,
    revision: knowledgeRevisionSchema,
    status: z.literal("detached"),
    duplicate: z.boolean(),
  })
  .strict();
export type CompanyBindingDetachReceipt = z.infer<
  typeof companyBindingDetachReceiptSchema
>;
