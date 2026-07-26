"use client";

import type { KeyboardEvent, ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import {
  applyMentionSelection,
  detectMentionQuery,
  filterMentionCandidates,
  type MentionCandidateView,
} from "@/components/social/mention-autocomplete";

export interface CommentComposerLabels {
  placeholder: string;
  submit: string;
  submitting: string;
  hint: string;
  errorConfig: string;
  errorForbidden: string;
  errorGeneric: string;
  mentionListLabel: string;
  mentionMatchCount: string;
}

export function CommentComposer({
  slug,
  taskNumber,
  labels,
  mentionCandidates = [],
}: {
  slug: string;
  taskNumber: number;
  labels: CommentComposerLabels;
  // (ADR-151) Summonable agents only — offering one that cannot be launched
  // is a design defect, not discoverability. Derived on the page from data it
  // already loads, so there is no autocomplete endpoint.
  mentionCandidates?: MentionCandidateView[];
}): ReactElement {
  const router = useRouter();
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches =
    mention && mentionCandidates.length > 0
      ? filterMentionCandidates(mentionCandidates, mention.query)
      : [];
  const open = matches.length > 0;
  // Combobox semantics are adopted ONLY where the feature is live. With no
  // summonable agents the textarea stays a plain multiline textbox, so screen
  // readers are never told about a listbox that can never open.
  const comboboxProps =
    mentionCandidates.length > 0
      ? ({
          "aria-activedescendant": open
            ? `${listId}-${activeIndex}`
            : undefined,
          "aria-autocomplete": "list",
          "aria-controls": open ? listId : undefined,
          "aria-expanded": open,
          role: "combobox",
        } as const)
      : {};

  useEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function syncMention(text: string, caret: number): void {
    if (mentionCandidates.length === 0) return;
    setMention(detectMentionQuery(text, caret));
    setActiveIndex(0);
  }

  function choose(agentId: string): void {
    const textarea = textareaRef.current;

    if (!mention || !textarea) return;

    const next = applyMentionSelection(
      body,
      textarea.selectionStart,
      mention.start,
      agentId,
    );

    setBody(next.text);
    setMention(null);
    setActiveIndex(0);
    // The caret must land after the inserted handle, which only exists once
    // React has flushed the new value into the DOM node.
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // IME safety: a composing keystroke (RU/CJK input) must reach the textarea
    // untouched — intercepting it eats the composition.
    if (event.nativeEvent.isComposing) return;
    if (!open) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(matches[activeIndex].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
    }
  }

  async function submit(): Promise<void> {
    if (busy || body.trim().length === 0) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/tasks/${taskNumber}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(
          payload?.code === "CONFIG"
            ? labels.errorConfig
            : payload?.code === "UNAUTHORIZED"
              ? labels.errorForbidden
              : labels.errorGeneric,
        );

        return;
      }

      setBody("");
      setMention(null);
      router.refresh();
    } catch {
      setError(labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor="task-comment-body">
        {labels.placeholder}
      </label>
      <div className="relative">
        <textarea
          ref={textareaRef}
          {...comboboxProps}
          className="min-h-[88px] w-full rounded-lg border border-line bg-paper p-3 text-[13px] leading-[1.6] text-ink outline-none transition focus:border-amber"
          disabled={busy}
          id="task-comment-body"
          maxLength={10_000}
          placeholder={labels.placeholder}
          value={body}
          onBlur={() => setMention(null)}
          onChange={(e) => {
            setBody(e.target.value);
            syncMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) =>
            syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
          }
        />
        {open ? (
          <ul
            aria-label={labels.mentionListLabel}
            className="absolute left-0 top-full z-20 mt-1 max-h-[220px] w-full max-w-[320px] overflow-auto rounded-[8px] border border-line bg-paper py-1 shadow-lg"
            id={listId}
            role="listbox"
          >
            {matches.map((candidate, index) => (
              <li key={candidate.id} role="none">
                <button
                  ref={index === activeIndex ? activeOptionRef : undefined}
                  aria-selected={index === activeIndex}
                  className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left ${
                    index === activeIndex ? "bg-ivory" : ""
                  }`}
                  id={`${listId}-${index}`}
                  role="option"
                  type="button"
                  // Selecting must not blur the textarea first, or the caret
                  // position the splice needs is already gone.
                  onClick={() => choose(candidate.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="font-mono text-[11.5px] text-ink">
                    {candidate.id}
                  </span>
                  <span className="text-[11px] text-mute">
                    {candidate.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <span aria-live="polite" className="sr-only">
        {open
          ? labels.mentionMatchCount.replace("$count", String(matches.length))
          : ""}
      </span>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-mute">{labels.hint}</span>
        <button
          className="rounded-lg border border-amber bg-amber-soft px-3 py-1.5 text-[12px] font-semibold text-amber transition hover:bg-amber/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || body.trim().length === 0}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? labels.submitting : labels.submit}
        </button>
      </div>
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
