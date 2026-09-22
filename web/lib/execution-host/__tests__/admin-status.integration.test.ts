import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getAdminExecutionHostStatus } from "@/lib/execution-host/admin-status";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const getPlatformStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/execution-host/platform-status", () => ({
  getPlatformStatus: getPlatformStatusMock,
}));

describe("execution host admin status", () => {
  let database: StartedPostgresTestDb;

  beforeAll(async () => {
    database = await startMainPostgresTestDb({
      databaseName: "execution_host_admin_status",
    });
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  });

  it("keeps manager evidence visible when the live host is unavailable", async () => {
    getPlatformStatusMock.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "supervisor_down",
      message: "host is offline",
      sessions: [],
    });
    const bootId = randomUUID();
    const streamId = randomUUID();
    const host = await seedLocalHost(database.db, { bootId });

    await database.db.execute(sql`
      INSERT INTO execution_event_streams (
        id, execution_host_id, stream_id, state,
        last_received_sequence, last_contiguous_sequence,
        last_ack_confirmed_sequence, last_boot_id, last_seen_at, last_error
      ) VALUES (
        ${randomUUID()}, ${host.id}, ${streamId}, 'active',
        12, 10, 9, ${bootId}, ${new Date("2026-09-22T12:00:00.000Z")},
        ${JSON.stringify({ reason: "fixture_stream_error" })}::jsonb
      )
    `);

    const status = await getAdminExecutionHostStatus({
      db: database.db,
      now: new Date("2026-09-22T12:01:00.000Z"),
    });

    expect(status.hosts).toEqual([
      expect.objectContaining({
        id: host.id,
        readiness: "ready",
        bootId,
      }),
    ]);
    expect(status.lag.streams).toEqual([
      expect.objectContaining({
        streamId,
        streamState: "active",
        lastReceivedSequence: "12",
        lastContiguousSequence: "10",
        lastAckConfirmedSequence: "9",
        lastError: { reason: "fixture_stream_error" },
        hostTelemetryStatus: "unavailable",
        lag: {
          hostToManager: null,
          contiguityGap: "2",
          ackConfirmation: "1",
          diagnostics: [],
        },
      }),
    ]);
  });
});
