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
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v)
  );
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
      if (typeof value !== "string") return `field "${field.name}" must be a string`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `field "${field.name}" must be a finite number`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") return `field "${field.name}" must be a boolean`;
      break;
    case "enum": {
      if (typeof value !== "string") return `field "${field.name}" must be a string`;
      const opts = field.options ?? [];

      if (!opts.includes(value)) {
        return `field "${field.name}" must be one of [${opts.join(", ")}]`;
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return `field "${field.name}" must be an array`;
      break;
  }

  return null;
}

export function validateHitlResponse(
  response: unknown,
  schema: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!schema || typeof schema !== "object") {
    return { ok: false, message: "hitl_requests.schema is missing or malformed" };
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

export function assertHitlResponse(
  response: unknown,
  schema: unknown,
): void {
  const result = validateHitlResponse(response, schema);

  if (!result.ok) {
    throw new MaisterError("NEEDS_INPUT", result.message);
  }
}
