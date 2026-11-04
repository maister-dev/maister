import type { ParsedAgentDefinition } from "@/lib/agents/definition";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";
import type { KnowledgeAttribution } from "@/lib/brain/record-types";
import type {
  CompanyAction,
  Owner,
  KnowledgeAccessRestriction,
} from "@/lib/company/types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { ProjectRole } from "@/lib/db/schema";
import type { JsonValue } from "@/lib/hitl-response-contract";

import { z } from "zod";

import {
  knowledgeReferenceSchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const nonblank = postgresTextSchema.min(1).regex(/\S/);

export const SPECIALIST_ASSIGNMENT_STATUSES = [
  "queued",
  "active",
  "waiting_input",
  "waiting_children",
  "waiting_resource",
  "reconciling",
  "awaiting_acceptance",
  "completed",
  "failed",
  "cancelled",
] as const;
export type SpecialistAssignmentStatus =
  (typeof SPECIALIST_ASSIGNMENT_STATUSES)[number];

export const assignmentOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), interactionId: identity }).strict(),
  z
    .object({
      kind: z.literal("task_comment"),
      projectId: identity,
      taskId: identity,
      commentId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      scheduleId: identity,
      triggerAttemptId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      eventId: identity,
      subscriptionId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("webhook"),
      endpointId: identity,
      deliveryId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delegation"),
      parentRunId: identity,
      workId: identity,
    })
    .strict(),
]);
export const assignmentDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), userId: identity }).strict(),
  z
    .object({
      kind: z.literal("task_comment"),
      projectId: identity,
      taskId: identity,
      threadCommentId: identity.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("outbound_subscription"),
      subscriptionId: identity,
      correlationId: identity,
    })
    .strict(),
]);
export const expectedAssignmentResultSchema = z
  .object({
    schemaRef: postgresTextSchema.min(1).max(512),
    schemaVersion: knowledgeRevisionSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    required: z.literal(true),
  })
  .strict();
export const assignmentVerificationRequirementSchema = z
  .object({
    kind: z.enum(["result", "effect", "health"]),
    referenceId: identity.nullable(),
    required: z.boolean(),
  })
  .strict();
export const assignmentObjectiveInputSchema = z
  .object({
    objective: nonblank.max(8000),
    expectedOutcome: nonblank.max(4000),
    input: postgresTextSchema.max(8000),
    targetIds: z.array(identity).max(32),
    inputRefs: z.array(knowledgeReferenceSchema).max(64),
    constraints: z.array(nonblank.max(2000)).max(32),
    expectedResult: expectedAssignmentResultSchema,
    verification: z.array(assignmentVerificationRequirementSchema).max(16),
  })
  .strict();

export type AssignmentOrigin = z.infer<typeof assignmentOriginSchema>;
export type AssignmentDestination = z.infer<typeof assignmentDestinationSchema>;
export type AssignmentObjectiveInput = z.infer<
  typeof assignmentObjectiveInputSchema
>;
export type AssignmentResultExpectation = z.infer<
  typeof expectedAssignmentResultSchema
>;

/** Historical permission witnesses describe captured authority, never grant current action access. */
export type AssignmentAuthorityWitness =
  | Readonly<{
      kind: "company_grant";
      owner: Extract<Owner, { kind: "company" }>;
      authorityId: string;
      revision: number;
      action: CompanyAction;
    }>
  | Readonly<{
      kind: "project_membership";
      projectId: string;
      membershipId: string;
      role: ProjectRole;
    }>
  | Readonly<{
      kind: "project_administrator";
      projectId: string;
      userId: string;
      role: "admin";
    }>;
export type AssignmentAuthoritySnapshot = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  actor: KnowledgeAttribution;
  witnesses: readonly AssignmentAuthorityWitness[];
  executionPolicy: ExecutionPolicy;
}>;
export type AssignmentStandingSnapshot = Readonly<{
  schemaVersion: 1;
  agentId: string;
  packageInstallId: string;
  packageName: string;
  packageRevision: string;
  definitionSha256: string;
  definition: ParsedAgentDefinition;
  configuration: Readonly<Record<string, JsonValue>> | null;
}>;
export type AssignmentInputSnapshot = Readonly<{
  schemaVersion: 1;
  objectiveInput: AssignmentObjectiveInput;
  standingDefinition: AssignmentStandingSnapshot;
  scheduledRequest: ScheduledAgentRequestSnapshot | null;
  authoritySnapshot: AssignmentAuthoritySnapshot;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
}>;

export const specialistAssignmentSchema = z
  .object({
    id: identity,
    revision: knowledgeRevisionSchema,
    owner: ownerSchema,
    objective: nonblank.max(8000),
    expectedOutcome: nonblank.max(4000),
    requester: knowledgeActorSchema,
    responsible: knowledgeActorSchema,
    specialistBindingId: identity,
    inputRevision: knowledgeRevisionSchema,
    contextRevision: z.number().int().min(0).max(2147483647),
    status: z.enum(SPECIALIST_ASSIGNMENT_STATUSES),
    targetIds: z.array(identity).max(32),
    inputRefs: z.array(knowledgeReferenceSchema).max(64),
    constraints: z.array(nonblank.max(2000)).max(32),
    expectedResult: expectedAssignmentResultSchema,
    verification: z.array(assignmentVerificationRequirementSchema).max(16),
    origin: assignmentOriginSchema,
    destination: assignmentDestinationSchema,
    runIds: z.array(identity).max(256),
    blockers: z.array(nonblank.max(2000)).max(32),
    acceptedResult: z
      .object({ id: identity, revision: knowledgeRevisionSchema })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SpecialistAssignment = z.infer<typeof specialistAssignmentSchema>;
export type SpecialistRunRole =
  "coordinator" | "specialist" | "child" | "continuation";

/** Server-prepared binding/input data; public requests do not accept snapshots or authors. */
export type PreparedSpecialistAssignment = Readonly<{
  owner: Owner;
  specialistBindingId: string;
  responsibleAgentId: string;
  objectiveInput: AssignmentObjectiveInput;
  standingDefinition: AssignmentStandingSnapshot;
  scheduledRequest: ScheduledAgentRequestSnapshot | null;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
  executionPolicy: ExecutionPolicy;
  origin: AssignmentOrigin;
  destination: AssignmentDestination;
}>;

export const assignmentInputUpdateSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    input: nonblank.max(8000),
    references: z.array(knowledgeReferenceSchema).max(64),
  })
  .strict();
export type AssignmentInputUpdate = z.infer<typeof assignmentInputUpdateSchema>;
export type AssignmentInputRevision = Readonly<{
  assignmentId: string;
  revision: number;
  snapshot: AssignmentInputSnapshot;
  actor: KnowledgeAttribution;
  digest: string;
  createdAt: string;
}>;
export type AssignmentStateReceipt = Readonly<{
  assignmentId: string;
  revision: number;
  status: SpecialistAssignmentStatus;
}>;
export const specialistRunLinkInputSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    runId: identity,
    role: z.enum(["coordinator", "specialist", "child", "continuation"]),
    work: z
      .object({ id: identity, revision: knowledgeRevisionSchema })
      .strict()
      .nullable(),
  })
  .strict();
export type SpecialistRunLinkInput = z.infer<
  typeof specialistRunLinkInputSchema
>;
