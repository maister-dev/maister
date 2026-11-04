import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyBindingAuthoritySnapshot } from "./company-binding-types";
import type {
  CompanyFlowBindingRevision,
  CompanyFlowBindingSnapshot,
} from "./company-flow-binding-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  companyBindingAuthoritySnapshotSchema,
  companySpecialistBindingSnapshotSchema,
} from "./company-binding-snapshot";
import {
  companyFlowExecutionSchema,
  companyFlowUserIdSchema,
  companyFlowRoleMappingsSchema,
  companyFlowRoleMappingsMatch,
} from "./company-flow-binding-types";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { flowYamlV1Schema, type FlowYamlV1 } from "@/lib/config.schema";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operation = z.enum(["created", "updated", "detached"]);
// Inspect the retained shape without injecting current parser defaults into historical bytes.
const frozenManifestSchema = z.custom<FlowYamlV1>(
  (value) => flowYamlV1Schema.safeParse(value).success,
);

export const companyFlowBindingSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    companyId: identity,
    flowRefId: identity,
    flowRevisionId: identity,
    packageInstallId: identity,
    packageRevision: identity,
    manifestSha256: digest,
    manifest: frozenManifestSchema,
    specialistBindingId: identity,
    specialistRevision: knowledgeRevisionSchema,
    specialist: companySpecialistBindingSnapshotSchema,
    execution: companyFlowExecutionSchema,
    roleMappings: companyFlowRoleMappingsSchema,
    routingAuthority: z
      .array(
        z
          .object({
            userId: companyFlowUserIdSchema,
            witness: companyBindingAuthoritySnapshotSchema.shape.witness.extend(
              { action: z.literal("assignments:answer") },
            ),
          })
          .strict(),
      )
      .max(1024),
    enabled: z.boolean(),
    detachedAt: z.string().datetime().nullable(),
    detachmentReason: postgresTextSchema
      .min(1)
      .max(2000)
      .regex(/\S/)
      .nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.specialist.packageInstallId !== snapshot.packageInstallId ||
      snapshot.specialist.packageRevision !== snapshot.packageRevision ||
      snapshot.specialist.coordinatorFlowRevisionId !==
        snapshot.flowRevisionId ||
      snapshot.specialist.definition.flow !== snapshot.flowRefId ||
      snapshot.manifest.name !== snapshot.flowRefId
    )
      context.addIssue({
        code: "custom",
        path: ["specialist"],
        message:
          "The coordinator configuration must preserve its exact responsible role and package/Flow identity",
      });
    const recipients = new Set(Object.values(snapshot.roleMappings).flat());
    const witnesses = snapshot.routingAuthority;

    if (
      !companyFlowRoleMappingsMatch(snapshot.manifest, snapshot.roleMappings) ||
      witnesses.length !== recipients.size ||
      new Set(witnesses.map((entry) => entry.userId)).size !==
        witnesses.length ||
      witnesses.some(
        (entry) =>
          !recipients.has(entry.userId) ||
          entry.witness.owner.companyId !== snapshot.companyId,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["routingAuthority"],
        message:
          "Reviewed routing must retain one exact company answer-authority witness for every mapped user",
      });
    if (
      (snapshot.detachedAt === null) !== (snapshot.detachmentReason === null) ||
      (snapshot.detachedAt !== null && snapshot.enabled)
    )
      context.addIssue({
        code: "custom",
        path: ["detachedAt"],
        message:
          "Retired company Flow bindings require a reason and cannot remain enabled",
      });
  });

/** Decode retained bytes under current company authority; provider files and mutable role heads are not historical truth. */
export function decodeCompanyFlowBindingRevision(
  row: Readonly<Record<string, unknown>>,
): CompanyFlowBindingRevision {
  const snapshot = companyFlowBindingSnapshotSchema.safeParse(row.snapshot);
  const authority = companyBindingAuthoritySnapshotSchema.safeParse(
    row.authority_snapshot,
  );
  const action = operation.safeParse(row.operation);
  const createdAt = databaseTimestamp(row.created_at);

  if (
    !snapshot.success ||
    !authority.success ||
    !action.success ||
    !createdAt ||
    !identity.safeParse(row.binding_id).success ||
    !knowledgeRevisionSchema.safeParse(row.revision).success ||
    !knowledgeDeliveryKeySchema.safeParse(row.request_key).success ||
    !digest.safeParse(row.request_digest).success ||
    !digest.safeParse(row.snapshot_digest).success
  )
    throw new MaisterError(
      "CONFIG",
      "The retained company Flow binding does not match its versioned configuration contract",
    );
  if (
    authority.data.actor.id !== row.request_actor_id ||
    authority.data.witness.owner.companyId !== snapshot.data.companyId ||
    contentDigest({
      snapshot: snapshot.data,
      authoritySnapshot: authority.data,
    }) !== row.snapshot_digest
  )
    throw new MaisterError(
      "CRASH",
      "The retained company Flow binding does not match its ownership, attribution or content witness",
    );

  return {
    bindingId: String(row.binding_id),
    revision: Number(row.revision),
    snapshot: snapshot.data,
    authoritySnapshot: authority.data,
    operation: action.data,
    requestKey: String(row.request_key),
    requestDigest: String(row.request_digest),
    snapshotDigest: String(row.snapshot_digest),
    createdAt,
  };
}

export async function retainCompanyFlowBindingRevision(
  tx: SqlTransaction,
  input: Readonly<{
    bindingId: string;
    revision: number;
    snapshot: CompanyFlowBindingSnapshot;
    authoritySnapshot: CompanyBindingAuthoritySnapshot;
    operation: "created" | "updated" | "detached";
    requestKey: string;
    requestDigest: string;
  }>,
): Promise<CompanyFlowBindingRevision> {
  const snapshot = companyFlowBindingSnapshotSchema.safeParse(input.snapshot);
  const authority = companyBindingAuthoritySnapshotSchema.safeParse(
    input.authoritySnapshot,
  );

  if (!snapshot.success || !authority.success)
    throw new MaisterError(
      "CONFIG",
      "The company Flow configuration or authority witness is invalid",
    );
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
      "The company Flow configuration size could not be validated",
    );
  if (sizes.snapshot_bytes > 4194304 || sizes.authority_bytes > 32768)
    throw new MaisterError(
      "CONFIG",
      "The retained company Flow configuration exceeds its byte limit",
    );
  const snapshotDigest = contentDigest({
    snapshot: snapshot.data,
    authoritySnapshot: authority.data,
  });
  const row = (
    await tx.execute(
      sql`INSERT INTO company_flow_binding_revisions(binding_id,revision,snapshot,authority_snapshot,request_actor_id,operation,request_key,request_digest,snapshot_digest) VALUES(${input.bindingId},${input.revision},${snapshotJson}::jsonb,${authorityJson}::jsonb,${authority.data.actor.id},${input.operation},${input.requestKey},${input.requestDigest},${snapshotDigest}) RETURNING *`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "CRASH",
      "The accepted company Flow configuration receipt was not retained",
    );

  return decodeCompanyFlowBindingRevision(row);
}
