import "server-only";

import type { FormFieldItems, FormSchema } from "@/lib/config.schema";

import { MaisterError } from "@/lib/errors";
import { validateStructuredOutput } from "@/lib/flows/output-schema";

/** Apply the response validator's structural bounds before recursive form parsing can discard unsafe input. */
export function assertAssignmentQuestionStructure(value: unknown): void {
  const result = validateStructuredOutput(value, { fields: [] });

  if (!result.ok)
    throw new MaisterError(
      "CONFIG",
      "Assignment question structure is invalid",
      {
        details: { reason: result.reason ?? "assignment_question_invalid" },
      },
    );
}

function assertAnswerableFields(spec: FormFieldItems): void {
  if (spec.fields) {
    const names = spec.fields.map((field) => field.name);
    const keys = Object.fromEntries(names.map((name) => [name, null]));

    if (names.length > 64 || new Set(names).size !== names.length)
      throw new MaisterError(
        "CONFIG",
        "Clarification forms require at most 64 distinct fields per object",
        { details: { reason: "assignment_question_fields_invalid" } },
      );
    assertAssignmentQuestionStructure(keys);
    for (const field of spec.fields) assertAnswerableFields(field);
  }
  if (spec.items) assertAnswerableFields(spec.items);
}

/** A retained native question must be representable by the same bounded, unsafe-key-free answer grammar. */
export function assertAnswerableAssignmentQuestionForm(
  schema: FormSchema,
): void {
  if (
    [
      "assignmentQuestion",
      "agentPrompt",
      "flowQuestion",
      "supervisorSessionId",
    ].some((name) => Object.hasOwn(schema, name))
  )
    throw new MaisterError(
      "CONFIG",
      "Clarification forms cannot supply server question, prompt or session metadata",
      { details: { reason: "assignment_question_server_metadata" } },
    );
  assertAnswerableFields({ type: "object", fields: schema.fields });
}
