import {
  parseFormSchemaJson,
  serializeFormSchema,
} from "@/lib/flows/editor/form-schema-edit";
import {
  deriveSchemaFileName,
  isRootSchemaFilePath,
  schemaFilePathToRef,
  schemaRefToFilePath,
} from "@/lib/flows/editor/reference-sources";

export type SchemaWriteIntent =
  | { ok: true; path: string; ref: string; content: string }
  | { ok: false; error: string };

export function buildSchemaWriteFromTitle(
  title: string,
  existingFilePaths: readonly string[],
  content: string,
): SchemaWriteIntent {
  const parsed = parseFormSchemaJson(content);

  if (!parsed.ok) return { ok: false, error: parsed.error };

  const path = deriveSchemaFileName(title, existingFilePaths);

  return {
    ok: true,
    path,
    ref: schemaFilePathToRef(path),
    content: serializeFormSchema(parsed.schema),
  };
}

export function buildSchemaWriteFromRef(
  ref: string,
  content: string,
): SchemaWriteIntent {
  const parsed = parseFormSchemaJson(content);

  if (!parsed.ok) return { ok: false, error: parsed.error };

  const path = schemaRefToFilePath(ref);

  if (!isRootSchemaFilePath(path)) {
    return {
      ok: false,
      error: "schema ref must point at ./schemas/<name>.json",
    };
  }

  return {
    ok: true,
    path,
    ref: schemaFilePathToRef(path),
    content: serializeFormSchema(parsed.schema),
  };
}
