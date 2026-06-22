import type { ChildRunRef } from "@/lib/queries/run";
import type { RunStatusKey } from "@/lib/runs/run-status-tone";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import {
  RUN_STATUS_DOT_CLASS,
  runStatusTone,
} from "@/lib/runs/run-status-tone";

export interface OrchestratorRunSubtreeLabels {
  // Section title, e.g. "Child runs (2)" — already pluralized for the child
  // count by the (server) caller. A STRING, not a function: this label is built
  // server-side and crosses the RSC → Client boundary, where a function prop is
  // not serializable.
  title: string;
  // Accessible name + visible eyebrow describing the delegation target column.
  agent: string;
  // Fallback ref shown for a task-less ("as-run") child.
  asRun: string;
  // Localized run-status labels, keyed by the runs.status string.
  status: Record<RunStatusKey, string>;
  // Empty state (rendered only when explicitly asked to; normally the parent
  // renders nothing for an empty tree).
  empty: string;
}

export interface OrchestratorRunSubtreeProps {
  childRuns: ChildRunRef[];
  labels: OrchestratorRunSubtreeLabels;
}

function statusLabel(
  labels: OrchestratorRunSubtreeLabels,
  status: string,
): string {
  return labels.status[status as RunStatusKey] ?? status;
}

// M37 Phase 6 (ADR-098): the dynamic run-tree subtree shown BELOW the flow
// graph on an orchestrator run's workbench. Each child is a visually
// subordinate (dashed, soft) sub-node card carrying its RUN-status dot/badge,
// task ref (KEY-N) or the as-run fallback, the delegation target agent id, and
// a link to the child run. Pure presentational — the parent loads
// getChildRuns(runId) and the localized labels.
export function OrchestratorRunSubtree({
  childRuns,
  labels,
}: OrchestratorRunSubtreeProps): ReactElement {
  return (
    <section
      aria-label={labels.title}
      className="mt-3 rounded-[12px] border border-dashed border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] p-4"
      data-testid="orchestrator-run-subtree"
    >
      <h2 className="m-0 mb-3 inline-flex items-center gap-2 font-sans text-[13px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>
      {childRuns.length === 0 ? (
        <p
          className="m-0 rounded-[8px] border border-dashed border-line bg-paper px-3 py-4 text-center font-mono text-[11px] text-mute"
          data-testid="orchestrator-run-subtree-empty"
        >
          {labels.empty}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {childRuns.map((child) => {
            const tone = runStatusTone(child.status);
            const ref =
              child.taskKey !== null && child.taskNumber !== null
                ? `${child.taskKey}-${child.taskNumber}`
                : labels.asRun;

            return (
              <li
                key={child.runId}
                className="relative rounded-[10px] border border-dashed border-line bg-paper px-3 py-2.5 transition-[border-color] hover:border-mute"
                data-child-run-id={child.runId}
                data-run-status={child.status}
              >
                <Link
                  aria-label={`${ref}: ${child.taskTitle ?? child.runId}`}
                  className="absolute inset-0 z-0"
                  href={`/runs/${child.runId}`}
                />
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      "h-2 w-2 flex-none rounded-full",
                      RUN_STATUS_DOT_CLASS[tone],
                    )}
                    data-run-tone={tone}
                  />
                  <span
                    className="relative z-10 flex-none rounded border border-line bg-ivory px-1 py-px font-mono text-[9.5px] font-bold tracking-[0.05em] text-mute"
                    data-as-run={child.taskKey === null ? "true" : "false"}
                  >
                    {ref}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.005em] text-ink">
                    {child.taskTitle ?? child.runId}
                  </span>
                  <span className="flex-none font-mono text-[10px] font-semibold tracking-[0.02em] text-mute-2">
                    {statusLabel(labels, child.status)}
                  </span>
                </div>
                {child.delegationAgentId ? (
                  <div className="mt-1.5 flex items-center gap-1.5 pl-4 font-mono text-[10px] tracking-[0.02em] text-mute">
                    <span className="text-mute-2">{labels.agent}</span>
                    <span
                      className="rounded border border-line bg-ivory px-1 py-px font-semibold text-ink-2"
                      data-testid="orchestrator-child-agent"
                    >
                      {child.delegationAgentId}
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
