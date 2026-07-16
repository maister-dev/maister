import type { ReactElement } from "react";
import type { PromotionOperationInput } from "@/lib/runs/promotion-operation";

import Link from "next/link";
import clsx from "clsx";
import { CurrencyDollarIcon } from "@heroicons/react/24/outline";

import {
  PrStateChip,
  type PrState,
  type PrStateChipLabels,
} from "@/components/pr-state-chip";
import { MarkdownBody } from "@/components/social/markdown-body";
import { RunHeaderPromotionAction } from "@/components/runs/run-header-promotion-action";

const keyRefChipClass =
  "rounded border border-line bg-ivory px-1.5 py-px font-mono text-[11px] font-bold tracking-[0.04em] text-ink-2";

export interface RunHeaderChangeSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  dirty?: boolean;
  unavailable?: boolean;
}

export interface RunHeaderLabels {
  branch: string;
  changes: string;
  changesUnavailable: string;
  changedFiles: string;
  openInspector: string;
  closeInspector: string;
  // The collapsible "Task" disclosure summary (task prompt block).
  task: string;
  // Cost-budget governance warn badge — `$pct`-token template (house pattern).
  // Optional so non-run-detail consumers (no budget signal) keep compiling.
  budgetWarn?: string;
  review?: string;
  promote?: string;
  promotionStarted?: string;
  targetDrift?: string;
  // ADR-139 PR-state chip labels. Optional so non-run-detail consumers (no PR
  // signal) keep compiling; the chip renders only when present.
  prChip?: PrStateChipLabels;
}

export interface RunHeaderProps {
  title: string;
  // Eyebrow above the title: `flow › current node` for flow runs.
  subtitle?: string;
  // KEY-N reference chip beside the status badge (null for scratch runs).
  keyRef?: string | null;
  // Task detail href; turns the KEY-N chip into a link to the task page.
  taskHref?: string | null;
  projectHref?: string | null;
  projectLabel?: string | null;
  // The launching task's prompt, rendered as a collapsible Markdown block.
  taskPrompt?: string | null;
  status: string;
  branch?: string | null;
  targetBranch?: string | null;
  // ADR-139 PR lifecycle: provider PR state + conflict flag for the header chip.
  prState?: PrState | null;
  prHasConflicts?: boolean | null;
  // ADR-140: the chip's reopen affordance is disabled without it. NOT taken from
  // `promotionOperation` — that is only built for a promotable Review run, and
  // reopen exists precisely for a DONE one.
  runId?: string;
  // Whether the viewer may reopen (= canAct). Reopen is a `promoteRun` (member)
  // route while this header renders for `readBoard` (viewer), so a viewer must
  // get the chip's disabled affordance rather than a button that 403s.
  canReopen?: boolean;
  changeSummary?: RunHeaderChangeSummary | null;
  // Derived run-scope budget warn signal (null = no badge).
  budgetStatus?: { warn: boolean; pct: number } | null;
  inspectorOpen: boolean;
  reviewHref?: string | null;
  promotionOperation?: (PromotionOperationInput & { runId: string }) | null;
  labels: RunHeaderLabels;
  onToggleInspector?: () => void;
}

export function formatRunChangeSummary(
  summary: RunHeaderChangeSummary | null | undefined,
  labels: Pick<
    RunHeaderLabels,
    "changedFiles" | "changes" | "changesUnavailable"
  >,
): string {
  if (!summary || summary.unavailable) return labels.changesUnavailable;

  return `${summary.fileCount} ${labels.changedFiles} | +${summary.additions} -${summary.deletions}`;
}

function statusTone(status: string): string {
  if (status === "Done") return "border-emerald-200 text-emerald-700";
  if (status === "Crashed" || status === "Failed") {
    return "border-red-200 text-red-700";
  }
  if (status === "NeedsInput" || status === "NeedsInputIdle") {
    return "border-amber-200 text-amber-700";
  }

  return "border-line text-ink-2";
}

export function RunHeader({
  title,
  subtitle,
  keyRef,
  taskHref,
  projectHref,
  projectLabel,
  taskPrompt,
  status,
  branch,
  targetBranch,
  prState,
  prHasConflicts,
  runId,
  canReopen,
  changeSummary,
  budgetStatus,
  inspectorOpen,
  reviewHref,
  promotionOperation,
  labels,
  onToggleInspector,
}: RunHeaderProps): ReactElement {
  const changes = formatRunChangeSummary(changeSummary, labels);
  const budgetBadge =
    budgetStatus?.warn && labels.budgetWarn
      ? labels.budgetWarn.replace("$pct", String(budgetStatus.pct))
      : null;

  return (
    <header
      className="flex flex-col gap-3 border-b border-line pb-4 md:flex-row md:items-start md:justify-between"
      data-testid="run-header"
    >
      <div className="min-w-0">
        {projectHref && projectLabel ? (
          <Link
            className="mb-1 inline-flex font-mono text-[11px] font-semibold text-mute transition-colors hover:text-ink"
            data-testid="run-header-project-link"
            href={projectHref}
          >
            {projectLabel}
          </Link>
        ) : null}
        {subtitle ? (
          <p
            className="mb-1 truncate font-mono text-[11px] uppercase tracking-[0.06em] text-mute"
            data-testid="run-header-eyebrow"
          >
            {subtitle}
          </p>
        ) : null}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              "inline-flex rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold",
              statusTone(status),
            )}
            data-testid="run-header-status"
          >
            {status}
          </span>
          {keyRef ? (
            taskHref ? (
              <Link
                className={clsx(
                  keyRefChipClass,
                  "transition-colors hover:border-amber hover:text-amber",
                )}
                data-testid="run-header-keyref"
                href={taskHref}
              >
                {keyRef}
              </Link>
            ) : (
              <span className={keyRefChipClass} data-testid="run-header-keyref">
                {keyRef}
              </span>
            )
          ) : null}
          {branch ? (
            <span
              className="min-w-0 truncate font-mono text-[11px] text-mute"
              data-testid="run-header-branch"
            >
              {labels.branch}: {branch}
              {targetBranch ? ` -> ${targetBranch}` : ""}
            </span>
          ) : null}
          {budgetBadge ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-line bg-amber-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-amber"
              data-testid="run-header-budget-warn"
            >
              <CurrencyDollarIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {budgetBadge}
            </span>
          ) : null}
          {labels.prChip ? (
            <PrStateChip
              labels={labels.prChip}
              prHasConflicts={prHasConflicts ?? null}
              prState={prState ?? null}
              runId={canReopen === false ? undefined : runId}
            />
          ) : null}
        </div>
        <h1 className="m-0 truncate font-sans text-[22px] font-bold leading-tight text-ink md:text-[26px]">
          {title}
        </h1>
        {taskPrompt ? (
          <details
            className="group mt-2 max-w-[760px]"
            data-testid="run-header-task"
          >
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mute hover:text-ink">
              <span className="transition-transform group-open:rotate-90">
                ›
              </span>
              {labels.task}
            </summary>
            <div className="mt-2">
              <MarkdownBody text={taskPrompt} />
            </div>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="rounded-[6px] border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink-2"
          data-dirty={changeSummary?.dirty ? "true" : "false"}
          data-testid="run-header-change-summary"
        >
          {labels.changes}: {changes}
        </span>
        {reviewHref &&
        promotionOperation &&
        labels.promote &&
        labels.promotionStarted &&
        labels.targetDrift ? (
          <RunHeaderPromotionAction
            labels={{
              promote: labels.promote,
              started: labels.promotionStarted,
              targetDrift: labels.targetDrift,
            }}
            operation={promotionOperation}
            reviewHref={reviewHref}
          />
        ) : reviewHref && labels.review ? (
          <Link
            className="rounded-[6px] border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] font-semibold text-ink-2 hover:bg-ivory"
            data-testid="run-header-review"
            href={reviewHref}
          >
            {labels.review}
          </Link>
        ) : null}
        <button
          aria-expanded={inspectorOpen}
          className="rounded-[6px] border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] font-semibold text-ink-2 hover:bg-ivory"
          data-testid="run-header-inspector-toggle"
          type="button"
          onClick={onToggleInspector}
        >
          {inspectorOpen ? labels.closeInspector : labels.openInspector}
        </button>
      </div>
    </header>
  );
}
