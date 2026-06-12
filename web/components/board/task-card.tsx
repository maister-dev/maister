import type { BacklogCard } from "@/lib/queries/board";
import type { ReactElement } from "react";

import clsx from "clsx";
import Link from "next/link";

import { LaunchPopover } from "@/components/board/launch-popover";

export interface TaskCardProps {
  card: BacklogCard;
  slug: string;
  canAct: boolean;
  launchLabel: string;
  launchDisabledLabel: string;
  launchDisabledReason?: string;
  blockedByLabel: string;
  runsCountLabel: (count: number) => string;
}

const PRIO_STRIPE: Record<BacklogCard["priority"], string> = {
  high: "bg-amber",
  med: "bg-accent-2 opacity-60",
  low: "bg-mute-2 opacity-40",
};

const FLOW_CHIP: Record<string, string> = {
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
  runsCountLabel,
}: TaskCardProps): ReactElement {
  const chip = FLOW_CHIP[card.flowRef] ?? "text-mute bg-ivory border-line";

  return (
    <article className="group/task relative flex cursor-grab flex-col gap-2 rounded-[10px] border border-line bg-paper px-3.5 pb-3 pt-3 transition-[transform,box-shadow,border-color] hover:-translate-y-px hover:border-mute hover:shadow-[0_6px_18px_-10px_rgba(22,20,15,0.14)] active:cursor-grabbing">
      <span
        className={clsx(
          "absolute -left-px bottom-3 top-3 w-[3px] rounded-[3px]",
          PRIO_STRIPE[card.priority],
        )}
      />
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex-1 text-[13.5px] font-semibold leading-[1.35] tracking-[-0.005em] text-ink">
          <span className="mr-1.5 rounded border border-line bg-ivory px-1 py-px align-middle font-mono text-[9.5px] font-bold tracking-[0.05em] text-mute">
            {card.keyRef}
          </span>
          <Link
            className="align-middle hover:text-amber hover:underline"
            href={`/projects/${slug}/tasks/${card.number}`}
          >
            {card.title}
          </Link>
        </div>
        <span
          className={clsx(
            "flex-none rounded border px-[7px] py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.08em]",
            chip,
          )}
        >
          {card.flowRef}
        </span>
      </div>
      {card.runCount > 0 ? (
        <span
          className="w-fit rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.04em] text-ink-2"
          data-testid="board-runs-count"
        >
          {runsCountLabel(card.runCount)}
        </span>
      ) : null}
      <div className="font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute">
        {card.prompt}
      </div>
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
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-line-soft pt-2">
        <div className="flex items-center gap-2.5 font-mono text-[10px] tracking-[0.02em] text-mute" />
        {canAct ? (
          <LaunchPopover
            disabledLabel={launchDisabledLabel}
            disabledReason={launchDisabledReason}
            label={launchLabel}
            taskId={card.taskId}
          />
        ) : null}
      </div>
    </article>
  );
}
