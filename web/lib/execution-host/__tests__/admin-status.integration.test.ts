import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getAdminExecutionHostStatus,
  isPanelUnavailable,
  type AdminExecutionHostStatus,
} from "@/lib/execution-host/admin-status";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const getPlatformStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/execution-host/platform-status", () => ({
  getPlatformStatus: getPlatformStatusMock,
}));

function availablePanel<T>(
  panel: T | Readonly<{ unavailable: true }>,
): Exclude<T, Readonly<{ unavailable: true }>> {
  expect(isPanelUnavailable(panel)).toBe(false);

  return panel as Exclude<T, Readonly<{ unavailable: true }>>;
}

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
    expect(availablePanel(status.lag).streams).toEqual([
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

  it("D6: a collector failure degrades ONE panel, not the page", async () => {
    getPlatformStatusMock.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "supervisor_down",
      message: "host is offline",
      sessions: [],
    });
    // `execution_hosts_local_active_uq` allows ONE active local host, and the
    // case above already registered it — reuse that row rather than racing the
    // constraint, so this test stays order-independent either way.
    const existing = await database.db.execute(
      sql`SELECT id FROM execution_hosts WHERE retired_at IS NULL LIMIT 1`,
    );

    if (existing.rows.length === 0)
      await seedLocalHost(database.db, { bootId: randomUUID() });

    // Exactly the condition an operator opens this page to diagnose: the
    // aggregate read exceeds its 2 s statement timeout.
    // Only the COLLECTOR's transaction fails; `execute` still works, so the
    // host list and the stored sweep read must survive it.
    const timingOutDb = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async () => {
            throw new Error("canceling statement due to statement timeout");
          };
        }

        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof database.db;

    const status: AdminExecutionHostStatus = await getAdminExecutionHostStatus({
      db: timingOutDb,
      now: new Date("2026-09-22T12:01:00.000Z"),
      logger: { warn: () => {}, debug: () => {} } as never,
    });

    expect(isPanelUnavailable(status.lag)).toBe(true);
    expect(isPanelUnavailable(status.hosts)).toBe(false);
    expect(availablePanel(status.hosts).length).toBeGreaterThan(0);
    expect(status.schedulerClock).toBeDefined();
    expect(status.workers).toBeDefined();
  });
});
