import type { BacklogCard } from "@/lib/queries/board";
import type { ReactElement } from "react";

import clsx from "clsx";
import Link from "next/link";

import { LaunchPopover } from "@/components/board/launch-popover";

export interface TaskCardProps {
  card: BacklogCard;
  projectId: string;
  slug: string;
  canAct: boolean;
  flowOptions: Array<{ id: string; label: string }>;
  runnerOptions: Array<{ id: string; label: string }>;
  launchLabel: string;
  launchDisabledLabel: string;
  launchDisabledReason?: string;
  blockedByLabel: string;
  unconfiguredLabel: string;
  triagedLabel: string;
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
  projectId,
  slug,
  canAct,
  flowOptions,
  runnerOptions,
  launchDisabledLabel,
  launchDisabledReason,
  launchLabel,
  blockedByLabel,
  unconfiguredLabel,
  triagedLabel,
}: TaskCardProps): ReactElement {
  // M33: a flowless simple-intent task renders the `unconfigured` chip — the
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
          {card.flowRef ?? unconfiguredLabel}
        </span>
      </div>
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
            flowOptions={flowOptions}
            label={launchLabel}
            projectId={projectId}
            runnerOptions={runnerOptions}
            slug={slug}
            taskId={card.taskId}
            taskNumber={card.number}
            verdict={{
              flowId: card.flowId,
              runnerId: card.runnerId,
              targetBranch: card.targetBranch,
              promotionMode: card.promotionMode,
            }}
          />
        ) : null}
      </div>
    </article>
  );
}
