import type { KnowledgeAttribution } from "@/lib/brain/record-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { AssignmentAuthoritySnapshot } from "./types";

import { z } from "zod";

import { assignmentObjectiveInputSchema } from "./types";

import { companyConfigurationReferenceSchema } from "@/lib/agents/trigger-attempt-types";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const retainedRevision = z.number().int().min(0).max(2147483647);

/** Caller work keys identify requested work; they never identify its author or grant authority. */
export const logicalWorkIdSchema = identity.regex(/^[A-Za-z0-9._:-]+$/);

/** Native delegation names exact assignment heads, independently of its eventual Run. */
export const assignmentWorkSelectorSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: identity,
    expectedRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    contextRevision: retainedRevision,
    logicalWorkId: logicalWorkIdSchema,
    workRevision: knowledgeRevisionSchema,
  })
  .strict();

/** Explicit enrollment distinguishes native appointments from historical opaque work labels. */
export const assignmentWorkWitnessSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identity,
    workRevision: knowledgeRevisionSchema,
    definitionSha256: digest,
  })
  .strict();

const rolePinSchema = z
  .object({
    agentId: identity,
    packageInstallId: identity,
    packageRevision: postgresTextSchema.min(1).max(192),
    definitionSha256: digest,
  })
  .strict();
const flowPinSchema = z
  .object({
    flowRefId: identity,
    flowRevisionId: identity,
    resolvedRevision: postgresTextSchema.min(1).max(192),
    manifestSha256: digest,
  })
  .strict();

/** Resolvers capture current installed bindings; public delegation never supplies these pins. */
export const assignmentWorkTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project_agent"),
      projectId: identity,
      attachmentId: identity,
      configurationSha256: digest,
      role: rolePinSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_flow"),
      projectId: identity,
      flowId: identity,
      flow: flowPinSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("company_agent"),
      companyId: identity,
      specialistBinding: companyConfigurationReferenceSchema,
      role: rolePinSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("company_flow"),
      companyId: identity,
      specialistBinding: companyConfigurationReferenceSchema,
      coordinatorBinding: companyConfigurationReferenceSchema,
      role: rolePinSchema,
      flow: flowPinSchema,
    })
    .strict(),
]);

/** One immutable request definition; business decisions and execution facts have separate identities. */
export const assignmentWorkDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    objectiveInput: assignmentObjectiveInputSchema,
    target: assignmentWorkTargetSchema,
    context: z
      .object({
        revision: retainedRevision,
        inputRevision: knowledgeRevisionSchema,
        inputSha256: digest,
        contentSha256: digest.nullable(),
      })
      .strict()
      .refine(
        (context) =>
          (context.revision === 0) === (context.contentSha256 === null),
        "Unrecorded context has no invented content witness",
      ),
    parent: z
      .object({
        runId: identity,
        nodeAttemptId: identity.nullable(),
        rootRunId: identity,
      })
      .strict(),
  })
  .strict();

export const SPECIALIST_WORK_DECISION_STATES = [
  "open",
  "clarification_requested",
  "accepted",
  "rework_requested",
  "cancelled",
] as const;

/** Native ceilings summarize the existing tree policy without inventing a Flow node for an agent parent. */
export const assignmentWorkBoundsSchema = z
  .object({
    schemaVersion: z.literal(1),
    maxDepth: knowledgeRevisionSchema,
    maxFanout: knowledgeRevisionSchema,
    maxActiveChildren: knowledgeRevisionSchema,
    maxChildRuns: knowledgeRevisionSchema,
    maxTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    wallClockMinutes: knowledgeRevisionSchema,
    consecutiveFailures: knowledgeRevisionSchema,
  })
  .strict();

export type AssignmentWorkSelector = z.infer<
  typeof assignmentWorkSelectorSchema
>;
export type AssignmentWorkWitness = z.infer<typeof assignmentWorkWitnessSchema>;
export type AssignmentWorkTarget = z.infer<typeof assignmentWorkTargetSchema>;
export type AssignmentWorkDefinition = z.infer<
  typeof assignmentWorkDefinitionSchema
>;
export type SpecialistWorkDecisionState =
  (typeof SPECIALIST_WORK_DECISION_STATES)[number];
export type AssignmentWorkBounds = z.infer<typeof assignmentWorkBoundsSchema>;

export const DEFAULT_ASSIGNMENT_WORK_BOUNDS: AssignmentWorkBounds = {
  schemaVersion: 1,
  maxDepth: 2,
  maxFanout: 4,
  maxActiveChildren: 2,
  maxChildRuns: 8,
  maxTokens: 100000,
  wallClockMinutes: 30,
  consecutiveFailures: 3,
};

/** Internal prepared data is rechecked against current storage before it can reserve a child. */
export type PreparedAssignmentWork = Readonly<{
  objectiveInput: AssignmentWorkDefinition["objectiveInput"];
  target: AssignmentWorkTarget;
  bounds: AssignmentWorkBounds;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
}>;

export type SpecialistWorkRecord = Readonly<{
  id: string;
  assignmentId: string;
  logicalWorkId: string;
  inputRevision: number;
  inputSha256: string;
  workRevision: number;
  revision: number;
  decisionState: SpecialistWorkDecisionState;
  definition: AssignmentWorkDefinition;
  definitionSha256: string;
  requestSha256: string;
  sourceKey: string;
  actor: KnowledgeAttribution;
  authoritySnapshot: AssignmentAuthoritySnapshot;
  bounds: AssignmentWorkBounds;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
  reservedRunId: string;
  childRunId: string | null;
  createdAt: string;
}>;
