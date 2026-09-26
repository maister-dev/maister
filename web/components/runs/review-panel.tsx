"use client";

import type { ReadinessDTO } from "@/lib/queries/readiness";
import type { Key, ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { Button, Input, ListBox, Select } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  DiffView,
  type PreparedFile,
  type RunDiffFile,
} from "@/components/workbench/diff-view";
import { resolveUiErrorMessageKey } from "@/lib/ui-error-message";
import {
  buildPromotionRequestBody,
  isMergedPrBehindResponse,
  isPublicationDivergedResponse,
  isTargetDriftResponse,
  promotionBlockReason,
  type PromotionDeliveryPolicy,
  type PromotionMode,
} from "@/lib/runs/promotion-operation";

// The prepared diff DTO the page builds server-side (`prepareDiff`): a per-file
// summary (path/status + `+`/`−` counts) and the syntax bundles the client diff
// hydrates. Repo-relative paths only — no server handles (FINDING C).
export type ReviewPanelDiff = {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  // The diff was cut at the 4 MiB buffer bound: `files`/`perFile` are a partial
  // prefix. Promotion is blocked behind an explicit acknowledgement so a run is
  // never promoted on a diff the reviewer could not see in full.
  truncated: boolean;
};

export type ReviewPanelConflict = {
  parentRepoPath: string;
  displayParentRepoPath?: string | null;
  targetBranch: string;
  runBranch: string;
  command: string;
};

export type ReviewPanelLabels = {
  promoteTo: string;
  promotionMode: string;
  readinessReady: string;
  readinessBlocked: string;
  prLink: string;
  targetDrift: string;
  promoteAnyway: string;
  diffTruncated: string;
  promoteTruncated: string;
  promotionMerge: string;
  promotionRebaseMerge: string;
  promotionPullRequest: string;
  promotionAiRebaseMerge: string;
  // ADR-141: branch-sync dialog + behind/ahead chip + resolver copy.
  // `behindAhead` / `syncInProgress` are PRE-RESOLVED server-side (their values
  // are known there): this is a client component, and RSC cannot serialize a
  // function across the boundary — every label here must stay a plain string.
  behindAhead: string;
  syncBranch: string;
  syncInProgress: string;
  resolveWithAgent: string;
  autoFinalize: string;
  autoFinalizeHint: string;
};

// ADR-141: the live sync state off the latest attempt. The update itself lives
// in the run git panel (ADR-181 D9); this panel only links into it.
export type ReviewPanelSync = {
  // Non-null ⇒ a sync claim is live (phase from the latest attempt); the panel
  // shows the phase and disables both promote and a second sync launch.
  inProgress: { phase: string } | null;
};

export interface ReviewPanelProps {
  id?: string;
  runId: string;
  baseBranch: string | null;
  baseCommit: string | null;
  runBranch: string;
  targetBranch: string | null;
  promotionMode: PromotionMode;
  deliveryPolicy: PromotionDeliveryPolicy;
  reviewedTargetCommit: string | null;
  readiness: ReadinessDTO | null;
  diff: ReviewPanelDiff;
  labels: ReviewPanelLabels;
  prUrl?: string | null;
  prNumber?: number | null;
  // The parent repo path, named in the conflict card so the operator can resolve
  // the merge by hand. Server-state; null on a pre-M18 row.
  parentRepoPath?: string | null;
  displayParentRepoPath?: string | null;
  // A pre-M18 row whose branch metadata cannot be derived: the panel shows the
  // "relaunch to promote" PRECONDITION state instead of the Promote action.
  legacyNeedsRelaunch?: boolean;
  // Server-resolved drift (the live target HEAD moved since this render): the
  // panel opens directly in the drift state offering "Promote anyway".
  driftDetected?: boolean;
  // Server-detected merge conflict context (renders the manual-resolution card).
  conflict?: ReviewPanelConflict;
  // Whether the viewer may promote (= canAct). The review SURFACE (diff,
  // readiness, conflict context) is always visible; only the Promote action is
  // gated. The server `requireProjectAction(…,"promoteRun")` is the real
  // boundary — this is UI consistency / defense-in-depth.
  canPromote?: boolean;
  // ADR-141: behind/ahead of the run branch vs its target (null when
  // the count could not be derived); branch-sync dialog seed + in-progress state.
  aheadBehind?: { ahead: number; behind: number } | null;
  sync?: ReviewPanelSync | null;
  // ADR-181 D9: the run git panel's Update section (`?git=update`) — every
  // sync entry point here links into it rather than owning a dialog.
  updateHref?: string | null;
}

const shell =
  "rounded-[14px] border border-line bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";

// A sync entry point is a link into the git panel's Update section, styled as
// the small outline button it replaced.
const syncLink =
  "inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-mute";

function selectionKey(key: Key | null, fallback: PromotionMode): PromotionMode {
  if (key === null) return fallback;

  return String(key) as PromotionMode;
}

export function ReviewPanel({
  id,
  runId,
  baseBranch,
  baseCommit,
  runBranch,
  targetBranch,
  promotionMode,
  deliveryPolicy,
  reviewedTargetCommit,
  readiness,
  diff,
  labels,
  prUrl,
  prNumber,
  parentRepoPath,
  displayParentRepoPath,
  legacyNeedsRelaunch = false,
  driftDetected = false,
  conflict,
  canPromote = true,
  aheadBehind = null,
  sync = null,
  updateHref = null,
}: ReviewPanelProps): ReactElement {
  const t = useTranslations("run");
  const tWorkbench = useTranslations("workbench");
  const router = useRouter();
  const [mode, setMode] = useState<PromotionMode>(promotionMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState(driftDetected);
  // ADR-181 (C): the last Promote was refused — the PR branch holds commits
  // the run does not.
  const [diverged, setDiverged] = useState(false);
  const [truncationAck, setTruncationAck] = useState(false);
  const [autoFinalize, setAutoFinalize] = useState(false);
  const syncClaimed = sync?.inProgress != null;
  const [conflictState, setConflictState] =
    useState<ReviewPanelConflict | null>(
      conflict
        ? {
            ...conflict,
            displayParentRepoPath:
              displayParentRepoPath ?? conflict.displayParentRepoPath,
          }
        : null,
    );
  const modeLabelId = useId();
  const readinessReady = readiness?.readiness === "ready";
  const promotionInput = {
    targetBranch,
    deliveryPolicy,
    mode,
    reviewedTargetCommit,
    canPromote,
    reviewReady: readinessReady,
    diffTruncated: diff.truncated,
    legacyNeedsRelaunch,
    truncationAcknowledged: truncationAck,
    autoFinalize,
  };
  const blockedPromotion = promotionBlockReason(promotionInput);

  async function promote(allowTargetDrift: boolean): Promise<void> {
    const body = buildPromotionRequestBody(promotionInput, allowTargetDrift);

    if (!body) return;

    setBusy(true);
    setError(null);
    setDiverged(false);

    try {
      const res = await fetch(`/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        router.refresh();

        return;
      }

      const data = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (isTargetDriftResponse(data)) {
        setDrift(true);
        router.refresh();

        return;
      }

      if (isPublicationDivergedResponse(data)) {
        setDiverged(true);

        return;
      }

      if (isMergedPrBehindResponse(data)) {
        setError(t("mergedPrBehind"));

        return;
      }

      if (data?.code === "CONFLICT") {
        setConflictState({
          displayParentRepoPath,
          parentRepoPath: parentRepoPath ?? "",
          targetBranch: body.targetBranch,
          runBranch,
          command: `git merge --no-ff ${runBranch}`,
        });

        return;
      }

      setError(t(resolveUiErrorMessageKey(data?.code)));
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={clsx(shell, "mt-6 p-5")}
      data-testid="review-panel"
      id={id}
    >
      <h2 className="mb-4 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-accent-4 before:content-['']">
        {t("reviewTitle")}
      </h2>

      {/* base → run → target spine */}
      <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-2">
        {baseBranch ? (
          <span
            className="rounded-md border border-line bg-paper px-2 py-1 font-semibold"
            data-testid="review-base-branch"
          >
            {baseBranch}
            {baseCommit ? (
              <span className="ml-1.5 text-mute">{baseCommit.slice(0, 7)}</span>
            ) : null}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-mute">
          →
        </span>
        <span
          className="rounded-md border border-amber-line bg-amber-soft px-2 py-1 font-semibold text-amber"
          data-testid="review-run-branch"
        >
          {runBranch}
        </span>
        <span aria-hidden="true" className="text-mute">
          →
        </span>
        {targetBranch ? (
          <span
            className="rounded-md border border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft px-2 py-1 font-semibold text-accent-4"
            data-testid="review-target-branch"
          >
            {targetBranch}
          </span>
        ) : null}
      </div>

      {/* ADR-141: behind/ahead chip + branch-sync affordance */}
      {aheadBehind && (aheadBehind.behind > 0 || aheadBehind.ahead > 0) ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-2"
          data-testid="review-ahead-behind"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-line bg-amber-soft px-2.5 py-1 font-mono text-[10.5px] font-bold text-amber">
            {labels.behindAhead}
          </span>
          {/* Gated at the ROUTE's granularity: sync is `promoteRun` (member),
              while this surface is `readBoard` (viewer). Offering it to a viewer
              only buys them a 403. */}
          {sync && !syncClaimed && canPromote && updateHref ? (
            <Link
              className={syncLink}
              data-testid="review-sync-open"
              href={updateHref}
              scroll={false}
            >
              <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {labels.syncBranch}
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* ADR-141: a live sync claim — promote + a second sync launch are frozen */}
      {syncClaimed ? (
        <p
          className="mb-4 rounded-[10px] border border-accent-4/40 bg-accent-4-soft p-3 font-mono text-[11px] text-accent-4"
          data-testid="review-sync-in-progress"
          role="status"
        >
          {labels.syncInProgress}
        </p>
      ) : null}

      {/* readiness summary */}
      {readiness ? (
        <div className="mb-4" data-testid="review-readiness">
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-bold",
              readinessReady
                ? "border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft text-accent-4"
                : "border-amber-line bg-amber-soft text-amber",
            )}
          >
            {readinessReady ? labels.readinessReady : labels.readinessBlocked}
          </span>
          {!readinessReady && readiness.reasons.length > 0 ? (
            <ul className="mt-2 flex list-none flex-col gap-1 p-0 font-mono text-[10.5px] text-mute">
              {readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ADR-066 diff (server-built Shiki bundle, split/inline) */}
      <div className="mb-4">
        <DiffView
          files={diff.files}
          labels={{
            empty: tWorkbench("diff.empty"),
            bodyUnavailable: tWorkbench("diff.bodyUnavailable"),
            added: tWorkbench("diff.added"),
            removed: tWorkbench("diff.removed"),
            displayMode: tWorkbench("diff.displayMode"),
            rich: tWorkbench("diff.rich"),
            raw: tWorkbench("diff.raw"),
            filterFiles: tWorkbench("diff.filterFiles"),
            filterFilesPlaceholder: tWorkbench("diff.filterFilesPlaceholder"),
            filterNoMatches: tWorkbench("diff.filterNoMatches"),
            showFiles: tWorkbench("diff.showFiles"),
            hideFiles: tWorkbench("diff.hideFiles"),
            refresh: tWorkbench("diff.refresh"),
            viewMode: tWorkbench("diff.viewMode"),
            split: tWorkbench("diff.split"),
            unified: tWorkbench("diff.unified"),
            truncated: tWorkbench("diff.truncated"),
          }}
          perFile={diff.perFile}
          truncated={diff.truncated}
        />
      </div>

      {prUrl ? (
        <p className="mb-4 font-mono text-[11px]">
          <a
            className="text-accent-4 underline hover:text-amber"
            href={prUrl}
            rel="noreferrer"
            target="_blank"
          >
            {labels.prLink}
            {prNumber ? ` #${prNumber}` : ""}
          </a>
        </p>
      ) : null}

      {conflictState ? (
        <div
          className="mb-4 rounded-[10px] border border-[#d9534f]/40 bg-[#d9534f]/10 p-4"
          data-testid="review-conflict"
          role="alert"
        >
          <p className="mb-2 font-mono text-[11px] font-bold text-[#d9534f]">
            {t("conflictTitle")}
          </p>
          <dl className="grid gap-1.5 font-mono text-[10.5px] text-ink-2">
            {conflictState.parentRepoPath ? (
              <div className="break-all">
                <dt className="inline text-mute">{t("conflictRepo")}: </dt>
                <dd className="inline">
                  {conflictState.displayParentRepoPath ??
                    conflictState.parentRepoPath}
                </dd>
              </div>
            ) : null}
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictTarget")}: </dt>
              <dd className="inline">{conflictState.targetBranch}</dd>
            </div>
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictRunBranch")}: </dt>
              <dd className="inline">{conflictState.runBranch}</dd>
            </div>
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictCommand")}: </dt>
              <dd className="inline font-bold">{conflictState.command}</dd>
            </div>
          </dl>
          {sync && !syncClaimed && updateHref ? (
            <Link
              className={clsx(syncLink, "mt-3")}
              data-testid="review-conflict-resolve-agent"
              href={updateHref}
              scroll={false}
            >
              {labels.resolveWithAgent}
            </Link>
          ) : null}
        </div>
      ) : null}

      {legacyNeedsRelaunch ? (
        <p
          className="rounded-[10px] border border-amber-line bg-amber-soft p-4 font-mono text-[11px] leading-[1.5] text-amber"
          data-testid="review-relaunch"
          role="alert"
        >
          {t("relaunchToPromote")}
        </p>
      ) : !canPromote ? null : diff.truncated && !truncationAck ? (
        <div
          className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
          data-testid="review-diff-truncated"
          role="alert"
        >
          <p className="mb-3 font-mono text-[11px] leading-[1.5] text-amber">
            {labels.diffTruncated}
          </p>
          <Button
            className="border-amber bg-amber font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
            data-testid="review-promote-truncated"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTruncationAck(true)}
          >
            {labels.promoteTruncated}
          </Button>
        </div>
      ) : blockedPromotion ? null : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
              {labels.promotionMode}
            </span>
            <span className="sr-only" id={modeLabelId}>
              {labels.promotionMode}
            </span>
            <Select
              aria-labelledby={modeLabelId}
              className="w-full max-w-[260px]"
              selectedKey={mode}
              variant="secondary"
              onSelectionChange={(key) => setMode(selectionKey(key, mode))}
            >
              <Select.Trigger className="h-9 rounded-md border-line bg-paper px-2 font-mono text-[11px] text-ink">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
                <ListBox aria-label={labels.promotionMode}>
                  <ListBox.Item id="merge" textValue={labels.promotionMerge}>
                    {labels.promotionMerge}
                  </ListBox.Item>
                  <ListBox.Item
                    id="rebase_merge"
                    textValue={labels.promotionRebaseMerge}
                  >
                    {labels.promotionRebaseMerge}
                  </ListBox.Item>
                  <ListBox.Item
                    id="pull_request"
                    textValue={labels.promotionPullRequest}
                  >
                    {labels.promotionPullRequest}
                  </ListBox.Item>
                  <ListBox.Item
                    id="ai_rebase_merge"
                    textValue={labels.promotionAiRebaseMerge}
                  >
                    {labels.promotionAiRebaseMerge}
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </label>

          {/* ADR-141 (decision 19): ai_rebase_merge one-click chaining — OFF by
              default (two-step: the resolver returns the run to Review). */}
          {mode === "ai_rebase_merge" ? (
            <div data-testid="review-auto-finalize">
              <label className="flex items-center gap-2 font-mono text-[11px] text-ink-2">
                <input
                  checked={autoFinalize}
                  type="checkbox"
                  onChange={(e) => setAutoFinalize(e.target.checked)}
                />
                {labels.autoFinalize}
              </label>
              <p className="ml-6 mt-0.5 font-mono text-[10.5px] text-mute">
                {labels.autoFinalizeHint}
              </p>
            </div>
          ) : null}

          {drift ? (
            <div
              className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
              data-testid="review-drift"
              role="alert"
            >
              <p className="mb-3 font-mono text-[11px] leading-[1.5] text-amber">
                {labels.targetDrift}
              </p>
              <div className="flex items-center gap-2">
                {sync && !syncClaimed && updateHref ? (
                  <Link
                    className={clsx(
                      syncLink,
                      "border-amber bg-amber text-white hover:bg-amber-2",
                    )}
                    data-testid="review-drift-sync"
                    href={updateHref}
                    scroll={false}
                  >
                    {labels.syncBranch}
                  </Link>
                ) : null}
                <Button
                  className={clsx(
                    "border-amber font-mono text-[10px] font-bold uppercase tracking-[0.06em]",
                    busy && "opacity-60",
                  )}
                  isDisabled={busy || syncClaimed}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void promote(true)}
                >
                  {labels.promoteAnyway}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className={clsx(
                "w-max bg-amber font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2",
                busy && "opacity-60",
              )}
              data-testid="review-promote"
              isDisabled={busy || !targetBranch || syncClaimed}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void promote(false)}
            >
              {labels.promoteTo} {targetBranch}
            </Button>
          )}

          {/* The live target HEAD this panel rendered against — carried into the
              promote payload as the optimistic-concurrency drift token. */}
          <Input
            data-testid="reviewed-target-commit"
            name="reviewedTargetCommit"
            type="hidden"
            value={reviewedTargetCommit ?? ""}
          />

          {diverged ? (
            <div
              className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
              data-testid="review-publication-diverged"
              role="alert"
            >
              <p className="mb-3 font-mono text-[11px] leading-[1.5] text-amber">
                {t("publicationDiverged")}
              </p>
              {updateHref ? (
                <Link
                  className={syncLink}
                  data-testid="review-publication-diverged-update"
                  href={updateHref}
                  scroll={false}
                >
                  <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
                  {labels.syncBranch}
                </Link>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p
              aria-live="polite"
              className="font-mono text-[10.5px] text-[#d9534f]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
