"use client";

import type { ReactElement, ReactNode } from "react";
import type { TranscriptLabels, TranscriptMessage } from "./transcript-view";
import type { UserTextSegment } from "./user-message-presentation";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";

import { splitUserText } from "./user-message-presentation";
import { useUserMessageExpansion } from "./use-user-message-expansion";

function Skills({
  segment,
  messageId,
}: {
  segment: Extract<UserTextSegment, { kind: "skills" }>;
  messageId: string;
}): ReactElement {
  const t = useTranslations("transcriptUser");
  const [open, setOpen] = useUserMessageExpansion(
    messageId,
    `skills:${segment.ordinal}`,
  );

  return (
    <details
      className="my-1 rounded border border-amber-line bg-paper px-2 py-1"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-mono text-[11px] text-amber">
        {t("skills", { count: segment.count })}
      </summary>
      {open ? (
        <div className="whitespace-pre-wrap break-words">{segment.text}</div>
      ) : null}
    </details>
  );
}

export function UserMessage({
  message,
  repeated,
  labels,
  userLabel,
  attachments,
}: {
  message: TranscriptMessage;
  repeated: boolean;
  labels: TranscriptLabels;
  userLabel?: string;
  attachments: ReactNode;
}): ReactElement {
  const t = useTranslations("transcriptUser");
  const [open, setOpen] = useUserMessageExpansion(message.id, "message");
  const [fullText, setFullText] = useState<string | null>(null);
  const [error, setError] = useState<"copyError" | "loadError" | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const request = useRef<Promise<string> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = fullText ?? message.content;
  const complete = !message.preview || fullText !== null;
  const segments = splitUserText(text);
  const delivery =
    message.delivery === "queued" || message.delivery === "steered"
      ? labels.deliveryBadge?.(message.delivery)
      : null;

  useEffect(() => {
    active.current = true;

    return () => {
      active.current = false;
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function load(): Promise<string> {
    if (complete) return text;
    if (request.current) return request.current;
    const href = new URL(
      message.preview!.fullContentHref,
      window.location.href,
    );

    if (href.origin !== window.location.origin)
      throw new TypeError("Full content must be same-origin");
    const abort = new AbortController();

    controller.current = abort;
    setLoading(true);
    setRetry(0);
    request.current = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        let result: string | null = null;

        try {
          response = await fetch(href, {
            signal: abort.signal,
            credentials: "same-origin",
          });
          if (response.ok) result = await response.text();
        } catch (cause) {
          if (abort.signal.aborted || attempt >= 2) throw cause;
          if (active.current) setRetry(attempt + 1);
          continue;
        }
        if (!response.ok) {
          if (response.status >= 500 && attempt < 2) {
            if (active.current) setRetry(attempt + 1);
            continue;
          }
          throw new TypeError(
            `Full content request failed (${response.status})`,
          );
        }

        if (abort.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        if (active.current) setFullText(result!);

        return result!;
      }
    })();
    try {
      return await request.current;
    } finally {
      request.current = null;
      if (active.current) setLoading(false);
    }
  }

  async function loadContent(): Promise<void> {
    setError(null);
    try {
      await load();
    } catch {
      if (active.current) setError("loadError");
    }
  }

  async function copy(): Promise<void> {
    setError(null);
    setCopied(false);
    let original: string;

    try {
      original = await load();
    } catch {
      if (active.current) setError("loadError");

      return;
    }
    if (!active.current) return;
    try {
      if (!navigator.clipboard) throw new TypeError("Clipboard unavailable");
      await navigator.clipboard.writeText(original);
      if (!active.current) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      if (active.current) setError("copyError");
    }
  }

  return (
    <article
      className="group ml-auto max-w-[88%] min-w-0 overflow-hidden break-words rounded-lg border border-amber-line bg-amber-soft px-3 py-2.5 text-ink"
      data-testid="compact-user-message"
    >
      <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        <span className="min-w-0 truncate">{userLabel ?? message.role}</span>
        <div className="flex flex-none flex-wrap items-center gap-2">
          {delivery ? (
            <span
              className="rounded-full border border-amber-line bg-paper px-2 py-0.5 normal-case tracking-normal text-amber"
              data-delivery={message.delivery}
              data-testid="scratch-delivery-badge"
            >
              {delivery}
            </span>
          ) : null}
          <button
            aria-label={labels.copy}
            className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-1 text-mute hover:text-amber"
            type="button"
            onClick={() => void copy()}
          >
            <ClipboardDocumentIcon aria-hidden="true" className="h-3 w-3" />
            {copied ? labels.copied : labels.copy}
          </button>
          {message.createdAt ? (
            <span suppressHydrationWarning>
              {new Date(message.createdAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      </div>
      {!open && !repeated ? (
        <p
          className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-[1.55]"
          data-testid="user-message-preview"
        >
          {segments
            .map((segment) =>
              segment.kind === "text"
                ? segment.text
                : t("skills", { count: segment.count }),
            )
            .join("")}
        </p>
      ) : null}
      <details
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;

          setOpen(next);
        }}
      >
        <summary
          className="cursor-pointer font-mono text-[11px] text-amber"
          onClick={() => {
            if (!open && !complete) void loadContent();
          }}
        >
          {!open && repeated
            ? t("repeated")
            : open
              ? t("collapse")
              : complete
                ? t("show", { count: text.length })
                : t("showFull")}
        </summary>
        {open ? (
          complete ? (
            <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.55]">
              {segments.map((segment) =>
                segment.kind === "text" ? (
                  <span key={segment.start}>{segment.text}</span>
                ) : (
                  <Skills
                    key={segment.start}
                    messageId={message.id}
                    segment={segment}
                  />
                ),
              )}
            </div>
          ) : (
            <button
              className="rounded border border-line px-2 py-1 text-[12px]"
              disabled={loading}
              type="button"
              onClick={() => void loadContent()}
            >
              {t("load")}
            </button>
          )
        ) : null}
      </details>
      {loading ? (
        <p aria-live="polite" className="text-[12px]">
          {retry ? t("retrying", { count: retry }) : t("loading")}
        </p>
      ) : null}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {t(error)}
        </p>
      ) : null}
      {copied ? (
        <span aria-live="polite" className="sr-only">
          {labels.copied}
        </span>
      ) : null}
      {attachments}
    </article>
  );
}
