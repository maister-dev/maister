"use client";

import type { ReactElement } from "react";
import type { ConfigPersistenceController } from "./use-config-persistence";

import { useTranslations } from "next-intl";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

const buttonClass =
  "rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50";

export function ConfigPersistDialog({
  controller: c,
}: {
  controller: ConfigPersistenceController;
}): ReactElement | null {
  const t = useTranslations("projects.configPersistence");

  if (!c.open) return null;
  const active =
    c.receipt &&
    ["preparing", "prepared", "publishing", "recovery_required"].includes(
      c.receipt.state,
    );
  const pushState =
    (c.pushResult?.operationId === c.receipt?.operationId
      ? c.pushResult?.state
      : undefined) ?? c.receipt?.pushState;
  const uncertainPush = pushState && ["pending", "unknown"].includes(pushState);
  const localNeedsRecovery = active || (c.uncertainId && !c.receipt);
  const needsRecovery = localNeedsRecovery || uncertainPush;

  return (
    <ConfirmDialog
      body={t("reviewBody")}
      busy={c.busy}
      cancelLabel={t("cancel")}
      testId="config-persist-dialog"
      title={t("reviewTitle")}
      titleId="config-persist-title"
      onClose={c.close}
    >
      <p aria-live="polite" className="text-sm text-mute">
        {c.busy ? t("working") : t("excluded")}
      </p>
      {c.error ? (
        <p className="text-danger" role="alert">
          {c.error}
        </p>
      ) : null}
      {c.preview?.kind === "ready" ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-2 text-sm">
            <dt>{t("branch")}</dt>
            <dd className="break-all font-mono">{c.preview.targetBranch}</dd>
            <dt>{t("message")}</dt>
            <dd className="break-all font-mono">{c.preview.message}</dd>
            <dt>{t("file")}</dt>
            <dd>maister.yaml</dd>
          </dl>
          {c.preview.usedDefaultAuthor ? (
            <p className="text-sm text-amber">{t("defaultAuthor")}</p>
          ) : null}
          <textarea
            readOnly
            aria-label={t("diff")}
            className="min-h-64 w-full resize-y rounded border border-line p-3 font-mono text-xs"
            data-testid="config-persist-diff"
            value={c.preview.diff}
          />
          <button
            className={buttonClass}
            data-testid="config-persist-confirm"
            disabled={c.busy}
            type="button"
            onClick={() => void c.confirm()}
          >
            {t("confirm")}
          </button>
        </>
      ) : null}
      {c.preview?.kind === "noop" ? (
        <p data-testid="config-persist-noop" role="status">
          {t("noop")}
        </p>
      ) : null}
      {c.preview?.kind === "blocked" ? (
        <div role="status">
          <p>{t(`reasons.${c.preview.reason}`)}</p>
          {c.preview.paths.length ? (
            <pre className="overflow-auto text-xs">
              {c.preview.paths.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
      {c.receipt ? (
        <div className="space-y-2 text-sm" role="status">
          {c.receipt.state === "committed" ? (
            <div data-testid="config-commit-success">
              <strong>{t("committed")}</strong>
              <p className="break-all font-mono">{c.receipt.commitSha}</p>
              <p>{t("localCommitPreserved")}</p>
            </div>
          ) : (
            <p>{t(`states.${c.receipt.state}`)}</p>
          )}
          {c.receipt.state === "noop" ? (
            <p data-testid="config-persist-noop">{t("noop")}</p>
          ) : null}
          {c.receipt.reason ? <p>{t(`reasons.${c.receipt.reason}`)}</p> : null}
          {c.receipt.cleanupState === "retained" ? (
            <p>{t("cleanupRetained")}</p>
          ) : null}
          <p className="break-all font-mono">
            {t("operation")}: {c.receipt.operationId}
          </p>
          {pushState && pushState !== "not_requested" ? (
            <p data-testid="config-push-state">
              {t(`pushStates.${pushState}`)}
            </p>
          ) : null}
        </div>
      ) : null}
      {c.uncertainId && !c.receipt ? (
        <p className="break-all text-sm">
          {t("operation")}: {c.uncertainId}
        </p>
      ) : null}
      {needsRecovery ? (
        <button
          className={buttonClass}
          disabled={c.busy}
          type="button"
          onClick={() => void c.recover()}
        >
          {t("recover")}
        </button>
      ) : null}
      {c.receipt?.state === "committed" && !uncertainPush && !c.pushReview ? (
        <button
          className={buttonClass}
          data-testid="config-push-review"
          disabled={c.busy}
          type="button"
          onClick={() => void c.reviewPush()}
        >
          {t("reviewPush")}
        </button>
      ) : null}
      {c.pushReview ? (
        <section
          aria-label={t("pushTitle")}
          className="space-y-3 border-t border-line pt-3"
        >
          <h3>{t("pushTitle")}</h3>
          <p className="break-all font-mono text-xs">
            origin · {c.pushReview.url} · {c.pushReview.destination}
          </p>
          <p className="break-all font-mono text-xs">
            {c.pushReview.commitSha}
          </p>
          <p className="break-all font-mono text-xs">
            {t("remoteBase")}: {c.pushReview.remoteBase ?? t("unborn")}
          </p>
          <textarea
            readOnly
            aria-label={t("outgoing")}
            className="w-full font-mono text-xs"
            value={c.pushReview.outgoingShas.join("\n") || t("pushUpToDate")}
          />
          <button
            className={buttonClass}
            data-testid="config-push-confirm"
            disabled={c.busy}
            type="button"
            onClick={() => void c.confirmPush()}
          >
            {t("confirmPush")}
          </button>
        </section>
      ) : null}
      {!c.busy && !localNeedsRecovery && c.preview?.kind !== "ready" ? (
        <button
          className={buttonClass}
          data-testid="config-persist-refresh"
          type="button"
          onClick={() => void c.freshPreview()}
        >
          {t("freshPreview")}
        </button>
      ) : null}
      <button
        className={buttonClass}
        data-testid="config-persist-close"
        disabled={c.busy}
        type="button"
        onClick={c.close}
      >
        {c.receipt || c.preview?.kind === "noop" ? t("close") : t("cancel")}
      </button>
    </ConfirmDialog>
  );
}
