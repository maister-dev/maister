"use client";

import type { RecoverUiState } from "@/lib/runs/recover-ui";
import type { NodeRestartPreview } from "@/lib/runs/node-restart-types";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
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
  canDiscard?: boolean;
  restartAttemptId?: string;
  checkpointAvailable?: boolean;
}

type DialogKind = "recover" | "discard" | null;

type RecoverErrorState = Exclude<RecoverUiState, "resumed" | "queued">;
type RestartChoice =
  | { kind: "keep" }
  | { kind: "loading" }
  | { kind: "checkpoint"; preview: NodeRestartPreview }
  | { kind: "unavailable" };

// The error/queued banners branch ONLY on the typed RecoverUiState — never on
// string-matched server messages.
const RECOVER_ERROR_KEY: Record<RecoverErrorState, string> = {
  conflict: "recoverConflict",
  busy: "recoverBusy",
  gone: "recoverGone",
  retry: "recoverRetry",
  error: "recoverError",
};

// ADR-175: the recover route's success body carries the run's COMMITTED status
// as a declared enum field. Reading it is not the string-matching the rule
// above forbids — that bans branching on server MESSAGES. A body that fails to
// parse degrades to the ordinary message rather than failing the recover.
async function committedRunStatus(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();

    return typeof body === "object" && body !== null && "runStatus" in body
      ? String((body as { runStatus: unknown }).runStatus)
      : null;
  } catch {
    return null;
  }
}

// A refusal's typed `details.reason` token, read for the same reason as the
// committed status above: it is a declared field, not a server message.
async function refusalReason(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const details =
      typeof body === "object" && body !== null && "details" in body
        ? (body as { details: unknown }).details
        : null;

    return typeof details === "object" &&
      details !== null &&
      "reason" in details
      ? String((details as { reason: unknown }).reason)
      : null;
  } catch {
    return null;
  }
}

export function RunRecoverActions({
  runId,
  canRecover,
  canDiscard = true,
  restartAttemptId,
  checkpointAvailable = false,
}: RunRecoverActionsProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const feedback = useFeedback();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RecoverErrorState | null>(null);
  const [queued, setQueued] = useState(false);
  const [choice, setChoice] = useState<RestartChoice>({ kind: "keep" });
  const previewRequest = useRef<AbortController | null>(null);
  const actionLabel = t(restartAttemptId ? "restartFailedNode" : "recover");
  const errorLabel = error
    ? restartAttemptId &&
      (error === "conflict" || error === "gone" || error === "error")
      ? t("restartFailedNodeError")
      : t(RECOVER_ERROR_KEY[error])
    : null;

  function close(): void {
    if (busy) return;
    previewRequest.current?.abort();
    setDialog(null);
    setError(null);
    setChoice({ kind: "keep" });
  }

  function keepWorkspace(): void {
    previewRequest.current?.abort();
    setError(null);
    setChoice({ kind: "keep" });
  }

  async function previewCheckpoint(): Promise<void> {
    if (!restartAttemptId || !checkpointAvailable) return;
    previewRequest.current?.abort();
    const controller = new AbortController();

    previewRequest.current = controller;
    setError(null);
    setChoice({ kind: "loading" });
    try {
      const query = new URLSearchParams({ restartAttempt: restartAttemptId });
      const res = await fetch(`/api/runs/${runId}/recover?${query}`, {
        signal: controller.signal,
      });

      if (!res.ok) throw new Error("Checkpoint preview is unavailable");
      const preview: NodeRestartPreview = await res.json();

      if (!controller.signal.aborted)
        setChoice({ kind: "checkpoint", preview });
    } catch {
      if (!controller.signal.aborted) setChoice({ kind: "unavailable" });
    }
  }

  async function recover(): Promise<void> {
    if (choice.kind === "loading" || choice.kind === "unavailable") return;
    setBusy(true);
    setError(null);
    setQueued(false);

    try {
      const query = restartAttemptId
        ? `?restartAttempt=${encodeURIComponent(restartAttemptId)}${choice.kind === "checkpoint" ? `&restartCheckpoint=${encodeURIComponent(choice.preview.token)}` : ""}`
        : "";
      const res = await fetch(`/api/runs/${runId}/recover${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const reason = res.status === 409 ? await refusalReason(res) : null;
      const state = recoverHttpToUiState(res.status, reason);

      if (state === "resumed") {
        // A 200 does not always mean the run is Running: a crashed coordinator
        // handed back to its child-wait gate commits as `WaitingOnChildren`, so
        // "Recovery started." would name a state it is not in.
        const runStatus = await committedRunStatus(res);

        feedback.success({
          message:
            runStatus === "WaitingOnChildren"
              ? t("recoverSucceededWaiting")
              : t(
                  restartAttemptId
                    ? "restartFailedNodeAccepted"
                    : "recoverSucceeded",
                ),
          mutationId: `recover:${runId}`,
        });
        router.refresh();
        setChoice({ kind: "keep" });
        setDialog(null);

        return;
      }

      if (state === "queued") {
        feedback.success({
          message: t("recoverQueued"),
          mutationId: `recover:${runId}`,
        });
        setQueued(true);
        setChoice({ kind: "keep" });
        setDialog(null);
        if (restartAttemptId) router.refresh();

        return;
      }

      if (reason?.startsWith("restart_checkpoint_"))
        setChoice({ kind: "unavailable" });
      else setError(state);
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
              "inline-flex w-max items-center gap-1.5 rounded-lg border border-accent-4 bg-accent-4-soft px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-accent-4 hover:bg-[color-mix(in_oklab,var(--accent-4-soft)_70%,var(--paper))]",
            )}
            data-testid="recover-button"
            type="button"
            onClick={() => {
              setError(null);
              setChoice({ kind: "keep" });
              setDialog("recover");
            }}
          >
            {restartAttemptId ? (
              <ArrowPathIcon aria-hidden className="size-3.5" />
            ) : null}
            {actionLabel}
          </button>
        ) : null}
        {canDiscard ? (
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
        ) : null}
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
          {errorLabel}
        </p>
      ) : null}

      {dialog === "recover" ? (
        <ConfirmDialog
          body={t(
            restartAttemptId ? "restartFailedNodeBody" : "recoverConfirmBody",
          )}
          busy={busy}
          cancelLabel={t("cancel")}
          testId="recover-confirm"
          title={t(
            restartAttemptId ? "restartFailedNodeTitle" : "recoverConfirmTitle",
          )}
          titleId="recover-confirm-title"
          onClose={close}
        >
          {restartAttemptId ? (
            <fieldset className="grid gap-2" disabled={busy}>
              <legend className="mb-2 text-sm font-semibold">
                {t("restartWorkspaceMode")}
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  checked={choice.kind === "keep"}
                  name="restart-workspace"
                  type="radio"
                  onChange={keepWorkspace}
                />
                {t("restartKeepWorkspace")}
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  checked={choice.kind !== "keep"}
                  disabled={!checkpointAvailable}
                  name="restart-workspace"
                  type="radio"
                  onChange={() => void previewCheckpoint()}
                />
                {t("restartRestoreCheckpoint")}
              </label>
              {!checkpointAvailable ? (
                <p className="text-xs text-mute">{t("restartNoCheckpoint")}</p>
              ) : null}
            </fieldset>
          ) : null}
          {choice.kind === "loading" ? (
            <p role="status">{t("restartPreviewLoading")}</p>
          ) : null}
          {choice.kind === "unavailable" ? (
            <div className="grid gap-2 text-sm">
              <p role="alert">{t("restartPreviewUnavailable")}</p>
              <button
                className="w-fit underline"
                type="button"
                onClick={() => void previewCheckpoint()}
              >
                {t("restartPreviewRetry")}
              </button>
            </div>
          ) : null}
          {choice.kind === "checkpoint" ? (
            <div className="grid gap-2 rounded-lg border border-amber-line bg-amber-soft p-3 text-sm">
              <p>{t("restartCheckpointBackup")}</p>
              {choice.preview.rewindsCommits ? (
                <p>{t("restartCheckpointBranch")}</p>
              ) : null}
              {choice.preview.fileCount > 0 ? (
                <div>
                  <p>
                    {t("restartPreviewFiles", {
                      count: choice.preview.fileCount,
                    })}
                  </p>
                  <ul className="mt-1 max-h-40 space-y-1 overflow-auto font-mono text-xs">
                    {choice.preview.files.map((file) => (
                      <li key={file.path} className="break-all">
                        {t(
                          file.removed
                            ? "restartPreviewRemove"
                            : "restartPreviewRestore",
                        )}{" "}
                        {file.path}
                      </li>
                    ))}
                  </ul>
                  {choice.preview.fileCount > choice.preview.files.length ? (
                    <p className="mt-1 text-xs">
                      {t("restartPreviewMore", {
                        count:
                          choice.preview.fileCount -
                          choice.preview.files.length,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p>{t("restartPreviewNoFiles")}</p>
              )}
            </div>
          ) : null}
          {error ? (
            <p
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {errorLabel}
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
              disabled={
                busy ||
                choice.kind === "loading" ||
                choice.kind === "unavailable"
              }
              type="button"
              onClick={() => void recover()}
            >
              {busy
                ? t(restartAttemptId ? "restartingFailedNode" : "recovering")
                : choice.kind === "checkpoint"
                  ? t("restartRestoreSubmit")
                  : actionLabel}
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
