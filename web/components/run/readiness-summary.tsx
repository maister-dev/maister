import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { ReactElement } from "react";

import clsx from "clsx";

export interface ReadinessSummaryLabels {
  state: Record<ReadinessState, string>;
  summary: string;
  reasons: string;
}

export interface ReadinessSummaryProps {
  state: ReadinessState;
  reasons: string[];
  labels: ReadinessSummaryLabels;
}

const STATE_BADGE: Record<ReadinessState, string> = {
  ready: "border-good bg-good-soft text-good",
  blocked:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  failed:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  stale: "border-amber-line bg-amber-soft text-amber",
  waiting: "border-amber-line bg-amber-soft text-amber",
  overridden: "border-line bg-ivory text-ink-2",
};

export function ReadinessSummary({
  state,
  reasons,
  labels,
}: ReadinessSummaryProps): ReactElement {
  const stateLabel = labels.state[state];

  return (
    <section className="rounded-[14px] border border-line bg-paper p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
          {labels.summary}
        </h2>
        <span
          aria-label={stateLabel}
          className={clsx(
            "rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]",
            STATE_BADGE[state],
          )}
          data-readiness={state}
          title={stateLabel}
        >
          {stateLabel}
        </span>
      </div>

      {reasons.length > 0 ? (
        <div className="mt-4">
          <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
            {labels.reasons}
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {reasons.map((reason, idx) => (
              <li
                key={idx}
                className="flex gap-2 text-[13px] leading-[1.4] text-body before:flex-none before:text-mute before:content-['•']"
              >
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
