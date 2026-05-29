import "server-only";

// M8 T3: extracted from web/app/api/runs/[runId]/stream/route.ts so the
// sweeper (T6), the activity bump route (T7), the resume helper (T9), and
// the SSE stream tail (M7) all share one accessor.
//
// `MAISTER_KEEPALIVE_MINUTES` semantics:
//   - Drives the sliding `keepalive_until` window on NeedsInput rows.
//   - Bumped on every web-console activity ping (T7).
//   - Read by the keep-alive sweeper to decide when a NeedsInput row
//     becomes NeedsInputIdle (T6).
//   - Re-applied to NeedsInputIdle → NeedsInput transitions on resume
//     via markResumed (T3 helpers below).
//   - In supervisor land it ALSO bounds the pending-permission deferred
//     timeout (M7).
//
// Default: 30 min (locked in CLAUDE.md §1 and docs/configuration.md).
//
// `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` and
// `MAISTER_NEEDSINPUTIDLE_TTL_HOURS` live in `web/lib/runs/keepalive-sweeper.ts`
// (T6/T12) since they only feed the sweeper loop.

const DEFAULT_KEEPALIVE_MINUTES = 30;

export function keepaliveMinutes(): number {
  const raw =
    process.env.MAISTER_KEEPALIVE_MINUTES ?? String(DEFAULT_KEEPALIVE_MINUTES);
  const minutes = Number.parseInt(raw, 10);

  return Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_KEEPALIVE_MINUTES;
}

export function keepaliveMs(): number {
  return keepaliveMinutes() * 60_000;
}

export function nextKeepaliveAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + keepaliveMs());
}
