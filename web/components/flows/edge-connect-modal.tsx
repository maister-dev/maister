"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";

// T3.4 — typed-edge connect modal (spec §4.7, D7). Collects the `outcome` for a
// new connection; the parent writes it through `setTransition` → `applyManifest`
// (the same single source of truth the side-form uses — there is NO second edge
// store). The four common outcomes are suggestion chips; free text is allowed.
//
// `duplicate` is parent-computed (via outcomeExistsForSource) against the live
// outcome reported through `onOutcomeChange`; when true the modal warns that
// confirming retargets the existing edge instead of adding a new one.
//
// A11y mirrors components/workbench/lifecycle-actions.tsx `DialogShell`:
// focus-trap + initial focus + focus-restore via refs, Escape-to-close, body
// scroll lock, `aria-labelledby`. The component is mounted only while a
// connection is pending — the parent owns mount/unmount.

export const EDGE_OUTCOME_SUGGESTIONS = [
  "success",
  "failure",
  "rework",
  "takeover",
] as const;

export type EdgeOutcomeSuggestion = (typeof EDGE_OUTCOME_SUGGESTIONS)[number];

export type EdgeConnectModalLabels = {
  title: string;
  outcome: string;
  suggestionsHint: string;
  freeTextHint: string;
  retargetWarning: string;
  confirm: string;
  cancel: string;
  suggestion: Record<EdgeOutcomeSuggestion, string>;
};

export interface EdgeConnectModalProps {
  labels: EdgeConnectModalLabels;
  source: string;
  target: string;
  duplicate: boolean;
  onOutcomeChange?: (outcome: string) => void;
  onConfirm: (outcome: string) => void;
  onCancel: () => void;
}

const FIELD_CLS =
  "min-h-[34px] w-full rounded-md border border-line bg-paper px-2.5 font-mono text-[12px] text-ink outline-none focus:border-amber";
const LABEL_CLS =
  "font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute";

export function EdgeConnectModal({
  labels,
  source,
  target,
  duplicate,
  onOutcomeChange,
  onConfirm,
  onCancel,
}: EdgeConnectModalProps): ReactElement {
  const [outcome, setOutcome] = useState("success");

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);

  onCancelRef.current = onCancel;

  const changeOutcome = (next: string): void => {
    setOutcome(next);
    onOutcomeChange?.(next);
  };

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  const canConfirm = outcome.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-4"
      data-testid="edge-connect-modal"
    >
      <button
        aria-label={labels.cancel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.48)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onCancel}
      />
      <div
        ref={dialogRef}
        aria-labelledby="edge-connect-modal-title"
        aria-modal="true"
        className="relative z-10 flex w-full max-w-[420px] flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-2xl"
        role="dialog"
      >
        <div className="border-b border-line px-4 py-3">
          <h2
            className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink"
            id="edge-connect-modal-title"
          >
            {labels.title}
          </h2>
          <p className="mt-1 font-mono text-[10px] text-mute">
            {source} → {target}
          </p>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="grid gap-1">
            <span className={LABEL_CLS}>{labels.outcome}</span>
            <input
              className={FIELD_CLS}
              data-testid="edge-connect-outcome"
              spellCheck={false}
              value={outcome}
              onChange={(event) => changeOutcome(event.target.value)}
            />
            <span className="font-mono text-[10px] text-mute">
              {labels.freeTextHint}
            </span>
          </label>

          <div className="grid gap-1">
            <span className={LABEL_CLS}>{labels.suggestionsHint}</span>
            <div className="flex flex-wrap gap-1.5">
              {EDGE_OUTCOME_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  className="rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                  data-testid={`edge-connect-suggestion-${suggestion}`}
                  type="button"
                  onClick={() => changeOutcome(suggestion)}
                >
                  {labels.suggestion[suggestion]}
                </button>
              ))}
            </div>
          </div>

          {duplicate ? (
            <p
              aria-live="polite"
              className="rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[10px] text-amber"
              data-testid="edge-connect-retarget-warning"
              role="alert"
            >
              {labels.retargetWarning}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
          <button
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
            data-testid="edge-connect-cancel"
            type="button"
            onClick={onCancel}
          >
            {labels.cancel}
          </button>
          <button
            className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
            data-testid="edge-connect-confirm"
            disabled={!canConfirm}
            type="button"
            onClick={() => onConfirm(outcome.trim())}
          >
            {labels.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
