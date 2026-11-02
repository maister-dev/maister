"use client";

import type { ReactNode } from "react";
import type {
  TranscriptPage,
  TranscriptPageMessage,
} from "@/lib/runs/transcript-page";
import type {
  TranscriptMessage,
  TranscriptLabels,
} from "@/components/run-transcript/transcript-view";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import { TranscriptView } from "@/components/run-transcript/transcript-view";
import { useRunPageStream } from "@/components/runs/run-stream-provider";

class TranscriptReadFailure extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}
type WindowPage = { page: TranscriptPage; dirty: boolean };
type TranscriptHistory = {
  tail: TranscriptPage | null;
  older: WindowPage[];
  newerAvailable: boolean;
};
const pageKey = (page: TranscriptPage): string => page.window.before ?? "empty";

async function fetchTranscriptPage(
  runId: string,
  nodeId: string | null,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<TranscriptPage> {
  const params = new URLSearchParams(query);

  if (nodeId) params.set("node", nodeId);
  params.set("limit", "100");
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/transcript?${params}`,
    { signal },
  );

  if (!response.ok) {
    const body: { reason?: string } = await response.json();

    throw new TranscriptReadFailure(
      response.status,
      body.reason ?? "read_failed",
    );
  }

  return response.json() as Promise<TranscriptPage>;
}

function windowQuery(page: TranscriptPage): URLSearchParams | null {
  return page.window.before && page.window.after
    ? new URLSearchParams({
        windowBefore: page.window.before,
        windowAfter: page.window.after,
      })
    : null;
}

function TranscriptMessages({
  messages,
  labels,
  running,
}: {
  messages: TranscriptPageMessage[];
  labels: TranscriptLabels;
  running: boolean;
}): ReactNode {
  const t = useTranslations("runPeek");
  const blocks: (
    | { kind: "messages"; messages: TranscriptMessage[] }
    | {
        kind: "preview";
        message: Extract<TranscriptPageMessage, { kind: "bounded_preview" }>;
      }
  )[] = [];

  for (const message of messages) {
    if ("kind" in message) blocks.push({ kind: "preview", message });
    else {
      const previous = blocks.at(-1);

      if (previous?.kind === "messages") previous.messages.push(message);
      else blocks.push({ kind: "messages", messages: [message] });
    }
  }

  return blocks.map((block) =>
    block.kind === "messages" ? (
      <TranscriptView
        key={block.messages[0].id}
        labels={labels}
        messages={block.messages}
        running={running}
      />
    ) : (
      <article
        key={block.message.id}
        className="rounded border border-line p-2"
        data-testid="peek-bounded-preview"
      >
        <strong>{t("preview")}</strong>
        <p>{t("previewBytes", { bytes: block.message.originalBytes })}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
          {block.message.preview}
        </pre>
      </article>
    ),
  );
}

export function RunTranscriptHistory({
  runId,
  nodeId,
  live = true,
  labels: suppliedLabels,
}: {
  runId: string;
  nodeId: string | null;
  live?: boolean;
  labels?: TranscriptLabels;
}): ReactNode {
  const t = useTranslations("runPeek"),
    runT = useTranslations("run");
  const stream = useRunPageStream(runId, live);
  const [history, setHistory] = useState<TranscriptHistory>({
    tail: null,
    older: [],
    newerAvailable: false,
  });
  const { tail, older, newerAvailable } = history;
  const historyRef = useRef(history);
  const publishHistory = useCallback((next: TranscriptHistory): void => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const [error, setError] = useState<TranscriptReadFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [notice, setNotice] = useState<
    "attemptChanged" | "historyBound" | null
  >(null);
  const host = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pendingEarlier = useRef<AbortController | null>(null);
  const releaseEarlierRead = useCallback((): void => {
    pendingEarlier.current?.abort();
    pendingEarlier.current = null;
    setLoading(false);
  }, []);
  const readingHistory = useRef(false);
  const windowRevision = useRef(0);
  const previousAttempt = useRef<string | null | undefined>(undefined);
  const activeWindow = useRef<string | null>(null);
  const pendingScroll = useRef<{
    element: HTMLElement;
    scroller: HTMLElement;
    top: number;
  } | null>(null);
  const retainScroll = useCallback((): void => {
    const scroller = host.current?.closest<HTMLElement>(
      '[data-testid="run-peek-scroll"]',
    );

    if (!host.current) return;
    const scrollContainer = scroller ?? document.scrollingElement;

    if (!(scrollContainer instanceof HTMLElement)) return;
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const element = [
      ...host.current.querySelectorAll<HTMLElement>(
        "[data-window-key] > article, [data-window-key] > div > *",
      ),
    ].find((item) => item.getBoundingClientRect().bottom > top);

    if (element)
      pendingScroll.current = {
        element,
        scroller: scrollContainer,
        top: element.getBoundingClientRect().top,
      };
  }, []);
  const refreshRef = useRef<() => void>(() => {});
  const generation = useRef(0);
  const adoptFailure = useCallback(
    (failure: unknown): void => {
      const next =
        failure instanceof TranscriptReadFailure
          ? failure
          : new TranscriptReadFailure(503, "transport");

      setError(next);
      if (next.status === 403 || next.status === 404) {
        controller.current?.abort();
        releaseEarlierRead();
        generation.current++;
        windowRevision.current++;
        readingHistory.current = false;
        publishHistory({ tail: null, older: [], newerAvailable: false });
      }
    },
    [publishHistory, releaseEarlierRead],
  );

  useEffect(() => {
    const abort = new AbortController();

    controller.current = abort;
    const current = ++generation.current;
    let inflight = false,
      dirty = false;
    const valid = (): boolean =>
      !abort.signal.aborted && generation.current === current;

    async function refresh(): Promise<void> {
      if (inflight) {
        dirty = true;

        return;
      }
      inflight = true;
      const revision = windowRevision.current;

      try {
        const latest = await fetchTranscriptPage(
          runId,
          nodeId,
          new URLSearchParams(),
          abort.signal,
        );

        if (!valid()) return;
        if (revision !== windowRevision.current) {
          dirty = true;

          return;
        }
        const attemptChanged =
          previousAttempt.current !== undefined &&
          previousAttempt.current !== latest.attemptId;

        previousAttempt.current = latest.attemptId;
        if (attemptChanged) {
          windowRevision.current++;
          releaseEarlierRead();
          readingHistory.current = false;
          setNotice("attemptChanged");
          publishHistory({ tail: latest, older: [], newerAvailable: false });
          setError(null);

          return;
        }
        const cached = historyRef.current;
        const retainedQuery =
          readingHistory.current && cached.tail
            ? windowQuery(cached.tail)
            : null;
        const visible = cached.older.find(
          ({ page }) => pageKey(page) === activeWindow.current,
        );
        const visibleQuery = visible ? windowQuery(visible.page) : null;
        const [displayed, refreshed] = await Promise.all([
          retainedQuery
            ? fetchTranscriptPage(runId, nodeId, retainedQuery, abort.signal)
            : Promise.resolve(latest),
          visibleQuery
            ? fetchTranscriptPage(runId, nodeId, visibleQuery, abort.signal)
            : Promise.resolve(null),
        ]);

        if (!valid()) return;
        if (revision !== windowRevision.current) {
          dirty = true;

          return;
        }
        if (readingHistory.current) retainScroll();
        publishHistory({
          tail: {
            ...displayed,
            usage: latest.usage,
            projection: latest.projection,
          },
          older: cached.older.map((item) =>
            refreshed && visible && pageKey(item.page) === pageKey(visible.page)
              ? { page: refreshed, dirty: false }
              : { ...item, dirty: true },
          ),
          newerAvailable: latest.window.after !== displayed.window.after,
        });
        setError(null);
      } catch (failure) {
        if (!valid()) return;
        if (revision !== windowRevision.current) {
          dirty = true;

          return;
        }
        if (
          failure instanceof TranscriptReadFailure &&
          failure.reason === "transcript_attempt_changed"
        ) {
          windowRevision.current++;
          releaseEarlierRead();
          readingHistory.current = false;
          publishHistory({ tail: null, older: [], newerAvailable: false });
          setNotice("attemptChanged");
          dirty = true;
        } else adoptFailure(failure);
      } finally {
        inflight = false;
        if (dirty && valid()) {
          dirty = false;
          void refresh();
        }
      }
    }
    refreshRef.current = () => {
      void refresh();
    };
    void refresh();

    return () => {
      abort.abort();
      controller.current = null;
    };
  }, [
    runId,
    nodeId,
    adoptFailure,
    publishHistory,
    releaseEarlierRead,
    retainScroll,
    retryKey,
  ]);
  useEffect(() => {
    if (stream.eventCount > 0) refreshRef.current();
  }, [stream.eventCount]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        const key = visible?.target.getAttribute("data-window-key");

        if (!key || key === activeWindow.current) return;
        activeWindow.current = key;
        if (
          historyRef.current.older.some(
            (item) => pageKey(item.page) === key && item.dirty,
          )
        )
          refreshRef.current();
      },
      {
        root: host.current.closest('[data-testid="run-peek-scroll"]'),
        threshold: 0,
      },
    );

    for (const element of host.current.querySelectorAll("[data-window-key]"))
      observer.observe(element);

    return () => observer.disconnect();
  }, [older.map((item) => pageKey(item.page)).join("|"), tail?.window.before]);
  useLayoutEffect(() => {
    const saved = pendingScroll.current;

    if (saved?.element.isConnected && saved.scroller.isConnected)
      saved.scroller.scrollTop +=
        saved.element.getBoundingClientRect().top - saved.top;
    pendingScroll.current = null;
  }, [history]);
  const earlier = async (): Promise<void> => {
    const cached = historyRef.current;
    const first = cached.older[0]?.page ?? cached.tail;
    const parentSignal = controller.current?.signal;

    if (
      !first?.beforeCursor ||
      !parentSignal ||
      parentSignal.aborted ||
      pendingEarlier.current
    )
      return;
    const owned = new AbortController();
    const abortEarlier = (): void => owned.abort();

    parentSignal.addEventListener("abort", abortEarlier, { once: true });
    const signal = owned.signal;
    const revision = ++windowRevision.current;

    pendingEarlier.current = owned;
    readingHistory.current = true;
    setLoading(true);
    try {
      const page = await fetchTranscriptPage(
        runId,
        nodeId,
        new URLSearchParams({ before: first.beforeCursor }),
        signal,
      );

      if (
        signal.aborted ||
        revision !== windowRevision.current ||
        page.attemptId !== previousAttempt.current
      )
        return;
      retainScroll();
      const current = historyRef.current;
      const pages = [
        { page, dirty: false },
        ...current.older,
        ...(current.tail ? [{ page: current.tail, dirty: false }] : []),
      ];
      const retained = pages.slice(0, 5);
      const unloaded = pages.length > retained.length;

      windowRevision.current++;
      if (unloaded) setNotice("historyBound");
      publishHistory({
        tail: retained.at(-1)!.page,
        older: retained.slice(0, -1),
        newerAvailable: current.newerAvailable || unloaded,
      });
    } catch (failure) {
      if (!signal.aborted && revision === windowRevision.current) {
        if (
          failure instanceof TranscriptReadFailure &&
          failure.reason === "transcript_attempt_changed"
        ) {
          setNotice("attemptChanged");
          refreshRef.current();
        } else adoptFailure(failure);
      }
    } finally {
      parentSignal.removeEventListener("abort", abortEarlier);
      if (pendingEarlier.current === owned) {
        pendingEarlier.current = null;
        setLoading(false);
      }
    }
  };
  const labels: TranscriptLabels = suppliedLabels ?? {
    thinking: runT("chatThinking"),
    rawEvent: runT("chatRawEvent"),
    input: runT("chatToolInput"),
    result: runT("chatToolResult"),
    copy: runT("chatCopy"),
    copied: runT("chatCopied"),
    toolCount: (name, count) => runT("chatToolCount", { name, count }),
  };
  const seen = new Set<string>();
  const pages = [...older.map((item) => item.page), ...(tail ? [tail] : [])];
  const messagesById = new Map(
    pages.flatMap((page) =>
      page.messages.map((message) => [message.id, message] as const),
    ),
  );
  const windows = pages.map((page) => ({
    ...page,
    messages: page.messages
      .filter((message) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);

        return true;
      })
      .map((message) => messagesById.get(message.id)!),
  }));

  return (
    <div
      ref={host}
      className="min-w-0 space-y-3"
      data-testid="run-transcript-history"
    >
      {error ? (
        <p role="status">
          {t(
            error.reason === "transcript_projection_poisoned"
              ? "projectionPoisoned"
              : error.status === 403
                ? "forbidden"
                : error.status === 404
                  ? "unavailable"
                  : "error",
          )}{" "}
          <button
            type="button"
            onClick={() => setRetryKey((value) => value + 1)}
          >
            {t("retry")}
          </button>
        </p>
      ) : null}
      {notice ? <p role="status">{t(notice)}</p> : null}
      {!tail && !error ? <p role="status">{t("loadingTranscript")}</p> : null}
      {(older[0]?.page ?? tail)?.hasEarlier ? (
        <button disabled={loading} type="button" onClick={() => void earlier()}>
          {t("earlierMessages")}
        </button>
      ) : null}
      {newerAvailable ? <p role="status">{t("newerMessages")}</p> : null}
      {older.length || newerAvailable ? (
        <button
          type="button"
          onClick={() => {
            windowRevision.current++;
            releaseEarlierRead();
            readingHistory.current = false;
            publishHistory({
              ...historyRef.current,
              older: [],
              newerAvailable: false,
            });
            setNotice(null);
            refreshRef.current();
          }}
        >
          {t("latestMessages")}
        </button>
      ) : null}
      {tail?.projection.state === "pending" ? (
        <p role="status">{t("projectionPending")}</p>
      ) : null}
      {tail?.usage ? (
        <p>
          {t("usage")}: {tail.usage.used} / {tail.usage.size}
        </p>
      ) : null}
      {tail?.projection.state === "caught_up" &&
      windows.every((page) => page.messages.length === 0) ? (
        <p>{t("emptyTranscript")}</p>
      ) : null}
      {windows.map((page) => (
        <div key={pageKey(page)} data-window-key={pageKey(page)}>
          <TranscriptMessages
            labels={labels}
            messages={page.messages}
            running={live && stream.liveness === "live"}
          />
        </div>
      ))}
    </div>
  );
}
