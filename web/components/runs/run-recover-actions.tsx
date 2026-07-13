"use client";

import type { RecoverUiState } from "@/lib/runs/recover-ui";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { recoverHttpToUiState } from "@/lib/runs/recover-ui";

export interface RunRecoverActionsProps {
  runId: string;
  // A Crashed run without a resumable session (no acpSessionId / non-agent
  // current node) can only be discarded — hide Recover, but ALWAYS expose
  // Discard so the run can still enter the GC countdown from the UI.
  canRecover: boolean;
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

export function RunRecoverActions({
  runId,
  canRecover,
}: RunRecoverActionsProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const feedback = useFeedback();
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
        feedback.success({
          message: t("recoverSucceeded"),
          mutationId: `recover:${runId}`,
        });
        router.refresh();
        setDialog(null);

        return;
      }

      if (state === "queued") {
        feedback.success({
          message: t("recoverQueued"),
          mutationId: `recover:${runId}`,
        });
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
        feedback.success({
          message: t("discardSucceeded"),
          mutationId: `discard:${runId}`,
        });
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
        {canRecover ? (
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
        ) : null}
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
          busy={busy}
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
          busy={busy}
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
