import type { NowTile } from "@/lib/queries/digest";
import type { ReactElement } from "react";

import Link from "next/link";

/**
 * The Now strip (`ATN-12`, ADR-171 D1) — the five numbers of T5.4's digest
 * window, each a link to the surface that owns it.
 *
 * A server component: the tiles carry no state and no interaction beyond the
 * link, so the counts arrive already rendered rather than after hydration.
 *
 * Zero-valued tiles are SHOWN, unlike in the digest sentence. A sentence that
 * lists what did not happen is unreadable; a strip whose tiles appear and
 * disappear is unreadable in a different way — the reader loses the fixed
 * positions they scan by.
 */

export interface NowTilesLabels {
  /** Keyed by tile id; each carries `$count`, consumed by replacement. */
  names: Record<string, string>;
  ariaLabel: string;
}

export interface NowTilesProps {
  tiles: readonly NowTile[];
  labels: NowTilesLabels;
  locale: string;
}

export function NowTiles({
  tiles,
  labels,
  locale,
}: NowTilesProps): ReactElement {
  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <section
      aria-label={labels.ariaLabel}
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"
      data-testid="now-tiles"
    >
      {tiles.map((tile) => (
        <Link
          key={tile.id}
          className="flex flex-col gap-1 rounded-[14px] border border-line bg-paper px-4 py-3 no-underline shadow-[var(--shadow-sm)] transition-transform hover:-translate-y-px"
          data-now-tile={tile.id}
          href={tile.href}
        >
          <span
            className="font-mono text-[22px] font-semibold leading-none text-ink"
            data-testid={`now-tile-${tile.id}`}
          >
            {numberFormat.format(tile.value)}
          </span>
          <span className="text-[12px] leading-[1.3] text-mute">
            {/* The label template carries the count too; the tile shows the
                number separately, so `$count` is stripped rather than filled. */}
            {labels.names[tile.id]?.replace("$count", "").trim()}
          </span>
        </Link>
      ))}
    </section>
  );
}
