import type { CrossProjectHitlItem } from "@/lib/queries/portfolio";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

const CRITICALITY_DOT: Record<string, string> = {
  critical: "bg-[var(--status-red)]",
  high: "bg-amber",
  medium: "bg-accent-2",
  low: "bg-mute-2",
};

export interface NeedsYouSummaryProps {
  count: number;
  items: CrossProjectHitlItem[];
  href: string;
  labels: {
    title: string;
    seeAll: string;
  };
}

// Compact home replacement for the full HITL + social inbox blocks (WI-1): the
// canonical "Needs you" count, a peek at the top items, and a link to the
// dedicated /inbox working surface. Inline respond lives on /inbox, not here.
export function NeedsYouSummary({
  count,
  items,
  href,
  labels,
}: NeedsYouSummaryProps): ReactElement {
  return (
    <section
      aria-label={labels.title}
      className="mb-6 rounded-[14px] border border-amber-line bg-amber-soft px-5 py-4"
      data-testid="needs-you-summary"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-amber">
          <span
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber px-1.5 font-mono text-[11px] font-bold text-white"
            data-testid="needs-you-count"
          >
            {count}
          </span>
          {labels.title}
        </div>
        <Link
          className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-mute transition-colors hover:text-amber"
          href={href}
        >
          {labels.seeAll} →
        </Link>
      </div>
      {items.length > 0 ? (
        <ul className="mt-3 flex list-none flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.hitlRequestId}>
              <Link
                className="grid grid-cols-[8px_1fr] items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-paper"
                href={href}
              >
                <span
                  className={clsx(
                    "h-2 w-2 rounded-full",
                    CRITICALITY_DOT[item.criticality ?? "low"] ?? "bg-mute-2",
                  )}
                />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] font-semibold text-ink-2">
                    {item.projectName}
                  </span>
                  <span className="truncate text-[12.5px] text-body">
                    {item.prompt}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
