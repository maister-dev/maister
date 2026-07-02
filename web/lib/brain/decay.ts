import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { isBrainProvisioned } from "./guard";

import { getDb } from "@/lib/db/client";

// Project Brain (ADR-122) decay sweep. Folded into runSystemSweep on the M24
// tick (60s), it self-throttles to hourly via a module-level last-run stamp so
// it does not hammer the DB every tick. Aging is EXPIRY-only and idempotent —
// items past `expires_at` (unless reinforced, which pushes expires_at out) flip
// to `status='expired'` and drop out of recall. There is NO per-tick confidence
// decrement, so running the sweep twice close together never double-penalizes
// (E-4). The sweep swallows its own errors into the summary — never throws.

const log = pino({
  name: "brain:decay",
  level: process.env.LOG_LEVEL ?? "info",
});

export const BRAIN_DECAY_THROTTLE_MS = 60 * 60 * 1000; // hourly

let lastSweepAtMs: number | null = null;

// Test hook — reset the in-memory throttle stamp between cases.
export function resetBrainDecayThrottle(): void {
  lastSweepAtMs = null;
}

export interface BrainDecaySummary {
  ran: boolean;
  expired: number;
  errors: string[];
}

type DecayDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export async function runBrainDecaySweep(
  opts: { db?: DecayDb; nowMs?: number; force?: boolean } = {},
): Promise<BrainDecaySummary> {
  // SQLite → Brain disabled (D3): the brain tables do not exist; no-op.
  if (!isBrainProvisioned()) return { ran: false, expired: 0, errors: [] };

  const nowMs = opts.nowMs ?? Date.now();

  if (
    !opts.force &&
    lastSweepAtMs !== null &&
    nowMs - lastSweepAtMs < BRAIN_DECAY_THROTTLE_MS
  ) {
    return { ran: false, expired: 0, errors: [] };
  }

  lastSweepAtMs = nowMs;
  const db = opts.db ?? (getDb() as unknown as DecayDb);

  try {
    const r = await db.execute(sql`
      UPDATE brain_items
      SET status = 'expired', updated_at = now()
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()
      RETURNING id
    `);

    return { ran: true, expired: r.rows.length, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error({ err: message }, "brain decay sweep failed");

    return { ran: true, expired: 0, errors: [message] };
  }
}
