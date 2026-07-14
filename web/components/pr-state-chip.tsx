import type { ReactElement } from "react";

import clsx from "clsx";
import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";

export type PrState = "open" | "merged" | "closed";

export interface PrStateChipLabels {
  open: string;
  merged: string;
  closed: string;
  conflicts: string;
  reopen: string;
}

export interface PrStateChipProps {
  prState: PrState | null;
  prHasConflicts: boolean | null;
  labels: PrStateChipLabels;
}

const CHIP =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold";

const STATE_ICON: Record<PrState, typeof CheckCircleIcon> = {
  open: ArrowsRightLeftIcon,
  merged: CheckCircleIcon,
  closed: XCircleIcon,
};

// merged reads as success (green check glyph); open is neutral; closed is a
// muted danger tone. Tokens mirror readiness-badge so PR status never drifts in
// colour across the run header and the board card.
const STATE_TONE: Record<PrState, string> = {
  open: "border-line bg-ivory text-ink-2",
  merged: "border-good bg-good-soft text-good",
  closed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
};

// Shared PR-lifecycle chip (ADR-137). Self-hiding: renders nothing until a scan
// records a PR state or a conflict. Conflicts take visual precedence — an
// unmergeable PR is the operator's most urgent signal — and carry the (disabled)
// reopen affordance until Task 12 wires the action.
export function PrStateChip({
  prState,
  prHasConflicts,
  labels,
}: PrStateChipProps): ReactElement | null {
  if (prHasConflicts === true) {
    return (
      <span
        className={clsx(CHIP, "border-amber-line bg-amber-soft text-amber")}
        data-pr-conflicts="true"
        data-testid="pr-state-chip"
      >
        <ExclamationTriangleIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {labels.conflicts}
        {/* wired by Task 12 (reopen) */}
        <button
          disabled
          aria-label={labels.reopen}
          className="ml-0.5 inline-flex cursor-not-allowed items-center opacity-50"
          data-testid="pr-reopen"
          title={labels.reopen}
          type="button"
        >
          <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  if (prState === null) return null;

  const Icon = STATE_ICON[prState];

  return (
    <span
      className={clsx(CHIP, STATE_TONE[prState])}
      data-pr-state={prState}
      data-testid="pr-state-chip"
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {labels[prState]}
    </span>
  );
}
