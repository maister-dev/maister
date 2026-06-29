import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

import { ElementForkButton } from "@/components/studio/element-fork-button";

// One bill-of-materials member, rendered as a card (never a bare id chip). A
// presentational Server Component (props in, markup out) so it renders under
// renderToStaticMarkup in the unit tests; when the element is forkable it embeds
// the ElementForkButton client island. The disk handle never reaches here; the
// page resolves `href` + `meta` + `forkPath` from server-side reads.

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
  // M39 A3: when the element has a resolvable source path, the fork control forks
  // it into a NEW centralized local package; `refName` = the package ref. Omitted
  // → the disabled "later" stub (e.g. mcps, which have no forkable file path).
  refName?: string;
  forkPath?: string | null;
  // The fork affordance is meaningless inside an editable local package (it is
  // already a working copy) — pass `false` there to drop it entirely (ADR-116).
  showFork?: boolean;
  // When true the WHOLE card is the open affordance (a single Link to `href`),
  // with no inner View button or action row. Card text stays selectable, so a
  // user can still copy a meta/description field. Used by the local composition
  // view; the installed viewer keeps the explicit View button + fork control.
  clickableCard?: boolean;
}

export function ElementCard({
  name,
  href,
  meta,
  description,
  labels,
  refName,
  forkPath,
  showFork = true,
  clickableCard = false,
}: ElementCardProps): ReactElement {
  const body = (
    <div className="min-w-0">
      <div className="truncate text-[14px] font-semibold text-ink">{name}</div>
      {description ? (
        <div className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-2">
          {description}
        </div>
      ) : null}
      {meta ? (
        <div className="mt-1 font-mono text-[11px] text-mute">{meta}</div>
      ) : null}
    </div>
  );

  if (clickableCard) {
    return (
      <Link
        className="flex flex-col gap-2 rounded-[14px] border border-line bg-paper px-4 py-3.5 transition-colors hover:border-amber"
        data-testid="element-card"
        href={href}
      >
        {body}
      </Link>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[14px] border border-line bg-paper px-4 py-3.5"
      data-testid="element-card"
    >
      {body}
      <div className="mt-auto flex items-center gap-2">
        <Link
          className="rounded-[9px] border border-line bg-ivory px-2.5 py-1 text-[12px] font-semibold text-ink transition-colors hover:border-amber"
          data-testid="element-card-view"
          href={href}
        >
          {labels.view}
        </Link>
        {showFork ? (
          refName && forkPath ? (
            <ElementForkButton
              elementName={name}
              elementPath={forkPath}
              label={labels.fork}
              refName={refName}
            />
          ) : (
            <span
              aria-disabled="true"
              className="cursor-default rounded-[9px] border border-dashed border-line px-2.5 py-1 text-[12px] text-mute"
              data-testid="element-card-fork"
              title={labels.forkPhase2Hint}
            >
              {labels.fork}
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}
