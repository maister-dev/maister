import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyBindingRevision,
  CompanyBindingAuthoritySnapshot,
  CompanySpecialistBindingSnapshot,
} from "./company-binding-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { agentDefinitionSha256 } from "./activity-snapshot";
import {
  bindingActionSubsetSchema,
  bindingConfigurationSchema,
  companySpecialistIdSchema,
} from "./company-binding-types";
import { resolveAgentConfig, validateInstanceConfig } from "./config";
import { frozenAgentDefinitionSchema } from "./frozen-definition";
import { installationAgentGrantSchema } from "./installation-access-types";

import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import { ownerSchema } from "@/lib/company/types";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2147483647);
const actorSchema = knowledgeActorSchema.extend({
  kind: z.literal("user"),
  id: postgresTextSchema.min(1).max(192),
  runId: z.null(),
  attemptId: z.null(),
});

export const companyBindingAuthoritySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.string().datetime(),
    actor: actorSchema,
    witness: z
      .object({
        kind: z.literal("company_grant"),
        owner: ownerSchema.options[0],
        authorityId: identity,
        revision,
        action: z.literal("specialists:manage"),
      })
      .strict(),
  })
  .strict();

export const companySpecialistBindingSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: companySpecialistIdSchema,
    packageInstallId: identity,
    packageName: identity,
    packageVersion: identity,
    packageRevision: identity,
    definitionSha256: digest,
    definition: frozenAgentDefinitionSchema,
    enabled: z.boolean(),
    detachedAt: z.string().datetime().nullable(),
    detachmentReason: postgresTextSchema
      .min(1)
      .max(2000)
      .regex(/\S/)
      .nullable(),
    configuration: bindingConfigurationSchema,
    effectiveConfiguration: bindingConfigurationSchema,
    grantActions: bindingActionSubsetSchema,
    runnerId: identity.nullable(),
    executionPolicy: executionPolicySchema,
    coordinatorFlowRevisionId: identity.nullable(),
    installationGrant: installationAgentGrantSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.installationGrant &&
      (snapshot.definition.workspace !== "none" ||
        snapshot.definition.flow !== null ||
        snapshot.coordinatorFlowRevisionId !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["installationGrant"],
        message:
          "Installation grants require a standalone repository-free role",
      });
    if (
      !snapshot.definition.specialist ||
      snapshot.definition.id !== snapshot.agentId ||
      snapshot.agentId.split(":")[0] !== snapshot.packageName ||
      agentDefinitionSha256(snapshot.definition) !== snapshot.definitionSha256
    )
      context.addIssue({
        code: "custom",
        path: ["definition"],
        message:
          "Frozen professional role does not match its exact package identity and witness",
      });
    if (
      (snapshot.detachedAt === null) !== (snapshot.detachmentReason === null) ||
      (snapshot.detachedAt !== null && snapshot.enabled)
    )
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "Detached bindings cannot remain enabled",
      });
    const configurationError = validateInstanceConfig(
      snapshot.definition.config,
      snapshot.configuration,
    );

    if (configurationError)
      context.addIssue({
        code: "custom",
        path: ["configuration"],
        message: configurationError,
      });
    if (
      contentDigest(
        resolveAgentConfig(snapshot.definition.config, snapshot.configuration),
      ) !== contentDigest(snapshot.effectiveConfiguration)
    )
      context.addIssue({
        code: "custom",
        path: ["effectiveConfiguration"],
        message:
          "Effective configuration does not match the frozen declaration and explicit overrides",
      });
  });

/** History remains readable from retained bytes after a pin is retired, under current company read authority. */
export function decodeCompanyBindingRevision(
  row: Readonly<Record<string, unknown>>,
): CompanyBindingRevision {
  const snapshot = companySpecialistBindingSnapshotSchema.safeParse(
    row.snapshot,
  );
  const authority = companyBindingAuthoritySnapshotSchema.safeParse(
    row.authority_snapshot,
  );
  const actor = actorSchema.safeParse(row.actor);
  const createdAt = databaseTimestamp(row.created_at);
  const operation = z
    .enum(["created", "updated", "detached"])
    .safeParse(row.operation);

  if (
    !snapshot.success ||
    !authority.success ||
    !actor.success ||
    !operation.success ||
    !createdAt ||
    !identity.safeParse(row.binding_id).success ||
    !revision.safeParse(row.revision).success ||
    !digest.safeParse(row.request_digest).success ||
    !digest.safeParse(row.snapshot_digest).success ||
    typeof row.request_key !== "string"
  )
    throw new MaisterError(
      "CONFIG",
      "Retained company binding configuration does not match its versioned contract",
      { details: { reason: "company_binding_snapshot_invalid" } },
    );
  if (
    row.request_actor_id !== actor.data.id ||
    contentDigest(actor.data) !== contentDigest(authority.data.actor) ||
    contentDigest({
      snapshot: snapshot.data,
      authoritySnapshot: authority.data,
      actor: actor.data,
    }) !== row.snapshot_digest
  )
    throw new MaisterError(
      "CRASH",
      "Company binding history or attribution does not match its immutable content witness",
      { details: { reason: "company_binding_snapshot_digest_mismatch" } },
    );

  return {
    bindingId: String(row.binding_id),
    revision: Number(row.revision),
    snapshot: snapshot.data,
    authoritySnapshot: authority.data,
    actor: actor.data,
    operation: operation.data,
    requestKey: row.request_key,
    requestDigest: String(row.request_digest),
    snapshotDigest: String(row.snapshot_digest),
    createdAt,
  };
}

export async function retainCompanyBindingRevision(
  tx: SqlTransaction,
  input: Readonly<{
    bindingId: string;
    revision: number;
    snapshot: CompanySpecialistBindingSnapshot;
    authoritySnapshot: CompanyBindingAuthoritySnapshot;
    operation: "created" | "updated" | "detached";
    requestKey: string;
    requestDigest: string;
  }>,
): Promise<void> {
  const snapshot = companySpecialistBindingSnapshotSchema.safeParse(
    input.snapshot,
  );
  const authority = companyBindingAuthoritySnapshotSchema.safeParse(
    input.authoritySnapshot,
  );

  if (!snapshot.success || !authority.success)
    throw new MaisterError(
      "CONFIG",
      "Company binding configuration or authority snapshot is invalid",
    );
  const actor = authority.data.actor;
  const snapshotDigest = contentDigest({
    snapshot: snapshot.data,
    authoritySnapshot: authority.data,
    actor,
  });
  const snapshotJson = JSON.stringify(snapshot.data);
  const authorityJson = JSON.stringify(authority.data);
  const sizes = (
    await tx.execute(
      sql`SELECT pg_column_size(${snapshotJson}::jsonb) AS snapshot_bytes,pg_column_size(${authorityJson}::jsonb) AS authority_bytes`,
    )
  ).rows[0];

  if (
    !sizes ||
    typeof sizes.snapshot_bytes !== "number" ||
    typeof sizes.authority_bytes !== "number"
  )
    throw new MaisterError(
      "CRASH",
      "The retained company binding size could not be validated",
    );
  if (sizes.snapshot_bytes > 2097152 || sizes.authority_bytes > 32768)
    throw new MaisterError(
      "CONFIG",
      "The retained company binding configuration exceeds its byte limit",
      { details: { reason: "company_binding_snapshot_too_large" } },
    );

  await tx.execute(
    sql`INSERT INTO company_specialist_binding_revisions(binding_id,revision,snapshot,authority_snapshot,actor,request_actor_id,operation,request_key,request_digest,snapshot_digest) VALUES(${input.bindingId},${input.revision},${snapshotJson}::jsonb,${authorityJson}::jsonb,${JSON.stringify(actor)}::jsonb,${actor.id},${input.operation},${input.requestKey},${input.requestDigest},${snapshotDigest})`,
  );
}
