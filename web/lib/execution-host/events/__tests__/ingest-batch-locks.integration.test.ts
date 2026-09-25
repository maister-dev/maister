// ADR-167 amendment (2026-09-25), I5: a runtime-event batch locks every run it
// can touch ONCE, ascending, before any insert — and so cannot deadlock with
// the writers that race it. 100 batches of six runs (each also releasing
// ANOTHER run's row held behind a gap) run against three live peers:
//   - an owner apply in its own order (`lockCurrentSessionAssignment`: run,
//     then assignment, FOR UPDATE; then the command row);
//   - an idle-resume CAS (`UPDATE runs` — NO KEY UPDATE — then an upgrade to
//     FOR UPDATE), the shape the per-event path's hoisted lock existed for;
//   - the canonical projection worker.
// A BEFORE INSERT trigger records, from pg_locks, whether each ingest
// transaction already held its run lock at its first event insert; a 100 ms
// watcher samples lock waits and is printed only on failure.
import type { Db } from "@/lib/execution-host/db";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executionCommands, runs } from "@/lib/db/schema";
import { ingestRuntimeEventBatch } from "@/lib/execution-host/events/ingest";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const RUNS = 6;
const ITERATIONS = 100;

let testDatabase: StartedPostgresTestDb;
let db: Db;
const hostId = randomUUID();
const hostKey = `eh_${randomUUID().replace(/-/g, "")}`;
const streamId = randomUUID();
const runIds = Array.from({ length: RUNS }, () => randomUUID());
const assignmentIds = runIds.map(() => randomUUID());
const commandIds = runIds.map(() => randomUUID());

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "execution_event_ingest_locks_test",
  });
  db = testDatabase.db as unknown as Db;
  const projectId = randomUUID();

  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'event-locks', 'Event locks', '/tmp/event-locks', '/tmp/event-locks/maister.yaml', 'EVT-LOCK')`,
    [projectId],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, $2, 'local_direct', 'locks host', '{"kind":"local_direct"}')`,
    [hostId, hostKey],
  );
  for (const [index, runId] of runIds.entries()) {
    await testDatabase.pool.query(
      `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
       values ($1, $2, 'scratch', 'Running', 'scratch', 'locks')`,
      [runId, projectId],
    );
    await testDatabase.pool.query(
      `insert into execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
       values ($1, $2, $3, 1, 'active', 'launch')`,
      [assignmentIds[index], runId, hostId],
    );
    await testDatabase.pool.query(
      "update runs set execution_assignment_id = $1 where id = $2",
      [assignmentIds[index], runId],
    );
    await testDatabase.pool.query(
      `insert into execution_commands (id, run_id, execution_host_id, execution_assignment_id,
         assignment_epoch, kind, state, max_attempts, accepted_at)
       values ($1, $2, $3, $4, 1, 'session.checkpoint', 'accepted', 1, now())`,
      [commandIds[index], runId, hostId, assignmentIds[index]],
    );
  }
  // Only a SELECT … FOR UPDATE on runs takes RowShareLock on the table before
  // an event insert: the insert's own FK check runs AFTER its row triggers.
  await testDatabase.pool.query(`
    create table ingest_lock_evidence (
      txid bigint primary key,
      holds_runs boolean not null
    );
    create function ingest_lock_evidence() returns trigger language plpgsql as $$
    begin
      insert into ingest_lock_evidence (txid, holds_runs)
      select txid_current(), exists (
        select 1 from pg_locks
         where pid = pg_backend_pid() and locktype = 'relation'
           and relation = 'runs'::regclass and mode = 'RowShareLock' and granted)
      on conflict (txid) do nothing;
      return new;
    end $$;
    create trigger ingest_lock_evidence before insert on execution_events
      for each row execute function ingest_lock_evidence();
  `);
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function envelope(sequence: number, run: number): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    eventId: randomUUID(),
    hostKey,
    hostBootId: "5e2d9a1c-4b7f-4c3e-8a6d-1f9b3c7e2a40",
    streamId,
    sequence: String(sequence),
    runId: runIds[run],
    assignmentId: assignmentIds[run],
    assignmentEpoch: 1,
    hostSessionId: "9c4e1b7a-3d2f-4a6e-b8c1-5e7d2a9f3b16",
    eventType: "session.update",
    occurredAt: "2026-09-25T00:00:00.000Z",
    payloadSchema: "maister.session.update.v1",
    payload: { update: { state: `working ${sequence}` } },
  };
}

function sqlState(error: unknown): string | null {
  for (let cause = error, depth = 0; cause && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;

    if (typeof code === "string") return code;
    cause = (cause as { cause?: unknown }).cause;
  }

  return null;
}

describe("batch ingest lock order (ADR-167 amendment 2026-09-25)", () => {
  it("I5: 100 six-run batches never deadlock with an owner apply, a resume CAS and the projector", async () => {
    const peerErrors: string[] = [];
    const batchRetries: Array<Record<string, unknown>> = [];
    const logger = {
      warn: (fields: Record<string, unknown>, message: string) => {
        if (message === "runtime-event-batch-retried")
          batchRetries.push(fields);
      },
      info: () => {},
      debug: () => {},
    } as unknown as Logger;
    const waits: unknown[] = [];
    let running = true;
    const watcher = (async () => {
      while (running) {
        const sample = await testDatabase.pool.query(
          `select a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) as blocked_by,
                  left(a.query, 120) as query,
                  (select json_agg(json_build_object('rel', l.relation::regclass::text, 'mode', l.mode, 'granted', l.granted))
                     from pg_locks l where l.pid = a.pid and l.locktype in ('relation', 'tuple', 'transactionid')) as locks
             from pg_stat_activity a
            where a.datname = current_database() and a.wait_event_type = 'Lock'`,
        );

        if (sample.rows.length > 0) waits.push(...sample.rows);
        await delay(100);
      }
    })();
    const pick = () => Math.floor(Math.random() * RUNS);
    const ownerApply = (async () => {
      while (running) {
        const run = pick();

        try {
          await db.transaction(async (tx) => {
            const bound = await lockCurrentSessionAssignment(tx, {
              runId: runIds[run]!,
              assignmentId: assignmentIds[run]!,
            });

            if (!bound) throw new Error("assignment is not current");
            await tx
              .update(executionCommands)
              // A write of the command row is what an apply does; the value
              // is irrelevant, the NO KEY UPDATE row lock is the point.
              .set({
                applicationAttempts: sql`${executionCommands.applicationAttempts}`,
              })
              .where(eq(executionCommands.id, commandIds[run]!));
          });
        } catch (error) {
          peerErrors.push(`owner:${sqlState(error) ?? String(error)}`);
        }
      }
    })();
    const resumeCas = (async () => {
      while (running) {
        const run = pick();

        try {
          await db.transaction(async (tx) => {
            await tx
              .update(runs)
              .set({ flowRevision: sql`${runs.flowRevision}` })
              .where(eq(runs.id, runIds[run]!));
            await tx
              .select({ id: runs.id })
              .from(runs)
              .where(eq(runs.id, runIds[run]!))
              .for("update");
          });
        } catch (error) {
          peerErrors.push(`resume:${sqlState(error) ?? String(error)}`);
        }
      }
    })();
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
    const batchErrors: string[] = [];

    try {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const base = iteration * (RUNS + 2);
        const held = (iteration + 3) % RUNS;
        const filler = iteration % RUNS;

        try {
          // A row of ANOTHER run waits behind the gap at `base`.
          await ingestRuntimeEventBatch({
            db,
            executionHostId: hostId,
            envelopes: [envelope(base + 1, held)],
            logger,
          });
          const batch = await ingestRuntimeEventBatch({
            db,
            executionHostId: hostId,
            logger,
            envelopes: [
              envelope(base, filler),
              ...Array.from({ length: RUNS }, (_, offset) =>
                envelope(base + 2 + offset, (offset + iteration) % RUNS),
              ),
            ],
          });

          expect(batch.contiguousThrough).toBe(String(base + RUNS + 1));
        } catch (error) {
          batchErrors.push(sqlState(error) ?? String(error));
        }
      }
    } finally {
      running = false;
      await Promise.all([ownerApply, resumeCas, watcher]);
      await worker.stop();
    }
    const evidence = await testDatabase.pool.query<{
      holds_runs: boolean;
      count: string;
    }>(
      "select holds_runs, count(*)::text as count from ingest_lock_evidence group by holds_runs",
    );

    if (
      batchErrors.length > 0 ||
      batchRetries.length > 0 ||
      peerErrors.some((error) => error.includes("40P01"))
    )
      process.stdout.write(
        `${JSON.stringify({ i5: { batchErrors, batchRetries, peerErrors: peerErrors.slice(0, 20), waits: waits.slice(0, 20) } })}\n`,
      );
    expect(batchErrors).toEqual([]);
    expect(batchRetries).toEqual([]);
    expect(peerErrors.filter((error) => error.includes("40P01"))).toEqual([]);
    // Every ingest transaction held its run locks before its first insert.
    expect(evidence.rows).toEqual([
      { holds_runs: true, count: String(2 * ITERATIONS) },
    ]);
  }, 300_000);

  it("I5b: a projector's FK check on a run does not hold a batch back", async () => {
    // A projection transaction that inserted a child row of a run holds
    // KEY SHARE on it until it commits. The batch's run lock must not wait
    // for it: under FOR UPDATE every batch queued behind every such holder.
    const holder = await testDatabase.pool.connect();
    const base = 10_000_000;

    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM runs WHERE id = $1 FOR KEY SHARE", [
        runIds[0],
      ]);
      const batch = ingestRuntimeEventBatch({
        db,
        executionHostId: hostId,
        envelopes: [envelope(base, 0), envelope(base + 1, 1)],
      });
      const outcome = await Promise.race([
        batch.then(() => "committed" as const),
        delay(5_000).then(() => "blocked" as const),
      ]);

      expect(outcome).toBe("committed");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
