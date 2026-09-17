import type { WorkInFlightCounts } from "@/lib/work/stage-counts";
import type { WorkInFlightStage } from "@/lib/work/stage";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import { WORK_IN_FLIGHT_STAGES } from "@/lib/work/stage";

/**
 * The Now strip (ADR-174 D1, D3) — the five in-flight stages, each a filter
 * over the table below it.
 *
 * A server component: the tiles carry no state beyond the link, so the counts
 * arrive already rendered rather than after hydration.
 *
 * The strip is CURRENT STATE, not a window. It answers "what is true now", and
 * its numbers are counted from the same rows the table renders — never from a
 * query of its own (`REQ-D2`).
 *
 * All five tiles render at zero. A strip whose tiles appear and disappear takes
 * away the fixed positions a reader scans by, which is the one thing a
 * five-number summary is for.
 */

export interface NowTilesLabels {
  /** `desk.nowLabel` — names the strip as a region and as a heading. */
  heading: string;
  /** The `workStage` namespace, so the strip and the row chips agree. */
  names: Record<WorkInFlightStage, string>;
}

export interface NowTilesProps {
  counts: WorkInFlightCounts;
  labels: NowTilesLabels;
  locale: string;
  /** The stage `?stage=` currently selects, or `null` when unfiltered. */
  activeStage: WorkInFlightStage | null;
}

/**
 * Filtering happens IN PLACE on `/` (`REQ-D3`) — a tile that navigated to
 * `/work` would answer the reader's question by taking the question away.
 *
 * The active tile links back to `/`, so the filter is always reversible from
 * the control that set it. Without that, a filter matching rows would be a trap:
 * `REQ-D6`'s clear affordance only appears when the result is EMPTY.
 */
function tileHref(stage: WorkInFlightStage, active: boolean): string {
  return active ? "/" : `/?stage=${stage}`;
}

export function NowTiles({
  counts,
  labels,
  locale,
  activeStage,
}: NowTilesProps): ReactElement {
  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <section
      aria-label={labels.heading}
      className="flex flex-col gap-3.5"
      data-testid="now-tiles"
    >
      <h2 className="m-0 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
        {labels.heading}
      </h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {WORK_IN_FLIGHT_STAGES.map((stage) => {
          const active = stage === activeStage;

          return (
            <Link
              key={stage}
              aria-current={active ? "true" : undefined}
              className={clsx(
                "flex flex-col gap-1 rounded-[14px] border px-4 py-3 no-underline shadow-[var(--shadow-sm)] transition-transform hover:-translate-y-px",
                active
                  ? "border-amber-line bg-amber-soft"
                  : "border-line bg-paper",
              )}
              data-now-tile={stage}
              href={tileHref(stage, active)}
            >
              <span
                className="font-mono text-[22px] font-semibold leading-none text-ink"
                data-testid={`now-tile-${stage}`}
              >
                {numberFormat.format(counts[stage])}
              </span>
              <span className="text-[12px] leading-[1.3] text-mute">
                {labels.names[stage]}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
