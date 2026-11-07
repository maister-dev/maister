import "server-only";

import type { AssignmentInputRevision, AssignmentInputSnapshot } from "./types";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { z } from "zod";
import { sql } from "drizzle-orm";

import {
  assignmentObjectiveInputSchema,
  projectCoordinatorFlowSnapshotSchema,
} from "./types";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { frozenAgentDefinitionSchema } from "@/lib/agents/frozen-definition";
import { scheduledRequestSnapshotSchema } from "@/lib/agents/scheduled-request";
import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import {
  COMPANY_ACTIONS,
  knowledgeRestrictionsSchema,
  ownerSchema,
} from "@/lib/company/types";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

const identity = z.string().min(1).max(192);
const revision = z.number().int().positive().max(2147483647);
const projectRole = z.enum(["viewer", "member", "admin", "owner"]);
const witnesses = z.array(
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("company_grant"),
        owner: ownerSchema.options[0],
        authorityId: identity,
        revision,
        action: z.enum(COMPANY_ACTIONS),
      })
      .strict(),
    z
      .object({
        kind: z.literal("project_membership"),
        projectId: identity,
        membershipId: identity,
        role: projectRole,
      })
      .strict(),
    z
      .object({
        kind: z.literal("project_administrator"),
        projectId: identity,
        userId: identity,
        role: z.literal("admin"),
      })
      .strict(),
  ]),
);
const standingFields = {
  agentId: identity,
  packageInstallId: identity,
  packageName: identity,
  packageRevision: identity,
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: frozenAgentDefinitionSchema,
  configuration: z.record(z.string(), z.json()).nullable(),
};
const standingSchema = z
  .discriminatedUnion("schemaVersion", [
    z.object({ schemaVersion: z.literal(1), ...standingFields }).strict(),
    z
      .object({
        schemaVersion: z.literal(2),
        ...standingFields,
        coordinatorFlow: projectCoordinatorFlowSnapshotSchema,
      })
      .strict(),
  ])
  .refine(
    (standing) =>
      standing.agentId === standing.definition.id &&
      standing.definitionSha256 ===
        agentDefinitionSha256(standing.definition) &&
      (standing.schemaVersion === 1 ||
        standing.definition.flow === standing.coordinatorFlow.flowRefId),
  );
const authoritySchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.string().datetime(),
    actor: knowledgeActorSchema,
    witnesses,
    executionPolicy: executionPolicySchema,
  })
  .strict();
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    objectiveInput: assignmentObjectiveInputSchema,
    standingDefinition: standingSchema,
    scheduledRequest: scheduledRequestSnapshotSchema.nullable(),
    authoritySnapshot: authoritySchema,
    sourceRestrictions: knowledgeRestrictionsSchema,
  })
  .strict();

/** Validate retained versioned planes and their content witness without re-resolving a mutable catalog. */
export function decodeAssignmentInput(
  row: Readonly<Record<string, unknown>>,
): AssignmentInputRevision {
  const parsed = snapshotSchema.safeParse({
    schemaVersion: row.schema_version,
    objectiveInput: row.objective_input,
    standingDefinition: row.standing_definition,
    scheduledRequest: row.scheduled_request,
    authoritySnapshot: row.authority_snapshot,
    sourceRestrictions: row.source_restrictions,
  });
  const actor = knowledgeActorSchema.safeParse(row.actor);
  const createdAt = databaseTimestamp(row.created_at);

  if (
    !parsed.success ||
    !actor.success ||
    !createdAt ||
    typeof row.assignment_id !== "string" ||
    !revision.safeParse(row.revision).success
  )
    throw new MaisterError(
      "CONFIG",
      "Stored assignment input does not match its versioned snapshot contract",
    );
  const snapshot: AssignmentInputSnapshot = parsed.data;

  if (
    contentDigest(snapshot) !== row.digest ||
    contentDigest(actor.data) !==
      contentDigest(snapshot.authoritySnapshot.actor)
  )
    throw new MaisterError(
      "CRASH",
      "Retained assignment input or attribution does not match its immutable content witness",
    );

  return {
    assignmentId: row.assignment_id,
    revision: Number(row.revision),
    snapshot,
    actor: actor.data,
    digest: String(row.digest),
    createdAt,
  };
}

/** One writer keeps frozen input planes and content witnesses identical across creation and append. */
export async function retainAssignmentInput(
  tx: SqlTransaction,
  assignmentId: string,
  inputRevision: number,
  snapshot: AssignmentInputSnapshot,
): Promise<void> {
  const parsed = snapshotSchema.safeParse(snapshot);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Assignment input snapshot does not match its immutable versioned contract",
    );
  await tx.execute(
    sql`INSERT INTO specialist_input_revisions(assignment_id,revision,objective_input,standing_definition,scheduled_request,authority_snapshot,source_restrictions,actor,digest) VALUES(${assignmentId},${inputRevision},${JSON.stringify(parsed.data.objectiveInput)}::jsonb,${JSON.stringify(parsed.data.standingDefinition)}::jsonb,${parsed.data.scheduledRequest === null ? null : JSON.stringify(parsed.data.scheduledRequest)}::jsonb,${JSON.stringify(parsed.data.authoritySnapshot)}::jsonb,${JSON.stringify(parsed.data.sourceRestrictions)}::jsonb,${JSON.stringify(parsed.data.authoritySnapshot.actor)}::jsonb,${contentDigest(parsed.data)})`,
  );
}
