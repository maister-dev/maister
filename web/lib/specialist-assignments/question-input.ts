/** Preserve the exact original input and question when appending a human answer. */
export function assignmentClarificationInput(
  value: Readonly<{
    originalInput: string;
    questionId: string;
    question: string;
    response: Readonly<Record<string, unknown>>;
  }>,
): string {
  return [
    value.originalInput,
    `Assignment clarification ${value.questionId}\nQuestion: ${value.question}\nHuman answer: ${JSON.stringify(value.response)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
