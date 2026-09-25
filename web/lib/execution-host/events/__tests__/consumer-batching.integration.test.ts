// ADR-167 amendment (2026-09-25), I4a / I4b / I6: the consumer pass reads a
// REAL supervisor's stream into a bounded buffer and commits it in batches.
// Each case owns its supervisor (and so its host and stream): the batch and ACK
// counts are only exact against a stream whose starting watermark is known.
import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import {
  consumeRuntimeEventStreamOnce,
  RUNTIME_EVENT_CONSUMER_STALL_MS,
  resetRuntimeEventConsumersForTests,
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { findStalledEventStreams } from "@/lib/execution-host/events/stream-health";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { countingTransport } from "@/test-support/counting-execution-host-transport";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  // Not a React hook; aliased so the hooks lint rule does not read it as one.
  useRealSupervisorUrl as pointTransportAtSupervisor,
} from "@/test-support/real-supervisor";

const T_MS = 250;

let database: StartedPostgresTestDb;
let db: Db;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "consumer_batching",
  });
  db = database.db as unknown as Db;
}, 240_000);

afterEach(async () => {
  await stopRuntimeEventConsumers();
  resetRuntimeEventConsumersForTests();
  while (cleanups.length > 0) await cleanups.pop()!();
});

afterAll(async () => {
  await database?.stop();
});

type Case = {
  supervisor: RealSupervisor;
  hostId: string;
  head(): Promise<bigint>;
  emit(): Promise<void>;
};

/** A real supervisor, its host row, a known run bound to it, and a session
 * whose checkpoint commands each commit host events. */
async function startCase(name: string): Promise<Case> {
  const supervisor = await startRealSupervisor({ fixtureArgs: ["--hang"] });
  const restoreUrl = pointTransportAtSupervisor(supervisor.url);

  cleanups.push(async () => {
    restoreUrl();
    await supervisor.kill();
  });
  const transport = createLocalDirectTransport();
  const health = await transport.health();

  if (health.kind !== "ready" || health.identity === null)
    throw new Error(`supervisor is not ready: ${JSON.stringify(health)}`);
  // One non-retired local host at a time; ingest resolves hosts by id.
  await database.pool.query(
    "update execution_hosts set retired_at = now() where retired_at is null",
  );
  const host = await seedLocalHost(database.db, {
    hostKey: health.identity.hostKey,
    bootId: health.identity.bootId,
  });
  const projectId = randomUUID();
  const runId = randomUUID();
  const assignmentId = randomUUID();

  await database.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, 'Consumer batching', $3, $4, $5)`,
    [
      projectId,
      `batching-${name}-${projectId.slice(0, 8)}`,
      `/tmp/consumer-batching-${projectId}`,
      `/tmp/consumer-batching-${projectId}/maister.yaml`,
      `CB${projectId.slice(0, 6)}`.toUpperCase(),
    ],
  );
  await database.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'scratch', 'Running', 'scratch', 'batching')`,
    [runId, projectId],
  );
  await database.pool.query(
    `insert into execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
     values ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, host.id],
  );
  await database.pool.query(
    "update runs set execution_assignment_id = $1 where id = $2",
    [assignmentId, runId],
  );
  // Open work, so the stall predicate has something that ought to produce
  // events (a quiet host with nothing open is never stalled).
  await database.pool.query(
    `insert into execution_commands (id, run_id, execution_host_id, execution_assignment_id,
       assignment_epoch, kind, state, max_attempts, accepted_at)
     values ($1, $2, $3, $4, 1, 'session.checkpoint', 'accepted', 1, now())`,
    [randomUUID(), runId, host.id, assignmentId],
  );
  const fence = {
    hostKey: health.identity.hostKey,
    assignmentId,
    assignmentEpoch: 1,
    runId,
  };
  const workspacePath = path.join(supervisor.runtimeRoot, `ws-${name}`);

  await mkdir(workspacePath, { recursive: true });
  const adopted = await transport.adoptWorkspace(
    buildEnvelope({
      commandId: randomUUID(),
      kind: "workspace.adopt",
      ...fence,
      payload: {
        runId,
        projectSlug: `batching-${name}`,
        kind: "directory",
        path: workspacePath,
      },
    }),
  );
  const created = await transport.createSession(
    buildEnvelope({
      commandId: randomUUID(),
      kind: "session.create",
      ...fence,
      payload: {
        executionWorkspaceId: adopted.executionWorkspaceId,
        stepId: `${name}-step`,
        executor: { agent: "claude", model: "mock" },
      },
    }),
  );

  return {
    supervisor,
    hostId: host.id,
    async head() {
      const status = await transport.platformStatus();

      if (status.kind !== "ready" || !status.health.stream?.headSequence)
        throw new Error("host stream head is unavailable");

      return BigInt(status.health.stream.headSequence);
    },
    async emit() {
      await transport.checkpointSession(
        created.sessionId,
        buildEnvelope({
          commandId: randomUUID(),
          kind: "session.checkpoint",
          ...fence,
          payload: {},
        }),
      );
    },
  };
}

describe("batched runtime-event consumer on a real supervisor", () => {
  it("I6: a burst of 3N events is acknowledged once per batch, never per event", async () => {
    const saved = process.env.MAISTER_EVENT_INGEST_BATCH_ROWS;
    // N small enough that 3N fits one host replay page: the burst then reaches
    // the manager on ONE connection whatever the host's paging does.
    const N = 100;

    process.env.MAISTER_EVENT_INGEST_BATCH_ROWS = String(N);
    cleanups.push(async () => {
      if (saved === undefined)
        delete process.env.MAISTER_EVENT_INGEST_BATCH_ROWS;
      else process.env.MAISTER_EVENT_INGEST_BATCH_ROWS = saved;
    });
    const host = await startCase("burst");

    while ((await host.head()) + 1n < BigInt(3 * N)) await host.emit();
    expect(await host.head()).toBe(BigInt(3 * N - 1));
    const counting = countingTransport(createLocalDirectTransport());
    const totals = { received: 0, batches: 0, acknowledged: 0, passes: 0 };

    // Until the host serves a whole burst on one connection (T7) it may end
    // the stream early; every pass still acknowledges per batch.
    while (totals.received < 3 * N && totals.passes < 20) {
      const pass = await consumeRuntimeEventStreamOnce({
        db,
        executionHostId: host.hostId,
        transport: counting.transport,
        owner: "i6-consumer",
        maxEvents: 3 * N - totals.received,
      });

      expect(pass.reconnectRequired).toBe(false);
      totals.received += pass.received;
      totals.batches += pass.batches;
      totals.acknowledged += pass.acknowledged;
      totals.passes += 1;
    }

    expect(totals.received).toBe(3 * N);
    expect(counting.counts.ackRequests).toBe(totals.acknowledged);
    // One ACK per committed batch at most; a connection the host ends early
    // splits at most one batch.
    expect(totals.acknowledged).toBeLessThanOrEqual(totals.batches);
    expect(totals.batches).toBeLessThanOrEqual(
      3 + counting.counts.streamOpens - 1,
    );
  });

  it("I4a: a trickle commits within T and never reads as a stall", async () => {
    const host = await startCase("trickle");
    const controller = new AbortController();
    const pass = consumeRuntimeEventStreamOnce({
      db,
      executionHostId: host.hostId,
      transport: createLocalDirectTransport(),
      owner: "i4a-consumer",
      signal: controller.signal,
    });
    const stalls: unknown[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const stalled = await findStalledEventStreams({ db, stallSeconds: 1 });

        // The predicate is host-wide; earlier cases' streams are not ours.
        stalls.push(
          ...stalled.filter((row) => row.executionHostId === host.hostId),
        );
        await delay(50);
      }
    })();
    const startHead = await host.head();

    try {
      // One event every T/2 for 10 × T.
      for (let index = 0; index < 20; index += 1) {
        await host.emit();
        await delay(T_MS / 2);
      }
      await delay(2 * T_MS);
    } finally {
      sampling = false;
      await sampler;
      controller.abort();
      await pass;
    }
    const delays = await database.pool.query<{ delay_ms: number }>(
      `select extract(epoch from (e.received_at - e.occurred_at)) * 1000 as delay_ms
         from execution_events e
         join execution_event_streams s on s.id = e.event_stream_id
        where s.execution_host_id = $1 and e.host_sequence > $2`,
      [host.hostId, startHead.toString()],
    );

    expect(delays.rows.length).toBeGreaterThanOrEqual(20);
    // Held no longer than T plus one transaction, never until N rows arrive.
    expect(
      Math.max(...delays.rows.map((row) => Number(row.delay_ms))),
    ).toBeLessThan(T_MS + 750);
    expect(stalls).toEqual([]);
  });

  it("I4b: a pass that stays open under load is never replaced as stalled", async () => {
    const host = await startCase("progress");
    const transport = createLocalDirectTransport();

    startRuntimeEventConsumer({ db, executionHostId: host.hostId, transport });
    const loops = globalThis.__maisterRuntimeEventConsumers!;
    const loop = loops.get(host.hostId)!;
    const startedAt = loop.lastProgressAt;

    for (let index = 0; index < 30; index += 1) {
      await host.emit();
      await delay(100);
    }
    await delay(2 * T_MS);
    // Still one open pass: the host closed nothing at this volume.
    expect(loop.lastProgressAt - startedAt).toBeGreaterThan(2_000);
    // The next activation, with the clock where it would stand after the
    // stall window of an equally busy pass: a loop that only reported progress
    // when a pass RETURNED would be aborted and replaced here.
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(startedAt + RUNTIME_EVENT_CONSUMER_STALL_MS + 1_000);

    try {
      startRuntimeEventConsumer({
        db,
        executionHostId: host.hostId,
        transport,
      });
    } finally {
      clock.mockRestore();
    }
    expect(loops.get(host.hostId)).toBe(loop);
    expect(loop.controller.signal.aborted).toBe(false);
  });
});
