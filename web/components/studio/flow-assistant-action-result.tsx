"use client";

import type { ScratchFlowActionResultPayload } from "@/lib/scratch-runs/transcript";
import type { ReactElement } from "react";

import clsx from "clsx";

export type FlowAssistantActionResultLabels = {
  status: Record<ScratchFlowActionResultPayload["status"], string>;
  touchedFiles: string;
  issues: string;
};

export function FlowAssistantActionResult({
  payload,
  labels,
}: {
  payload: ScratchFlowActionResultPayload;
  labels: FlowAssistantActionResultLabels;
}): ReactElement {
  const success = payload.status === "applied";
  const warn = payload.status === "stale";

  return (
    <section
      className={clsx(
        "min-w-0 max-w-full overflow-hidden rounded-lg border px-3 py-2.5 text-[12px] leading-[1.45]",
        success
          ? "border-accent-3 bg-accent-3-soft text-accent-3"
          : warn
            ? "border-amber-line bg-amber-soft text-amber"
            : "border-danger-line bg-danger-soft text-danger",
      )}
      data-testid="studio-flow-action-result"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em]">
            {labels.status[payload.status]}
          </div>
          <div className="mt-1 text-[13px] font-semibold text-ink">
            {payload.summary}
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-current/25 px-2 py-0.5 font-mono text-[10px]">
          {payload.operations.length}
        </span>
      </div>

      {payload.touchedPaths.length > 0 ? (
        <div className="mt-2 min-w-0">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] opacity-75">
            {labels.touchedFiles}
          </div>
          <ul className="mt-1 grid max-h-28 list-none gap-1 overflow-auto p-0 font-mono text-[10.5px]">
            {payload.touchedPaths.map((path) => (
              <li
                key={path}
                className="truncate rounded bg-paper/60 px-2 py-1 text-ink"
              >
                {path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {payload.issues && payload.issues.length > 0 ? (
        <div className="mt-2 min-w-0">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] opacity-75">
            {labels.issues}
          </div>
          <ul className="mt-1 grid max-h-28 list-disc gap-1 overflow-auto pl-4 text-[11px]">
            {payload.issues.map((issue, index) => (
              <li key={`${index}-${issue}`} className="break-words">
                {issue}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {payload.message ? (
        <p className="mt-2 text-[11.5px] text-current/80">{payload.message}</p>
      ) : null}
    </section>
  );
}
