import type { ChildProcess } from "node:child_process";
import type { StartedPostgresTestDb } from "./pg-container";

import { randomUUID } from "node:crypto";

import { expect } from "vitest";

type ResponderProcess = Readonly<{
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}>;

/** Kill the real responder after host input delivery but before its manager
 * acknowledgement transaction commits. The connection owns the fault barrier.
 */
export async function interruptPermissionInputAcknowledgement(input: {
  database: StartedPostgresTestDb;
  hitlRequestId: string;
  startResponder: () => ResponderProcess;
}): Promise<void> {
  const { database, hitlRequestId, startResponder } = input;
  let responder: ResponderProcess | undefined;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const trigger = `permission_ack_${randomUUID().replaceAll("-", "")}`;
  const lock = await database.pool.connect();

  try {
    await lock.query("SELECT pg_advisory_lock(260912, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${hitlRequestId}' AND NEW.responded_at IS NOT NULL THEN PERFORM pg_advisory_xact_lock(260912, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON hitl_requests FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    responder = startResponder();
    await expect
      .poll(
        async () => {
          if (responder?.child.exitCode !== null)
            throw new Error(responder?.output());
          const waiting = await database.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260912 AND objid = $1 AND NOT granted",
            [lockKey],
          );

          return waiting.rows[0].count;
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe(1);
    expect(responder.child.kill("SIGKILL")).toBe(true);
    await responder.exited;
    expect(responder.child.signalCode).toBe("SIGKILL");
  } finally {
    responder?.child.kill("SIGKILL");
    await responder?.exited;
    await lock.query("SELECT pg_advisory_unlock_all()");
    lock.release();
    await database.pool.query(
      `DROP TRIGGER IF EXISTS ${trigger} ON hitl_requests`,
    );
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
}
