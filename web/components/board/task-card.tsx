import type { BacklogCard } from "@/lib/queries/board";
import type { ReactElement } from "react";

import clsx from "clsx";

import { LaunchButton } from "@/components/board/launch-button";

export interface TaskCardProps {
  card: BacklogCard;
  canAct: boolean;
  launchLabel: string;
  launchDisabledLabel: string;
  launchDisabledReason?: string;
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
  canAct,
  launchDisabledLabel,
  launchDisabledReason,
  launchLabel,
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
          {card.title}
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
      <div className="font-mono text-[11px] leading-[1.45] tracking-[0.01em] text-mute">
        {card.prompt}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-line-soft pt-2">
        <div className="flex items-center gap-2.5 font-mono text-[10px] tracking-[0.02em] text-mute" />
        {canAct ? (
          <LaunchButton
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
