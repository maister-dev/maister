import type { RunStatusKey } from "@/lib/runs/run-status-tone";
import type { ReactElement } from "react";

import clsx from "clsx";

import {
  RUN_STATUS_DOT_CLASS,
  runStatusTone,
} from "@/lib/runs/run-status-tone";

export interface RunInspectorChildRun {
  runId: string;
  status: string;
  // KEY-N back-reference; null for a task-less ("as-run") child.
  taskRef: string | null;
}

export interface RunInspectorChildRunsLabels {
  // Section title, e.g. "Spawned runs ({count})".
  title: (count: number) => string;
  asRun: string;
  status: Record<RunStatusKey, string>;
}

export interface RunInspectorChildRunsListProps {
  childRuns: RunInspectorChildRun[];
  labels: RunInspectorChildRunsLabels;
}

// M37 Phase 6 (ADR-098): the expandable "Spawned runs (N)" section in the
// run-detail inspector. Each row is a status dot + the child's task ref (or the
// as-run fallback) + a link to the child run. The parent renders nothing when
// there are no children, so this component assumes a non-empty list.
export function RunInspectorChildRunsList({
  childRuns,
  labels,
}: RunInspectorChildRunsListProps): ReactElement {
  return (
    <details
      open
      className="rounded-[8px] border border-line bg-paper"
      data-testid="run-inspector-child-runs"
    >
      <summary className="cursor-pointer list-none px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-mute marker:hidden">
        {labels.title(childRuns.length)}
      </summary>
      <ul className="m-0 flex list-none flex-col gap-1 p-2 pt-0">
        {childRuns.map((child) => {
          const tone = runStatusTone(child.status);

          return (
            <li
              key={child.runId}
              className="flex items-center gap-2 rounded-[6px] border border-line bg-ivory px-2 py-1.5"
              data-child-run-id={child.runId}
              data-run-status={child.status}
            >
              <span
                className={clsx(
                  "h-2 w-2 flex-none rounded-full",
                  RUN_STATUS_DOT_CLASS[tone],
                )}
                data-run-tone={tone}
              />
              <a
                className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink hover:underline"
                data-as-run={child.taskRef === null ? "true" : "false"}
                href={`/runs/${child.runId}`}
              >
                {child.taskRef ?? labels.asRun}
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
