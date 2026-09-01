import "server-only";

import type { FormFieldItems, FormSchema } from "@/lib/config.schema";

// M26 (ADR-063): the single structured-output validator. HITL forms and graph
// node `output.result` both validate against the same `formSchemaSchema`
// grammar (string/number/boolean/enum/array/object-with-fields/json). Pure
// function, returns a discriminated result — never throws. The field/schema
// types are derived from the Zod-owned `FormSchema` so the validator can never
// drift from the parser grammar.
// ADR-162: a structural pre-pass runs BEFORE any field check — unsafe own keys
// and depth/key-count/array-length bounds. It applies to all three consumers of
// this validator (node output, HITL form/human responses, Brain lesson
// distillation), which all validate LLM-origin payloads.

type SchemaField = FormSchema["fields"][number];

// The shape shared by a named field and a nameless array-element declaration —
// everything the value check needs, nothing the authoring layer adds.
type ValueSpec = {
  type: SchemaField["type"];
  options?: readonly string[];
  fields?: readonly SchemaField[];
  items?: FormFieldItems;
};

// Structural bounds on an LLM-authored payload. Deliberately constants, not env
// vars: `MAISTER_NODE_OUTPUT_MAX_BYTES` is the capacity dial and already
// subsumes per-string length.
export const MAX_OUTPUT_DEPTH = 64;
export const MAX_OUTPUT_OBJECT_KEYS = 10_000;
export const MAX_OUTPUT_ARRAY_LENGTH = 10_000;

const UNSAFE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Walks the payload once for the bounds that no per-field rule can express.
// Depth counts containers only, so a scalar leaf at MAX_OUTPUT_DEPTH is valid.
function checkStructure(root: unknown): string | null {
  let totalKeys = 0;

  function walk(value: unknown, path: string, depth: number): string | null {
    if (Array.isArray(value)) {
      if (depth > MAX_OUTPUT_DEPTH) {
        return `payload exceeds the maximum nesting depth (${MAX_OUTPUT_DEPTH}) at ${path}`;
      }
      if (value.length > MAX_OUTPUT_ARRAY_LENGTH) {
        return `array at ${path} exceeds the maximum length (${MAX_OUTPUT_ARRAY_LENGTH})`;
      }
      for (let i = 0; i < value.length; i += 1) {
        const err = walk(value[i], `${path}[${i}]`, depth + 1);

        if (err) return err;
      }

      return null;
    }

    if (isPlainObject(value)) {
      if (depth > MAX_OUTPUT_DEPTH) {
        return `payload exceeds the maximum nesting depth (${MAX_OUTPUT_DEPTH}) at ${path}`;
      }
      const keys = Object.keys(value);

      totalKeys += keys.length;
      if (totalKeys > MAX_OUTPUT_OBJECT_KEYS) {
        return `payload exceeds the maximum object key count (${MAX_OUTPUT_OBJECT_KEYS})`;
      }
      for (const key of keys) {
        const keyPath = `${path}.${key}`;

        if (UNSAFE_KEYS.has(key)) {
          return `unsafe key "${key}" at ${keyPath}`;
        }
        const err = walk(value[key], keyPath, depth + 1);

        if (err) return err;
      }

      return null;
    }

    return null;
  }

  return walk(root, "$", 1);
}

// Type check for a value that is known to be present. `label` is the display
// name in the error message — a field name at the top, `name[i]` for an array
// element.
function checkValue(
  value: unknown,
  spec: ValueSpec,
  label: string,
): string | null {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return `field "${label}" must be a string`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `field "${label}" must be a finite number`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean")
        return `field "${label}" must be a boolean`;
      break;
    case "enum": {
      if (typeof value !== "string") return `field "${label}" must be a string`;
      const opts = spec.options ?? [];

      if (!opts.includes(value)) {
        return `field "${label}" must be one of [${opts.join(", ")}]`;
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) return `field "${label}" must be an array`;
      const items = spec.items;

      if (!items) break;
      for (let i = 0; i < value.length; i += 1) {
        const err = checkValue(value[i], items, `${label}[${i}]`);

        if (err) return err;
      }
      break;
    }
    case "object": {
      if (!isPlainObject(value)) return `field "${label}" must be an object`;
      for (const child of spec.fields ?? []) {
        const err = checkField(value[child.name], child);

        if (err) return `in "${label}": ${err}`;
      }
      break;
    }
    case "json":
      break;
  }

  return null;
}

function checkField(value: unknown, field: SchemaField): string | null {
  const required = field.required ?? false;
  // ADR-162 (C-4): for `json` — and only `json` — an explicit JSON null is a
  // PRESENT value; an opaque field whose legitimate value is null would
  // otherwise be unrepresentable. Every other type keeps the M26 rule.
  const present =
    field.type === "json"
      ? value !== undefined
      : value !== undefined && value !== null;

  if (!present) {
    if (required) return `field "${field.name}" is required`;

    return null;
  }

  return checkValue(value, field, field.name);
}

export function validateStructuredOutput(
  value: unknown,
  schema: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!schema || typeof schema !== "object") {
    return { ok: false, message: "schema is missing or malformed" };
  }
  const rawFields = (schema as { fields?: unknown }).fields;

  if (!Array.isArray(rawFields)) {
    return { ok: false, message: "schema.fields is not an array" };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: "value must be a JSON object" };
  }

  const structural = checkStructure(value);

  if (structural) return { ok: false, message: structural };

  for (const field of rawFields as FormSchema["fields"]) {
    const err = checkField(value[field.name], field);

    if (err) return { ok: false, message: err };
  }

  return { ok: true };
}
