import type { ReactElement } from "react";

import { ArrowUpTrayIcon, CheckIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import {
  button,
  danger,
  fieldLabel,
  inputClass,
  neutral,
  primary,
  Section,
  type GitSectionProps,
} from "@/components/workbench/git-panel-kit";

// ADR-181 D11/D12: open a PR from the publication before any promotion, and
// finalize a PR-backed run to Done — from Review as a promotion, from any other
// parked status on the operator's confirmation.
export function GitPrSection({
  state,
  busy,
  dirtyCount,
  mutate,
  actionButton,
}: GitSectionProps): ReactElement {
  const t = useTranslations("workbenchGit");
  // Pre-filled from the server's defaults in the read this section mounted
  // with; the operator's edits stand across refreshes.
  const [prTitle, setPrTitle] = useState(() => state.prDefaults?.title ?? "");
  const [prBody, setPrBody] = useState(() => state.prDefaults?.body ?? "");
  const [prTarget, setPrTarget] = useState(
    () => state.prDefaults?.targetBranch ?? "",
  );
  const [prDraft, setPrDraft] = useState(false);
  const [prReused, setPrReused] = useState(false);
  const [driftRefused, setDriftRefused] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  // D13: a scratch run's PR target is locked by its scratch row.
  const targetLocked = state.runKind === "scratch";

  // D11: the server applies its defaults for an omitted field, so an emptied
  // title or target is left out rather than sent blank.
  function openPr(): void {
    const title = prTitle.trim();
    const target = prTarget.trim();

    void mutate<{ reused?: boolean }>(
      "openPr",
      "pr",
      {
        ...(title !== "" ? { title } : {}),
        body: prBody,
        draft: prDraft,
        ...(target !== "" ? { targetBranch: target } : {}),
      },
      (result) => {
        // C18: an existing PR came back untouched — say so, never "applied".
        setPrReused(result?.reused === true);
      },
    );
  }

  // D12/C23: from Review a finalize is a promotion, so it carries the target
  // head this panel rendered; a drift refusal offers the explicit override.
  function finalizePr(allowTargetDrift: boolean): void {
    const inReview = state.runStatus === "Review";

    void mutate(
      "finalizePr",
      "pr/finalize",
      inReview
        ? {
            ...(state.targetHead
              ? { reviewedTargetCommit: state.targetHead }
              : {}),
            ...(allowTargetDrift ? { allowTargetDrift: true } : {}),
          }
        : {},
      () => undefined,
    ).then((failure) => {
      setDriftRefused(failure?.details?.reason === "target_drift");
      setFinalizeOpen(false);
    });
  }

  return (
    <Section id="pr" title={t("section.pr")}>
      {state.publicBranch !== null ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("pr.title")}</span>
            <input
              className={inputClass}
              data-testid="git-panel-pr-title"
              maxLength={256}
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("pr.body")}</span>
            <textarea
              className={clsx(inputClass, "min-h-[72px] py-1.5")}
              data-testid="git-panel-pr-body"
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("pr.target")}</span>
            <input
              aria-describedby={
                targetLocked ? "git-panel-pr-target-locked" : undefined
              }
              className={inputClass}
              data-testid="git-panel-pr-target"
              readOnly={targetLocked}
              value={prTarget}
              onChange={(event) => setPrTarget(event.target.value)}
            />
            {targetLocked ? (
              <span
                className="font-mono text-[10px] text-ink-2"
                data-testid="git-panel-pr-target-locked"
                id="git-panel-pr-target-locked"
              >
                {t("pr.targetLocked")}
              </span>
            ) : null}
          </label>
          <label className="flex items-center gap-2 font-mono text-[10px] text-ink-2">
            <input
              checked={prDraft}
              data-testid="git-panel-pr-draft"
              type="checkbox"
              onChange={(event) => setPrDraft(event.target.checked)}
            />
            {t("pr.draft")}
          </label>
          <div className="flex flex-wrap gap-2">
            {actionButton({
              id: "openPr",
              tone: primary,
              blockedBy: dirtyCount > 0 ? t("hint.commitOrDiscardFirst") : null,
              icon: (
                <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />
              ),
              onClick: openPr,
            })}
          </div>
          {prReused ? (
            <p
              className="m-0 font-mono text-[10px] text-ink-2"
              data-testid="git-panel-pr-reused"
              role="status"
            >
              {t("pr.reused")}
            </p>
          ) : null}
        </>
      ) : (
        <p
          className="m-0 font-mono text-[10px] text-mute"
          data-testid="git-panel-pr-unpublished"
        >
          {t("pr.publishFirst")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {state.pr
          ? actionButton({
              id: "finalizePr",
              icon: <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />,
              // D12: outside Review no readiness is asserted — the
              // operator's confirmed click is the decision.
              onClick: () =>
                state.runStatus === "Review"
                  ? finalizePr(false)
                  : setFinalizeOpen(true),
            })
          : null}
        {driftRefused ? (
          <button
            className={clsx(button, danger)}
            data-testid="git-panel-pr-finalize-anyway"
            disabled={busy !== null}
            type="button"
            onClick={() => finalizePr(true)}
          >
            {t("pr.finalizeAnyway")}
          </button>
        ) : null}
      </div>

      {finalizeOpen ? (
        <ConfirmDialog
          body={t("pr.finalizeBody")}
          busy={busy !== null}
          cancelLabel={t("cancel")}
          testId="git-panel-pr-finalize-dialog"
          title={t("pr.finalizeTitle")}
          titleId="git-panel-pr-finalize-title"
          onClose={() => setFinalizeOpen(false)}
        >
          <div className="flex justify-end gap-2">
            <button
              className={clsx(button, neutral)}
              disabled={busy !== null}
              type="button"
              onClick={() => setFinalizeOpen(false)}
            >
              {t("cancel")}
            </button>
            <button
              className={clsx(button, primary)}
              data-testid="git-panel-pr-finalize-confirm"
              disabled={busy !== null}
              type="button"
              onClick={() => finalizePr(false)}
            >
              <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("pr.finalizeConfirm")}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}
