"use client";

import type { TaskClarificationHistory } from "@/lib/queries/task-clarifications";
import type { FormEvent, ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Labels = {
  title: string;
  blocking: string;
  nonBlocking: string;
  requestedBy: string;
  recipient: string;
  reason: string;
  open: string;
  answered: string;
  cancelled: string;
  superseded: string;
  answer: string;
  submit: string;
  cancel: string;
  recipientUnavailable: string;
  yes: string;
  no: string;
};

type Props = {
  history: readonly TaskClarificationHistory[];
  userId: string;
  canAct: boolean;
  recipientEligibleById: Record<string, boolean>;
  nameById: Record<string, string>;
  slug: string;
  taskNumber: number;
  labels: Labels;
};

function UserClarificationRow({
  row,
  userId,
  canAct,
  recipientEligibleById,
  nameById,
  slug,
  taskNumber,
  labels,
}: Props & { row: TaskClarificationHistory }): ReactElement {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(slug)}/tasks/${taskNumber}/clarifications/${encodeURIComponent(row.id)}`;
  const canAnswer =
    row.status === "open" && row.recipientUserId === userId && canAct;
  const canCancel = row.status === "open" && row.requesterUserId === userId;
  const recipientAvailable =
    row.recipientUserId !== null &&
    recipientEligibleById[row.recipientUserId] === true;

  async function submitAnswer(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${base}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer: row.answerFormat === "yes_no" ? answer === "yes" : answer,
        }),
      });

      if (!response.ok)
        throw new Error((await response.json()).message ?? "Answer failed");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answer failed");
    } finally {
      setPending(false);
    }
  }

  async function cancel(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(base, { method: "DELETE" });

      if (!response.ok)
        throw new Error(
          (await response.json()).message ?? "Cancellation failed",
        );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <article
      className="flex flex-col gap-2 border-t border-line-soft pt-3"
      data-testid="task-user-clarification"
    >
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-mute">
        <span>#{row.seq}</span>
        <span>{labels[row.status]}</span>
        <span>{row.blocking ? labels.blocking : labels.nonBlocking}</span>
      </div>
      <p className="m-0 text-[13px] font-semibold text-ink">{row.question}</p>
      <p className="m-0 text-[12px] text-ink-2">
        {labels.reason}: {row.reason}
      </p>
      <p className="m-0 text-[11px] text-mute">
        {labels.requestedBy}:{" "}
        {nameById[row.requesterUserId ?? ""] ?? row.requesterUserId} ·{" "}
        {labels.recipient}:{" "}
        {nameById[row.recipientUserId ?? ""] ?? row.recipientUserId}
      </p>
      {row.answer !== null ? (
        <pre className="m-0 whitespace-pre-wrap rounded border border-line-soft bg-ivory p-2 text-[12px] text-ink">
          {typeof row.answer === "string"
            ? row.answer
            : JSON.stringify(row.answer)}
        </pre>
      ) : null}
      {row.status === "open" && !recipientAvailable ? (
        <p className="m-0 text-[12px] text-amber">
          {labels.recipientUnavailable}
        </p>
      ) : null}
      {canAnswer ? (
        <form className="flex flex-col gap-2" onSubmit={submitAnswer}>
          {row.answerFormat === "yes_no" ? (
            <select
              required
              aria-label={labels.answer}
              className="rounded border border-line bg-paper p-2"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            >
              <option value="">—</option>
              <option value="yes">{labels.yes}</option>
              <option value="no">{labels.no}</option>
            </select>
          ) : (
            <textarea
              required
              aria-label={labels.answer}
              className="min-h-20 rounded border border-line bg-paper p-2"
              maxLength={4000}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <button
            className="self-start rounded border border-line px-3 py-1.5 text-[12px]"
            disabled={pending}
            type="submit"
          >
            {labels.submit}
          </button>
        </form>
      ) : null}
      {canCancel ? (
        <button
          className="self-start rounded border border-line px-3 py-1.5 text-[12px]"
          disabled={pending}
          type="button"
          onClick={cancel}
        >
          {labels.cancel}
        </button>
      ) : null}
      {error ? (
        <p className="m-0 text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function TaskUserClarifications(props: Props): ReactElement | null {
  const rows = props.history.filter((row) => row.originKind === "user");

  if (rows.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line-soft bg-paper p-3"
      data-testid="task-user-clarifications"
    >
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
        {props.labels.title}
      </h2>
      {rows.map((row) => (
        <UserClarificationRow key={row.id} {...props} row={row} />
      ))}
    </section>
  );
}
