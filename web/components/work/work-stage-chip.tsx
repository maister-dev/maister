import type { ReactElement } from "react";
import type { RunStatusValue } from "@/lib/runs/run-status-values";
import type { PromotedKind, WorkProgress, WorkStage } from "@/lib/work/stage";

import clsx from "clsx";
import {
  ArchiveBoxXMarkIcon,
  BoltIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  HandRaisedIcon,
  InboxArrowDownIcon,
  LockClosedIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from "@heroicons/react/24/outline";

/**
 * The run statuses `STAGE_BY_RUN_STATUS` collapses many-to-one (ADR-174).
 *
 * A live session, a checkpoint and a manual takeover are all `WaitingOnHuman`;
 * a running graph and a parked orchestrator are both `Executing`. The raw-enum
 * column used to carry that distinction, and `REQ-D8` moves it here rather than
 * dropping it — the column went away, the information did not.
 *
 * Spelled out under `satisfies` so a twelfth run status that ALSO collapses is
 * a compile error rather than a silently unrefined chip.
 */
export const STAGE_REFINEMENTS = [
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "Running",
  "WaitingOnChildren",
] as const satisfies readonly RunStatusValue[];

export type StageRefinement = (typeof STAGE_REFINEMENTS)[number];

// The whole `workStage` namespace, passed in so the lookup happens ONCE at the
// render root and no call site grows its own switch (ADR-170).
export type WorkStageLabels = Record<
  WorkStage | "blocked" | "promotedResult" | `run${StageRefinement}`,
  string
>;

export interface WorkStageChipProps {
  stage: WorkStage;
  blocked: boolean;
  promotedKind: PromotedKind | null;
  progress: WorkProgress | null;
  labels: WorkStageLabels;
  /**
   * OPTIONAL by contract (`REQ-D8`). `decision-card.tsx`, `hitl-card.tsx` and
   * `flight-card.tsx` all render this chip and pass none; a chip given none
   * MUST render exactly as it did before the refinement existed.
   */
  runStatus?: RunStatusValue | null;
  // Icon-only mode still needs an accessible name, so the label is rendered as
  // `aria-label` rather than dropped.
  iconOnly?: boolean;
}

const CHIP =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold";

const STAGE_ICON: Record<WorkStage, typeof CheckCircleIcon> = {
  Triage: InboxArrowDownIcon,
  Held: HandRaisedIcon,
  Ready: PlayCircleIcon,
  Queued: ClockIcon,
  Executing: BoltIcon,
  WaitingOnHuman: PauseCircleIcon,
  Review: EyeIcon,
  Crashed: ExclamationTriangleIcon,
  Promoted: CheckCircleIcon,
  Abandoned: ArchiveBoxXMarkIcon,
};

// Only genuinely actionable stages carry the amber attention tone; a promoted
// run reads as success (green check glyph). `blocked` deliberately does NOT get
// the attention tone — it looks like it needs a human and does not (ADR-169 D7).
const STAGE_TONE: Record<WorkStage, string> = {
  Triage: "border-line bg-ivory text-ink-2",
  Held: "border-amber-line bg-amber-soft text-amber",
  Ready: "border-line bg-paper text-ink-2",
  Queued: "border-line bg-ivory text-mute",
  Executing: "border-line bg-paper text-ink-2",
  WaitingOnHuman: "border-amber-line bg-amber-soft text-amber",
  Review: "border-line bg-ivory text-ink-2",
  Crashed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  Promoted: "border-good bg-good-soft text-good",
  Abandoned: "border-line bg-ivory text-mute",
};

// The single label lookup. A result-only completion is NOT a promoted branch,
// so it does not borrow the "Promoted" copy (ADR-170 D3).
export function workStageLabel(
  labels: WorkStageLabels,
  stage: WorkStage,
  promotedKind: PromotedKind | null,
): string {
  if (stage === "Promoted" && promotedKind === "result") {
    return labels.promotedResult;
  }

  return labels[stage];
}

function refinementOf(
  runStatus: RunStatusValue | null | undefined,
): StageRefinement | null {
  return runStatus !== null &&
    runStatus !== undefined &&
    (STAGE_REFINEMENTS as readonly string[]).includes(runStatus)
    ? (runStatus as StageRefinement)
    : null;
}

export function WorkStageChip({
  stage,
  blocked,
  promotedKind,
  progress,
  labels,
  runStatus,
  iconOnly = false,
}: WorkStageChipProps): ReactElement {
  const Icon = STAGE_ICON[stage];
  const label = workStageLabel(labels, stage, promotedKind);
  const counted =
    progress !== null && progress.total > 0
      ? `${label} ${progress.done}/${progress.total}`
      : label;
  const refinement = refinementOf(runStatus);
  // The refinement joins the ACCESSIBLE name too, not just the painted text —
  // an icon-only chip is exactly where losing it would be invisible.
  const named =
    refinement === null
      ? counted
      : `${counted} — ${labels[`run${refinement}`]}`;

  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-label={iconOnly ? named : undefined}
        className={clsx(CHIP, STAGE_TONE[stage])}
        data-testid="work-stage-chip"
        data-work-stage={stage}
        title={iconOnly ? named : undefined}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {iconOnly ? null : counted}
        {refinement === null || iconOnly ? null : (
          <span
            className="font-normal text-[10px] opacity-80"
            data-work-run-status={refinement}
          >
            {labels[`run${refinement}`]}
          </span>
        )}
      </span>
      {blocked ? (
        <span
          aria-label={iconOnly ? labels.blocked : undefined}
          className={clsx(CHIP, "border-line bg-ivory text-mute")}
          data-testid="work-stage-blocked"
          title={iconOnly ? labels.blocked : undefined}
        >
          <LockClosedIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {iconOnly ? null : labels.blocked}
        </span>
      ) : null}
    </span>
  );
}
