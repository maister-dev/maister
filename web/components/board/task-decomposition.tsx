import type { ChildTaskRef } from "@/lib/queries/board";
import type { RunStatusKey } from "@/lib/runs/run-status-tone";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import {
  RUN_STATUS_DOT_CLASS,
  runStatusTone,
} from "@/lib/runs/run-status-tone";

export interface TaskDecompositionLabels {
  // Group title, e.g. "Decomposition ({count})".
  title: (count: number) => string;
  // Status shown for a child task that has never been launched.
  noRun: string;
  // Localized run-status labels keyed by the runs.status string.
  status: Record<RunStatusKey, string>;
}

export interface TaskDecompositionProps {
  childTasks: ChildTaskRef[];
  slug: string;
  labels: TaskDecompositionLabels;
}

// M37 Phase 6 (ADR-098): the collapsible decomposition group rendered UNDER a
// parent (orchestrator) task card. Each child is a mini-row: a RUN-status dot,
// the child KEY-N, and the title, linking to the child task. Sibling section —
// it does not touch the card body. The parent renders nothing when there are
// no children, so this assumes a non-empty list.
export function TaskDecomposition({
  childTasks,
  slug,
  labels,
}: TaskDecompositionProps): ReactElement {
  return (
    <details
      className="rounded-[8px] border border-dashed border-line-soft bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))]"
      data-testid="task-decomposition"
    >
      <summary className="cursor-pointer list-none px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-mute marker:hidden">
        {labels.title(childTasks.length)}
      </summary>
      <ul className="m-0 flex list-none flex-col gap-1 p-2 pt-0">
        {childTasks.map((child) => {
          const tone =
            child.latestRunStatus !== null
              ? runStatusTone(child.latestRunStatus)
              : "pending";
          const statusLabel =
            child.latestRunStatus !== null
              ? (labels.status[child.latestRunStatus as RunStatusKey] ??
                child.latestRunStatus)
              : labels.noRun;

          return (
            <li
              key={child.taskId}
              className="flex items-center gap-2 rounded-[6px] border border-line bg-paper px-2 py-1.5"
              data-child-task-id={child.taskId}
              data-run-status={child.latestRunStatus ?? "none"}
            >
              <span
                className={clsx(
                  "h-2 w-2 flex-none rounded-full",
                  RUN_STATUS_DOT_CLASS[tone],
                )}
                data-run-tone={tone}
              />
              <Link
                className="flex-none rounded border border-line bg-ivory px-1 py-px font-mono text-[9.5px] font-bold tracking-[0.05em] text-mute hover:border-amber hover:text-amber"
                href={`/projects/${slug}/tasks/${child.number}`}
              >
                {child.keyRef}
              </Link>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">
                {child.title}
              </span>
              <span className="flex-none font-mono text-[9.5px] tracking-[0.02em] text-mute-2">
                {statusLabel}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
