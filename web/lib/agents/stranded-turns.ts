import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Logger } from "pino";
import type { StrandedAgentTurnRow } from "@/types/execution-host-observability";

import { sql, type SQL } from "drizzle-orm";

import { MESSAGE_TURN_VARIANTS, OWNED_TURN_VARIANTS } from "./turn-variants";

/** A queued agent message older than this, on a run with nothing in flight, is
 * reported. Not configurable: it is an alarm threshold, not a policy. */
export const STRANDED_AGENT_TURN_MS = 10 * 60_000;

type StrandedRow = {
  run_id: string;
  run_status: string;
  turn_id: string;
  ordinal: number;
  created_at: Date | string;
  resume_requested_at: Date | string | null;
};

export type StrandedAgentTurnsQueryRow = {
  total: number;
  rows: StrandedRow[];
};

/** The oldest queued message per run whose run has no owned turn claimed or
 * dispatched and no agent prompt whose application is still open — nothing
 * that would ever pick the message up. A run parked `NeedsInputIdle` with a
 * queue key is excluded: the continuation worker's resume arm and the
 * freed-slot gate own it while it waits for capacity. Shared by the sweep's
 * report and the admin read model so the two can never disagree about what
 * "stranded" is. */
export function strandedAgentTurnsQuery(now: Date, limit: number): SQL {
  const before = new Date(now.getTime() - STRANDED_AGENT_TURN_MS);
  const owned = sql.join(
    OWNED_TURN_VARIANTS.map((variant) => sql`${variant}`),
    sql`, `,
  );
  const messages = sql.join(
    MESSAGE_TURN_VARIANTS.map((variant) => sql`${variant}`),
    sql`, `,
  );

  return sql`
    WITH stranded AS (
      SELECT DISTINCT ON (t.run_id)
        t.run_id, r.status AS run_status, t.id AS turn_id, t.ordinal,
        t.created_at, r.resume_requested_at
      FROM agent_turns t
      JOIN runs r ON r.id = t.run_id
      WHERE t.state = 'queued'
        AND t.variant IN (${messages})
        AND t.created_at < ${before.toISOString()}::timestamptz
        AND NOT (r.status = 'NeedsInputIdle' AND r.resume_requested_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM agent_turns busy
          WHERE busy.run_id = t.run_id
            AND busy.state IN ('claimed', 'dispatched')
            AND busy.variant IN (${owned})
        )
        AND NOT EXISTS (
          SELECT 1 FROM execution_commands ec
          WHERE ec.run_id = t.run_id
            AND ec.kind = 'session.prompt'
            AND ec.owner_kind = 'agent_turn'
            AND ec.application_state IN ('pending', 'applying', 'poisoned')
        )
      ORDER BY t.run_id, t.ordinal
    )
    SELECT
      (SELECT count(*)::int FROM stranded) AS total,
      coalesce((
        SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at)
        FROM (SELECT * FROM stranded ORDER BY created_at LIMIT ${limit}) page
      ), '[]'::jsonb) AS rows
  `;
}

export function mapStrandedAgentTurns(
  rows: readonly StrandedRow[],
  now: Date,
): StrandedAgentTurnRow[] {
  return rows.map((row) => ({
    runId: row.run_id,
    runStatus: row.run_status,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    ageMs: Math.max(0, now.getTime() - new Date(row.created_at).getTime()),
    resumeRequestedAt: row.resume_requested_at
      ? new Date(row.resume_requested_at).toISOString()
      : null,
  }));
}

/** The queued-message invariant's alarm (ADR-182 / D-A6): a message that is
 * neither delivered nor superseded and has no owner left to deliver it. Read
 * only — no repair; with a logger, one WARN per stranded run per call. Never
 * throws: a failed read is an `errors` entry, the `reportPoisonedConsumers`
 * contract. */
export async function reportStrandedAgentTurns(input: {
  db: Db;
  logger?: Logger;
  now?: Date;
  limit?: number;
}): Promise<{
  // null: the read failed — distinct from "none stranded".
  count: number | null;
  rows: StrandedAgentTurnRow[];
  errors: string[];
}> {
  const now = input.now ?? new Date();

  try {
    const result = await input.db.execute<StrandedAgentTurnsQueryRow>(
      strandedAgentTurnsQuery(now, input.limit ?? 50),
    );
    const [summary] = result.rows;
    const rows = mapStrandedAgentTurns(summary?.rows ?? [], now);

    for (const row of rows) input.logger?.warn(row, "agent-message-stranded");

    return { count: summary?.total ?? 0, rows, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    input.logger?.error({ err: message }, "stranded agent turn report failed");

    return {
      count: null,
      rows: [],
      errors: [`stranded agent turn report failed: ${message}`],
    };
  }
}
