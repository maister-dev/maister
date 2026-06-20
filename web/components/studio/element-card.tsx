import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

// One bill-of-materials member, rendered as a card (never a bare id chip). Pure
// presentational Server Component — props in, markup out — so it renders under
// renderToStaticMarkup (no jsdom) in the unit tests. The disk handle never
// reaches here; the page resolves `href` + `meta` from server-side reads.

export interface ElementCardLabels {
  view: string;
  fork: string;
  forkPhase2Hint: string;
}

export interface ElementCardProps {
  name: string;
  href: string;
  // The kind-specific meta line (already localized + interpolated). Omitted when
  // a degraded member has no readable meta — render nothing rather than blank.
  meta?: string | null;
  // Optional secondary line (e.g. an agent's when-to-call summary).
  description?: ReactNode;
  labels: ElementCardLabels;
}

export function ElementCard({
  name,
  href,
  meta,
  description,
  labels,
}: ElementCardProps): ReactElement {
  return (
    <div
      className="flex flex-col gap-2 rounded-[14px] border border-line bg-paper px-4 py-3.5"
      data-testid="element-card"
    >
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold text-ink">
          {name}
        </div>
        {description ? (
          <div className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-2">
            {description}
          </div>
        ) : null}
        {meta ? (
          <div className="mt-1 font-mono text-[11px] text-mute">{meta}</div>
        ) : null}
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Link
          className="rounded-[9px] border border-line bg-ivory px-2.5 py-1 text-[12px] font-semibold text-ink transition-colors hover:border-amber"
          data-testid="element-card-view"
          href={href}
        >
          {labels.view}
        </Link>
        <span
          aria-disabled="true"
          className="cursor-default rounded-[9px] border border-dashed border-line px-2.5 py-1 text-[12px] text-mute"
          data-testid="element-card-fork"
          title={labels.forkPhase2Hint}
        >
          {labels.fork}
        </span>
      </div>
    </div>
  );
}
