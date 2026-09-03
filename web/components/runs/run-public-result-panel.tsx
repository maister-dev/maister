import type { RunPublicResultDto } from "@/lib/runs/run-result-dto";
import type { ResultStatus } from "@/lib/run-results/types";
import type { ReactElement } from "react";

import clsx from "clsx";

// ADR-165 (T8.1 / AC-34): the run-detail public-result panel. Renders NOTHING
// when the run has no contract and no rows — an empty card on every ordinary run
// would be noise, and "this run publishes no public result" is better said by
// absence than by a placeholder.

export interface RunPublicResultLabels {
  title: string;
  schemaRef: string;
  revision: string;
  superseded: string;
  collected: string;
  notCollected: string;
  value: string;
  noValue: string;
  completedWithoutPromotion: string;
  status: Record<ResultStatus, string>;
  failureReason: string;
}

export interface RunPublicResultPanelProps {
  result: RunPublicResultDto | null;
  labels: RunPublicResultLabels;
}

// Tone per status. A green check for `valid` and a muted dash for `absent`
// follow the repo's affordance convention: an outcome is read as a glyph, not
// as a word.
const STATUS_TONE: Record<ResultStatus, string> = {
  valid: "text-emerald border-emerald-line bg-emerald-soft",
  pending: "text-mute border-line bg-paper",
  absent: "text-mute border-line bg-paper",
  missing: "text-danger border-danger-line bg-danger-soft",
  stale: "text-amber border-amber-line bg-amber-soft",
  invalid: "text-danger border-danger-line bg-danger-soft",
  unavailable: "text-mute border-line bg-paper",
};

const STATUS_GLYPH: Record<ResultStatus, string> = {
  valid: "✓",
  pending: "…",
  absent: "—",
  missing: "✗",
  stale: "!",
  invalid: "✗",
  unavailable: "—",
};

/** Compact size for the disclosure summary — a reader's cue, not a metric. */
function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function RunPublicResultPanel({
  result,
  labels,
}: RunPublicResultPanelProps): ReactElement | null {
  if (!result) return null;

  return (
    <section
      aria-label={labels.title}
      className="flex flex-col gap-2 rounded-[8px] border border-line bg-paper p-2"
      data-result-status={result.resultStatus}
      data-testid="run-public-result"
    >
      <header className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={clsx(
            "flex h-4 w-4 flex-none items-center justify-center rounded-full border font-mono text-[10px]",
            STATUS_TONE[result.resultStatus],
          )}
          data-testid="run-public-result-glyph"
        >
          {STATUS_GLYPH[result.resultStatus]}
        </span>
        <h3 className="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-mute">
          {labels.title}
        </h3>
        <span
          className="ml-auto font-mono text-[10px] text-mute"
          data-testid="run-public-result-status"
        >
          {labels.status[result.resultStatus]}
        </span>
      </header>

      {result.schemaRef ? (
        <p
          className="m-0 truncate font-mono text-[11px] text-ink"
          data-testid="run-public-result-schema-ref"
          title={result.schemaRef}
        >
          {labels.schemaRef}: {result.schemaRef}
        </p>
      ) : null}

      <p className="m-0 flex flex-wrap gap-x-3 font-mono text-[10px] text-mute">
        {result.revision !== null ? (
          <span data-testid="run-public-result-revision">
            {labels.revision} {result.revision}
          </span>
        ) : null}
        {result.supersededCount > 0 ? (
          <span data-testid="run-public-result-superseded">
            {labels.superseded}: {result.supersededCount}
          </span>
        ) : null}
        <span data-testid="run-public-result-collected">
          {result.collectedAt ? labels.collected : labels.notCollected}
        </span>
      </p>

      {result.completedWithoutPromotion ? (
        <p
          className="m-0 font-mono text-[10px] text-mute"
          data-testid="run-public-result-no-promotion"
        >
          {labels.completedWithoutPromotion}
        </p>
      ) : null}

      {result.failure ? (
        <p
          className="m-0 rounded-[6px] border border-danger-line bg-danger-soft px-2 py-1 font-mono text-[10px] text-danger"
          data-testid="run-public-result-failure"
          role="status"
        >
          {labels.failureReason}: {result.failure.reason}
        </p>
      ) : null}

      {result.value === null ? (
        <p
          className="m-0 rounded-[6px] border border-line bg-ivory p-2 text-[12px] text-mute"
          data-testid="run-public-result-no-value"
        >
          {labels.noValue}
        </p>
      ) : (
        <details className="rounded-[6px] border border-line bg-ivory">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 font-mono text-[10px] uppercase text-mute marker:hidden">
            <span>{labels.value}</span>
            {result.valueBytes !== null ? (
              <span data-testid="run-public-result-value-size">
                {formatBytes(result.valueBytes)}
              </span>
            ) : null}
          </summary>
          <pre
            className="m-0 max-h-[320px] overflow-auto p-2 font-mono text-[11px] text-ink"
            data-testid="run-public-result-value"
          >
            {JSON.stringify(result.value, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}
