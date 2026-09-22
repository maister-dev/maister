import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import { collectExecutionEventLag } from "@/lib/execution-host/events/lag-read-model";
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

  it("reports held ingest from the host head, then returns to zero without changing active stream state", async () => {
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

    await transport.createSession(
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

    const heldHealth = await transport.platformStatus();

    expect(heldHealth.kind).toBe("ready");
    if (heldHealth.kind !== "ready") return;
    expect(heldHealth.health.stream?.headSequence).not.toBeNull();
    expect(heldHealth.health.stream?.unacknowledgedCount).toBeGreaterThan(0);
    const stream = heldHealth.health.stream!;
    const head = BigInt(stream.headSequence!);
    const managerSequence = head > 0n ? head - 1n : -1n;
    const host = await seedLocalHost(database.db, {
      hostKey: heldHealth.health.host!.hostKey,
      bootId: heldHealth.health.host!.bootId,
    });
    const streamRowId = randomUUID();

    await database.db.execute(sql`
      INSERT INTO execution_event_streams (
        id, execution_host_id, stream_id, state,
        last_received_sequence, last_contiguous_sequence,
        last_ack_confirmed_sequence, last_boot_id, last_seen_at
      ) VALUES (
        ${streamRowId}, ${host.id}, ${stream.streamId}, 'active',
        ${managerSequence < 0n ? null : managerSequence},
        ${managerSequence < 0n ? null : managerSequence},
        ${managerSequence < 0n ? null : managerSequence},
        ${heldHealth.health.host!.bootId}, ${new Date()}
      )
    `);

    const held = await collectExecutionEventLag({
      db: database.db,
      health: heldHealth,
    });

    expect(held.streams[0]).toMatchObject({
      streamState: "active",
      lag: { hostToManager: "1" },
    });
    expect(held.streams[0].hostTelemetry?.unacknowledgedCount).toBe(
      stream.unacknowledgedCount,
    );

    await database.db.execute(sql`
      UPDATE execution_event_streams
      SET last_received_sequence = ${head},
          last_contiguous_sequence = ${head},
          last_ack_confirmed_sequence = ${head}
      WHERE id = ${streamRowId}
    `);
    await transport.acknowledgeRuntimeEvents({
      streamId: stream.streamId,
      throughSequence: head.toString(),
    });
    const caughtUpHealth = await transport.platformStatus();
    const caughtUp = await collectExecutionEventLag({
      db: database.db,
      health: caughtUpHealth,
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
  }, 60_000);
});
