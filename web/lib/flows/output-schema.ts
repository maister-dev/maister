import "server-only";

// M26 (ADR-063): the single structured-output validator. HITL forms and graph
// node `output.result` both validate against the same `formSchemaSchema`
// grammar (string/number/boolean/enum/array/object-with-fields). Pure function,
// returns a discriminated result — never throws.

type FieldType = "string" | "number" | "boolean" | "enum" | "array" | "object";

type SchemaField = {
  name: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  fields?: ReadonlyArray<SchemaField>;
};

type FormSchemaLike = {
  schemaVersion?: number;
  fields: ReadonlyArray<SchemaField>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkField(value: unknown, field: SchemaField): string | null {
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
    case "object": {
      if (!isPlainObject(value))
        return `field "${field.name}" must be an object`;
      for (const child of field.fields ?? []) {
        const err = checkField(value[child.name], child);

        if (err) return `in "${field.name}": ${err}`;
      }
      break;
    }
  }

  return null;
}

export function validateStructuredOutput(
  value: unknown,
  schema: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!schema || typeof schema !== "object") {
    return { ok: false, message: "schema is missing or malformed" };
  }
  const fields = (schema as FormSchemaLike).fields;

  if (!Array.isArray(fields)) {
    return { ok: false, message: "schema.fields is not an array" };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: "value must be a JSON object" };
  }
  for (const field of fields) {
    const err = checkField(value[field.name], field);

    if (err) return { ok: false, message: err };
  }

  return { ok: true };
}
