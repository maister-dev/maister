import type { FlowVerificationState } from "@/lib/queries/readiness";
import type { ReactElement } from "react";

import clsx from "clsx";

import { READINESS_BADGE } from "@/components/readiness-badge";

export interface ReadinessSummaryLabels {
  state: Record<FlowVerificationState, string>;
  summary: string;
  reasons: string;
}

export interface ReadinessSummaryProps {
  state: FlowVerificationState;
  reasons: string[];
  evidenceHref?: string;
  evidenceLabel?: string;
  labels: ReadinessSummaryLabels;
}

export function ReadinessSummary({
  state,
  reasons,
  evidenceHref,
  evidenceLabel,
  labels,
}: ReadinessSummaryProps): ReactElement {
  const stateLabel = labels.state[state];

  const badge =
    state in READINESS_BADGE
      ? READINESS_BADGE[state as keyof typeof READINESS_BADGE]
      : "border-line text-mute";
  const containerClass =
    "w-fit max-w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-sm font-medium text-ink";
  const label = (
    <>
      <span className="mr-2">{labels.summary}</span>
      <span
        className={clsx(
          "rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]",
          badge,
        )}
        data-readiness={state}
        title={stateLabel}
      >
        {stateLabel}
      </span>
    </>
  );

  if (reasons.length === 0)
    return (
      <div className={containerClass} data-testid="flow-verification">
        {label}
      </div>
    );

  return (
    <details className={containerClass} data-testid="flow-verification">
      <summary className="cursor-pointer">{label}</summary>
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
        {evidenceHref && evidenceLabel ? (
          <a className="text-xs underline" href={evidenceHref}>
            {evidenceLabel}
          </a>
        ) : null}
      </div>
    </details>
  );
}
