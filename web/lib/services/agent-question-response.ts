import "server-only";

import type { FormFieldItems } from "@/lib/config.schema";

import { formSchemaSchema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import {
  isPlainObject,
  validateStructuredOutput,
} from "@/lib/flows/output-schema";

/** Clarification choices suggest answers; they do not constrain a human's reply. */
function questionValueSchema(value: FormFieldItems): FormFieldItems {
  return {
    ...value,
    type: value.type === "enum" ? "string" : value.type,
    ...(value.fields
      ? {
          fields: value.fields.map((field) => ({
            ...field,
            ...questionValueSchema(field),
          })),
        }
      : {}),
    ...(value.items ? { items: questionValueSchema(value.items) } : {}),
  };
}

function emptyRequiredQuestionText(
  value: unknown,
  spec: FormFieldItems,
  path: string,
): string | null {
  if (spec.type === "object" && isPlainObject(value)) {
    for (const field of spec.fields ?? []) {
      const fieldValue = value[field.name];
      const fieldPath = path ? `${path}.${field.name}` : field.name;

      if (
        field.required &&
        (field.type === "string" || field.type === "enum") &&
        typeof fieldValue === "string" &&
        fieldValue.trim().length === 0
      )
        return fieldPath;
      const empty = emptyRequiredQuestionText(fieldValue, field, fieldPath);

      if (empty) return empty;
    }
  }
  if (spec.type === "array" && Array.isArray(value) && spec.items) {
    for (const [index, item] of value.entries()) {
      const empty = emptyRequiredQuestionText(
        item,
        spec.items,
        `${path}[${index}]`,
      );

      if (empty) return empty;
    }
  }

  return null;
}

/** Validate an agent clarification without changing the stored answer or Flow enums. */
export function assertAgentQuestionResponse(
  response: unknown,
  schema: unknown,
): void {
  const parsed = formSchemaSchema.safeParse(schema);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Agent question form schema is invalid", {
      details: { reason: "agent_question_schema_invalid" },
    });
  const fields = parsed.data.fields.map((field) => ({
    ...field,
    ...questionValueSchema(field),
  }));
  const validation = validateStructuredOutput(response, {
    ...parsed.data,
    fields,
  });

  if (!validation.ok) throw new MaisterError("NEEDS_INPUT", validation.message);
  const empty = emptyRequiredQuestionText(
    response,
    { type: "object", fields: parsed.data.fields },
    "",
  );

  if (empty)
    throw new MaisterError(
      "NEEDS_INPUT",
      "A required clarification answer is empty",
      {
        details: { reason: "agent_question_answer_empty", field: empty },
      },
    );
}
