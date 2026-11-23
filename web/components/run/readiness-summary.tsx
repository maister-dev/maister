import type { FlowVerificationState } from "@/lib/queries/readiness";
import type { ReactElement, ReactNode } from "react";

import clsx from "clsx";

import { READINESS_BADGE } from "@/components/readiness-badge";

export interface ReadinessSummaryLabels {
  state: Record<FlowVerificationState, string>;
  summary: string;
  reasons: string;
}

interface ReadinessSummaryReason {
  id: string;
  explanation: string;
  nextAction: string;
  evidence?: ReactNode;
}

export interface ReadinessSummaryProps {
  state: FlowVerificationState;
  reasons: ReadinessSummaryReason[];
  labels: ReadinessSummaryLabels;
}

export function ReadinessSummary({
  state,
  reasons,
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
      <div
        className={containerClass}
        data-testid="flow-verification"
        tabIndex={-1}
      >
        {label}
      </div>
    );

  return (
    <details
      className={containerClass}
      data-testid="flow-verification"
      tabIndex={-1}
    >
      <summary className="cursor-pointer">{label}</summary>
      <div className="mt-4">
        <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
          {labels.reasons}
        </h3>
        <ul className="mt-2 flex flex-col gap-1.5">
          {reasons.map((reason) => (
            <li
              key={reason.id}
              className="flex gap-2 text-[13px] leading-[1.4] text-body before:flex-none before:text-mute before:content-['•']"
              data-check-row={reason.id}
              tabIndex={-1}
            >
              <div className="min-w-0">
                <p className="break-words">{reason.explanation}</p>
                <p className="text-xs text-mute">{reason.nextAction}</p>
                {reason.evidence}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
