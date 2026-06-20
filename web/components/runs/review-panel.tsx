"use client";

import type { ReadinessDTO } from "@/lib/queries/readiness";
import type { Key, ReactElement } from "react";

import { Button, Input, ListBox, Select } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import {
  DiffView,
  type PreparedFile,
  type RunDiffFile,
} from "@/components/workbench/diff-view";

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

type PromotionMode =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";

type ReviewPanelDeliveryPolicy = {
  strategy: PromotionMode;
  push: "never" | "on_success";
  trigger: "manual" | "auto_on_ready";
  targetBranch: string;
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
};

export interface ReviewPanelProps {
  runId: string;
  baseBranch: string | null;
  baseCommit: string | null;
  runBranch: string;
  targetBranch: string | null;
  promotionMode: PromotionMode;
  deliveryPolicy: ReviewPanelDeliveryPolicy;
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
}

const shell =
  "rounded-[14px] border border-line bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";

function selectionKey(key: Key | null, fallback: PromotionMode): PromotionMode {
  if (key === null) return fallback;

  return String(key) as PromotionMode;
}

export function ReviewPanel({
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
}: ReviewPanelProps): ReactElement {
  const t = useTranslations("run");
  const tWorkbench = useTranslations("workbench");
  const router = useRouter();
  const [mode, setMode] = useState<PromotionMode>(promotionMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState(driftDetected);
  const [truncationAck, setTruncationAck] = useState(false);
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

  async function promote(allowTargetDrift: boolean): Promise<void> {
    if (!targetBranch) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetBranch,
          deliveryPolicyOverride: {
            ...deliveryPolicy,
            strategy: mode,
            trigger: "manual",
            targetBranch,
          },
          // Omit when null (the render-time resolveBaseCommit threw): the route
          // rejects a null with CONFIG 400, but a MISSING field hits the
          // server's `!reviewedTargetCommit → PRECONDITION` path cleanly.
          ...(reviewedTargetCommit ? { reviewedTargetCommit } : {}),
          ...(allowTargetDrift ? { allowTargetDrift: true } : {}),
        }),
      });

      if (res.ok) {
        router.refresh();

        return;
      }

      const data = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (
        data?.code === "PRECONDITION" &&
        /target advanced/i.test(data.message ?? "")
      ) {
        setDrift(true);
        router.refresh();

        return;
      }

      if (data?.code === "CONFLICT") {
        setConflictState({
          displayParentRepoPath,
          parentRepoPath: parentRepoPath ?? "",
          targetBranch,
          runBranch,
          command: `git merge --no-ff ${runBranch}`,
        });

        return;
      }

      setError(data?.code ?? "CRASH");
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const readinessReady = readiness?.readiness === "ready";

  return (
    <section className={clsx(shell, "mt-6 p-5")} data-testid="review-panel">
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
      ) : (
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

          {drift ? (
            <div
              className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
              data-testid="review-drift"
              role="alert"
            >
              <p className="mb-3 font-mono text-[11px] leading-[1.5] text-amber">
                {labels.targetDrift}
              </p>
              <Button
                className={clsx(
                  "border-amber bg-amber font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2",
                  busy && "opacity-60",
                )}
                isDisabled={busy}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => void promote(true)}
              >
                {labels.promoteAnyway}
              </Button>
            </div>
          ) : (
            <Button
              className={clsx(
                "w-max bg-amber font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2",
                busy && "opacity-60",
              )}
              isDisabled={busy || !targetBranch}
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
