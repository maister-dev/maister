"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type AgentMemoryDrawerLabels = {
  title: string;
  close: string;
  edit: string;
  save: string;
  cancel: string;
  clear: string;
  clearConfirm: string;
  empty: string;
  size: string;
  overCap: string;
  conflict: string;
  loadError: string;
};

type MemoryState = {
  content: string;
  hash: string | null;
  sizeChars: number;
  maxChars: number;
  updatedAt: string | null;
};

type Props = {
  slug: string;
  agentId: string;
  agentLabel: string;
  labels: AgentMemoryDrawerLabels;
  canEdit: boolean;
  onClose: () => void;
};

// ADR-152 REQ-C9 AC4: a DEDICATED portaled drawer, deliberately not the
// 520-760px instance-config modal — a memory file is a document up to
// MAISTER_AGENT_MEMORY_MAX_CHARS characters and needs the width. Portaled to
// document.body because a position:fixed panel inside a transformed ancestor
// resolves against the wrong containing block.
export function AgentMemoryDrawer({
  slug,
  agentId,
  agentLabel,
  labels,
  canEdit,
  onClose,
}: Props) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const endpoint = `/api/projects/${slug}/agents/${encodeURIComponent(agentId)}/memory`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint);

      if (!res.ok) {
        setError(labels.loadError);

        return;
      }

      setState((await res.json()) as MemoryState);
      setError(null);
    } catch {
      setError(labels.loadError);
    }
  }, [endpoint, labels.loadError]);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    void load();
    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      (triggerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const save = async (): Promise<void> => {
    if (draft === null || !state) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft, ifHash: state.hash }),
      });

      if (res.status === 409) {
        const body = (await res.json()) as { current: MemoryState };

        // A concurrent agent write landed first. Show its content rather than
        // clobbering it — the human clears the same CAS bar the agent does.
        setState(body.current);
        setError(labels.conflict);

        return;
      }

      if (!res.ok) {
        setError(res.status === 422 ? labels.overCap : labels.loadError);

        return;
      }

      setState((await res.json()) as MemoryState);
      setDraft(null);
    } catch {
      setError(labels.loadError);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    if (!window.confirm(labels.clearConfirm)) return;
    setBusy(true);

    try {
      await fetch(endpoint, { method: "DELETE" });
      await load();
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const sizeOf = draft === null ? (state?.sizeChars ?? 0) : draft.length;
  const overCap = state !== null && sizeOf > state.maxChars;

  return createPortal(
    <div
      aria-labelledby="agent-memory-drawer-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
    >
      {/* The backdrop is its own button rather than a click handler on the
          dialog: a non-interactive element must not carry mouse/keyboard
          listeners, and this keeps the dismissal keyboard-reachable. Disabled
          while busy, like the shared confirmation convention. */}
      <button
        aria-label={labels.close}
        className="absolute inset-0 cursor-default"
        disabled={busy}
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="relative flex h-full w-full max-w-[900px] flex-col gap-3 border-l border-line bg-paper p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="m-0 font-mono text-[13px] font-bold text-ink"
              id="agent-memory-drawer-title"
            >
              {labels.title}
            </h2>
            <p className="m-0 font-mono text-[11px] text-mute">{agentLabel}</p>
          </div>
          <button
            ref={closeRef}
            aria-label={labels.close}
            className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {error ? (
          <p className="m-0 font-mono text-[11px] text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <p
          className={`m-0 font-mono text-[11px] ${overCap ? "text-danger" : "text-mute"}`}
        >
          {labels.size
            .replace("{size}", String(sizeOf))
            .replace("{max}", String(state?.maxChars ?? 0))}
        </p>

        {draft === null ? (
          <pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-surface p-3 font-mono text-[12px] text-ink">
            {state?.content ? state.content : labels.empty}
          </pre>
        ) : (
          <textarea
            className="flex-1 resize-none rounded-[8px] border border-line bg-surface p-3 font-mono text-[12px] text-ink"
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}

        {canEdit ? (
          <div className="flex items-center gap-2">
            {draft === null ? (
              <>
                <button
                  className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
                  type="button"
                  onClick={() => setDraft(state?.content ?? "")}
                >
                  {labels.edit}
                </button>
                <button
                  className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-danger disabled:opacity-50"
                  disabled={busy}
                  type="button"
                  onClick={() => void clear()}
                >
                  {labels.clear}
                </button>
              </>
            ) : (
              <>
                <button
                  className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                  disabled={busy || overCap}
                  type="button"
                  onClick={() => void save()}
                >
                  {labels.save}
                </button>
                <button
                  className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-mute disabled:opacity-50"
                  disabled={busy}
                  type="button"
                  onClick={() => setDraft(null)}
                >
                  {labels.cancel}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
