import type { ReactElement } from "react";
import type { MaisterErrorCode } from "@/lib/errors-core";
import type { TerminalCause } from "@/lib/domain-events/taxonomy";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

export type TerminalCauseStatus = "Failed" | "Crashed" | "Abandoned";

export interface TerminalCauseLabels {
  title: Record<TerminalCauseStatus, string>;
  codes: Partial<Record<MaisterErrorCode, string>>;
  reasons: Partial<Record<string, string>>;
  reasonLabel: string;
}

export function isTerminalCauseStatus(
  status: string,
): status is TerminalCauseStatus {
  return status === "Failed" || status === "Crashed" || status === "Abandoned";
}

/**
 * B6 (ADR-177 amendment): why a run ended, composed from its terminal event's
 * cause — the code's copy and the reason's copy, never a raw token as the
 * primary text. An unknown reason shows only as a muted token line; the source
 * is provenance, not operator copy, and is not rendered.
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

  if (!codeCopy && !reasonCopy && !cause.reason) return null;

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
        {codeCopy ? <p>{codeCopy}</p> : null}
        {reasonCopy ? <p>{reasonCopy}</p> : null}
        {cause.reason && !reasonCopy ? (
          <p className="text-xs text-mute">
            {labels.reasonLabel}: <code>{cause.reason}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
