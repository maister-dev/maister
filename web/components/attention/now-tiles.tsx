import type { TaskDisplayStatusKey } from "@/lib/tasks/task-display-status";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import { TaskStatusChip } from "@/components/tasks/task-status-chip";

export interface NowTilesProps {
  counts: ReadonlyMap<TaskDisplayStatusKey, number>;
  heading: string;
  locale: string;
  activeStatus: TaskDisplayStatusKey | null;
}

export function NowTiles({
  counts,
  heading,
  locale,
  activeStatus,
}: NowTilesProps): ReactElement {
  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <section
      aria-label={heading}
      className="flex flex-col gap-3.5"
      data-testid="now-tiles"
    >
      <h2 className="m-0 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
        {heading}
      </h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {[...counts].map(([status, count]) => {
          const active = status === activeStatus;

          return (
            <Link
              key={status}
              aria-current={active ? "true" : undefined}
              className={clsx(
                "flex flex-col gap-1 rounded-[14px] border px-4 py-3 no-underline shadow-[var(--shadow-sm)] transition-transform hover:-translate-y-px",
                active
                  ? "border-amber-line bg-amber-soft"
                  : "border-line bg-paper",
              )}
              data-now-tile={status}
              href={active ? "/" : `/?status=${status}`}
            >
              <span
                className="font-mono text-[22px] font-semibold leading-none text-ink"
                data-testid={`now-tile-${status}`}
              >
                {numberFormat.format(count)}
              </span>
              <TaskStatusChip status={status} />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
