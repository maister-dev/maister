import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { RunKind } from "@/lib/db/schema";
import type { RunOutcomeBucket } from "@/lib/runs/outcome-bucket";

import { filtersToParams } from "@/lib/runs/list-params";
import { toUtcDateString } from "@/lib/utc-day";

// ADR-177 D8: the overview's link into the `/runs` ledger.
//
// The param names come from the ledger's own `filtersToParams` — CALLED, not
// copied, so the two cannot drift apart. What this adds is the translation
// from an Observatory PERIOD (`[since, until)` instants) to the ledger's
// inclusive `from`/`to` day strings. That translation is the whole reason a
// cell's count equals the list it opens — get it wrong by one day and the
// parity silently breaks.

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
  const { from, to } = periodToLedgerDates(input.period);
  const params = filtersToParams({
    page: 1,
    projectSlug: input.projectSlug,
    kind: input.kind,
    bucket: input.bucket,
    dateFrom: from,
    dateTo: to,
  });

  return `/runs?${params.toString()}`;
}
