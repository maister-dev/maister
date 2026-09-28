import type { ReactElement } from "react";
import type { MaisterErrorCode } from "@/lib/errors-core";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

import {
  isTerminalCauseStatus,
  type TerminalCause,
  type TerminalCauseStatus,
} from "@/lib/domain-events/taxonomy";

export interface TerminalCauseLabels {
  title: Record<TerminalCauseStatus, string>;
  // Complete over the code union and the reason registry: the catalogs are
  // pinned by the notice's test.
  codes: Partial<Record<MaisterErrorCode, string>>;
  reasons: Partial<Record<string, string>>;
  reasonLabel: string;
  unknownReason: string;
}

/**
 * B6 (ADR-177 amendment): why a run ended, composed from its terminal event's
 * cause. The reason's copy says it most precisely, so it leads; the code's copy
 * stands in only when the reason has none (the two can read as contradictory
 * side by side — a time limit filed under PRECONDITION). A reason without copy
 * is never the primary text: the code's copy, or a "no further detail" line,
 * leads and the token follows muted. The source is provenance, not operator
 * copy, and is not rendered.
 */
export function TerminalCauseNotice({
  status,
  cause,
  labels,
  showTitle = true,
}: {
  status: string;
  cause: TerminalCause | null;
  labels: TerminalCauseLabels;
  showTitle?: boolean;
}): ReactElement | null {
  if (!cause || !isTerminalCauseStatus(status)) return null;
  const codeCopy = cause.code ? labels.codes[cause.code] : undefined;
  const reasonCopy = cause.reason ? labels.reasons[cause.reason] : undefined;
  const primary =
    reasonCopy ?? codeCopy ?? (cause.reason ? labels.unknownReason : undefined);

  if (!primary) return null;

  return (
    <div
      className="mb-3 flex items-start gap-2 text-[13px] leading-[1.4] text-body"
      data-testid="terminal-cause-notice"
    >
      <ExclamationTriangleIcon
        aria-hidden="true"
        className="mt-[1px] size-4 shrink-0 text-red-500"
      />
      <div className="min-w-0">
        {showTitle ? (
          <p className="font-semibold text-ink">{labels.title[status]}</p>
        ) : null}
        <p>{primary}</p>
        {cause.reason && !reasonCopy ? (
          <p className="text-xs text-mute">
            {labels.reasonLabel}: <code>{cause.reason}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
