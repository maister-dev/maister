"use client";

import type { ReactElement } from "react";
import type {
  LibrarianCardView,
  LibrarianOperationView,
  LibrarianRelatedTaskView,
} from "@/lib/librarian/read-models";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

type Props = {
  cards: LibrarianCardView[];
  operations: LibrarianOperationView[];
  tasks: LibrarianRelatedTaskView[];
  busyCardId: string | null;
  onDecide: (card: LibrarianCardView, decision: "accept" | "reject") => void;
};

function changedLines(
  before: string,
  after: string,
): { removed: string[]; added: string[] } {
  const previous = before.split("\n");
  const proposed = after.split("\n");
  const previousSet = new Set(previous);
  const proposedSet = new Set(proposed);

  return {
    removed: previous.filter((line) => !proposedSet.has(line)),
    added: proposed.filter((line) => !previousSet.has(line)),
  };
}

function StatementDiff({
  card,
}: {
  card: LibrarianCardView;
}): ReactElement | null {
  const t = useTranslations("librarian");

  if (card.currentPrompt === null || card.proposedPrompt === null) return null;
  const changed = changedLines(card.currentPrompt, card.proposedPrompt);

  return (
    <div
      className="mt-2 rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-5"
      data-testid="librarian-statement-diff"
    >
      <p className="m-0 mb-1 text-mute">
        {t("statementDiff", { revision: card.targetRevision ?? "?" })}
      </p>
      {changed.removed.map((line, index) => (
        <p key={`removed-${index}`} className="m-0 break-words text-red-700">
          − {line}
        </p>
      ))}
      {changed.added.map((line, index) => (
        <p key={`added-${index}`} className="m-0 break-words text-green-700">
          + {line}
        </p>
      ))}
      {changed.removed.length === 0 && changed.added.length === 0 ? (
        <p className="m-0 text-mute">{t("statementNoChange")}</p>
      ) : null}
    </div>
  );
}

function Card({
  card,
  busyCardId,
  onDecide,
}: Pick<Props, "busyCardId" | "onDecide"> & {
  card: LibrarianCardView;
}): ReactElement {
  const t = useTranslations("librarian");
  const locale = useLocale();
  const pending = card.status === "pending";
  const actionLabel = t.has(`cardAction_${card.action}`)
    ? t(`cardAction_${card.action}`)
    : t("cardAction_unavailable");

  return (
    <li
      className="rounded-lg border border-line bg-paper p-3"
      data-testid={`librarian-card-${card.status}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <strong className="text-[12.5px]">{actionLabel}</strong>
        <span className="font-mono text-[11px] text-mute">
          {t(`cardStatus_${card.status}`)}
        </span>
      </div>
      {!card.available ? (
        <p className="m-0 mt-1 text-[11px] text-mute">
          {t("linkedUnavailable")}
        </p>
      ) : card.action === "statement_accept" ? (
        <StatementDiff card={card} />
      ) : card.action === "memory_suggest" ? (
        <p className="m-0 mt-2 rounded-md border border-line bg-canvas p-2 text-[12px]">
          {typeof (card.payload.memory as { content?: unknown } | undefined)
            ?.content === "string"
            ? (card.payload.memory as { content: string }).content
            : t("linkedUnavailable")}
        </p>
      ) : (
        <div className="mt-2 space-y-1 text-[12px]">
          {card.target.runId ? (
            <Link className="underline" href={`/runs/${card.target.runId}`}>
              {t("openRun")}
            </Link>
          ) : null}
          {card.hitlPrompt ? (
            <p className="m-0 whitespace-pre-wrap">{card.hitlPrompt}</p>
          ) : null}
          {card.action === "hitl_respond" ? (
            <p className="m-0 whitespace-pre-wrap break-words rounded-md bg-canvas p-2">
              {t("cardProposedResponse", {
                response: JSON.stringify(card.payload.response),
              })}
            </p>
          ) : null}
          {card.action === "run_promote" ? (
            <p className="m-0 break-words">
              {t("cardPromoteDetails", {
                mode: t.has(`promotionMode_${String(card.payload.mode)}`)
                  ? t(`promotionMode_${String(card.payload.mode)}`)
                  : t("linkedUnavailable"),
                branch: card.runBranch ?? t("linkedUnavailable"),
                commit: String(card.payload.reviewedTargetCommit ?? ""),
              })}
            </p>
          ) : null}
          {card.action === "run_discard" ? (
            <p className="m-0 text-red-700">{t("cardDiscardWarning")}</p>
          ) : null}
        </div>
      )}
      {pending ? (
        <p className="m-0 mt-2 text-[11px] text-mute">
          {t("cardExpiresAt", {
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(card.expiresAt)),
          })}
        </p>
      ) : null}
      {pending && card.available ? (
        <div className="mt-2 flex gap-2">
          <button
            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold text-paper disabled:opacity-50 ${card.action === "run_discard" ? "bg-red-700" : "bg-ink"}`}
            disabled={busyCardId !== null}
            type="button"
            onClick={() => onDecide(card, "accept")}
          >
            {t(
              card.action === "run_discard"
                ? "cardConfirmDiscard"
                : "cardAccept",
            )}
          </button>
          <button
            className="rounded-md border border-line px-2.5 py-1 text-[11px] disabled:opacity-50"
            disabled={busyCardId !== null}
            type="button"
            onClick={() => onDecide(card, "reject")}
          >
            {t("cardReject")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function Receipt({
  operation,
}: {
  operation: LibrarianOperationView;
}): ReactElement {
  const t = useTranslations("librarian");
  const runStatusT = useTranslations("run.runStatus");
  const runId = operation.result?.runId;
  const outcome = operation.result?.outcome ?? operation.result?.status;
  const queuePosition = operation.result?.queuePosition;
  const clarificationSeq = operation.result?.seq;

  return (
    <li
      className="rounded-md border border-line px-2.5 py-2 text-[11px]"
      data-testid="librarian-operation-receipt"
    >
      <div className="flex flex-wrap justify-between gap-1">
        <span className="font-medium">
          {operation.kind === "clarification_request"
            ? t("clarificationRequested")
            : operation.kind === "clarification_cancel"
              ? t("clarificationCancelled")
              : t.has(`operationKind_${operation.kind}`)
                ? t(`operationKind_${operation.kind}`)
                : t("linkedUnavailable")}
        </span>
        <span className="font-mono text-mute">
          {t.has(`operationStatus_${operation.status}`)
            ? t(`operationStatus_${operation.status}`)
            : t("linkedUnavailable")}
        </span>
      </div>
      {!operation.available ? (
        <span className="text-mute">{t("linkedUnavailable")}</span>
      ) : (
        <div className="mt-1 flex flex-wrap gap-2 text-mute">
          {typeof runId === "string" ? (
            <Link href={`/runs/${runId}`}>{t("openRun")}</Link>
          ) : null}
          {operation.kind === "clarification_request" && operation.taskPath ? (
            <Link href={operation.taskPath}>
              {t("openClarificationTask", {
                sequence:
                  typeof clarificationSeq === "number" ? clarificationSeq : "?",
              })}
            </Link>
          ) : null}
          {operation.liveRunStatus ? (
            <span>
              {t("liveRunStatus", {
                status: runStatusT.has(operation.liveRunStatus)
                  ? runStatusT(operation.liveRunStatus)
                  : t("linkedUnavailable"),
              })}
            </span>
          ) : null}
          {typeof outcome === "string" ? (
            <span>
              {t.has(`operationOutcome_${outcome}`)
                ? t(`operationOutcome_${outcome}`)
                : runStatusT.has(outcome)
                  ? runStatusT(outcome)
                  : t("linkedUnavailable")}
            </span>
          ) : null}
          {typeof queuePosition === "number" ? (
            <span>{t("queuePosition", { position: queuePosition })}</span>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function LibrarianWork({
  cards,
  operations,
  tasks,
  busyCardId,
  onDecide,
}: Props): ReactElement | null {
  const t = useTranslations("librarian");
  const taskStatusT = useTranslations("taskDetail.status");
  const [showAllCards, setShowAllCards] = useState(false);
  const [showAllOperations, setShowAllOperations] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);

  if (cards.length === 0 && operations.length === 0 && tasks.length === 0)
    return null;

  return (
    <div
      className="max-h-[35dvh] overflow-y-auto border-t border-line bg-canvas px-4 py-3"
      data-testid="librarian-linked-work"
    >
      {cards.length > 0 ? (
        <section aria-label={t("needsAttention")}>
          <h3 className="m-0 mb-2 text-[12px] font-semibold">
            {t("needsAttention")}
          </h3>
          <ul className="m-0 list-none space-y-2 p-0">
            {(showAllCards ? cards : cards.slice(0, 10)).map((card) => (
              <Card
                key={card.id}
                busyCardId={busyCardId}
                card={card}
                onDecide={onDecide}
              />
            ))}
          </ul>
          {cards.length > 10 && !showAllCards ? (
            <button
              className="mt-2 text-xs underline"
              type="button"
              onClick={() => setShowAllCards(true)}
            >
              {t("showMore", { count: cards.length - 10 })}
            </button>
          ) : null}
        </section>
      ) : null}
      {operations.length > 0 ? (
        <section aria-label={t("operationReceipts")} className="mt-3">
          <h3 className="m-0 mb-2 text-[12px] font-semibold">
            {t("operationReceipts")}
          </h3>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {(showAllOperations ? operations : operations.slice(0, 10)).map(
              (operation) => (
                <Receipt key={operation.id} operation={operation} />
              ),
            )}
          </ul>
          {operations.length > 10 && !showAllOperations ? (
            <button
              className="mt-2 text-xs underline"
              type="button"
              onClick={() => setShowAllOperations(true)}
            >
              {t("showMore", { count: operations.length - 10 })}
            </button>
          ) : null}
        </section>
      ) : null}
      {tasks.length > 0 ? (
        <section aria-label={t("relatedWork")} className="mt-3">
          <h3 className="m-0 mb-2 text-[12px] font-semibold">
            {t("relatedWork")}
          </h3>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {(showAllTasks ? tasks : tasks.slice(0, 20)).map((task, index) => (
              <li key={`${task.taskId}-${index}`}>
                {task.available && task.projectSlug && task.number !== null ? (
                  <Link
                    className="inline-flex max-w-full gap-1 rounded-full border border-line bg-paper px-2 py-1 text-[11px]"
                    href={`/projects/${task.projectSlug}/tasks/${task.number}`}
                    title={task.title ?? undefined}
                  >
                    <span className="font-mono">
                      {task.projectSlug}-{task.number}
                    </span>
                    <span className="truncate text-mute">
                      {task.status && taskStatusT.has(task.status)
                        ? taskStatusT(task.status)
                        : t("linkedUnavailable")}
                    </span>
                    {task.fromMessageId === null &&
                    task.toMessageId === null ? (
                      <span
                        className="text-mute"
                        data-testid="librarian-source-unavailable"
                      >
                        {t("linkedSourceUnavailable")}
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  <span className="rounded-full border border-line px-2 py-1 text-[11px] text-mute">
                    {t("linkedUnavailable")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {tasks.length > 20 && !showAllTasks ? (
            <button
              className="mt-2 text-xs underline"
              type="button"
              onClick={() => setShowAllTasks(true)}
            >
              {t("showMore", { count: tasks.length - 20 })}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
