"use client";

import type {
  RailWorkspaceRow,
  RailWorkspaceTone,
} from "@/lib/queries/portfolio";
import type { ReactElement, ReactNode } from "react";

import { CpuChipIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import clsx from "clsx";

import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

// needs / waiting use the warm --attention token (the only warm accent besides
// --danger); running keeps the shared pulse keyframe from globals.css.
const dotByTone: Record<RailWorkspaceTone, string> = {
  running: "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]",
  waiting: "bg-attention",
  needs: "bg-attention",
  human: "bg-ink-2",
  review: "bg-accent-2",
  crashed: "bg-danger",
};

const chipClass =
  "inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-line bg-ivory px-1.5 py-px font-mono text-[9.5px] text-mute";

// Server-translated, per-row display strings. Built in left-rail.tsx so the
// presentational view stays hook-free (unit-testable via renderToStaticMarkup).
export interface ActiveWorkspaceRowLabels {
  statusWord: string;
  attention: boolean;
  flowLabel: string | null;
  flowTooltip: string | null;
  flowAria: string | null;
  runnerLabel: string | null;
  runnerTooltip: string | null;
  runnerAria: string | null;
  issueLabel: string | null;
  issueAria: string | null;
  ttlTone: "warning" | "due" | null;
  ttlLabel: string | null;
  ttlCountdown: string | null;
  archivedLabel: string | null;
}

function FlowIcon(): ReactElement {
  return (
    <WrenchScrewdriverIcon
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0"
      data-testid="flow-chip-icon"
    />
  );
}

function RunnerIcon(): ReactElement {
  return (
    <CpuChipIcon
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0"
      data-testid="runner-chip-icon"
    />
  );
}

interface ViewProps {
  tone: RailWorkspaceTone;
  name: string;
  runHref: string;
  time: string;
  issueHref: string | null;
  labels: ActiveWorkspaceRowLabels;
  actions?: ReactNode;
}

// Pure presentational row — NO hooks. Two-line compact layout from preformatted
// props. Line 1 has a fixed min-height and a reserved right slot so swapping the
// resting time for the hover actions never moves the row or the name link.
export function ActiveWorkspaceRowView({
  tone,
  name,
  runHref,
  time,
  issueHref,
  labels,
  actions,
}: ViewProps): ReactElement {
  return (
    <div
      className="group relative flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors hover:bg-ivory focus-within:bg-ivory"
      data-testid="active-workspace-row"
    >
      <div className="flex min-h-[26px] items-center gap-2">
        <span
          aria-label={labels.statusWord}
          className={clsx("h-2 w-2 shrink-0 rounded-full", dotByTone[tone])}
          data-status-tone={tone}
          role="img"
          title={labels.statusWord}
        />
        <Link
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold tracking-[-0.005em] text-ink hover:text-amber"
          href={runHref}
        >
          {name}
        </Link>
        {labels.attention ? (
          <span
            className="shrink-0 font-mono text-[10px] font-semibold tracking-[0.02em] text-attention"
            data-testid="status-word"
          >
            {labels.statusWord}
          </span>
        ) : null}
        <div className="flex min-w-[76px] shrink-0 items-center justify-end gap-1">
          <span
            className="font-mono text-[10px] tracking-[0.04em] text-mute-2 group-hover:hidden group-focus-within:hidden"
            data-testid="row-time"
          >
            {time}
          </span>
          {actions ? (
            <div className="hidden items-center gap-1 group-hover:flex group-focus-within:flex">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-4">
        {labels.flowLabel ? (
          <span
            aria-label={labels.flowAria ?? undefined}
            className={chipClass}
            data-testid="flow-chip"
            title={labels.flowTooltip ?? undefined}
          >
            <FlowIcon />
            <span className="truncate">{labels.flowLabel}</span>
          </span>
        ) : null}
        {labels.runnerLabel ? (
          <span
            aria-label={labels.runnerAria ?? undefined}
            className={chipClass}
            data-testid="runner-chip"
            title={labels.runnerTooltip ?? undefined}
          >
            <RunnerIcon />
            <span className="truncate">{labels.runnerLabel}</span>
          </span>
        ) : null}
        {issueHref && labels.issueLabel ? (
          <Link
            aria-label={labels.issueAria ?? undefined}
            className={clsx(chipClass, "hover:border-mute hover:text-ink-2")}
            data-testid="issue-chip"
            href={issueHref}
          >
            {labels.issueLabel}
          </Link>
        ) : null}
        {labels.ttlTone && labels.ttlLabel ? (
          <span
            className={clsx(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.06em]",
              labels.ttlTone === "due"
                ? "border-red-300 bg-red-50 text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
                : "border-amber-line bg-amber-soft text-attention",
            )}
            data-testid="ttl-badge"
            data-ttl-state={labels.ttlTone}
          >
            <span
              className={clsx(
                "h-[5px] w-[5px] rounded-full",
                labels.ttlTone === "due" ? "bg-red-500" : "bg-attention",
              )}
            />
            {labels.ttlLabel}
            {labels.ttlCountdown ? (
              <span
                suppressHydrationWarning
                className="font-normal normal-case tracking-normal"
              >
                · {labels.ttlCountdown}
              </span>
            ) : null}
          </span>
        ) : null}
        {labels.archivedLabel ? (
          <span
            className="inline-flex items-center rounded-full border border-line bg-ivory px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-mute"
            data-testid="ttl-archived"
          >
            {labels.archivedLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Thin client wrapper: supplies the lifecycle `menu` action-sheet (inline Stop +
// ⋯ overflow, with scratch rename inside the sheet) to the pure view. The menu
// always offers "Open run", so it renders for every row.
export function ActiveWorkspaceRow({
  row,
  labels,
}: {
  row: RailWorkspaceRow;
  labels: ActiveWorkspaceRowLabels;
}): ReactElement {
  return (
    <ActiveWorkspaceRowView
      actions={
        <WorkbenchLifecycleActions
          actions={row.lifecycleActions}
          runHref={row.href}
          runId={row.runId}
          runKind={row.runKind}
          runLabel={row.name}
          taskKey={row.taskKey}
          taskNumber={row.taskNumber}
          variant="menu"
        />
      }
      issueHref={row.issueHref}
      labels={labels}
      name={row.name}
      runHref={row.href}
      time={row.time}
      tone={row.statusTone}
    />
  );
}
