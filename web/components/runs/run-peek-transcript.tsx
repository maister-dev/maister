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

export function RunPeekTranscript({
  runId,
  nodeId,
}: {
  runId: string;
  nodeId: string | null;
}): ReactNode {
  const t = useTranslations("runPeek"),
    runT = useTranslations("run");
  const stream = useRunPageStream(runId, true);
  const [tail, setTail] = useState<TranscriptPage | null>(null);
  const [older, setOlder] = useState<WindowPage[]>([]);
  const [error, setError] = useState<TranscriptReadFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [notice, setNotice] = useState<
    "attemptChanged" | "historyBound" | null
  >(null);
  const host = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const currentOlder = useRef(older);
  const previousAttempt = useRef<string | null | undefined>(undefined);
  const activeWindow = useRef<string | null>(null);
  const pendingScroll = useRef<{ top: number; height: number } | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const generation = useRef(0);

  useEffect(() => {
    currentOlder.current = older;
  }, [older]);
  const adoptFailure = useCallback((failure: unknown): void => {
    const next =
      failure instanceof TranscriptReadFailure
        ? failure
        : new TranscriptReadFailure(503, "transport");

    setError(next);
    if (next.status === 403 || next.status === 404) {
      controller.current?.abort();
      generation.current++;
      setTail(null);
      setOlder([]);
    }
  }, []);

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
      try {
        const latest = await fetchTranscriptPage(
          runId,
          nodeId,
          new URLSearchParams(),
          abort.signal,
        );

        if (!valid()) return;
        if (
          previousAttempt.current !== undefined &&
          previousAttempt.current !== latest.attemptId
        ) {
          setOlder([]);
          setNotice("attemptChanged");
        }
        previousAttempt.current = latest.attemptId;
        setTail(latest);
        setError(null);
        const visible = currentOlder.current.find(
          ({ page }) => pageKey(page) === activeWindow.current,
        );

        if (visible?.page.window.before && visible.page.window.after) {
          const query = new URLSearchParams({
            windowBefore: visible.page.window.before,
            windowAfter: visible.page.window.after,
          });
          const refreshed = await fetchTranscriptPage(
            runId,
            nodeId,
            query,
            abort.signal,
          );

          if (valid())
            setOlder((pages) =>
              pages.map((item) =>
                pageKey(item.page) === pageKey(visible.page)
                  ? { page: refreshed, dirty: false }
                  : { ...item, dirty: true },
              ),
            );
        } else
          setOlder((pages) => pages.map((item) => ({ ...item, dirty: true })));
      } catch (failure) {
        if (!valid()) return;
        if (
          failure instanceof TranscriptReadFailure &&
          failure.reason === "transcript_attempt_changed"
        ) {
          setOlder([]);
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
  }, [runId, nodeId, adoptFailure, retryKey]);
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
          currentOlder.current.some(
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
    const scroller = host.current?.closest<HTMLElement>(
      '[data-testid="run-peek-scroll"]',
    );

    if (saved && scroller) {
      scroller.scrollTop = saved.top + scroller.scrollHeight - saved.height;
      pendingScroll.current = null;
    }
  }, [older]);
  const earlier = async (): Promise<void> => {
    const first = older[0]?.page ?? tail;
    const signal = controller.current?.signal;

    if (!first?.beforeCursor || !signal || loading) return;
    setLoading(true);
    try {
      const page = await fetchTranscriptPage(
        runId,
        nodeId,
        new URLSearchParams({ before: first.beforeCursor }),
        signal,
      );

      if (signal.aborted) return;
      const scroller = host.current?.closest<HTMLElement>(
        '[data-testid="run-peek-scroll"]',
      );

      if (scroller)
        pendingScroll.current = {
          top: scroller.scrollTop,
          height: scroller.scrollHeight,
        };
      if (currentOlder.current.length >= 4) setNotice("historyBound");
      setOlder((pages) => [{ page, dirty: false }, ...pages].slice(0, 4));
    } catch (failure) {
      if (!signal.aborted) {
        if (
          failure instanceof TranscriptReadFailure &&
          failure.reason === "transcript_attempt_changed"
        ) {
          setOlder([]);
          setNotice("attemptChanged");
          refreshRef.current();
        } else adoptFailure(failure);
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  };
  const labels: TranscriptLabels = {
    thinking: runT("chatThinking"),
    rawEvent: runT("chatRawEvent"),
    input: runT("chatToolInput"),
    result: runT("chatToolResult"),
    copy: runT("chatCopy"),
    copied: runT("chatCopied"),
    toolCount: (name, count) => runT("chatToolCount", { name, count }),
  };
  const seen = new Set<string>();
  const windows = [
    ...older.map((item) => item.page),
    ...(tail ? [tail] : []),
  ].map((page) => ({
    ...page,
    messages: page.messages.filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);

      return true;
    }),
  }));

  return (
    <div ref={host} className="min-w-0 space-y-3" data-testid="peek-transcript">
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
      {!tail && !error ? <p role="status">{t("loading")}</p> : null}
      {(older[0]?.page ?? tail)?.hasEarlier ? (
        <button disabled={loading} type="button" onClick={() => void earlier()}>
          {t("earlierMessages")}
        </button>
      ) : null}
      {older.length ? (
        <button
          type="button"
          onClick={() => {
            setOlder([]);
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
      {tail && windows.every((page) => page.messages.length === 0) ? (
        <p>{t("emptyTranscript")}</p>
      ) : null}
      {windows.map((page) => (
        <div key={pageKey(page)} data-window-key={pageKey(page)}>
          <TranscriptMessages
            labels={labels}
            messages={page.messages}
            running={stream.liveness === "live"}
          />
        </div>
      ))}
    </div>
  );
}
