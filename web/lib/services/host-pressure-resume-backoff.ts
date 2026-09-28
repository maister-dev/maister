// ADR-183 amendment 2026-09-28: the sweep's auto-resume of a host-paused
// interrupt backs off per row and never gives up — an answered row has no
// card, so "left to the operator" had no operator. One tick is one call of
// the sweep's resume step.
export const RESUME_BACKOFF_CAP_TICKS = 16;
export const RESUME_STUCK_FAILURES = 3;

export type ResumeBackoff = {
  startTick(): void;
  due(rowId: string): boolean;
  failed(rowId: string): { failures: number; stuck: boolean };
  succeeded(rowId: string): void;
};

export function createResumeBackoff(): ResumeBackoff {
  const rows = new Map<string, { failures: number; retryAtTick: number }>();
  let tick = 0;

  return {
    startTick() {
      tick += 1;
    },
    due(rowId) {
      const row = rows.get(rowId);

      return !row || tick >= row.retryAtTick;
    },
    failed(rowId) {
      const failures = (rows.get(rowId)?.failures ?? 0) + 1;
      const wait = 2 ** (failures - 1);

      rows.set(rowId, {
        failures,
        retryAtTick: tick + Math.min(wait, RESUME_BACKOFF_CAP_TICKS),
      });

      // Loud at the third consecutive throw and at every doubling after it;
      // once the wait is capped the per-throw WARN is enough.
      return {
        failures,
        stuck:
          failures >= RESUME_STUCK_FAILURES && wait <= RESUME_BACKOFF_CAP_TICKS,
      };
    },
    succeeded(rowId) {
      rows.delete(rowId);
    },
  };
}
