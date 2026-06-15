import type { ReactElement } from "react";

import clsx from "clsx";

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
}

export interface RunHeaderProps {
  title: string;
  subtitle?: string;
  status: string;
  branch?: string | null;
  targetBranch?: string | null;
  changeSummary?: RunHeaderChangeSummary | null;
  inspectorOpen: boolean;
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
  status,
  branch,
  targetBranch,
  changeSummary,
  inspectorOpen,
  labels,
  onToggleInspector,
}: RunHeaderProps): ReactElement {
  const changes = formatRunChangeSummary(changeSummary, labels);

  return (
    <header
      className="flex flex-col gap-3 border-b border-line pb-4 md:flex-row md:items-start md:justify-between"
      data-testid="run-header"
    >
      <div className="min-w-0">
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
          {branch ? (
            <span
              className="min-w-0 truncate font-mono text-[11px] text-mute"
              data-testid="run-header-branch"
            >
              {labels.branch}: {branch}
              {targetBranch ? ` -> ${targetBranch}` : ""}
            </span>
          ) : null}
        </div>
        <h1 className="m-0 truncate font-sans text-[22px] font-bold leading-tight text-ink md:text-[26px]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-[760px] text-[13px] leading-5 text-mute">
            {subtitle}
          </p>
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
