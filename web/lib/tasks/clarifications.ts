import "server-only";

export const MAX_CLARIFICATION_QUESTION_CHARS = 2_000;
export const MAX_CLARIFICATION_ANSWER_CHARS = 4_000;
export const MAX_CLARIFICATIONS_IN_PROMPT = 20;

export type ClarificationHistoryRow = {
  id: string;
  seq: number;
  question: string;
  answer: unknown;
  answeredAt: Date | null;
  supersededAt: Date | null;
};

export type TaskClarificationContext = {
  id: string;
  seq: number;
  question: string;
  answer: unknown;
};

export type ClarificationRequestState = {
  activationState: "pending_termination" | "active" | "failed" | null;
  respondedAt: Date | null;
  supersededAt: Date | null;
};

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function formatAnswer(answer: unknown): string {
  const serialized = JSON.stringify(answer);

  return bounded(serialized ?? "null", MAX_CLARIFICATION_ANSWER_CHARS);
}

export function orderedAnsweredClarifications(
  rows: ClarificationHistoryRow[],
): TaskClarificationContext[] {
  return rows
    .filter(
      (row) =>
        row.answeredAt !== null &&
        row.supersededAt === null &&
        row.answer !== null,
    )
    .sort((left, right) => {
      const sequenceDelta = left.seq - right.seq;

      return sequenceDelta !== 0 ? sequenceDelta : left.id.localeCompare(right.id);
    })
    .slice(0, MAX_CLARIFICATIONS_IN_PROMPT)
    .map((row) => ({
      id: row.id,
      seq: row.seq,
      question: bounded(row.question, MAX_CLARIFICATION_QUESTION_CHARS),
      answer: row.answer,
    }));
}

export function deriveAwaitingClarification(
  requests: ClarificationRequestState[],
): boolean {
  return requests.some(
    (request) =>
      request.activationState === "active" &&
      request.respondedAt === null &&
      request.supersededAt === null,
  );
}

export function composeEffectivePrompt(
  prompt: string,
  clarifications: TaskClarificationContext[],
): string {
  if (clarifications.length === 0) return prompt;

  return [
    prompt,
    "## Human clarifications",
    ...clarifications.flatMap((clarification) => [
      `### Clarification ${clarification.seq}`,
      `Question: ${clarification.question}`,
      `Answer: ${formatAnswer(clarification.answer)}`,
    ]),
  ].join("\n\n");
}
