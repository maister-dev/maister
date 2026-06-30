import type { ReactElement } from "react";
import type { BudgetSurfaceCardProps } from "@/components/observatory/types";

import {
  ExclamationTriangleIcon,
  NoSymbolIcon,
  ShieldExclamationIcon,
} from "@heroicons/react/24/outline";

function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function BudgetSurfaceCard({
  budget,
  labels,
  locale,
}: BudgetSurfaceCardProps): ReactElement {
  const budgetLabels = labels.budget;

  return (
    <section
      className="mt-4 rounded-lg border border-line bg-paper p-4"
      data-testid="observatory-budget"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="m-0 text-sm font-semibold text-ink">
            {budgetLabels.title}
          </h3>
          <p className="mt-1 max-w-[72ch] text-xs text-mute">
            {budgetLabels.subtitle}
          </p>
        </div>
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
          {labels.observationsOnly}
        </span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        <div className="flex items-center gap-3 bg-ivory px-3 py-3">
          <ExclamationTriangleIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-amber"
          />
          <div>
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              {budgetLabels.escalations}
            </div>
            <div className="mt-1 font-mono text-[20px] font-semibold leading-none text-ink">
              {formatCount(locale, budget.budgetEscalations)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 bg-ivory px-3 py-3">
          <NoSymbolIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-rose-500"
          />
          <div>
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              {budgetLabels.terminations}
            </div>
            <div className="mt-1 font-mono text-[20px] font-semibold leading-none text-ink">
              {formatCount(locale, budget.budgetTerminations)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 bg-ivory px-3 py-3">
          <ShieldExclamationIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-amber"
          />
          <div>
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              {budgetLabels.guardrailTrips}
            </div>
            <div
              className="mt-1 font-mono text-[20px] font-semibold leading-none text-ink"
              data-testid="observatory-hook-trips"
            >
              {formatCount(locale, budget.hookTripEscalations)}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[10.5px] text-mute">
        {budgetLabels.warnNotSurfaced}
      </p>
    </section>
  );
}
