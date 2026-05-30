import "server-only";

import { MaisterError } from "@/lib/errors";

type FieldType = "string" | "number" | "boolean" | "enum" | "array";

type FormField = {
  name: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
};

type FormSchemaLike = {
  schemaVersion?: number;
  fields: ReadonlyArray<FormField>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkField(value: unknown, field: FormField): string | null {
  const required = field.required ?? false;
  const present = value !== undefined && value !== null;

  if (!present) {
    if (required) return `field "${field.name}" is required`;

    return null;
  }
  switch (field.type) {
    case "string":
      if (typeof value !== "string")
        return `field "${field.name}" must be a string`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `field "${field.name}" must be a finite number`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean")
        return `field "${field.name}" must be a boolean`;
      break;
    case "enum": {
      if (typeof value !== "string")
        return `field "${field.name}" must be a string`;
      const opts = field.options ?? [];

      if (!opts.includes(value)) {
        return `field "${field.name}" must be one of [${opts.join(", ")}]`;
      }
      break;
    }
    case "array":
      if (!Array.isArray(value))
        return `field "${field.name}" must be an array`;
      break;
  }

  return null;
}

export function validateHitlResponse(
  response: unknown,
  schema: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!schema || typeof schema !== "object") {
    return {
      ok: false,
      message: "hitl_requests.schema is missing or malformed",
    };
  }
  const fields = (schema as FormSchemaLike).fields;

  if (!Array.isArray(fields)) {
    return { ok: false, message: "schema.fields is not an array" };
  }
  if (!isPlainObject(response)) {
    return {
      ok: false,
      message: "response must be a JSON object",
    };
  }
  for (const field of fields) {
    const err = checkField(response[field.name], field);

    if (err) return { ok: false, message: err };
  }

  return { ok: true };
}

export function assertHitlResponse(response: unknown, schema: unknown): void {
  const result = validateHitlResponse(response, schema);

  if (!result.ok) {
    throw new MaisterError("NEEDS_INPUT", result.message);
  }
}

// --- M11a: graph review-decision validation (ADR-024 / Phase 5) ------------
// A graph `human_review` HITL stores `{ review: true, allowedDecisions,
// transitions, reworkTargets, workspacePolicies }` (server-state derived from
// the pinned manifest at creation). The reviewer's decision rides INSIDE the
// `response` payload and is validated against that allow-list — never trusted
// from the body — BEFORE any state mutation.

type ReviewSchemaLike = {
  review?: boolean;
  allowedDecisions?: string[];
  transitions?: Record<string, string>;
  reworkTargets?: string[];
  workspacePolicies?: string[];
};

export type ResolvedReviewDecision = {
  decision: string;
  // Set only when the decision routes to a rework target.
  workspacePolicy?: string;
  reworkTarget?: string;
};

export function isReviewSchema(schema: unknown): boolean {
  return isPlainObject(schema) && (schema as ReviewSchemaLike).review === true;
}

export function validateReviewDecision(
  response: unknown,
  schema: unknown,
): ({ ok: true } & ResolvedReviewDecision) | { ok: false; message: string } {
  if (!isPlainObject(schema)) {
    return { ok: false, message: "review hitl schema is missing or malformed" };
  }
  if (!isPlainObject(response)) {
    return { ok: false, message: "response must be a JSON object" };
  }

  const s = schema as ReviewSchemaLike;
  const allowed = s.allowedDecisions ?? [];
  const decision = response.decision;

  if (typeof decision !== "string" || !allowed.includes(decision)) {
    return {
      ok: false,
      message: `decision must be one of [${allowed.join(", ")}]`,
    };
  }

  const transitions = s.transitions ?? {};

  if (!Object.hasOwn(transitions, decision)) {
    return {
      ok: false,
      message: `decision "${decision}" has no declared transition`,
    };
  }

  const target = transitions[decision];
  const isRework = (s.reworkTargets ?? []).includes(target);

  if (!isRework) {
    return { ok: true, decision };
  }

  // Rework decision: a submitted workspacePolicy must be allowed; an omitted
  // policy defaults to the first declared (typically `keep`).
  const policies = s.workspacePolicies ?? [];
  const submitted = response.workspacePolicy;

  if (submitted !== undefined) {
    if (typeof submitted !== "string" || !policies.includes(submitted)) {
      return {
        ok: false,
        message: `workspacePolicy must be one of [${policies.join(", ")}]`,
      };
    }

    return {
      ok: true,
      decision,
      workspacePolicy: submitted,
      reworkTarget: target,
    };
  }

  return {
    ok: true,
    decision,
    workspacePolicy: policies[0] ?? "keep",
    reworkTarget: target,
  };
}

export function assertReviewDecision(
  response: unknown,
  schema: unknown,
): ResolvedReviewDecision {
  const result = validateReviewDecision(response, schema);

  if (!result.ok) {
    throw new MaisterError("NEEDS_INPUT", result.message);
  }

  return {
    decision: result.decision,
    workspacePolicy: result.workspacePolicy,
    reworkTarget: result.reworkTarget,
  };
}
