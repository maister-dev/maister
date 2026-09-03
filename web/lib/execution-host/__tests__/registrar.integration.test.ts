// ADR-165 T3.2 — local host registrar + resolver (G1–G6) against a REAL
// supervisor child (identity minted into its own state store).

import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import {
  ensureLocalExecutionHost,
  resetRegistrarStateForTests,
} from "@/lib/execution-host/registrar";
import {
  hostForAssignment,
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { runReconcileSweep } from "@/lib/reconcile";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { createFakeExecutionHost } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

vi.mock("@/lib/reconcile", () => ({
  runReconcileSweep: vi.fn(async () => ({})),
}));

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let sup: RealSupervisor;
let sup2: RealSupervisor | null = null;
let sup3: RealSupervisor | null = null;
let restoreUrl: () => void = () => {};

type HostRow = {
  id: string;
  hostKey: string;
  readiness: string;
  readinessReason: string | null;
  lastBootId: string | null;
  capabilities: Record<string, unknown>;
  retiredAt: Date | null;
  updatedAt: Date;
};

async function hostRows(): Promise<HostRow[]> {
  return (await db
    .select()
    .from(schema.executionHosts)
    .orderBy(asc(schema.executionHosts.registeredAt))) as unknown as HostRow[];
}

async function healthIdentity(
  url: string,
): Promise<{ hostKey: string; bootId: string }> {
  const res = await fetch(`${url}/health`, { cache: "no-store" });
  const body = (await res.json()) as {
    host: { hostKey: string; bootId: string };
  };

  return body.host;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_registrar_test",
  });
  db = testDatabase.db as unknown as Db;
  projectId = await seedProject(testDatabase.db);
  sup = await startRealSupervisor();
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await sup?.kill();
  await sup2?.kill();
  await sup3?.kill();
  await testDatabase?.stop();
});

describe("registrar (real supervisor)", () => {
  it("G1: first boot → one row, readiness ready, protocolVersion 1", async () => {
    const result = await ensureLocalExecutionHost({ db });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.action).toBe("insert");

    const rows = await hostRows();
    const identity = await healthIdentity(sup.url);

    expect(rows).toHaveLength(1);
    expect(rows[0].hostKey).toBe(identity.hostKey);
    expect(rows[0].readiness).toBe("ready");
    expect(rows[0].capabilities.protocolVersion).toBe(1);
    expect(rows[0].lastBootId).toBe(identity.bootId);
  });

  it("G2: restart on the same state dir → same row, new boot id, one reconcile", async () => {
    const [before] = await hostRows();

    sup = await sup.restart();
    const identity = await healthIdentity(sup.url);

    expect(identity.hostKey).toBe(before.hostKey);
    expect(identity.bootId).not.toBe(before.lastBootId);

    const result = await ensureLocalExecutionHost({ db });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.action).toBe("restart");
    expect(result.restarted).toBe(true);

    const rows = await hostRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].lastBootId).toBe(identity.bootId);
    expect(vi.mocked(runReconcileSweep)).toHaveBeenCalledTimes(1);

    const again = await ensureLocalExecutionHost({ db });

    expect(again.status === "registered" && again.action).toBe("touch");
    expect(vi.mocked(runReconcileSweep)).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("G3: a different key with zero live assignments retires the old row and inserts the new one", async () => {
    const [old] = await hostRows();

    sup2 = await startRealSupervisor();
    restoreUrl();
    restoreUrl = useRealSupervisorUrl(sup2.url);

    const result = await ensureLocalExecutionHost({ db });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.action).toBe("retire_and_insert");

    const rows = await hostRows();
    const identity = await healthIdentity(sup2.url);

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === old.id)?.retiredAt).not.toBeNull();
    expect(rows.filter((r) => r.retiredAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.retiredAt === null)?.hostKey).toBe(
      identity.hostKey,
    );
  }, 120_000);

  it("G4: a different key while the old row owns a live run is REFUSED and every command resolution fails host_identity_mismatch", async () => {
    const active = (await hostRows()).find((r) => r.retiredAt === null)!;
    const runId = await seedRun(testDatabase.db, {
      projectId,
      status: "Running",
    });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: active.id,
        reason: "launch",
      }),
    );

    sup3 = await startRealSupervisor();
    restoreUrl();
    restoreUrl = useRealSupervisorUrl(sup3.url);
    resetResolverForTests();

    const result = await ensureLocalExecutionHost({ db });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.liveRunIds).toEqual([runId]);

    const rows = await hostRows();
    const stillActive = rows.find((r) => r.retiredAt === null)!;

    expect(rows).toHaveLength(2);
    expect(stillActive.id).toBe(active.id);
    expect(stillActive.readiness).toBe("unavailable");
    expect(stillActive.readinessReason).toBe("identity_changed");

    await expect(hostForAssignment(db, assignment)).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "EXECUTOR_UNAVAILABLE" &&
        err.details?.reason === "host_identity_mismatch",
    );

    // Cleanup: the run finishes, the assignment is released, and the
    // registrar re-observes the sup2 identity → readiness ready again.
    await sup3.kill();
    sup3 = null;
    await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "test"),
    );
    await db
      .update(schema.runs)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, runId));
    restoreUrl();
    restoreUrl = useRealSupervisorUrl(sup2!.url);
    resetResolverForTests();
    const back = await ensureLocalExecutionHost({ db });

    expect(back.status).toBe("registered");
    expect(
      (await hostRows()).find((r) => r.retiredAt === null)?.readiness,
    ).toBe("ready");
  }, 120_000);

  it("G5: an unreachable child marks readiness unavailable at most once per 30 s and never throws", async () => {
    await sup2!.kill();
    resetRegistrarStateForTests();
    let t = Date.now();
    const now = () => new Date(t);

    const first = await ensureLocalExecutionHost({
      db,
      now,
      healthTimeoutMs: 500,
    });

    expect(first.status).toBe("unavailable");
    if (first.status !== "unavailable") return;
    expect(first.reason).toBe("network");

    const afterFirst = (await hostRows()).find((r) => r.retiredAt === null)!;

    expect(afterFirst.readiness).toBe("unavailable");
    expect(afterFirst.readinessReason).toBe("network");

    const second = await ensureLocalExecutionHost({
      db,
      now,
      healthTimeoutMs: 500,
    });

    expect(second.status).toBe("unavailable");
    const afterSecond = (await hostRows()).find((r) => r.retiredAt === null)!;

    expect(afterSecond.updatedAt.getTime()).toBe(
      afterFirst.updatedAt.getTime(),
    );

    t += 30_001;
    await ensureLocalExecutionHost({ db, now, healthTimeoutMs: 500 });
    const afterWindow = (await hostRows()).find((r) => r.retiredAt === null)!;

    expect(afterWindow.updatedAt.getTime()).toBeGreaterThan(
      afterFirst.updatedAt.getTime(),
    );
  }, 60_000);

  it("G6: localHost() memoizes for 30 s — one health call per window", async () => {
    resetResolverForTests();
    resetRegistrarStateForTests();
    const fake = createFakeExecutionHost();
    let t = Date.now();
    const now = () => new Date(t);
    const opts = { db, transport: fake.transport, now };

    const h1 = await localHost(opts);
    const h2 = await localHost(opts);
    const h3 = await localHost(opts);

    expect(h1.hostKey).toBe(fake.identity.hostKey);
    expect(h2.id).toBe(h1.id);
    expect(h3.id).toBe(h1.id);
    expect(fake.callsOf("health")).toHaveLength(1);

    t += 30_001;
    await localHost(opts);
    expect(fake.callsOf("health")).toHaveLength(2);
  });
});
