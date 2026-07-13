import type { TaskClarificationHistory as TaskClarificationHistoryRow } from "@/lib/queries/task-clarifications";
import type { ReactElement } from "react";

export type TaskClarificationHistoryLabels = {
  title: string;
  awaiting: string;
  question: string;
  answer: string;
};

type TaskClarificationHistoryProps = {
  awaitingClarification: boolean;
  history: readonly TaskClarificationHistoryRow[];
  labels: TaskClarificationHistoryLabels;
};

function answeredHistory(
  history: readonly TaskClarificationHistoryRow[],
): TaskClarificationHistoryRow[] {
  return history
    .filter(
      (clarification) =>
        clarification.answeredAt !== null &&
        clarification.supersededAt === null &&
        clarification.answer !== null,
    )
    .toSorted(
      (left, right) =>
        left.seq - right.seq || left.id.localeCompare(right.id),
    );
}

function formatAnswer(answer: unknown): string {
  return JSON.stringify(answer) ?? "null";
}

export function TaskClarificationHistory({
  awaitingClarification,
  history,
  labels,
}: TaskClarificationHistoryProps): ReactElement | null {
  const answered = answeredHistory(history);

  if (!awaitingClarification && answered.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line-soft bg-paper p-3"
      data-testid="task-clarification-history"
    >
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
        {labels.title}
      </h2>
      {awaitingClarification ? (
        <p
          className="w-fit rounded border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[10px] font-semibold text-amber"
          data-testid="task-awaiting-clarification"
        >
          {labels.awaiting}
        </p>
      ) : null}
      {answered.map((clarification) => (
        <article
          key={clarification.id}
          className="flex flex-col gap-1 border-t border-dashed border-line-soft pt-2 first:border-t-0 first:pt-0"
        >
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
            {labels.question}
          </p>
          <p className="text-[12px] text-ink">{clarification.question}</p>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute">
            {labels.answer}
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-ivory p-2 font-mono text-[11px] text-ink-2">
            {formatAnswer(clarification.answer)}
          </pre>
        </article>
      ))}
    </section>
  );
}
