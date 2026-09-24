import type { Pool } from "pg";

import { randomUUID } from "node:crypto";

import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

/** Hold ONE canonical projector for ONE run: a claim no worker can take, so the
 * run's events stay ingested but unprojected for exactly that consumer while
 * every other consumer keeps running. `projectExecutionEvents` answers
 * `unavailable` for a claimed cursor, which is the whole mechanism — no mock.
 * The returned release clears only this hold's own claim and wakes projection.
 */
export async function holdProjection(
  pool: Pool,
  input: { consumerName: string; runId: string },
): Promise<() => Promise<void>> {
  const owner = `test-hold:${randomUUID()}`;

  // The insert's FK check locks the run row, which an ingest transaction may
  // hold while it seeds this run's consumer rows: Postgres breaks that cycle
  // by aborting one side (40P01), and the hold is simply taken again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query(
        `INSERT INTO execution_event_consumers (consumer_name, run_id, claim_owner, claim_expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')
         ON CONFLICT (consumer_name, run_id)
         DO UPDATE SET claim_owner = EXCLUDED.claim_owner, claim_expires_at = EXCLUDED.claim_expires_at`,
        [input.consumerName, input.runId, owner],
      );
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "40P01" || attempt >= 5)
        throw error;
    }
  }

  return async () => {
    await pool.query(
      `UPDATE execution_event_consumers SET claim_owner = NULL, claim_expires_at = NULL
       WHERE consumer_name = $1 AND run_id = $2 AND claim_owner = $3`,
      [input.consumerName, input.runId, owner],
    );
    runEventWakeBus.wakeProjection();
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Which runs a row-level fixture applies to: one run, or every child of a
 * parent — including children created after the fixture is armed. */
export type RunScope = { runId: string } | { parentRunId: string };

function scopePredicate(scope: RunScope): string {
  return "runId" in scope
    ? `NEW.run_id = ${sqlLiteral(scope.runId)}`
    : `EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.parent_run_id = ${sqlLiteral(scope.parentRunId)})`;
}

/** Drop every `run_session_incarnations` insert for the scoped runs, so neither
 * the create ACK nor the lifecycle projector can make an incarnation durable —
 * the prompt-admission fence timeout window. Dropped inserts are counted per
 * run, which makes a re-drive cadence observable. Release is idempotent.
 */
export async function suppressIncarnations(
  pool: Pool,
  scope: RunScope,
): Promise<{
  recentAttempts(windowMs: number): Promise<number[]>;
  release(): Promise<void>;
}> {
  const tag = randomUUID().replaceAll("-", "");
  const attempts = `test_incarnation_attempts_${tag}`;
  const suppress = `test_suppress_incarnation_${tag}`;

  await pool.query(
    `CREATE TABLE ${attempts} (run_id text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  );
  await pool.query(
    `CREATE FUNCTION ${suppress}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF ${scopePredicate(scope)} THEN INSERT INTO ${attempts} (run_id) VALUES (NEW.run_id); RETURN NULL; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${suppress} BEFORE INSERT ON run_session_incarnations FOR EACH ROW EXECUTE FUNCTION ${suppress}()`,
  );

  return {
    async recentAttempts(windowMs: number): Promise<number[]> {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${attempts} WHERE at > clock_timestamp() - ($1::int * interval '1 millisecond') GROUP BY run_id`,
        [windowMs],
      );

      return rows.map((row) => row.n);
    },
    async release(): Promise<void> {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${suppress} ON run_session_incarnations`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${suppress}()`);
      await pool.query(`DROP TABLE IF EXISTS ${attempts}`);
    },
  };
}

/** `holdProjection` for runs that do not exist yet: every child of
 * `parentRunId` has its `consumerName` cursor claimed the moment the row is
 * first written, so the projector never runs for it until release. Release is
 * idempotent and wakes projection.
 */
export async function holdChildProjection(
  pool: Pool,
  input: { consumerName: string; parentRunId: string },
): Promise<() => Promise<void>> {
  const tag = randomUUID().replaceAll("-", "");
  const owner = `test-hold:${tag}`;
  const hold = `test_hold_child_projection_${tag}`;

  await pool.query(
    `CREATE FUNCTION ${hold}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.consumer_name = ${sqlLiteral(input.consumerName)} AND ${scopePredicate({ parentRunId: input.parentRunId })} THEN
       NEW.claim_owner := ${sqlLiteral(owner)};
       NEW.claim_expires_at := clock_timestamp() + interval '1 hour';
     END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hold} BEFORE INSERT ON execution_event_consumers FOR EACH ROW EXECUTE FUNCTION ${hold}()`,
  );

  return async () => {
    await pool.query(
      `DROP TRIGGER IF EXISTS ${hold} ON execution_event_consumers`,
    );
    await pool.query(`DROP FUNCTION IF EXISTS ${hold}()`);
    await pool.query(
      "UPDATE execution_event_consumers SET claim_owner = NULL, claim_expires_at = NULL WHERE claim_owner = $1",
      [owner],
    );
    runEventWakeBus.wakeProjection();
  };
}
