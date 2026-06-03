import "server-only";

// Single source of truth for the external_check gate readiness rules, shared by
// the readiness rollup (`lib/queries/readiness.ts`), the authoritative review
// gate (`evidence-readiness.ts`), and the board/portfolio read models. Before
// this module each of the four hand-rewrote the collapse + allow-list (with
// "mirrors X:line" comments) and had begun to drift.

// An external_check gate blocks review/merge unless its latest live report is
// `passed` or human-`overridden`. `pending`/`failed`/`stale`/`skipped` all
// block — an allow-list (not a deny-list), so a future gate status can never
// silently read as ready. Mirrors `assertEvidenceReady`.
export const EXTERNAL_GATE_READY_STATUSES: ReadonlySet<string> = new Set([
  "passed",
  "overridden",
]);

export function isExternalGateReady(status: string): boolean {
  return EXTERNAL_GATE_READY_STATUSES.has(status);
}

// Collapse external_check gate rows to one representative per key: the row with
// the max `createdAt`, tiebreak `id` descending. Supersede-on-new-commit
// re-stales the prior `passed` row and appends a fresh row on the same
// (gateId, attempt), so only the latest report governs — a leftover `stale` row
// must never skew the verdict. `keyOf` is the grouping key: `gateId` within a
// single run, `${runId}:${gateId}` across runs. Callers pass rows already
// filtered to live (latest-attempt) external_check rows; the live-attempt filter
// stays caller-side because it differs per surface (single-run vs multi-run).
export function collapseLatestExternalPerGate<
  T extends { id: string; createdAt: Date },
>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const latest = new Map<string, T>();

  for (const row of rows) {
    const key = keyOf(row);
    const prev = latest.get(key);
    const newer =
      !prev ||
      row.createdAt.getTime() > prev.createdAt.getTime() ||
      (row.createdAt.getTime() === prev.createdAt.getTime() &&
        row.id > prev.id);

    if (newer) latest.set(key, row);
  }

  return [...latest.values()];
}
