import type { ExecutionEventProjector } from "../projector";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backfillProjectionConsumers,
  startProjectionWorker,
} from "../projection-worker";
import { CANONICAL_PROJECTION_CONSUMERS } from "../projection-consumers";
import { ingestRuntimeEvent } from "../ingest";
import {
  ExecutionEventProjectionError,
  claimNextExecutionProjection,
  projectExecutionEvents,
  rearmExecutionProjection,
} from "../projector";
import { projectionLimitsFromEnv } from "../projection-limits";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const projectId = randomUUID();

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "projection_worker_test",
  });
  await database.pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     VALUES ($1, 'projection-worker', 'Projection worker', '/tmp/projection-worker', '/tmp/projection-worker/maister.yaml', 'PROJ-WORKER')`,
    [projectId],
  );
  await database.pool.query(`CREATE TABLE projection_worker_effects (
    ordinal bigserial PRIMARY KEY, consumer_name text NOT NULL, event_id text NOT NULL,
    run_id text NOT NULL, UNIQUE (consumer_name, event_id))`);
}, 240_000);

afterAll(async () => {
  await database?.stop();
});

async function seedRun(count: number): Promise<string> {
  const runId = randomUUID();

  await database.pool.query(
    `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision)
     VALUES ($1, $2, 'scratch', 'Pending', 'scratch', 'projection-worker')`,
    [runId, projectId],
  );
  await database.pool.query(
    `INSERT INTO execution_events
     (id, source, source_key, run_id, event_type, payload_schema, payload, payload_bytes, occurred_at, run_sequence, ingest_disposition)
     SELECT $1 || ':' || n, 'manager', n::text, $1, 'test.projection', 'test.projection.v1',
       jsonb_build_object('index', n), 20, now(), n, 'accepted'
     FROM generate_series(0, $2::int - 1) n`,
    [runId, count],
  );

  return runId;
}

function effectProjector(consumerName: string): ExecutionEventProjector {
  return {
    consumerName,
    project: async (tx, event) => {
      await tx.execute(sql`INSERT INTO projection_worker_effects (consumer_name, event_id, run_id)
        VALUES (${consumerName}, ${event.id}, ${event.runId})`);
    },
  };
}

async function waitForCursor(
  consumerName: string,
  runId: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await database.pool.query<{ cursor: string | null }>(
      "SELECT last_run_sequence::text AS cursor FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
      [consumerName, runId],
    );

    if (result.rows[0]?.cursor === expected) return;
    await delay(25);
  }
  throw new Error(
    `projection cursor ${consumerName}/${runId} did not reach ${expected}`,
  );
}

it("shutdown aborts preparation, releases its claim and preserves retry state", async () => {
  const runId = await seedRun(1);
  const consumerName = `shutdown-${randomUUID()}`;
  let prepared: () => void = () => {};
  const preparationStarted = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const worker = startProjectionWorker({
    db: database.db,
    projectors: [
      {
        ...effectProjector(consumerName),
        prepare: async (_db, event, signal) => {
          prepared();
          await delay(60_000, undefined, { signal });

          return event;
        },
      },
    ],
  });

  try {
    await preparationStarted;
    const startedAt = performance.now();

    await worker.stop();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    const result = await database.pool.query<{
      claim_owner: string | null;
      last_run_sequence: string | null;
      state: string;
      attempts: number;
    }>(
      `SELECT claim_owner, last_run_sequence, state, attempts FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2`,
      [consumerName, runId],
    );

    expect(result.rows).toEqual([
      {
        claim_owner: null,
        last_run_sequence: null,
        state: "ready",
        attempts: 0,
      },
    ]);
    expect(
      (
        await database.pool.query(
          `SELECT * FROM projection_worker_effects WHERE consumer_name = $1`,
          [consumerName],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await worker.stop();
  }
}, 15_000);

it("shutdown retains a claim when PostgreSQL cleanup cannot be confirmed", async () => {
  const runId = await seedRun(1);
  const consumerName = `shutdown-connection-${randomUUID()}`;
  const controller = new AbortController();

  await expect(
    projectExecutionEvents({
      db: database.db,
      runId,
      signal: controller.signal,
      projector: {
        consumerName,
        project: async (tx) => {
          const result = await tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );

          await database.pool.query("SELECT pg_terminate_backend($1)", [
            result.rows[0].pid,
          ]);
          controller.abort();
          await tx.execute(sql`SELECT 1`);
        },
      },
    }),
  ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  const state = await database.pool.query<{
    claimed: boolean;
    attempts: number;
    state: string;
  }>(
    "SELECT claim_owner IS NOT NULL AS claimed, attempts, state FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
    [consumerName, runId],
  );

  expect(state.rows).toEqual([{ claimed: true, attempts: 0, state: "ready" }]);
});

it("worker shutdown reports unconfirmed database cleanup instead of a successful drain", async () => {
  const runId = await seedRun(1);
  const consumerName = `shutdown-worker-connection-${randomUUID()}`;
  let releaseProject: () => void = () => {};
  let enteredProject: (pid: number) => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseProject = resolve;
  });
  const entered = new Promise<number>((resolve) => {
    enteredProject = resolve;
  });
  const worker = startProjectionWorker({
    db: database.db,
    projectors: [
      {
        consumerName,
        project: async (tx, event) => {
          if (event.runId !== runId) return;
          const result = await tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );

          enteredProject(result.rows[0].pid);
          await released;
          await tx.execute(sql`SELECT 1`);
        },
      },
    ],
  });
  let stopped: Promise<unknown> | undefined;

  try {
    const pid = await entered;

    stopped = worker.stop().then(
      () => null,
      (error: unknown) => error,
    );
    await database.pool.query("SELECT pg_terminate_backend($1)", [pid]);
    releaseProject();
    expect(await stopped).toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    const state = await database.pool.query(
      "SELECT claim_owner IS NOT NULL AS claimed, attempts, state FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
      [consumerName, runId],
    );

    expect(state.rows).toEqual([
      { claimed: true, attempts: 0, state: "ready" },
    ]);
  } finally {
    releaseProject();
    await (stopped ?? worker.stop());
  }
}, 15_000);

it("bounds hydrated content in a quantum even when reference envelopes are small", async () => {
  const runId = await seedRun(3);
  const consumerName = `hydrated-budget-${randomUUID()}`;
  const projector: ExecutionEventProjector = {
    ...effectProjector(consumerName),
    prepare: async (_db, event) => ({
      ...event,
      payload: { text: "x".repeat(750_000) },
      payloadBytes: 750_000,
    }),
  };

  for (const cursor of ["0", "1", "2"]) {
    const result = await projectExecutionEvents({
      db: database.db,
      runId,
      projector,
    });

    expect(result).toMatchObject({
      projected: 1,
      lastRunSequence: cursor,
      poisoned: false,
    });
  }
  expect(
    (
      await database.pool.query(
        "SELECT * FROM projection_worker_effects WHERE consumer_name = $1",
        [consumerName],
      )
    ).rows,
  ).toHaveLength(3);
});

async function startProductionWorker(): Promise<{
  child: ChildProcess;
  exited: Promise<number | null>;
}> {
  const child = fork(
    path.resolve("test-support/projection-worker-process.ts"),
    [],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let tail = "";
  const record = (chunk: Buffer): void => {
    tail = (tail + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("message", () => resolve());
      }),
      exited.then(() => {
        throw new Error(`projection process exited before readiness: ${tail}`);
      }),
      delay(10_000).then(() => {
        throw new Error(`projection process readiness timed out: ${tail}`);
      }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }

  return { child, exited };
}

describe("autonomous canonical projection worker", () => {
  it("uses configured byte/row quanta and DB-clock lease, then restores defaults after the env is removed", async () => {
    const env = {
      MAISTER_PROJECTION_CONCURRENCY: "1",
      MAISTER_PROJECTION_BATCH_ROWS: "2",
      MAISTER_PROJECTION_BATCH_BYTES: "30",
      MAISTER_PROJECTION_LEASE_MS: "60000",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    const runId = await seedRun(6);
    const consumerName = `configured-${randomUUID()}`;
    const projector = effectProjector(consumerName);

    try {
      Object.assign(process.env, env);
      const limits = projectionLimitsFromEnv();

      expect(limits).toEqual({
        concurrency: 1,
        batchRows: 2,
        batchBytes: 30,
        leaseMs: 60000,
      });
      await database.pool.query(
        "INSERT INTO execution_event_consumers (consumer_name, run_id) VALUES ($1, $2)",
        [consumerName, runId],
      );
      const claim = await claimNextExecutionProjection({
        db: database.db,
        consumerNames: [consumerName],
        owner: "configured",
      });
      const ttl = await database.pool.query<{ ttl: number }>(
        "SELECT extract(epoch FROM (claim_expires_at - clock_timestamp()))::float8 AS ttl FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
        [consumerName, runId],
      );

      expect(claim?.runId).toBe(runId);
      expect(ttl.rows[0]!.ttl).toBeGreaterThan(55);
      expect(ttl.rows[0]!.ttl).toBeLessThanOrEqual(60);
      await database.pool.query(
        "UPDATE execution_event_consumers SET claim_owner = NULL, claim_expires_at = NULL WHERE consumer_name = $1 AND run_id = $2",
        [consumerName, runId],
      );
      const first = await projectExecutionEvents({
        db: database.db,
        runId,
        projector,
      });

      expect(first.projected).toBe(1);
      for (const key of Object.keys(env)) delete process.env[key];
      const rest = await projectExecutionEvents({
        db: database.db,
        runId,
        projector,
      });

      expect(rest.projected).toBe(5);
      Object.assign(process.env, env);
      const nextRun = await seedRun(3);

      expect(
        (
          await projectExecutionEvents({
            db: database.db,
            runId: nextRun,
            projector,
          })
        ).projected,
      ).toBe(1);
      expect(() =>
        projectionLimitsFromEnv({ MAISTER_PROJECTION_CONCURRENCY: "3" }),
      ).toThrow(/MAISTER_PROJECTION_CONCURRENCY/);
      expect(() =>
        projectionLimitsFromEnv({ MAISTER_PROJECTION_LEASE_MS: "5000" }),
      ).toThrow(/MAISTER_PROJECTION_LEASE_MS/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("AT-03: seeds every run released by another run's stream gap", async () => {
    const firstRun = await seedRun(0);
    const secondRun = await seedRun(0);
    const hostId = randomUUID();
    const hostKey = `eh_${randomUUID().replaceAll("-", "")}`;
    const streamId = randomUUID();
    const firstAssignment = randomUUID();
    const secondAssignment = randomUUID();

    await database.pool.query(
      `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport)
      VALUES ($1, $2, 'local_direct', 'gap host', '{"kind":"local_direct"}')`,
      [hostId, hostKey],
    );
    await database.pool.query(
      `INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
      VALUES ($1, $2, $3, 1, 'active', 'launch'), ($4, $5, $3, 1, 'active', 'launch')`,
      [firstAssignment, firstRun, hostId, secondAssignment, secondRun],
    );
    const envelope = (
      runId: string,
      assignmentId: string,
      sequence: string,
    ): Record<string, unknown> => ({
      envelopeVersion: 1,
      eventId: randomUUID(),
      hostKey,
      hostBootId: randomUUID(),
      streamId,
      sequence,
      runId,
      assignmentId,
      assignmentEpoch: 1,
      hostSessionId: null,
      occurredAt: new Date().toISOString(),
      eventType: "usage.recorded",
      payloadSchema: "maister.usage.recorded.v1",
      payload: { inputTokens: 1, model: "test", sessionName: "default" },
    });

    await ingestRuntimeEvent({
      db: database.db,
      executionHostId: hostId,
      envelope: envelope(firstRun, firstAssignment, "0"),
    });
    await ingestRuntimeEvent({
      db: database.db,
      executionHostId: hostId,
      envelope: envelope(secondRun, secondAssignment, "2"),
    });
    const before = await database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM execution_event_consumers WHERE run_id = $1",
      [secondRun],
    );

    expect(before.rows).toEqual([{ count: 0 }]);
    const filled = await ingestRuntimeEvent({
      db: database.db,
      executionHostId: hostId,
      envelope: envelope(firstRun, firstAssignment, "1"),
    });
    const after = await database.pool.query<{ consumer_name: string }>(
      "SELECT consumer_name FROM execution_event_consumers WHERE run_id = $1",
      [secondRun],
    );

    expect(filled.acceptedCount).toBe(2);
    expect(after.rows.map((row) => row.consumer_name).sort()).toEqual(
      Object.values(CANONICAL_PROJECTION_CONSUMERS).sort(),
    );
    await database.pool.query(
      "UPDATE execution_assignments SET state = 'released', ended_at = now(), released_reason = 'test_complete' WHERE execution_host_id = $1",
      [hostId],
    );
    await database.pool.query(
      "UPDATE execution_hosts SET retired_at = now() WHERE id = $1",
      [hostId],
    );
  });

  it("AT-03: bounds payload bytes before loading event bodies", async () => {
    const runId = await seedRun(25);

    await database.pool.query(
      `UPDATE execution_events SET payload = jsonb_build_object('text', repeat('x', 60000)), payload_bytes = 60011 WHERE run_id = $1`,
      [runId],
    );
    const result = await projectExecutionEvents({
      db: database.db,
      runId,
      projector: {
        consumerName: `bytes:${randomUUID()}`,
        project: async () => {},
      },
    });

    expect(result).toMatchObject({ projected: 17, lastRunSequence: "16" });
  });

  it("AT-03: backfills at most 100 runs and resumes after its cursor run is deleted", async () => {
    const prefix = `zz-backfill:${randomUUID()}:`;
    const consumerName = `backfill:${randomUUID()}`;

    await database.pool.query(
      `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision)
      SELECT $1 || lpad(n::text, 3, '0'), $2, 'scratch', 'Pending', 'scratch', 'backfill'
      FROM generate_series(0, 100) n`,
      [prefix, projectId],
    );
    await database.pool.query(
      `INSERT INTO execution_events (id, source, source_key, run_id, event_type, payload_schema, payload, occurred_at, run_sequence, ingest_disposition)
      SELECT id || ':event', 'manager', '0', id, 'test.projection', 'test.v1', '{}', now(), 0, 'accepted'
      FROM runs WHERE starts_with(id, $1)`,
      [prefix],
    );
    const first = await backfillProjectionConsumers(database.db, consumerName);

    expect(first).toEqual({ complete: false, seeded: 100 });
    const cursor = await database.pool.query<{ after_run_id: string }>(
      "SELECT after_run_id FROM execution_projection_backfills WHERE consumer_name = $1",
      [consumerName],
    );

    expect(cursor.rows[0].after_run_id.startsWith(prefix)).toBe(true);
    await database.pool.query("DELETE FROM runs WHERE id = $1", [
      cursor.rows[0].after_run_id,
    ]);
    const second = await backfillProjectionConsumers(database.db, consumerName);
    const missing = await database.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM runs r
      WHERE EXISTS (SELECT 1 FROM execution_events e WHERE e.run_id = r.id AND e.ingest_disposition = 'accepted')
      AND NOT EXISTS (SELECT 1 FROM execution_event_consumers c WHERE c.run_id = r.id AND c.consumer_name = $1)`,
      [consumerName],
    );

    expect(second.complete).toBe(true);
    expect(second.seeded).toBeGreaterThan(0);
    expect(second.seeded).toBeLessThanOrEqual(100);
    expect(missing.rows).toEqual([{ count: 0 }]);
  });

  it("AT-04: rearms only the observed failure generation and cursor", async () => {
    const runId = await seedRun(1);
    const consumerName = `repair:${randomUUID()}`;
    const failure = await projectExecutionEvents({
      db: database.db,
      runId,
      projector: {
        consumerName,
        project: async () => {
          throw new ExecutionEventProjectionError("repair required", true);
        },
      },
    });
    const state = await database.pool.query<{
      error_generation: string;
      event_id: string;
    }>(
      "SELECT last_error->>'errorGeneration' AS error_generation, last_error->>'eventId' AS event_id FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
      [consumerName, runId],
    );
    const input = {
      db: database.db,
      runId,
      consumerName,
      eventId: state.rows[0].event_id,
      expectedCursor: null,
      errorGeneration: state.rows[0].error_generation,
    };

    expect(failure.poisoned).toBe(true);
    await expect(
      rearmExecutionProjection({ ...input, errorGeneration: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      rearmExecutionProjection({ ...input, expectedCursor: 0n }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await rearmExecutionProjection(input);
    const completed = await projectExecutionEvents({
      db: database.db,
      runId,
      projector: effectProjector(consumerName),
    });

    expect(completed).toMatchObject({ projected: 1, lastRunSequence: "0" });
    await expect(rearmExecutionProjection(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("AT-03: production registry recovers a killed claim and a terminal event after sequence 200", async () => {
    const runId = await seedRun(260);
    const hostId = randomUUID();
    const assignmentId = randomUUID();
    const commandId = randomUUID();
    const hostKey = `eh_${randomUUID().replaceAll("-", "")}`;

    await database.pool.query(
      "UPDATE runs SET run_kind = 'agent', next_execution_event_sequence = 260 WHERE id = $1",
      [runId],
    );
    await database.pool.query(
      `UPDATE execution_events SET
      event_type = CASE WHEN run_sequence % 10 = 0 THEN 'usage.recorded' ELSE 'session.update' END,
      payload = CASE WHEN run_sequence % 10 = 0 THEN '{"inputTokens":1,"model":"test","sessionName":"default"}'::jsonb
        ELSE '{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}'::jsonb END
      WHERE run_id = $1`,
      [runId],
    );
    await database.pool.query(
      `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport)
      VALUES ($1, $2, 'local_direct', 'projection host', '{"kind":"local_direct"}')`,
      [hostId, hostKey],
    );
    await database.pool.query(
      `INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
      VALUES ($1, $2, $3, 1, 'active', 'launch')`,
      [assignmentId, runId, hostId],
    );
    await database.pool.query(
      `INSERT INTO execution_commands (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch, kind, payload, state, max_attempts)
      VALUES ($1, $2, $3, $4, 1, 'session.prompt', '{}', 'delivering', 3)`,
      [commandId, runId, assignmentId, hostId],
    );
    await ingestRuntimeEvent({
      db: database.db,
      executionHostId: hostId,
      envelope: {
        envelopeVersion: 1,
        eventId: randomUUID(),
        hostKey,
        hostBootId: randomUUID(),
        streamId: randomUUID(),
        sequence: "0",
        runId,
        assignmentId,
        assignmentEpoch: 1,
        hostSessionId: null,
        occurredAt: new Date().toISOString(),
        eventType: "session.command",
        payloadSchema: "maister.session.command.v1",
        payload: {
          commandId,
          kind: "session.prompt",
          phase: "completed",
          status: "succeeded",
          result: { stopReason: "end_turn", meta: null },
        },
      },
    });
    await database.pool
      .query(`CREATE FUNCTION slow_projection_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$`);
    await database.pool
      .query(`CREATE TRIGGER slow_projection_state BEFORE INSERT ON run_transcript_states
      FOR EACH ROW EXECUTE FUNCTION slow_projection_state()`);
    const first = await startProductionWorker();

    try {
      const deadline = Date.now() + 10_000;
      let claimed = false;

      while (Date.now() < deadline) {
        const state = await database.pool.query<{ claimed: boolean }>(
          "SELECT claim_owner IS NOT NULL AS claimed FROM execution_event_consumers WHERE run_id = $1 AND consumer_name = $2",
          [runId, CANONICAL_PROJECTION_CONSUMERS.transcript],
        );

        if (state.rows[0]?.claimed) {
          claimed = true;
          break;
        }
        await delay(20);
      }
      expect(claimed).toBe(true);
    } finally {
      first.child.kill("SIGKILL");
      await first.exited;
      await database.pool.query(
        "DROP TRIGGER slow_projection_state ON run_transcript_states",
      );
      await database.pool.query("DROP FUNCTION slow_projection_state()");
    }
    const second = await startProductionWorker();

    try {
      // No ingest or manual lease edit: the production DB-clock lease expires.
      await Promise.all(
        Object.values(CANONICAL_PROJECTION_CONSUMERS).map((name) =>
          waitForCursor(name, runId, "260", 40_000),
        ),
      );
      const command = await database.pool.query<{ state: string }>(
        "SELECT state FROM execution_commands WHERE id = $1",
        [commandId],
      );
      const transcript = await database.pool.query<{ content: string }>(
        "SELECT content FROM run_messages WHERE run_id = $1",
        [runId],
      );
      const cost = await database.pool.query<{
        input_tokens: number;
        source_event_count: number;
      }>(
        "SELECT input_tokens, source_event_count FROM run_cost_rollups WHERE run_id = $1",
        [runId],
      );

      expect(command.rows).toEqual([{ state: "succeeded" }]);
      expect(transcript.rows).toEqual([{ content: "x".repeat(234) }]);
      expect(cost.rows).toEqual([{ input_tokens: 26, source_event_count: 26 }]);
    } finally {
      second.child.kill("SIGTERM");
      await second.exited;
    }
  }, 60_000);

  it("AT-03: drains more than two batches fairly after restart without new ingest", async () => {
    const longRun = await seedRun(260);
    const shortRun = await seedRun(1);
    const consumerName = `drain:${randomUUID()}`;
    const projector = effectProjector(consumerName);

    // Persist the boot scan before replacing the worker process state. The
    // second activation must rediscover backlog from durable consumer cursors.
    await backfillProjectionConsumers(database.db, consumerName);
    const first = startProjectionWorker({
      db: database.db,
      projectors: [projector],
    });

    await first.stop();
    const second = startProjectionWorker({
      db: database.db,
      projectors: [projector],
    });
    const competitor = startProjectionWorker({
      db: database.db,
      projectors: [projector],
    });

    try {
      await Promise.all([
        waitForCursor(consumerName, longRun, "259"),
        waitForCursor(consumerName, shortRun, "0"),
      ]);
      const effects = await database.pool.query<{ run_id: string }>(
        "SELECT run_id FROM projection_worker_effects WHERE consumer_name = $1 AND run_id = ANY($2::text[]) ORDER BY ordinal",
        [consumerName, [longRun, shortRun]],
      );

      expect(effects.rows).toHaveLength(261);
      expect(
        effects.rows.findIndex((row) => row.run_id === shortRun),
      ).toBeLessThan(260);
      expect(await second.health()).toEqual({ state: "running", reason: null });
      expect(await competitor.health()).toEqual({
        state: "running",
        reason: null,
      });
    } finally {
      await Promise.all([second.stop(), competitor.stop()]);
    }
  }, 25_000);

  it("AT-03: services a last-event transient retry after its deadline without a new event", async () => {
    const runId = await seedRun(1);
    const consumerName = `retry:${randomUUID()}`;
    const ordinary = effectProjector(consumerName);
    let shouldFail = true;
    const worker = startProjectionWorker({
      db: database.db,
      projectors: [
        {
          consumerName,
          project: async (tx, event) => {
            if (event.runId === runId && shouldFail) {
              shouldFail = false;
              throw new Error("injected temporary projection failure");
            }
            await ordinary.project(tx, event);
          },
        },
      ],
    });

    try {
      await waitForCursor(consumerName, runId, "0");
      const rows = await database.pool.query<{
        attempts: number;
        state: string;
      }>(
        "SELECT attempts, state FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
        [consumerName, runId],
      );

      expect(shouldFail).toBe(false);
      expect(rows.rows).toEqual([{ attempts: 0, state: "ready" }]);
    } finally {
      await worker.stop();
    }
  }, 25_000);
});
