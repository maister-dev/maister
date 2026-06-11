import type { FormSchema } from "@/lib/config.schema";

import { formSchemaSchema } from "@/lib/config.schema";

// A single field of `formSchemaSchema.fields` (recursive `object` fields). The
// grammar type is local to config.schema, so derive it from the exported
// FormSchema rather than re-declaring it.
export type FormSchemaField = FormSchema["fields"][number];
export type FormSchemaFieldType = FormSchemaField["type"];

export const FORM_FIELD_TYPES: readonly FormSchemaFieldType[] = [
  "string",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
] as const;

// A path into the nested `fields` tree: each entry is the field index at that
// depth. `[]` targets the schema's top-level `fields`; `[0, 1]` targets the
// second child of the first field; etc.
export type FieldPath = number[];

export type FieldEdit =
  | { kind: "add"; path: FieldPath }
  | { kind: "remove"; path: FieldPath }
  | { kind: "move"; path: FieldPath; direction: "up" | "down" }
  | {
      kind: "update";
      path: FieldPath;
      patch: Partial<
        Pick<
          FormSchemaField,
          "name" | "label" | "type" | "required" | "options"
        >
      >;
    };

export type ParseResult =
  | { ok: true; schema: FormSchema }
  | { ok: false; error: string };

/**
 * Parse + validate a `schemas/*.json` (or `output.result`) doc against
 * `formSchemaSchema`. Two-step: JSON syntax first, then the grammar — so the
 * builder can show a precise reason and stays decoupled from the editing layer.
 */
export function parseFormSchemaJson(text: string): ParseResult {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalid JSON",
    };
  }

  const parsed = formSchemaSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid form schema",
    };
  }

  return { ok: true, schema: parsed.data };
}

/**
 * Stable pretty-print used both for the JSON toggle and the `onChange` payload.
 * Deterministic (2-space, key order from the schema), so a schema→JSON→schema→
 * JSON round-trip is byte-stable.
 */
export function serializeFormSchema(schema: FormSchema): string {
  return JSON.stringify(schema, null, 2);
}

function blankField(): FormSchemaField {
  return { name: "field", type: "string" };
}

// Return the `fields` array at `path` (mutable copy chain rooted at a fresh
// schema clone). The returned array is the live child container to edit.
function cloneSchema(schema: FormSchema): FormSchema {
  return JSON.parse(JSON.stringify(schema)) as FormSchema;
}

// Walk to the parent container of the field addressed by `path`, returning that
// container and the target index. For `path = []`, the container is the schema's
// top-level `fields` and the index is `fields.length` (append target).
function resolveContainer(
  schema: FormSchema,
  path: FieldPath,
): {
  container: FormSchemaField[];
  index: number;
} {
  let container: FormSchemaField[] = schema.fields;

  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const field = container[path[depth]];

    if (!field) break;
    field.fields ??= [];
    container = field.fields;
  }

  const index = path.length === 0 ? container.length : path[path.length - 1];

  return { container, index };
}

// Resolve the `object` field whose children `add` targets. `path = []` means the
// schema root; otherwise the field addressed by the full path.
function resolveAddTarget(
  schema: FormSchema,
  path: FieldPath,
): FormSchemaField[] {
  if (path.length === 0) return schema.fields;

  let field: FormSchemaField | undefined;
  let container: FormSchemaField[] = schema.fields;

  for (const idx of path) {
    field = container[idx];
    if (!field) return schema.fields;
    container = field.fields ?? [];
  }

  if (!field) return schema.fields;
  field.fields ??= [];

  return field.fields;
}

/**
 * Apply a single structured-field edit, returning a NEW schema (input never
 * mutated). `add` appends a blank `string` field into the addressed object's
 * children (root for `[]`); `remove`/`move`/`update` operate on the field
 * addressed by `path`. Out-of-range / boundary moves are no-ops.
 */
export function applyFieldEdit(
  schema: FormSchema,
  edit: FieldEdit,
): FormSchema {
  const next = cloneSchema(schema);

  if (edit.kind === "add") {
    resolveAddTarget(next, edit.path).push(blankField());

    return next;
  }

  const { container, index } = resolveContainer(next, edit.path);

  if (index < 0 || index >= container.length) return next;

  if (edit.kind === "remove") {
    container.splice(index, 1);

    return next;
  }

  if (edit.kind === "move") {
    const swapWith = edit.direction === "up" ? index - 1 : index + 1;

    if (swapWith < 0 || swapWith >= container.length) return next;
    const [moved] = container.splice(index, 1);

    container.splice(swapWith, 0, moved);

    return next;
  }

  // update
  container[index] = { ...container[index], ...edit.patch };

  return next;
}
