import type { FormSchema } from "@/lib/config.schema";
import type {
  OperationalResultV1,
  OperationalValidationCode,
  OperationalValidationDiagnostic,
} from "@/lib/run-results/operational-types";

import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nonempty = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank");
const referenceSchema = z
  .object({
    kind: z.enum(["task", "external_issue", "operation_receipt", "other"]),
    id: nonempty(512),
    state: z.enum(["confirmed", "unresolved"]),
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);

        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "reference URL must use http/https without credentials")
      .optional(),
  })
  .strict();
const diagnosticSchema = z
  .object({
    code: nonempty(128),
    severity: z.enum(["warning", "error"]),
    operation: nonempty(256),
    message: nonempty(2000),
    retryable: z.boolean(),
    remediation: nonempty(2000),
    referenceIds: z.array(nonempty(512)).max(1000).optional(),
    service: nonempty(256).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

/** Version 1 is immutable; changes require a new supported semantic version. */
export const operationalResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(["success", "partial", "blocked", "failed"]),
    summary: nonempty(2000),
    coverage: z
      .object({
        state: z.enum(["complete", "incomplete", "not_started"]),
        remainingKnown: count.nullable(),
      })
      .strict(),
    counts: z
      .object({
        scanned: count,
        attempted: count,
        completed: count,
        failed: count,
        skipped: count,
        created: count,
      })
      .strict(),
    references: z.array(referenceSchema).max(1000),
    diagnostics: z.array(diagnosticSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const fail = (
      rule: OperationalValidationCode,
      path: string[],
      message: string,
    ): void =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message,
        params: { operationalRule: rule },
      });
    const { counts, coverage, references, diagnostics } = value;

    if (counts.attempted !== counts.completed + counts.failed)
      fail(
        "attempted_count_mismatch",
        ["counts", "attempted"],
        "attempted must equal completed + failed",
      );
    if (counts.attempted + counts.skipped > counts.scanned)
      fail(
        "scanned_count_exceeded",
        ["counts", "scanned"],
        "attempted + skipped must not exceed scanned",
      );
    if (counts.created > counts.attempted)
      fail(
        "created_count_exceeded",
        ["counts", "created"],
        "created must not exceed attempted",
      );
    if (coverage.state === "complete" && coverage.remainingKnown !== 0)
      fail(
        "complete_coverage_remaining",
        ["coverage", "remainingKnown"],
        "complete coverage requires remainingKnown=0",
      );
    if (coverage.state === "not_started" && counts.scanned !== 0)
      fail(
        "not_started_has_scanned",
        ["counts", "scanned"],
        "not_started coverage cannot report scanned work",
      );
    const ids = new Set(references.map((reference) => reference.id));
    const identities = references.map(
      (reference) => `${reference.kind}:${reference.id}`,
    );

    if (new Set(identities).size !== identities.length)
      fail(
        "duplicate_reference",
        ["references"],
        "reference identities must be unique",
      );
    if (
      diagnostics.some((diagnostic) =>
        diagnostic.referenceIds?.some((id) => !ids.has(id)),
      )
    )
      fail(
        "undeclared_diagnostic_reference",
        ["diagnostics"],
        "diagnostic referenceIds must resolve to declared references",
      );
    const error = diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    );
    const unresolved = references.some(
      (reference) => reference.state === "unresolved",
    );
    const progress =
      counts.completed > 0 ||
      counts.created > 0 ||
      references.some(
        (reference) =>
          reference.kind === "operation_receipt" &&
          reference.state === "confirmed",
      );

    if (
      value.outcome === "success" &&
      (coverage.state !== "complete" ||
        counts.failed > 0 ||
        error ||
        unresolved)
    )
      fail(
        "success_inconsistent",
        ["outcome"],
        "success requires complete coverage without failed work, errors or unresolved effects",
      );
    if (value.outcome === "partial" && !progress)
      fail(
        "partial_requires_progress",
        ["outcome"],
        "partial requires confirmed progress",
      );
    if (
      value.outcome === "partial" &&
      !error &&
      coverage.state === "complete" &&
      counts.failed === 0 &&
      !unresolved
    )
      fail(
        "partial_requires_incomplete_work",
        ["outcome"],
        "partial requires incomplete or failed work",
      );
    if ((value.outcome === "blocked" || value.outcome === "failed") && !error)
      fail(
        "error_diagnostic_required",
        ["diagnostics"],
        "blocked/failed requires an actionable error diagnostic",
      );
    if (counts.failed > 0 && !error)
      fail(
        "failed_work_requires_error",
        ["diagnostics"],
        "failed work requires an actionable error diagnostic",
      );
    if (
      counts.created >
      references.filter((reference) => reference.state === "confirmed").length
    )
      fail(
        "creation_reference_missing",
        ["references"],
        "confirmed creations require their confirmed references",
      );
  });

const validationPath =
  /^(?:schemaVersion|outcome|summary|coverage(?:\.(?:state|remainingKnown))?|counts(?:\.(?:scanned|attempted|completed|failed|skipped|created))?|references(?:\[\d{1,4}\](?:\.(?:kind|id|state|url))?)?|diagnostics(?:\[\d{1,4}\](?:\.(?:code|severity|operation|message|retryable|remediation|service|httpStatus|referenceIds(?:\[\d{1,4}\])?))?)?)$/;

function operationalIssueCode(issue: z.ZodIssue): OperationalValidationCode {
  if (issue.code === "custom" && issue.params?.operationalRule)
    return issue.params.operationalRule as OperationalValidationCode;

  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? "field_required" : "invalid_type";
    case "invalid_value":
      if (issue.input === undefined) return "field_required";

      return issue.path.length === 1 && issue.path[0] === "schemaVersion"
        ? "unsupported_version"
        : "invalid_value";
    case "unrecognized_keys":
      return "unknown_fields";
    case "invalid_format":
    case "too_small":
    case "too_big":
    case "not_multiple_of":
    case "custom":
      return "invalid_value";
    default:
      return "invalid_structure";
  }
}

/** reportInput is used only to classify missing values; rejected data is discarded. */
export function operationalValidationDiagnostics(
  issues: readonly z.ZodIssue[],
): OperationalValidationDiagnostic[] {
  const diagnostics = issues
    .slice(0, 20)
    .map((issue): OperationalValidationDiagnostic => {
      const path = issue.path.reduce<string>(
        (result, segment) =>
          typeof segment === "number"
            ? `${result}[${segment}]`
            : typeof segment === "string"
              ? `${result}${result ? "." : ""}${segment}`
              : "$",
        "",
      );

      return {
        code: operationalIssueCode(issue),
        path: path.length <= 128 && validationPath.test(path) ? path : "$",
      };
    });

  return diagnostics.filter(
    (diagnostic, index) =>
      diagnostics.findIndex(
        (entry) =>
          entry.code === diagnostic.code && entry.path === diagnostic.path,
      ) === index,
  );
}

/** Structural safety stays in the existing FormSchema/output validator. */
export const OPERATIONAL_FORM_SCHEMA: FormSchema = {
  schemaVersion: 1,
  fields: [
    { name: "schemaVersion", type: "number", required: true },
    {
      name: "outcome",
      type: "enum",
      required: true,
      options: ["success", "partial", "blocked", "failed"],
    },
    { name: "summary", type: "string", required: true },
    { name: "coverage", type: "json", required: true },
    { name: "counts", type: "json", required: true },
    {
      name: "references",
      type: "array",
      required: true,
      items: { type: "json" },
    },
    {
      name: "diagnostics",
      type: "array",
      required: true,
      items: { type: "json" },
    },
  ],
};

export function parseOperationalResult(
  value: unknown,
): OperationalResultV1 | null {
  const parsed = operationalResultV1Schema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
