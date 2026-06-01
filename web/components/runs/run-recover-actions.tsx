"use client";

import type { RecoverUiState } from "@/lib/runs/recover-ui";
import type { ReactElement, ReactNode } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { recoverHttpToUiState } from "@/lib/runs/recover-ui";

export interface RunRecoverActionsProps {
  runId: string;
}

type DialogKind = "recover" | "discard" | null;

type RecoverErrorState = Exclude<RecoverUiState, "resumed" | "queued">;

// The error/queued banners branch ONLY on the typed RecoverUiState — never on
// string-matched server messages.
const RECOVER_ERROR_KEY: Record<RecoverErrorState, string> = {
  conflict: "recoverConflict",
  gone: "recoverGone",
  retry: "recoverRetry",
  error: "recoverError",
};

function ConfirmDialog({
  testId,
  titleId,
  title,
  body,
  cancelLabel,
  onClose,
  children,
}: {
  testId: string;
  titleId: string;
  title: string;
  body: string;
  cancelLabel: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

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
        onCloseRef.current();

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

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={cancelLabel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[460px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        data-testid={testId}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id={titleId}
          >
            {title}
          </h2>
          <button
            aria-label={cancelLabel}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <p className="m-0 text-[13px] leading-[1.5] text-body">{body}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function RunRecoverActions({
  runId,
}: RunRecoverActionsProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RecoverErrorState | null>(null);
  const [queued, setQueued] = useState(false);

  function close(): void {
    if (busy) return;
    setDialog(null);
    setError(null);
  }

  async function recover(): Promise<void> {
    setBusy(true);
    setError(null);
    setQueued(false);

    try {
      const res = await fetch(`/api/runs/${runId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const state = recoverHttpToUiState(res.status);

      if (state === "resumed") {
        router.refresh();
        setDialog(null);

        return;
      }

      if (state === "queued") {
        setQueued(true);
        setDialog(null);

        return;
      }

      setError(state);
    } catch {
      setError("error");
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/discard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      if (res.status === 200) {
        router.refresh();
        setDialog(null);

        return;
      }

      setError("conflict");
    } catch {
      setError("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="run-recover-actions">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={clsx(
            "inline-flex w-max items-center rounded-lg border border-accent-4 bg-accent-4-soft px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-accent-4 hover:bg-[color-mix(in_oklab,var(--accent-4-soft)_70%,var(--paper))]",
          )}
          data-testid="recover-button"
          type="button"
          onClick={() => {
            setError(null);
            setDialog("recover");
          }}
        >
          {t("recover")}
        </button>
        <button
          className="inline-flex w-max items-center rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
          data-testid="discard-button"
          type="button"
          onClick={() => {
            setError(null);
            setDialog("discard");
          }}
        >
          {t("discard")}
        </button>
      </div>

      {queued ? (
        <p
          aria-live="polite"
          className="rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-semibold text-ink-2"
          data-testid="recover-queued"
        >
          {t("recoverQueued")}
        </p>
      ) : null}

      {error && !dialog ? (
        <p
          aria-live="assertive"
          className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {t(RECOVER_ERROR_KEY[error])}
        </p>
      ) : null}

      {dialog === "recover" ? (
        <ConfirmDialog
          body={t("recoverConfirmBody")}
          cancelLabel={t("cancel")}
          testId="recover-confirm"
          title={t("recoverConfirmTitle")}
          titleId="recover-confirm-title"
          onClose={close}
        >
          {error ? (
            <p
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {t(RECOVER_ERROR_KEY[error])}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={close}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(
                "rounded-lg border border-accent-4 bg-accent-4-soft px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-accent-4 hover:bg-[color-mix(in_oklab,var(--accent-4-soft)_70%,var(--paper))]",
                busy && "opacity-60",
              )}
              data-testid="recover-confirm-submit"
              disabled={busy}
              type="button"
              onClick={() => void recover()}
            >
              {busy ? t("recovering") : t("recover")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}

      {dialog === "discard" ? (
        <ConfirmDialog
          body={t("discardConfirmBody")}
          cancelLabel={t("cancel")}
          testId="discard-confirm"
          title={t("discardConfirmTitle")}
          titleId="discard-confirm-title"
          onClose={close}
        >
          {error ? (
            <p
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {t(RECOVER_ERROR_KEY[error])}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={close}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(
                "rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2",
                busy && "opacity-60",
              )}
              data-testid="discard-confirm-submit"
              disabled={busy}
              type="button"
              onClick={() => void discard()}
            >
              {busy ? t("discarding") : t("discard")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
