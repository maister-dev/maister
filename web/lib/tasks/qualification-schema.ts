import { z } from "zod";

import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";

const identifier = z.string().trim().min(1).max(256);
const explanation = z.string().trim().min(1).max(2000);

export const taskQualificationValueSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestType: z.enum(["bug", "feature", "maintenance", "question"]),
    decision: z.enum([
      "ready",
      "needs_information",
      "needs_review",
      "not_actionable",
    ]),
    checks: z
      .array(
        z
          .object({
            dimension: z.enum(QUALIFICATION_DIMENSIONS),
            state: z.enum(["pass", "fail", "unknown", "not_applicable"]),
            rationale: explanation,
            evidenceIds: z.array(identifier).max(32),
          })
          .strict(),
      )
      .length(QUALIFICATION_DIMENSIONS.length),
    reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,255}$/)).max(16),
    nextActions: z.array(explanation).max(16),
    evidenceRefs: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum([
              "repository",
              "task",
              "run",
              "source",
              "human_attestation",
            ]),
            reference: identifier,
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const dimensions = new Set(value.checks.map((check) => check.dimension));

    if (dimensions.size !== QUALIFICATION_DIMENSIONS.length)
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Every qualification dimension must occur exactly once",
      });
    const evidence = new Set(value.evidenceRefs.map((item) => item.id));

    if (evidence.size !== value.evidenceRefs.length)
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "Evidence IDs must be unique",
      });
    value.checks.forEach((check, index) => {
      if (check.evidenceIds.some((id) => !evidence.has(id)))
        context.addIssue({
          code: "custom",
          path: ["checks", index, "evidenceIds"],
          message: "Evidence IDs must refer to this assessment's evidence",
        });
      if (
        check.state === "not_applicable" &&
        (check.dimension !== "bug_evidence" || value.requestType === "bug")
      )
        context.addIssue({
          code: "custom",
          path: ["checks", index, "state"],
          message:
            "Only bug evidence for a non-bug request can be not applicable",
        });
      if (
        value.decision === "ready" &&
        check.state !== "pass" &&
        check.state !== "not_applicable"
      )
        context.addIssue({
          code: "custom",
          path: ["decision"],
          message: "Ready requires every applicable check to pass",
        });
    });
    const relevance = value.checks.find(
      (check) => check.dimension === "relevance",
    );

    if (
      value.decision === "ready" &&
      !value.evidenceRefs.some(
        (reference) =>
          reference.kind === "repository" &&
          relevance?.evidenceIds.includes(reference.id),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "Readiness requires repository evidence for current relevance",
      });
    if (value.decision === "not_actionable" && value.evidenceRefs.length === 0)
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "A non-actionable disposition requires supporting evidence",
      });
    if (
      value.decision !== "ready" &&
      (value.reasonCodes.length === 0 || value.nextActions.length === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["nextActions"],
        message: "Held decisions require a reason and an actionable next step",
      });
  });

export const taskQualificationWriteSchema = z
  .object({
    requestKey: z.string().uuid(),
    expectedInputRevision: z.number().int().min(1).max(2_147_483_647),
    expectedQualificationRevision: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .nullable(),
    qualification: taskQualificationValueSchema,
    flowId: identifier.optional(),
    runnerId: identifier.optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    enqueue: z.boolean().optional(),
  })
  .strict();
export type TaskQualificationWrite = z.infer<
  typeof taskQualificationWriteSchema
>;
