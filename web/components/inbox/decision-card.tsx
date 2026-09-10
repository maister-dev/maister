import type { WorkStageLabels } from "@/components/work/work-stage-chip";
import type { DecisionItem } from "@/lib/queries/decisions";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import { RunRecoverActions } from "@/components/runs/run-recover-actions";
import { WorkStageChip } from "@/components/work/work-stage-chip";

export interface DecisionCardLabels {
  review: string;
  openTask: string;
  stage: WorkStageLabels;
}

// The three non-HITL decision populations on the same card shell the HITL cards
// use. Actions route to the surface that OWNS them — recover/discard inline
// through the existing endpoints, promotion through the run's review surface,
// which is the only place the drift-guarded reviewed target commit exists.
export function DecisionCard({
  item,
  labels,
}: {
  item: Extract<DecisionItem, { kind: "crashed" | "promotable" | "flagged" }>;
  labels: DecisionCardLabels;
}): ReactElement {
  const taskHref =
    item.taskId !== null && item.taskKey !== null
      ? `/projects/${item.projectSlug}/tasks/${item.taskKey.split("-").pop()}`
      : null;

  return (
    <article
      className={clsx(
        "flex flex-col gap-2.5 rounded-[14px] border border-l-2 border-line bg-paper px-4 py-3.5",
        item.kind === "crashed"
          ? "border-l-[var(--status-red)]"
          : "border-l-line",
      )}
      data-decision-kind={item.kind}
      data-testid="decision-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <WorkStageChip
          blocked={false}
          labels={labels.stage}
          progress={null}
          promotedKind={null}
          stage={item.stage}
        />
        <span className="font-mono text-[11px] text-mute">
          {item.projectName}
        </span>
        {item.taskKey !== null ? (
          <span className="font-mono text-[11px] font-semibold text-ink-2">
            {item.taskKey}
          </span>
        ) : null}
      </div>

      <p className="m-0 text-[13px] leading-[1.45] text-ink">
        {item.taskTitle ?? item.taskKey ?? item.projectName}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {item.kind === "crashed" ? (
          <RunRecoverActions
            canRecover={item.crashed.action === "recover"}
            runId={item.crashed.runId}
          />
        ) : null}
        {item.kind === "promotable" && item.runId !== null ? (
          <Link
            className="inline-flex h-8 items-center rounded-[10px] border border-line bg-ivory px-3 text-[12.5px] font-semibold text-ink no-underline"
            href={`/runs/${item.runId}`}
          >
            {labels.review}
          </Link>
        ) : null}
        {item.kind === "flagged" && taskHref !== null ? (
          <Link
            className="inline-flex h-8 items-center rounded-[10px] border border-line bg-ivory px-3 text-[12.5px] font-semibold text-ink no-underline"
            href={taskHref}
          >
            {labels.openTask}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
