import type { ResultStatus } from "@/lib/run-results/types";
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
  // ADR-165: the child's public-result state, or null when it has no contract.
  // Null renders NO glyph — most children publish nothing, and a placeholder on
  // every row would drown the ones that do.
  resultStatus?: ResultStatus | null;
}

// ADR-165: the same glyph vocabulary the public-result panel uses, so a child
// row and the child's own page agree at a glance.
const RESULT_GLYPH: Record<ResultStatus, string> = {
  valid: "✓",
  pending: "…",
  absent: "—",
  missing: "✗",
  stale: "!",
  invalid: "✗",
  unavailable: "—",
};

const RESULT_TONE: Record<ResultStatus, string> = {
  valid: "text-emerald",
  pending: "text-mute",
  absent: "text-mute",
  missing: "text-danger",
  stale: "text-amber",
  invalid: "text-danger",
  unavailable: "text-mute",
};

export interface RunInspectorChildRunsLabels {
  // Section title, e.g. "Spawned runs (2)" — already pluralized for the child
  // count by the (server) caller. A STRING, not a function: this label crosses
  // the RSC → Client boundary (LiveRunInspector is a Client Component) and a
  // function prop is not serializable across it.
  title: string;
  asRun: string;
  status: Record<RunStatusKey, string>;
  // ADR-165: accessible names for the result glyph. Icon-only affordances MUST
  // carry one (web/CLAUDE.md), and the glyph alone is not a name.
  resultStatus?: Record<ResultStatus, string>;
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
        {labels.title}
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
              {child.resultStatus && labels.resultStatus ? (
                <span
                  aria-label={labels.resultStatus[child.resultStatus]}
                  className={clsx(
                    "flex-none font-mono text-[11px]",
                    RESULT_TONE[child.resultStatus],
                  )}
                  data-result-status={child.resultStatus}
                  data-testid="child-run-result-glyph"
                  title={labels.resultStatus[child.resultStatus]}
                >
                  {RESULT_GLYPH[child.resultStatus]}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
