import type { BacklogCard } from "@/lib/queries/board";
import type { RelationCandidate } from "@/components/social/relations-editor";
import type { TaskDecompositionLabels } from "@/components/board/task-decomposition";
import type { ReactElement } from "react";

import clsx from "clsx";
import Link from "next/link";

import { LaunchPopover } from "@/components/board/launch-popover";
import {
  TaskCardEditModal,
  TaskInlineEditableField,
} from "@/components/board/task-card-editing";
import { TaskDecomposition } from "@/components/board/task-decomposition";

export interface TaskCardProps {
  card: BacklogCard;
  slug: string;
  canAct: boolean;
  launchLabel: string;
  launchDisabledLabel: string;
  launchDisabledReason?: string;
  blockedByLabel: string;
  unconfiguredLabel: string;
  triagedLabel: string;
  runsCountLabel: (count: number) => string;
  decompositionLabels: TaskDecompositionLabels;
  relationCandidates: RelationCandidate[];
}

const PRIO_STRIPE: Record<BacklogCard["priority"], string> = {
  high: "bg-amber",
  med: "bg-accent-2 opacity-60",
  low: "bg-mute-2 opacity-40",
};

export const FLOW_CHIP: Record<string, string> = {
  bugfix: "text-amber bg-amber-soft border-amber-line",
  "spec-clarify":
    "text-accent-2 bg-accent-2-soft border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))]",
  autonomous:
    "text-accent-3 bg-accent-3-soft border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))]",
  refactor:
    "text-accent-4 bg-accent-4-soft border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))]",
};

export function TaskCard({
  card,
  slug,
  canAct,
  launchDisabledLabel,
  launchDisabledReason,
  launchLabel,
  blockedByLabel,
  unconfiguredLabel,
  triagedLabel,
  runsCountLabel,
  decompositionLabels,
  relationCandidates,
}: TaskCardProps): ReactElement {
  // M34: a flowless simple-intent task renders the `unconfigured` chip — the
  // launch popover collects the missing fields.
  const chip = card.flowRef
    ? (FLOW_CHIP[card.flowRef] ?? "text-mute bg-ivory border-line")
    : "text-danger bg-ivory border-line";

  return (
    <article className="group/task relative flex cursor-grab flex-col gap-2 rounded-[10px] border border-line bg-paper px-3.5 pb-3 pt-3 transition-[transform,box-shadow,border-color] hover:-translate-y-px hover:border-mute hover:shadow-[0_6px_18px_-10px_rgba(22,20,15,0.14)] active:cursor-grabbing">
      <span
        className={clsx(
          "absolute -left-px bottom-3 top-3 w-[3px] rounded-[3px]",
          PRIO_STRIPE[card.priority],
        )}
      />
      <div
        className="flex items-center justify-between gap-2 rounded-md border border-line-soft bg-ivory/70 px-2 py-1.5"
        data-testid="task-card-meta-bar"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link
            className="rounded border border-line bg-paper px-1.5 py-px font-mono text-[9.5px] font-bold tracking-[0.05em] text-mute transition hover:border-amber hover:text-amber focus:border-amber focus:text-amber"
            href={`/projects/${slug}/tasks/${card.number}`}
          >
            {card.keyRef}
          </Link>
          <span
            className={clsx(
              "rounded border px-1.5 py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.08em]",
              chip,
            )}
          >
            {card.flowRef ?? unconfiguredLabel}
          </span>
        </div>
        <TaskCardEditModal
          canEdit={canAct}
          card={card}
          relationCandidates={relationCandidates}
          slug={slug}
          triggerClassName="inline-flex h-6 w-6 flex-none items-center justify-center rounded-md border border-line bg-paper text-mute transition hover:border-amber hover:text-amber focus:border-amber focus:text-amber"
        />
      </div>
      <TaskInlineEditableField
        canEdit={canAct}
        className="min-w-0 text-[13.5px] font-semibold leading-[1.35] tracking-[-0.005em] text-ink"
        field="title"
        href={`/projects/${slug}/tasks/${card.number}`}
        slug={slug}
        taskNumber={card.number}
        value={card.title}
      />
      {card.runCount > 0 ? (
        <span
          className="w-fit rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.04em] text-ink-2"
          data-testid="board-runs-count"
        >
          {runsCountLabel(card.runCount)}
        </span>
      ) : null}
      <TaskInlineEditableField
        multiline
        canEdit={canAct}
        className="font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute"
        field="prompt"
        slug={slug}
        taskNumber={card.number}
        value={card.prompt}
      />
      {card.blockedBy.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-danger">
          <span>{blockedByLabel}</span>
          {card.blockedBy.map((blocker) => (
            <Link
              key={`${blocker.key}-${blocker.number}`}
              className="rounded border border-line bg-ivory px-1 py-px font-semibold hover:border-amber hover:text-amber"
              href={`/projects/${slug}/tasks/${blocker.number}`}
            >
              {blocker.key}-{blocker.number}
            </Link>
          ))}
        </div>
      ) : null}
      {card.childTasks.length > 0 ? (
        <TaskDecomposition
          childTasks={card.childTasks}
          labels={decompositionLabels}
          slug={slug}
        />
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-line-soft pt-2">
        <div className="flex items-center gap-2.5 font-mono text-[10px] tracking-[0.02em] text-mute">
          {card.triageStatus === "triaged" ? (
            <span className="rounded border border-line bg-ivory px-1.5 py-px font-semibold text-accent-4">
              {triagedLabel}
            </span>
          ) : null}
        </div>
        {canAct ? (
          <LaunchPopover
            disabledLabel={launchDisabledLabel}
            disabledReason={launchDisabledReason}
            hasRuns={card.runCount > 0}
            label={launchLabel}
            taskId={card.taskId}
          />
        ) : null}
      </div>
    </article>
  );
}
