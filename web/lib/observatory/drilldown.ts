import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { RunKind } from "@/lib/db/schema";
import type { RunOutcomeBucket } from "@/lib/runs/outcome-bucket";

import { toUtcDateString } from "@/lib/utc-day";

// ADR-177 D8: the overview's link into the `/runs` ledger.
//
// The param NAMES come from the ledger's own `filtersToParams`, so the two
// cannot drift apart; what this adds is the translation from an Observatory
// PERIOD (`[since, until)` instants) to the ledger's inclusive `from`/`to`
// day strings. That translation is the whole reason a cell's count equals the
// list it opens — get it wrong by one day and the parity silently breaks.

export interface RunsLedgerDrilldown {
  projectSlug?: string;
  period: ObservatoryPeriod;
  kind?: RunKind;
  bucket?: RunOutcomeBucket;
}

/** `[since, until)` → the inclusive `from`/`to` day pair the ledger parses. */
export function periodToLedgerDates(period: ObservatoryPeriod): {
  from: string;
  to: string;
} {
  return {
    from: toUtcDateString(period.since),
    // `until` is exclusive and day-aligned, so the last INCLUDED day is the
    // one before it.
    to: toUtcDateString(new Date(period.until.getTime() - 1)),
  };
}

export function runsLedgerHref(input: RunsLedgerDrilldown): string {
  const params = new URLSearchParams();
  const { from, to } = periodToLedgerDates(input.period);

  if (input.projectSlug) params.set("project", input.projectSlug);
  if (input.kind) params.set("kind", input.kind);
  if (input.bucket) params.set("bucket", input.bucket);
  params.set("from", from);
  params.set("to", to);

  return `/runs?${params.toString()}`;
}
