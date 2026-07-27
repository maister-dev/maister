"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";

export type AgentMemoryDrawerLabels = {
  title: string;
  close: string;
  edit: string;
  save: string;
  cancel: string;
  clear: string;
  clearConfirm: string;
  clearConfirmTitle: string;
  clearError: string;
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
  const [confirmingClear, setConfirmingClear] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const endpoint = `/api/projects/${slug}/agents/${encodeURIComponent(agentId)}/memory`;

  const requestClose = useCallback((): void => {
    if (!busy) onClose();
  }, [busy, onClose]);

  // The shared trap owns initial focus, Escape, focus restore, body scroll lock
  // and the Tab cycle — hand-rolling a second copy is how the two drift. It is
  // disabled while the Clear confirmation is open so the nested dialog keeps the
  // keyboard.
  useModalFocusTrap(panelRef, requestClose, !confirmingClear);

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
    void load();
  }, [load]);

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

  // A failed clear must SAY so: silently reloading unchanged content reads as
  // "nothing happened" for a destructive action the operator just confirmed.
  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(endpoint, { method: "DELETE" });

      if (!res.ok) {
        setError(labels.clearError);

        return;
      }

      await load();
      setDraft(null);
      setConfirmingClear(false);
    } catch {
      setError(labels.clearError);
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
        onClick={requestClose}
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
            aria-label={labels.close}
            className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink"
            disabled={busy}
            type="button"
            onClick={requestClose}
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
                  onClick={() => setConfirmingClear(true)}
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

        {confirmingClear ? (
          <ConfirmDialog
            body={labels.clearConfirm}
            busy={busy}
            cancelLabel={labels.cancel}
            testId="agent-memory-clear-confirm"
            title={labels.clearConfirmTitle}
            titleId="agent-memory-clear-confirm-title"
            onClose={() => setConfirmingClear(false)}
          >
            <div className="flex justify-end gap-2">
              <button
                className="h-8 rounded-[8px] border border-line px-3 text-[12px] text-mute hover:bg-ivory disabled:opacity-50"
                disabled={busy}
                type="button"
                onClick={() => setConfirmingClear(false)}
              >
                {labels.cancel}
              </button>
              <button
                className="h-8 rounded-[8px] border border-danger bg-danger px-3 text-[12px] font-semibold text-white disabled:opacity-50"
                data-testid="agent-memory-clear-confirm-submit"
                disabled={busy}
                type="button"
                onClick={() => void clear()}
              >
                {labels.clear}
              </button>
            </div>
          </ConfirmDialog>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
