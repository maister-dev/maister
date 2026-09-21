import type { CostDimensionRow } from "@/lib/queries/observatory";
import type { ObservatoryCostSummary } from "@/lib/queries/observatory";
import type { ObservatoryLabels } from "@/components/observatory/types";
import type { ParsedObservatoryFilters } from "@/lib/observatory/filters";
import type { ReactElement } from "react";

import Link from "next/link";

import { observatoryViewHref } from "@/lib/observatory/href";

// ADR-178 D6: the overview's one-line cost answer, with the Cost view one
// click away. Tokens only — USD stays out (M51 non-goal).

export interface OverviewCostStripProps {
  cost: ObservatoryCostSummary;
  labels: ObservatoryLabels;
  locale: string;
  current: ParsedObservatoryFilters["current"];
  pathname: string;
}

const TOP_N = 3;

export function OverviewCostStrip({
  cost,
  labels,
  locale,
  current,
  pathname,
}: OverviewCostStripProps): ReactElement {
  const format = (value: number): string =>
    new Intl.NumberFormat(locale).format(value);

  return (
    <section
      className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[14px] border border-line bg-paper px-5 py-3"
      data-testid="observatory-cost-strip"
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-mute">
        {labels.costBreakdown.totalHeader}
      </span>
      <strong className="font-mono text-[15px] font-semibold text-ink">
        {format(cost.totalTokens)}
      </strong>
      <Top
        format={format}
        label={labels.costBreakdown.byModelTitle}
        rows={cost.byModel}
      />
      <Top
        format={format}
        label={labels.costBreakdown.byRunnerTitle}
        rows={cost.byRunner}
      />
      <Top
        format={format}
        label={labels.costBreakdown.byFlowTitle}
        rows={cost.byFlow}
      />
      <Link
        className="ml-auto font-mono text-[11px] font-semibold text-amber underline-offset-2 hover:underline"
        href={observatoryViewHref(pathname, current, "cost")}
      >
        {labels.views.cost}
      </Link>
    </section>
  );
}

function Top({
  format,
  label,
  rows,
}: {
  format: (value: number) => string;
  label: string;
  rows: readonly CostDimensionRow[];
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        {label}
      </span>
      {rows.length === 0 ? (
        <span className="font-mono text-[11px] text-mute">—</span>
      ) : (
        rows.slice(0, TOP_N).map((row) => (
          <span key={row.key} className="font-mono text-[11px] text-ink-2">
            {row.label} {format(row.totalTokens)}
          </span>
        ))
      )}
    </div>
  );
}
