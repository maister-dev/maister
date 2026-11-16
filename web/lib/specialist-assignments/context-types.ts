import { z } from "zod";

import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import {
  knowledgeDeliveryKeySchema,
  knowledgeReferenceSchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import {
  evidenceFindingsV1Schema,
  sourceFindingSchema,
} from "@/lib/run-results/findings-types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const revision = z.number().int().min(0).max(2147483647);
const baseEntrySchema = z.object({
  id: identity,
  text: postgresTextSchema.min(1).max(8000).regex(/\S/),
  state: z.enum(["open", "accepted", "resolved", "withdrawn"]),
  references: z.array(knowledgeReferenceSchema).max(64),
  supersedesEntryId: identity.optional(),
});

const editableNoteKinds = [
  "objective",
  "constraint",
  "source",
  "hypothesis",
  "question",
  "decision",
  "work",
  "blocker",
] as const;
const editableBaseEntrySchema = baseEntrySchema.extend({
  state: z.enum(["open", "resolved", "withdrawn"]),
});
const editableContextEntrySchema = z.discriminatedUnion("kind", [
  editableBaseEntrySchema.extend({ kind: z.enum(editableNoteKinds) }).strict(),
  editableBaseEntrySchema
    .extend({ kind: z.literal("finding"), findings: evidenceFindingsV1Schema })
    .strict(),
]);

export const assignmentContextEntrySchema = z.discriminatedUnion("kind", [
  baseEntrySchema.extend({ kind: z.enum(editableNoteKinds) }).strict(),
  baseEntrySchema
    .extend({
      kind: z.literal("accepted"),
      state: z.literal("accepted"),
      acceptedWork: z
        .object({
          decisionId: identity,
          workId: identity,
          workRevision: knowledgeRevisionSchema,
          childRunId: identity,
          resultRevision: knowledgeRevisionSchema,
          sourceFindings: z.array(sourceFindingSchema).max(32),
        })
        .strict(),
    })
    .strict(),
  baseEntrySchema
    .extend({ kind: z.literal("finding"), findings: evidenceFindingsV1Schema })
    .strict(),
]);
export type AssignmentContextEntry = z.infer<
  typeof assignmentContextEntrySchema
>;

export const assignmentContextItemSchema = z
  .object({
    entry: assignmentContextEntrySchema,
    actor: knowledgeActorSchema,
    introducedRevision: knowledgeRevisionSchema,
    ownerEpoch: z.number().int().positive().safe().nullable(),
    executionEpoch: knowledgeRevisionSchema.optional(),
  })
  .strict();
export const assignmentContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputRevision: knowledgeRevisionSchema,
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(assignmentContextItemSchema).max(256),
  })
  .strict();
export type AssignmentContextSnapshot = z.infer<
  typeof assignmentContextSnapshotSchema
>;

/** Public edits cannot manufacture a work acceptance or confirmation, even when the author can update working notes. */
export const assignmentContextUpdateSchema = z
  .object({
    expectedRevision: revision,
    expectedInputRevision: knowledgeRevisionSchema,
    updates: z.array(editableContextEntrySchema).min(1).max(64),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const replaced = new Set<string>();

    for (const [index, entry] of value.updates.entries()) {
      if (
        ids.has(entry.id) ||
        entry.id === entry.supersedesEntryId ||
        (entry.supersedesEntryId !== undefined &&
          replaced.has(entry.supersedesEntryId))
      )
        context.addIssue({
          code: "custom",
          path: ["updates", index, "id"],
          message: "Context entry identities and replacements must be distinct",
        });
      ids.add(entry.id);
      if (entry.supersedesEntryId !== undefined)
        replaced.add(entry.supersedesEntryId);
    }
  });
export type AssignmentContextUpdate = z.infer<
  typeof assignmentContextUpdateSchema
>;

export const assignmentContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: identity,
    revision,
    baseRevision: revision,
    recording: z.enum(["unrecorded", "recorded"]),
    inputRevision: knowledgeRevisionSchema,
    currentInputRevision: knowledgeRevisionSchema,
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    objective: postgresTextSchema.min(1).max(8000),
    expectedOutcome: postgresTextSchema.min(1).max(4000),
    constraints: z.array(postgresTextSchema.min(1).max(2000)).max(32),
    entries: z.array(assignmentContextItemSchema).max(256),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    createdAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.recording === "unrecorded"
        ? value.revision === 0 &&
          value.baseRevision === 0 &&
          value.entries.length === 0 &&
          value.digest === null &&
          value.createdAt === null
        : value.revision > 0 &&
          value.baseRevision === value.revision - 1 &&
          value.digest !== null &&
          value.createdAt !== null;

    if (
      !valid ||
      value.entries.some((item) => item.introducedRevision > value.revision)
    )
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message:
          "Context recording and attribution must match the retained revision",
      });
  });

export type AssignmentContext = z.infer<typeof assignmentContextSchema>;

export const assignmentContextReadSchema = z
  .object({
    assignmentId: identity,
    revision: revision.optional(),
  })
  .strict();
