"use client";

import type { ReactElement } from "react";
import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";
import type { LibrarianPanelMode } from "@/components/librarian/panel-mode";
import type { LibrarianSubject } from "@/lib/librarian/types";
import type { LibrarianCardView } from "@/lib/librarian/read-models";
import type {
  LibrarianConversationView,
  LibrarianMessageDto,
} from "@/lib/librarian/view";

import {
  ArrowDownIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLibrarian } from "@/components/librarian/librarian-provider";
import { LibrarianWork } from "@/components/librarian/librarian-work";
import { librarianPanelMode } from "@/components/librarian/panel-mode";
import { TranscriptView } from "@/components/run-transcript/transcript-view";
import { useModalA11y } from "@/components/use-modal-a11y";
import { useRunStream } from "@/lib/use-run-stream";

const STICK_THRESHOLD_PX = 32;
const PAGE_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SendBlock = "disabled" | "no_runner" | "resetting" | "empty" | "sending";

type RefusalBody = { code?: string; details?: { reason?: string } } | null;

export function draftStorageKey(ownerId: string): string {
  return `maister.librarian.draft.${ownerId}`;
}

function readDraft(ownerId: string): string {
  try {
    return window.localStorage.getItem(draftStorageKey(ownerId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(ownerId: string, draft: string): void {
  try {
    if (draft) window.localStorage.setItem(draftStorageKey(ownerId), draft);
    else window.localStorage.removeItem(draftStorageKey(ownerId));
  } catch {
    // Storage may be blocked; the draft then lives only in memory.
  }
}

/** The page the owner may attach explicitly — a run or a project by the id
 * or slug in the URL, never the page's history (ADR-189 D6). */
export function attachableSubject(pathname: string): LibrarianSubject | null {
  const run = /^\/runs\/([^/]+)/.exec(pathname);

  if (run && UUID.test(run[1])) return { runId: run[1] };
  const project = /^\/projects\/([^/]+)/.exec(pathname);

  if (project && project[1] !== "new") return { projectSlug: project[1] };

  return null;
}

export function refusalKey(body: RefusalBody): string {
  const reason = body?.details?.reason;

  switch (body?.code) {
    case "CONFIG":
      return reason === "librarian_disabled" ? "errorDisabled" : "errorSend";
    case "EXECUTOR_UNAVAILABLE":
      return "errorNoRunner";
    case "BUDGET_EXCEEDED":
      return "errorBudget";
    case "CONFLICT":
      return reason === "reset_in_progress" ? "errorResetting" : "errorSend";
    case "PRECONDITION":
      return reason === "not_found" ? "errorSubjectNotFound" : "errorSend";
    default:
      return "errorSend";
  }
}

function sendBlockOf(
  view: LibrarianConversationView | null,
  draft: string,
  sending: boolean,
): SendBlock | null {
  if (view?.availability.state === "disabled") return "disabled";
  if (view && view.availability.state !== "ready") return "no_runner";
  if (view && view.conversation.resetState !== "idle") return "resetting";
  if (sending) return "sending";
  if (!draft.trim()) return "empty";

  return null;
}

function systemText(
  t: ReturnType<typeof useTranslations>,
  body: string | null,
): string {
  if (body === "turn_stopped") return t("systemTurnStopped");
  if (body?.startsWith("turn_failed:")) {
    const reason = body.slice("turn_failed:".length);

    return t.has(`systemTurnFailed_${reason}`)
      ? t(`systemTurnFailed_${reason}`)
      : t("systemTurnFailed");
  }

  return body ?? "";
}

function mergeMessages(
  current: LibrarianMessageDto[],
  incoming: LibrarianMessageDto[],
): LibrarianMessageDto[] {
  const byId = new Map(current.map((message) => [message.id, message]));

  for (const message of incoming) byId.set(message.id, message);

  return [...byId.values()].sort((a, b) =>
    BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
  );
}

export function LibrarianPanel(): ReactElement | null {
  const librarian = useLibrarian();

  return librarian ? <LibrarianPanelBody /> : null;
}

function LibrarianPanelBody(): ReactElement {
  const librarian = useLibrarian()!;
  const t = useTranslations("librarian");
  const pathname = usePathname() ?? "/";
  const {
    open,
    ownerId,
    changeTick,
    hostComposerVisible,
    closePanel,
    takeOpener,
    setIndicator,
  } = librarian;
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const savedScrollRef = useRef<number | null>(null);
  const pendingClientIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<LibrarianConversationView | null>(null);
  const [messages, setMessages] = useState<LibrarianMessageDto[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [subject, setSubject] = useState<LibrarianSubject | null>(null);
  const [sending, setSending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);

  const mode: LibrarianPanelMode =
    viewportWidth === null
      ? "docked"
      : librarianPanelMode({ viewportWidth, pathname, hostComposerVisible });
  const modal = mode !== "docked" || expanded;

  useEffect(() => {
    const measure = () => setViewportWidth(window.innerWidth);

    measure();
    window.addEventListener("resize", measure);

    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    setDraft(readDraft(ownerId));
    setDraftLoaded(true);
  }, [ownerId]);

  useEffect(() => {
    if (draftLoaded) writeDraft(ownerId, draft);
  }, [ownerId, draft, draftLoaded]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [conversationRes, messagesRes] = await Promise.all([
        fetch("/api/librarian/conversation", { cache: "no-store" }),
        fetch(`/api/librarian/messages?limit=${PAGE_LIMIT}`, {
          cache: "no-store",
        }),
      ]);

      if (!conversationRes.ok || !messagesRes.ok) {
        setLoadFailed(true);

        return;
      }
      const nextView =
        (await conversationRes.json()) as LibrarianConversationView;
      const page = (await messagesRes.json()) as {
        messages: LibrarianMessageDto[];
      };

      setView(nextView);
      setIndicator(nextView.indicator.state);
      setMessages((current) => mergeMessages(current, page.messages));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [setIndicator]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, changeTick, refresh]);

  const transcript = useMemo<TranscriptMessage[]>(
    () =>
      messages
        .filter(
          (message) =>
            message.deliveryState !== "queued" &&
            message.deliveryState !== "withdrawn" &&
            message.deliveryState !== "withdrawn_by_reset",
        )
        .map((message) => ({
          id: message.id,
          role:
            message.authorKind === "owner"
              ? "user"
              : message.authorKind === "system"
                ? "system"
                : "assistant",
          content: message.masked
            ? t("messageUnavailable")
            : message.authorKind === "system"
              ? systemText(t, message.body)
              : (message.body ?? ""),
          createdAt: message.createdAt,
        })),
    [messages, t],
  );
  const lastMessageId = transcript[transcript.length - 1]?.id ?? null;

  // LUI-06: a reader who scrolled up stays where they are; the list follows
  // only a reader already at the bottom.
  useEffect(() => {
    const list = listRef.current;

    if (!list || !lastMessageId) return;
    if (stickRef.current) {
      list.scrollTop = list.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [lastMessageId]);

  function onListScroll(): void {
    const list = listRef.current;

    if (!list) return;
    savedScrollRef.current = list.scrollTop;
    stickRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <
      STICK_THRESHOLD_PX;
    if (stickRef.current) setShowJump(false);
  }

  function jumpToLatest(): void {
    const list = listRef.current;

    if (!list) return;
    list.scrollTop = list.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  }

  // The read cursor follows what the owner has actually been shown.
  const lastSeq = view?.conversation.lastSeq ?? null;
  const readThrough = view?.conversation.readThroughSeq ?? null;

  useEffect(() => {
    if (!open || lastSeq === null || readThrough === null) return;
    if (BigInt(lastSeq) <= BigInt(readThrough) || !stickRef.current) return;
    void fetch("/api/librarian/read-cursor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: lastSeq }),
    }).catch(() => undefined);
  }, [open, lastSeq, readThrough, showJump]);

  useModalA11y(panelRef, closePanel, open && modal);

  // LUI-05: opening focuses the composer (after the modal hook's own initial
  // focus); closing returns focus to whatever opened the panel.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      composerRef.current?.focus();
      const list = listRef.current;

      if (list && savedScrollRef.current !== null)
        list.scrollTop = savedScrollRef.current;

      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      takeOpener()?.focus();
    }
  }, [open, modal, takeOpener]);

  const activeTurn = view?.activeTurn ?? null;
  const responding = open && activeTurn?.status === "running";
  // ADR-189 D8: the run stream ticks while the turn runs; the durable reply
  // arrives as a `librarian.message` frame and replaces the live line.
  const { eventCount } = useRunStream(
    responding ? (view?.conversation.runId ?? null) : null,
    { retain: false },
  );

  const sendBlock = sendBlockOf(view, draft, sending);
  const attachable = attachableSubject(pathname);

  async function send(): Promise<void> {
    if (sendBlock) return;
    const body = draft.trim();

    pendingClientIdRef.current ??= crypto.randomUUID();
    setSending(true);
    setErrorKey(null);
    try {
      const response = await fetch("/api/librarian/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId: pendingClientIdRef.current,
          body,
          ...(subject ? { subject } : {}),
        }),
      });

      if (!response.ok) {
        setErrorKey(
          refusalKey((await response.json().catch(() => null)) as RefusalBody),
        );

        return;
      }
      pendingClientIdRef.current = null;
      setDraft("");
      stickRef.current = true;
      await refresh();
    } catch {
      setErrorKey("errorSend");
    } finally {
      setSending(false);
    }
  }

  async function stopResponse(): Promise<void> {
    setErrorKey(null);
    const response = await fetch("/api/librarian/turns/current/stop", {
      method: "POST",
    }).catch(() => null);

    if (!response || !response.ok) setErrorKey("errorStop");
    await refresh();
  }

  async function withdraw(messageId: string): Promise<void> {
    setErrorKey(null);
    const response = await fetch(
      `/api/librarian/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    ).catch(() => null);

    if (!response || !response.ok) setErrorKey("errorWithdraw");
    await refresh();
  }

  async function decideCard(
    card: LibrarianCardView,
    decision: "accept" | "reject",
  ): Promise<void> {
    setBusyCardId(card.id);
    setErrorKey(null);

    try {
      const response = await fetch(
        `/api/librarian/cards/${encodeURIComponent(card.id)}/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(card.action === "statement_accept" &&
            card.targetRevision !== null
              ? { expectedRevision: Number(card.targetRevision) }
              : {}),
          }),
        },
      );

      if (!response.ok) setErrorKey("errorCardDecision");
      await refresh();
    } catch {
      setErrorKey("errorCardDecision");
    } finally {
      setBusyCardId(null);
    }
  }

  const availability = view?.availability.state ?? null;
  const panelClass = clsx(
    "flex-col border-line bg-paper text-ink",
    open ? "flex" : "hidden",
    mode === "fullscreen" && "fixed inset-0 z-[60] h-[100dvh] w-full",
    mode !== "fullscreen" &&
      modal &&
      clsx(
        "fixed inset-y-0 right-0 z-[60] h-[100dvh] border-l shadow-2xl",
        expanded
          ? "w-[min(960px,calc(100vw-32px))]"
          : "w-[min(480px,calc(100vw-64px))]",
      ),
    !modal &&
      "sticky top-[57px] h-[calc(100dvh-57px-36px)] w-[clamp(360px,28vw,440px)] self-start border-l",
  );

  return (
    <>
      {open && modal ? (
        <div
          aria-hidden
          className="fixed inset-0 z-[55] bg-black/30"
          data-testid="librarian-backdrop"
          onClick={closePanel}
        />
      ) : null}
      <div
        ref={panelRef}
        aria-label={t("panelLabel")}
        aria-modal={modal ? true : undefined}
        className={panelClass}
        data-mode={expanded && mode !== "fullscreen" ? "expanded" : mode}
        data-testid="librarian-panel"
        id="librarian-panel"
        role={modal ? "dialog" : "complementary"}
        onKeyDown={(event) => {
          // Docked Escape lives on the panel root, never on `window`, so an
          // Escape meant for another dialog cannot collapse the librarian.
          if (!modal && event.key === "Escape") {
            event.stopPropagation();
            closePanel();
          }
        }}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="m-0 mr-auto text-[14px] font-semibold">
            {t("title")}
          </h2>
          {mode === "fullscreen" ? null : (
            <button
              aria-label={expanded ? t("collapseReading") : t("expandReading")}
              aria-pressed={expanded}
              className="rounded-md p-1.5 text-mute hover:text-ink"
              data-testid="librarian-expand"
              title={expanded ? t("collapseReading") : t("expandReading")}
              type="button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <ArrowsPointingInIcon aria-hidden className="h-4 w-4" />
              ) : (
                <ArrowsPointingOutIcon aria-hidden className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            aria-label={t("close")}
            className="rounded-md p-1.5 text-mute hover:text-ink"
            data-testid="librarian-close"
            title={t("close")}
            type="button"
            onClick={closePanel}
          >
            <XMarkIcon aria-hidden className="h-4 w-4" />
          </button>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
            <span
              className="inline-flex min-w-0 items-center gap-1 truncate rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-mute"
              data-testid="librarian-subject"
            >
              {t("subjectLabel")}:{" "}
              <b className="truncate font-semibold text-ink">
                {subject?.runId
                  ? t("subjectRun")
                  : subject?.projectSlug
                    ? t("subjectProject", { slug: subject.projectSlug })
                    : t("subjectGeneral")}
              </b>
              {subject ? (
                <button
                  aria-label={t("subjectClear")}
                  className="ml-1 text-mute hover:text-ink"
                  title={t("subjectClear")}
                  type="button"
                  onClick={() => setSubject(null)}
                >
                  <XMarkIcon aria-hidden className="h-3 w-3" />
                </button>
              ) : null}
            </span>
            {attachable && !subject ? (
              <button
                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-mute hover:text-ink"
                data-testid="librarian-attach-page"
                type="button"
                onClick={() => setSubject(attachable)}
              >
                <PaperClipIcon aria-hidden className="h-3 w-3" />
                {t("attachPage")}
              </button>
            ) : null}
          </div>
        </header>

        {availability && availability !== "ready" ? (
          <p
            className="m-0 border-b border-line bg-amber-soft px-4 py-2 text-[12px] leading-[1.45] text-amber"
            data-testid="librarian-availability"
            role="status"
          >
            {t(`availability_${availability}`)}
          </p>
        ) : null}
        {loadFailed ? (
          <p className="m-0 px-4 py-2 text-[12px] text-red-700" role="alert">
            {t("errorLoad")}
          </p>
        ) : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={listRef}
            aria-label={t("transcriptLabel")}
            aria-live="polite"
            className="h-full overflow-y-auto px-4 py-3"
            data-testid="librarian-transcript"
            role="log"
            onScroll={onListScroll}
          >
            {transcript.length === 0 ? (
              <p className="m-0 text-[12.5px] text-mute">{t("empty")}</p>
            ) : (
              <TranscriptView
                assistantLabel={t("title")}
                labels={{
                  thinking: t("transcriptThinking"),
                  rawEvent: t("transcriptRawEvent"),
                  input: t("transcriptInput"),
                  result: t("transcriptResult"),
                  copy: t("transcriptCopy"),
                  copied: t("transcriptCopied"),
                  toolCount: (name, count) => `${name} · ${count}`,
                }}
                messages={transcript}
                running={responding}
                userLabel={t("you")}
              />
            )}
            {responding ? (
              <p
                className="m-0 mt-2 font-mono text-[11px] text-mute"
                data-events={eventCount}
                data-testid="librarian-responding"
                role="status"
              >
                {t("responding")}
              </p>
            ) : activeTurn?.status === "admitted" ? (
              <p
                className="m-0 mt-2 font-mono text-[11px] text-mute"
                data-testid="librarian-waiting"
                role="status"
              >
                {activeTurn.queuePosition
                  ? t("waitingForSlot", { position: activeTurn.queuePosition })
                  : t("starting")}
              </p>
            ) : null}
          </div>
          {showJump ? (
            <button
              className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-ivory px-3 py-1.5 text-[12px] text-ink shadow"
              data-testid="librarian-jump-latest"
              type="button"
              onClick={jumpToLatest}
            >
              <ArrowDownIcon aria-hidden className="h-3.5 w-3.5" />
              {t("jumpToLatest")}
            </button>
          ) : null}
        </div>

        {view ? (
          <LibrarianWork
            busyCardId={busyCardId}
            cards={view.cards}
            operations={view.operationReceipts}
            tasks={view.relatedWork}
            onDecide={(card, decision) => void decideCard(card, decision)}
          />
        ) : null}

        {view && view.queuedMessages.length > 0 ? (
          <ul
            aria-label={t("queuedLabel")}
            className="m-0 flex list-none flex-wrap gap-2 border-t border-line px-4 py-2"
            data-testid="librarian-queued"
          >
            {view.queuedMessages.map((message) => (
              <li
                key={message.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px]"
              >
                <span className="truncate">{message.body}</span>
                <button
                  aria-label={t("withdraw")}
                  className="inline-flex shrink-0 items-center gap-0.5 text-mute hover:text-ink"
                  title={t("withdraw")}
                  type="button"
                  onClick={() => void withdraw(message.id)}
                >
                  <XMarkIcon aria-hidden className="h-3.5 w-3.5" />
                  <span className="text-[11px]">{t("withdraw")}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <form
          className="sticky bottom-0 border-t border-line bg-paper px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={composerRef}
            aria-describedby={sendBlock ? "librarian-send-reason" : undefined}
            aria-label={t("composerLabel")}
            className="block max-h-40 min-h-[64px] w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink"
            data-testid="librarian-composer"
            placeholder={t("composerPlaceholder")}
            value={draft}
            onChange={(event) => {
              pendingClientIdRef.current = null;
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              aria-describedby={sendBlock ? "librarian-send-reason" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-paper disabled:opacity-50"
              data-testid="librarian-send"
              disabled={sendBlock !== null}
              type="submit"
            >
              <PaperAirplaneIcon aria-hidden className="h-4 w-4" />
              {t("send")}
            </button>
            <button
              aria-describedby={
                activeTurn ? undefined : "librarian-stop-reason"
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink disabled:opacity-50"
              data-testid="librarian-stop-response"
              disabled={!activeTurn}
              type="button"
              onClick={() => void stopResponse()}
            >
              <StopIcon aria-hidden className="h-4 w-4" />
              {t("stopResponse")}
            </button>
          </div>
          {sendBlock ? (
            <p
              className="m-0 mt-1.5 text-[11.5px] leading-[1.4] text-mute"
              data-testid="librarian-send-reason"
              id="librarian-send-reason"
            >
              {t(`sendBlocked_${sendBlock}`)}
            </p>
          ) : null}
          {activeTurn ? null : (
            <p className="sr-only" id="librarian-stop-reason">
              {t("stopBlocked")}
            </p>
          )}
          {errorKey ? (
            <p
              className="m-0 mt-1.5 text-[12px] leading-[1.45] text-red-700"
              data-testid="librarian-error"
              role="alert"
            >
              {t(errorKey)}
            </p>
          ) : null}
        </form>
      </div>
    </>
  );
}
