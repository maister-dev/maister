import type { TaskQualificationValue } from "./qualification-types";

import { z } from "zod";

import { QUALIFICATION_DIMENSIONS } from "./qualification-types";
import { taskQualificationValueSchema } from "./qualification-schema";

const locator = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const humanAssessmentEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: locator }).strict(),
  z.object({ kind: z.literal("run"), runId: locator }).strict(),
  z
    .object({ kind: z.literal("file"), path: z.string().min(1).max(180) })
    .strict(),
]);
export type HumanAssessmentEvidence = z.infer<
  typeof humanAssessmentEvidenceSchema
>;

const humanAssessmentBodySchema = z
  .object({
    requestKey: z.string().uuid(),
    contextToken: digest,
    expectedInputRevision: z.number().int().min(1).max(2_147_483_647),
    expectedQualificationRevision: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .nullable(),
    repositoryToken: digest.nullable(),
    requestType: taskQualificationValueSchema.shape.requestType,
    decision: taskQualificationValueSchema.shape.decision,
    checks: z
      .array(
        z
          .object({
            dimension: z.enum(QUALIFICATION_DIMENSIONS),
            state: z.enum(["pass", "fail", "unknown", "not_applicable"]),
            rationale: z.string().trim().min(1).max(2000),
            evidenceIndexes: z.array(z.number().int().min(0).max(31)).max(32),
          })
          .strict(),
      )
      .length(QUALIFICATION_DIMENSIONS.length),
    evidence: z.array(humanAssessmentEvidenceSchema).max(32),
    nextActions: z.array(z.string().trim().min(1).max(2000)).max(16),
  })
  .strict();

export type HumanAssessmentWrite = z.infer<typeof humanAssessmentBodySchema>;
export type HumanAssessmentIssue = Readonly<{ path: string; key: string }>;
export type HumanAssessmentDraft = Readonly<{
  contextToken: string;
  expectedInputRevision: number;
  expectedQualificationRevision: number | null;
  tasks: ReadonlyArray<Readonly<{ id: string; label: string }>>;
  runs: ReadonlyArray<Readonly<{ id: string; label: string }>>;
  repository?: Readonly<{ token: string; ref: string }>;
}>;

/** Preserve actual human judgments while generating machine-only identity and reason fields. */
export function humanAssessmentValue(
  request: HumanAssessmentWrite,
  references: TaskQualificationValue["evidenceRefs"],
): TaskQualificationValue {
  return {
    schemaVersion: 1,
    requestType: request.requestType,
    decision: request.decision,
    checks: request.checks.map(({ evidenceIndexes, ...check }) => ({
      ...check,
      evidenceIds: evidenceIndexes.map((index) => `evidence-${index + 1}`),
    })),
    evidenceRefs: references,
    reasonCodes: request.decision === "ready" ? [] : [request.decision],
    nextActions: request.nextActions,
  };
}

export const humanAssessmentWriteSchema = humanAssessmentBodySchema.superRefine(
  (request, context) => {
    if (
      new Set(request.evidence.map((item) => JSON.stringify(item))).size !==
      request.evidence.length
    )
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "duplicate",
      });
    if (
      request.evidence.some((item) => item.kind === "file") &&
      !request.repositoryToken
    )
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "repository",
      });
    const machine = taskQualificationValueSchema.safeParse(
      humanAssessmentValue(
        request,
        request.evidence.map((item, index) => ({
          id: `evidence-${index + 1}`,
          kind: item.kind === "file" ? "repository" : item.kind,
          reference: "validated-by-server",
        })),
      ),
    );

    if (!machine.success)
      for (const issue of machine.error.issues) {
        const path = issue.path.map((segment) =>
          segment === "evidenceRefs"
            ? "evidence"
            : segment === "evidenceIds"
              ? "evidenceIndexes"
              : segment,
        );
        const key =
          path[0] === "decision"
            ? "ready"
            : path[0] === "evidence"
              ? request.decision === "ready"
                ? "repository"
                : "evidence"
              : path[0] === "nextActions"
                ? "nextAction"
                : path[2] === "evidenceIndexes"
                  ? "evidence"
                  : path[2] === "state"
                    ? "notApplicable"
                    : "invalid";

        context.addIssue({ code: "custom", path, message: key });
      }
  },
);

const issueKeys = new Set([
  "duplicate",
  "repository",
  "ready",
  "evidence",
  "nextAction",
  "notApplicable",
  "invalid",
]);

export function humanAssessmentIssues(
  error: z.ZodError,
): HumanAssessmentIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    key: issueKeys.has(issue.message) ? issue.message : "required",
  }));
}
