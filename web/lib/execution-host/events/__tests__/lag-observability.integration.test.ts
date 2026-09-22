import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import { commandStreamLost } from "@/lib/execution-host/events/stream-health";
import { consumeRuntimeEventStreamOnce } from "@/lib/execution-host/events/consumer";
import { collectExecutionEventLag } from "@/lib/execution-host/events/lag-read-model";
import { createExecutionObservability } from "@/lib/execution-host/events/lag-observation";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { runEventStreamHealthPass } from "@/lib/execution-host/events/stream-health";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

describe("execution lag observability across the real host and manager stores", () => {
  let database: StartedPostgresTestDb;
  let supervisor: RealSupervisor;
  let restoreUrl: () => void = () => {};
  const quietLogger = pino({ level: "silent" });

  beforeAll(async () => {
    database = await startMainPostgresTestDb({
      databaseName: "execution_lag_observability",
    });
    supervisor = await startRealSupervisor({ fixtureArgs: ["--hang"] });
    restoreUrl = useRealSupervisorUrl(supervisor.url);
  }, 180_000);

  afterAll(async () => {
    restoreUrl();
    await supervisor?.kill();
    await database?.stop();
  });

  it("qualifies ingest and projection lag while the unchanged stall pass alone owns lost", async () => {
    const transport = createLocalDirectTransport();
    const initial = await transport.health();

    expect(initial.kind).toBe("ready");
    if (initial.kind !== "ready" || initial.identity === null) return;

    const runId = randomUUID();
    const assignmentId = randomUUID();
    const workspacePath = path.join(supervisor.runtimeRoot, "lag-workspace");
    const fence = {
      hostKey: initial.identity.hostKey,
      assignmentId,
      assignmentEpoch: 1,
      runId,
    };

    await mkdir(workspacePath, { recursive: true });
    const adopted = await transport.adoptWorkspace(
      buildEnvelope({
        commandId: randomUUID(),
        kind: "workspace.adopt",
        ...fence,
        payload: {
          runId,
          projectSlug: "lag-observability",
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
          stepId: "lag-step",
          executor: { agent: "claude", model: "mock" },
        },
      }),
    );

    for (let index = 0; index < 110; index += 1) {
      await transport.checkpointSession(
        created.sessionId,
        buildEnvelope({
          commandId: randomUUID(),
          kind: "session.checkpoint",
          ...fence,
          payload: {},
        }),
      );
    }

    let heldHealth = await transport.platformStatus();
    const healthDeadline = Date.now() + 15_000;

    while (
      heldHealth.kind !== "ready" ||
      (heldHealth.health.stream?.unacknowledgedCount ?? 0) <= 110
    ) {
      if (Date.now() >= healthDeadline) {
        throw new Error(
          `real supervisor did not publish the lag fixture: ${JSON.stringify(heldHealth)}`,
        );
      }
      await delay(25);
      heldHealth = await transport.platformStatus();
    }

    expect(heldHealth.kind).toBe("ready");
    if (heldHealth.kind !== "ready") return;
    expect(heldHealth.health.stream?.headSequence).not.toBeNull();
    expect(heldHealth.health.stream?.unacknowledgedCount).toBeGreaterThan(0);
    const stream = heldHealth.health.stream!;
    const head = BigInt(stream.headSequence!);
    const host = await seedLocalHost(database.db, {
      hostKey: heldHealth.health.host!.hostKey,
      bootId: heldHealth.health.host!.bootId,
    });
    const streamRowId = randomUUID();
    const projectId = randomUUID();
    const commandId = randomUUID();

    await database.db.execute(sql`
      INSERT INTO projects (
        id, slug, name, repo_path, maister_yaml_path, task_key
      ) VALUES (
        ${projectId}, ${`lag-${projectId}`}, 'Lag observability',
        '/tmp/lag-observability', '/tmp/lag-observability/maister.yaml', 'LAG'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO runs (
        id, project_id, run_kind, status, flow_version, flow_revision
      ) VALUES (
        ${runId}, ${projectId}, 'scratch', 'Running', 'scratch', 'lag-test'
      )
    `);
    await database.db.execute(sql`
      INSERT INTO execution_assignments (
        id, run_id, execution_host_id, epoch, state, placement_reason
      ) VALUES (
        ${assignmentId}, ${runId}, ${host.id}, 1, 'active', 'launch'
      )
    `);
    await database.db.execute(sql`
      UPDATE runs SET execution_assignment_id = ${assignmentId}
      WHERE id = ${runId}
    `);

    await database.db.execute(sql`
      INSERT INTO execution_event_streams (
        id, execution_host_id, stream_id, state,
        last_received_sequence, last_contiguous_sequence,
        last_ack_confirmed_sequence, last_boot_id, last_seen_at
      ) VALUES (
        ${streamRowId}, ${host.id}, ${stream.streamId}, 'active',
        NULL, NULL, NULL,
        ${heldHealth.health.host!.bootId}, ${new Date()}
      )
    `);
    await database.db.execute(sql`
      INSERT INTO execution_commands (
        id, run_id, execution_host_id, execution_assignment_id,
        assignment_epoch, kind, state, max_attempts, accepted_at
      ) VALUES (
        ${commandId}, ${runId}, ${host.id}, ${assignmentId}, 1,
        'session.checkpoint', 'accepted', 1, ${new Date()}
      )
    `);

    const held = await collectExecutionEventLag({
      db: database.db,
      health: heldHealth,
    });

    expect(held.streams[0]).toMatchObject({
      streamState: "active",
      lag: { hostToManager: (head + 1n).toString() },
    });
    expect(held.streams[0].hostTelemetry?.unacknowledgedCount).toBe(
      stream.unacknowledgedCount,
    );

    expect(await commandStreamLost({ db: database.db, commandId })).toBe(false);

    let previous = null;
    let lagging = null;
    const observationStart = Date.now();

    for (let sweep = 0; sweep < 4; sweep += 1) {
      const sampledHealth = await transport.platformStatus();

      await consumeRuntimeEventStreamOnce({
        db: database.db,
        executionHostId: host.id,
        transport,
        owner: "lag-observability-consumer",
        maxEvents: 1,
        logger: quietLogger,
      });
      const model = await collectExecutionEventLag({
        db: database.db,
        health: sampledHealth,
        now: new Date(observationStart + sweep * 1_000),
      });
      const observation = createExecutionObservability({
        attemptId: `lag-attempt-${sweep}`,
        observerId: `lag-observer-${sweep % 2}`,
        model,
        previous,
        workers: {},
        impasse: 0,
        lagAgeMs: 0,
      });

      previous = observation.stream;
      lagging = observation;
      expect(model.streams[0].streamState).toBe("active");
      expect(observation.stream?.hostBacklog).toMatchObject({
        status: "available",
      });
    }

    expect(lagging?.stream).toMatchObject({
      verdict: "lagging",
      incidentOpen: true,
      transition: "lagging",
      streak: 3,
    });
    expect(await commandStreamLost({ db: database.db, commandId })).toBe(false);

    for (let releasePass = 0; releasePass < 10; releasePass += 1) {
      const watermark = await database.db.execute<{ received: string | null }>(
        sql`SELECT last_received_sequence::text AS received
            FROM execution_event_streams WHERE id = ${streamRowId}`,
      );

      const received = BigInt(watermark.rows[0]?.received ?? "-1");

      if (received >= head) break;
      const remaining = head - received;
      const pass = await consumeRuntimeEventStreamOnce({
        db: database.db,
        executionHostId: host.id,
        transport,
        owner: "lag-observability-consumer",
        maxEvents: Number(remaining > 50n ? 50n : remaining),
        logger: quietLogger,
      });

      expect(pass.received).toBeGreaterThan(0);
    }
    await database.db.execute(sql`
      UPDATE execution_event_consumers c
      SET last_run_sequence = horizon.maximum_sequence,
          last_served_at = now()
      FROM (
        SELECT MAX(run_sequence) AS maximum_sequence
        FROM execution_events
        WHERE run_id = ${runId} AND ingest_disposition = 'accepted'
      ) horizon
      WHERE c.run_id = ${runId}
    `);
    const caughtUpHealth = await transport.platformStatus();
    const caughtUp = await collectExecutionEventLag({
      db: database.db,
      health: caughtUpHealth,
      now: new Date(observationStart + 5_000),
    });
    const recovered = createExecutionObservability({
      attemptId: "lag-attempt-recovered",
      observerId: "lag-observer-recovered",
      model: caughtUp,
      previous: lagging?.stream ?? null,
      workers: {},
      impasse: 0,
      lagAgeMs: 0,
    });

    expect(caughtUp.streams[0]).toMatchObject({
      streamState: "active",
      lag: {
        hostToManager: "0",
        contiguityGap: "0",
        ackConfirmation: "0",
      },
    });
    expect(caughtUp.streams[0].hostTelemetry?.unacknowledgedCount).toBe(0);
    expect(recovered.stream).toMatchObject({
      verdict: "clear",
      incidentOpen: false,
      transition: "recovered",
    });

    const consumerName = `lag-projection-${randomUUID()}`;

    await database.db.execute(sql`
      INSERT INTO execution_event_consumers (
        consumer_name, run_id, last_run_sequence, state
      ) VALUES (${consumerName}, ${runId}, NULL, 'ready')
    `);
    const projectionHeld = await collectExecutionEventLag({
      db: database.db,
      health: caughtUpHealth,
    });

    expect(projectionHeld.streams[0].hostTelemetry?.unacknowledgedCount).toBe(
      0,
    );
    expect(BigInt(projectionHeld.consumers.maximumBacklog)).toBeGreaterThan(
      100n,
    );

    for (;;) {
      const projected = await projectExecutionEvents({
        db: database.db,
        runId,
        projector: { consumerName, project: async () => {} },
      });

      if (projected.projected === 0) break;
    }
    const projectionCaughtUp = await collectExecutionEventLag({
      db: database.db,
      health: caughtUpHealth,
    });

    expect(projectionCaughtUp.consumers.maximumBacklog).toBe("0");

    await database.db.execute(sql`
      UPDATE execution_event_streams
      SET last_seen_at = now() - interval '10 minutes'
      WHERE id = ${streamRowId}
    `);
    const firstStall = await runEventStreamHealthPass({
      db: database.db,
      stallSeconds: 300,
      restartConsumer: () => {},
    });

    expect(firstStall).toMatchObject({ stalled: 1, degraded: 0 });
    expect(await commandStreamLost({ db: database.db, commandId })).toBe(false);
    const secondStall = await runEventStreamHealthPass({
      db: database.db,
      stallSeconds: 300,
      restartConsumer: () => {},
    });

    expect(secondStall).toMatchObject({ stalled: 1, degraded: 1 });
    expect(await commandStreamLost({ db: database.db, commandId })).toBe(true);
    const lostModel = await collectExecutionEventLag({
      db: database.db,
      health: caughtUpHealth,
    });
    const lostObservation = createExecutionObservability({
      attemptId: "lag-attempt-lost",
      observerId: "lag-observer-lost",
      model: lostModel,
      previous: recovered.stream
        ? {
            ...recovered.stream,
            incidentOpen: true,
            verdict: "lagging",
          }
        : null,
      workers: {},
      impasse: 1,
      lagAgeMs: 0,
    });

    expect(lostObservation.stream).toMatchObject({
      streamState: "lost",
      verdict: "inactive",
      incidentOpen: false,
      transition: "reset",
    });

    await database.db.execute(sql`
      INSERT INTO execution_event_streams (
        id, execution_host_id, stream_id, state, last_seen_at
      ) VALUES (
        ${randomUUID()}, ${host.id}, ${randomUUID()}, 'active', now()
      )
    `);
    expect(await commandStreamLost({ db: database.db, commandId })).toBe(false);
  }, 60_000);
});
