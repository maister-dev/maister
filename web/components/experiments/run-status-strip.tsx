import type { ExperimentComparisonRunDTO } from "@/lib/experiments/comparison";
import type { ExperimentMemberRunStatus } from "@/lib/experiments/types";
import type { ReactElement } from "react";

import { RUN_STATUS_DOT_CLASS } from "@/lib/runs/run-status-tone";

export type RunStatusLabels = Record<ExperimentMemberRunStatus, string>;

export function RunStatusStrip({
  run,
  labels,
}: {
  run: ExperimentComparisonRunDTO;
  labels: RunStatusLabels;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={`h-2 w-2 rounded-full ${RUN_STATUS_DOT_CLASS[run.statusTone]}`}
      />
      <span className="font-mono text-[11px] font-semibold text-ink">
        {labels[run.status]}
      </span>
      {run.runnerLabels.map((runner) => (
        <span
          key={runner}
          className="rounded-full border border-line bg-paper px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-mute"
        >
          {runner}
        </span>
      ))}
    </div>
  );
}
