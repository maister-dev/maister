import type { ReactElement } from "react";
import type { CostKindBreakdownProps } from "@/components/observatory/types";

export function CostKindBreakdown({
  rows,
  labels,
  locale,
}: CostKindBreakdownProps): ReactElement {
  return (
    <section
      className="rounded-lg border border-line bg-paper p-4"
      data-testid="observatory-cost-by-kind"
    >
      <h3 className="m-0 text-sm font-semibold text-ink">
        {labels.costBreakdown.byKindTitle}
      </h3>
      <p className="mt-1 text-xs text-mute">
        {labels.costBreakdown.storedLifetime}
      </p>
      <ul className="m-0 mt-3 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
        {rows.map((row) => (
          <li
            key={row.kind}
            className="rounded-md border border-line-soft bg-ivory px-3 py-2"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              {row.kind}
            </span>
            <strong className="mt-1 block text-sm text-ink">
              {new Intl.NumberFormat(locale).format(row.totalTokens)}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
