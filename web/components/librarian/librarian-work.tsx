"use client";

import type { ReactElement } from "react";
import type { LibrarianCardView } from "@/lib/librarian/read-models";
import type {
  HistoryCollection,
  HistoryItem,
  ActionHistoryPage,
  WorkAttention,
} from "@/lib/librarian/action-history";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

type CardActions = {
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
}: CardActions & {
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

export function LibrarianReceipt({
  item,
}: {
  item: HistoryItem;
}): ReactElement {
  const t = useTranslations("librarian");
  const operationKey = `operationKind_${item.kind}`;
  const cardKey = `cardAction_${item.kind}`;
  const relationKey = `history.kind.${item.kind}`;
  const statusKey = `operationStatus_${item.outcome}`;
  const cardStatusKey = `cardStatus_${item.outcome}`;

  return (
    <li
      className="min-w-0 rounded-md border border-line px-2 py-1.5 text-xs"
      data-testid="librarian-operation-receipt"
    >
      <div className="flex flex-wrap justify-between gap-x-2">
        <span className="font-semibold">
          {t.has(operationKey)
            ? t(operationKey)
            : t.has(cardKey)
              ? t(cardKey)
              : t.has(relationKey)
                ? t(relationKey)
                : t("history.unsupported")}
        </span>
        <span className="text-mute">
          {t.has(statusKey)
            ? t(statusKey)
            : t.has(cardStatusKey)
              ? t(cardStatusKey)
              : t("history.linked")}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-2 text-mute">
        {item.targets.map((target, index) => (
          <li key={index} className="min-w-0 break-words">
            {target.state === "visible" ? (
              <Link className="underline" href={target.href}>
                {target.label}
                {target.title ? ` · ${target.title}` : ""}
              </Link>
            ) : (
              t("linkedUnavailable")
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function LibrarianWork({
  currentWork,
  attention,
  generation,
  changeTick,
  busyCardId,
  onDecide,
}: CardActions & {
  currentWork: HistoryItem[];
  attention: WorkAttention;
  generation: number;
  changeTick: number;
}): ReactElement {
  const t = useTranslations("librarian.history");
  const [collection, setCollection] = useState<HistoryCollection | null>(null);
  const [page, setPage] = useState<ActionHistoryPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const activeRead = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!collection) return;
    const request = new AbortController();

    activeRead.current = request;
    void fetch(`/api/librarian/history/actions?collection=${collection}`, {
      signal: request.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Action history read failed");
        const result = (await response.json()) as ActionHistoryPage;

        if (request.signal.aborted) return;
        if (result.historyGeneration === generation) {
          setPage(result);
          setFailed(false);
        } else setFailed(true);
        setLoadingMore(false);
      })
      .catch(() => {
        if (!request.signal.aborted) {
          setFailed(true);
          setLoadingMore(false);
        }
      });

    return () => {
      request.abort();
      activeRead.current?.abort();
    };
  }, [collection, generation, changeTick]);

  useEffect(() => {
    if (collection) panel.current?.focus();
  }, [collection]);

  function select(next: HistoryCollection): void {
    activeRead.current?.abort();
    setPage(null);
    setFailed(false);
    setLoadingMore(false);
    setCollection(next);
  }

  function close(): void {
    activeRead.current?.abort();
    setCollection(null);
    setPage(null);
    opener.current?.focus();
  }

  async function more(): Promise<void> {
    if (!collection || !page?.nextCursor || loadingMore) return;
    const request = new AbortController();
    const previous = page;
    const cursor = page.nextCursor;

    activeRead.current?.abort();
    activeRead.current = request;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/librarian/history/actions?collection=${collection}&cursor=${encodeURIComponent(cursor)}`,
        { signal: request.signal, cache: "no-store" },
      );

      if (!response.ok) throw new Error("Action history page read failed");
      const next = (await response.json()) as ActionHistoryPage;

      if (request.signal.aborted) return;
      if (next.historyGeneration !== generation) {
        setPage(null);
        setFailed(true);

        return;
      }
      setPage({ ...next, items: [...previous.items, ...next.items] });
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (!request.signal.aborted) setLoadingMore(false);
    }
  }

  const rows =
    page?.historyGeneration === generation
      ? page.items
      : collection === "attention"
        ? attention.items
        : [];

  return (
    <div
      className="relative shrink-0 border-t border-line px-4 py-1.5"
      data-testid="librarian-linked-work"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button
          aria-expanded={collection === "actions" || collection === "tasks"}
          className="font-semibold underline"
          type="button"
          onClick={(event) => {
            opener.current = event.currentTarget;
            select("actions");
          }}
        >
          {t("title")}
        </button>
        {attention.count > 0 ? (
          <button
            aria-expanded={collection === "attention"}
            className="font-semibold text-amber underline"
            type="button"
            onClick={(event) => {
              opener.current = event.currentTarget;
              select("attention");
            }}
          >
            {t("attention", { count: attention.count })}
          </button>
        ) : null}
        {currentWork.length > 0 ? (
          <details className="min-w-0">
            <summary className="cursor-pointer">
              {t("currentTasks", { count: currentWork.length })}
            </summary>
            <ul className="absolute inset-x-3 bottom-full z-10 max-h-[30dvh] space-y-1 overflow-auto rounded border border-line bg-paper p-2 shadow-lg">
              {currentWork.map((item) => (
                <LibrarianReceipt key={item.id} item={item} />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {collection ? (
        // Escape dismisses this dialog before the surrounding Librarian panel.
        // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions
        <section
          ref={panel}
          aria-label={t(
            collection === "attention" ? "attentionTab" : collection,
          )}
          className="absolute inset-x-2 bottom-full z-20 flex max-h-[min(55dvh,440px)] min-w-0 flex-col rounded-lg border border-line bg-paper shadow-xl"
          data-testid="librarian-action-history"
          role="dialog"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-line p-2">
            <nav aria-label={t("title")} className="flex gap-2 text-xs">
              {(["actions", "tasks", "attention"] as const).map((option) => (
                <button
                  key={option}
                  aria-pressed={collection === option}
                  className="rounded border border-line px-1.5 py-1"
                  type="button"
                  onClick={() => option !== collection && select(option)}
                >
                  {option === "attention" ? t("attentionTab") : t(option)}
                </button>
              ))}
            </nav>
            <button
              className="px-1 text-xs underline"
              type="button"
              onClick={close}
            >
              {t("close")}
            </button>
          </div>
          <div
            className="min-h-0 overflow-y-auto overscroll-contain p-2"
            // Keep an independent keyboard scroll target for receipts without links.
            // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
            tabIndex={0}
          >
            {failed ? (
              <p className="text-xs text-danger" role="alert">
                {t("unavailable")}
              </p>
            ) : null}
            {rows.length > 0 ? (
              <ul className="grid gap-1">
                {rows.map((item) =>
                  item.confirmation ? (
                    <Card
                      key={`${item.sourceKind}:${item.id}`}
                      busyCardId={busyCardId}
                      card={item.confirmation}
                      onDecide={onDecide}
                    />
                  ) : (
                    <LibrarianReceipt
                      key={`${item.sourceKind}:${item.id}`}
                      item={item}
                    />
                  ),
                )}
              </ul>
            ) : (
              <p className="text-xs text-mute">
                {page ? t("empty") : failed ? null : t("loading")}
              </p>
            )}
            {page?.nextCursor ? (
              <button
                className="mt-2 text-xs underline"
                disabled={loadingMore}
                type="button"
                onClick={() => void more()}
              >
                {t("more")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
