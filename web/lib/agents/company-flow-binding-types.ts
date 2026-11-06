import type { CompanyGrantWitness } from "@/lib/company/types";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  CompanyBindingAuthoritySnapshot,
  CompanySpecialistBindingSnapshot,
} from "./company-binding-types";

import { z } from "zod";

import {
  COMPANY_EXECUTION_ENGINE_MIN,
  companyFlowExecutionSchema,
} from "@/lib/config.schema";
import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

export const companyFlowUserIdSchema = postgresTextSchema.min(1).max(192);

export { COMPANY_EXECUTION_ENGINE_MIN, companyFlowExecutionSchema };
export const companyFlowRoleMappingsSchema = z
  .record(
    postgresTextSchema
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
    z
      .array(companyFlowUserIdSchema)
      .min(1)
      .max(32)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Company role recipients must be distinct",
      ),
  )
  .refine(
    (roles) => Object.keys(roles).length <= 32,
    "A company Flow has at most 32 mapped roles",
  );

/** Reviewed company configuration cannot grant a mapped human or specialist any action. */
export const companyFlowBindingCreateSchema = z
  .object({
    owner: ownerSchema.options[0],
    specialistBindingId: identity,
    specialistRevision: knowledgeRevisionSchema,
    flowRevisionId: identity,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    execution: companyFlowExecutionSchema,
    enabled: z.boolean().default(false),
    roleMappings: companyFlowRoleMappingsSchema,
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export const companyFlowBindingUpdateSchema = companyFlowBindingCreateSchema
  .extend({ enabled: z.boolean(), expectedRevision: knowledgeRevisionSchema })
  .strict();
export type CompanyFlowBindingConfiguration = z.output<
  typeof companyFlowBindingCreateSchema
>;
export type CompanyFlowBindingCreate = z.input<
  typeof companyFlowBindingCreateSchema
>;
export type CompanyFlowBindingUpdate = z.input<
  typeof companyFlowBindingUpdateSchema
>;

/** Full accepted bytes and a logical historical provider identity survive explicit retirement. */
export type CompanyFlowBindingSnapshot = Readonly<{
  schemaVersion: 1;
  companyId: string;
  flowRefId: string;
  flowRevisionId: string;
  packageInstallId: string;
  packageRevision: string;
  manifestSha256: string;
  manifest: FlowYamlV1;
  specialistBindingId: string;
  specialistRevision: number;
  specialist: CompanySpecialistBindingSnapshot;
  execution: z.infer<typeof companyFlowExecutionSchema>;
  roleMappings: z.infer<typeof companyFlowRoleMappingsSchema>;
  routingAuthority: readonly Readonly<{
    userId: string;
    witness: CompanyGrantWitness;
  }>[];
  enabled: boolean;
  detachedAt: string | null;
  detachmentReason: string | null;
}>;
export type CompanyFlowBindingRevision = Readonly<{
  bindingId: string;
  revision: number;
  snapshot: CompanyFlowBindingSnapshot;
  authoritySnapshot: CompanyBindingAuthoritySnapshot;
  operation: "created" | "updated" | "detached";
  requestKey: string;
  requestDigest: string;
  snapshotDigest: string;
  createdAt: string;
}>;
export type CompanyFlowBinding = Readonly<{
  id: string;
  revision: number;
  owner: Readonly<{ kind: "company"; companyId: string }>;
  configuration: CompanyFlowBindingSnapshot;
  createdAt: string;
  updatedAt: string;
}>;

/** Company routing names every human role explicitly; repository-role or inline assignee defaults cannot grant access. */
export function companyFlowRoleMappingsMatch(
  manifest: FlowYamlV1,
  mappings: z.infer<typeof companyFlowRoleMappingsSchema>,
): boolean {
  const humans = manifest.nodes.filter(
    (node) => node.type === "human" || node.type === "form",
  );
  const labels = new Set(humans.flatMap((node) => node.settings?.roles ?? []));

  return (
    !humans.some(
      (node) =>
        !node.settings?.roles?.length ||
        (node.type === "human" && Boolean(node.settings?.assignees?.length)),
    ) &&
    Object.keys(mappings).every((label) => labels.has(label)) &&
    [...labels].every((label) =>
      Object.prototype.hasOwnProperty.call(mappings, label),
    )
  );
}
