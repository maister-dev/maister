// ADR-166 T3.2 — local host registrar + resolver (G1–G8) against a REAL
// supervisor child (identity minted into its own state store), plus fake
// transports where a scenario needs a scripted identity.

import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";
import pino, { type Logger } from "pino";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { EXECUTION_HOST_KEY_HEADER } from "../../../../runtime/execution-host-address";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host";
import {
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import {
  ensureLocalExecutionHost,
  resetRegistrarStateForTests,
} from "@/lib/execution-host/registrar";
import {
  hostForAssignment,
  localHost,
  primeResolverForTests,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import {
  checkAssignedHostDiagnostics,
  registerRemoteHost,
} from "@/lib/execution-host/remote-direct";
import { resetRuntimeEventConsumersForTests } from "@/lib/execution-host/events/consumer";
import { runReconcileSweep } from "@/lib/reconcile";
import { assertCapabilityGuardEvidence } from "@/lib/flows/enforcement-evidence";
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

// The registrar no longer runs any domain sweep; the mock stays as the
// regression guard that it never does again.
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

function captureLogger(): {
  logger: Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => void lines.push(JSON.parse(s)) },
  );

  return { logger, lines };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not settle in ${ms} ms`)),
        ms,
      ),
    ),
  ]);
}

async function remoteReadiness(hostId: string): Promise<
  | {
      readiness: string;
      readinessReason: string | null;
      updatedAt: Date;
      lastSeenAt: Date | null;
    }
  | undefined
> {
  return (
    await db
      .select({
        readiness: fullSchema.executionHosts.readiness,
        readinessReason: fullSchema.executionHosts.readinessReason,
        updatedAt: fullSchema.executionHosts.updatedAt,
        lastSeenAt: fullSchema.executionHosts.lastSeenAt,
      })
      .from(fullSchema.executionHosts)
      .where(eq(fullSchema.executionHosts.id, hostId))
  )[0];
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
  resetRuntimeEventConsumersForTests();
  restoreUrl();
  await sup?.kill();
  await sup2?.kill();
  await sup3?.kill();
  await testDatabase?.stop();
});

afterEach(() => {
  resetRuntimeEventConsumersForTests();
});

describe("registrar (real supervisor)", () => {
  it("requires an explicit shared-workspace topology before starting remote placements", async () => {
    vi.stubEnv("MAISTER_EXECUTION_HOST_PREFERRED_KEY", "supervisor-remote");
    vi.stubEnv("MAISTER_EXECUTION_HOST_SHARED_WORKSPACE", undefined);
    vi.stubEnv("MAISTER_EXECUTION_HOST_ENDPOINTS", "{}");

    try {
      await expect(localHost({ db })).rejects.toMatchObject({
        code: "CONFIG",
        details: { reason: "remote_shared_workspace_required" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it("C-04: addressed admission refuses an incompatible or replaced peer and recovers its receipt after a same-key boot", async () => {
    const registered = await ensureLocalExecutionHost({ db });
    if (registered.status !== "registered")
      throw new Error("owner not registered");
    const owner = registered.host;
    const runId = await seedRun(testDatabase.db, {
      projectId,
      runKind: "flow",
    });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: owner.id,
        reason: "legacy_backfill",
      }),
    );
    const directory = join(sup.runtimeRoot, "addressed-c04");
    await mkdir(directory);
    const other = await startRealSupervisor();
    let upstream = other.url;
    let changeProtocol = false;
    let disableAsyncPrompt = false;
    const effectRequests: string[] = [];
    const proxyErrors: Error[] = [];
    const proxy = createServer(async (request, reply) => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      if (method !== "GET") effectRequests.push(method + " " + path);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const name of ["content-type", EXECUTION_HOST_KEY_HEADER]) {
          const value = request.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        const response = await fetch(upstream + path, {
          method,
          headers,
          body: method === "GET" ? undefined : Buffer.concat(chunks),
        });
        const body = await response.json();
        if (changeProtocol && path.startsWith("/health")) {
          body.host.protocolVersion = 2;
        }
        if (disableAsyncPrompt && path === "/capabilities") {
          body.asyncPrompt = false;
        }
        reply.writeHead(response.status, {
          "content-type": "application/json",
        });
        reply.end(JSON.stringify(body));
      } catch (error) {
        if (error instanceof Error) proxyErrors.push(error);
        reply.destroy(error as Error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const port = proxy.address();
    if (!port || typeof port === "string")
      throw new Error("proxy not listening");
    const restore = useRealSupervisorUrl(`http://127.0.0.1:${port.port}`);
    vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", owner.hostKey);
    const hosts = createExecutionHosts({ db });
    const spec = {
      runId,
      projectSlug: "addressed",
      kind: "directory" as const,
      path: directory,
    };
    const attempt = async () =>
      (await hosts.forAssignment(assignment)).adoptWorkspace(spec);

    try {
      // Exercise production admission and outbound command routing through a
      // single stable endpoint whose upstream is switched between real peers.
      primeResolverForTests(owner);
      await expect(attempt()).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "host_identity_mismatch" },
      });
      expect(effectRequests).toEqual([]);
      expect(await listCommandsForRun(db, runId)).toEqual([]);

      upstream = sup.url;
      changeProtocol = true;
      await expect(attempt()).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "workspace_protocol_unsupported" },
      });
      expect(effectRequests).toEqual([]);

      changeProtocol = false;
      disableAsyncPrompt = true;
      await expect(attempt()).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "workspace_protocol_unsupported" },
      });
      expect(effectRequests).toEqual([]);
      disableAsyncPrompt = false;
      const accepted = await attempt().catch((error: unknown) => {
        throw new AggregateError(
          [error, ...proxyErrors],
          "workspace command failed through fixture proxy",
        );
      });
      const [command] = await listCommandsForRun(db, runId);
      expect(command.state).toBe("succeeded");
      const receipt = await hosts.local().getCommandReceipt(command.id);
      expect(receipt).toMatchObject({ commandId: command.id });
      upstream = other.url;
      await expect(
        hosts.local().getCommandReceipt(command.id),
      ).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "host_identity_mismatch" },
      });
      upstream = sup.url;
      const previousBoot = (await healthIdentity(sup.url)).bootId;

      sup = await sup.restart();
      upstream = sup.url;
      const rebound = await hosts.forAssignment(assignment);
      const newBoot = (await healthIdentity(sup.url)).bootId;
      expect(newBoot).not.toBe(previousBoot);
      expect(rebound.host.lastBootId).toBe(newBoot);
      expect(rebound.assignment.executionHostId).toBe(owner.id);
      expect(await hosts.local().getCommandReceipt(command.id)).toEqual(
        receipt,
      );
      expect(accepted.executionWorkspaceId).toMatch(/^ws_[0-9a-f]{32}$/);
      expect(effectRequests).toEqual(["POST /workspaces/adopt"]);
    } finally {
      vi.unstubAllEnvs();
      restore();
      resetResolverForTests();
      await db.transaction((tx) =>
        releaseAssignmentForRun(tx as unknown as Db, runId, "completed"),
      );
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await other.kill();
    }
  }, 120_000);

  it("G2: restart on the same state dir → same row, new boot id, restarted:true + execution-host-restarted, NO reconcile sweep", async () => {
    const [before] = await hostRows();

    sup = await sup.restart();
    const identity = await healthIdentity(sup.url);

    expect(identity.hostKey).toBe(before.hostKey);
    expect(identity.bootId).not.toBe(before.lastBootId);

    const { logger, lines } = captureLogger();
    const result = await ensureLocalExecutionHost({ db, logger });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.action).toBe("restart");
    expect(result.restarted).toBe(true);

    const rows = await hostRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].lastBootId).toBe(identity.bootId);
    expect(
      lines.filter((l) => l.msg === "execution-host-restarted"),
    ).toMatchObject([
      {
        hostId: before.id,
        previousBootId: before.lastBootId,
        bootId: identity.bootId,
      },
    ]);
    // The registrar never runs a domain sweep: the periodic reconcile pass
    // classifies the runs the dead process owned.
    expect(vi.mocked(runReconcileSweep)).not.toHaveBeenCalled();

    const again = await ensureLocalExecutionHost({ db, logger });

    expect(again.status === "registered" && again.action).toBe("touch");
    expect(again.status === "registered" && again.restarted).toBe(false);
    expect(
      lines.filter((l) => l.msg === "execution-host-restarted"),
    ).toHaveLength(1);
    expect(vi.mocked(runReconcileSweep)).not.toHaveBeenCalled();
  }, 120_000);

  it("G2b: localHost() re-entered while a restart resolution is in flight resolves (no self-wait) — the removed onRestart sweep regression", async () => {
    const [row] = await hostRows();
    // The same key with a NEW boot id: the registrar takes the `restart` branch.
    const fake = createFakeExecutionHost({ hostKey: row.hostKey });
    const gate = deferred();
    const { logger, lines } = captureLogger();

    expect(fake.identity.bootId).not.toBe(row.lastBootId);
    fake.onCall("health", () => gate.promise);
    resetResolverForTests();
    resetRegistrarStateForTests();

    const first = localHost({
      db,
      transport: fake.transport,
      force: true,
      logger,
    });

    // The health call is parked: a second resolution now joins the in-flight one.
    await vi.waitFor(() => expect(fake.callsOf("health")).toHaveLength(1));
    const second = localHost({ db, transport: fake.transport, logger });

    gate.resolve();
    const [h1, h2] = await withTimeout(
      Promise.all([first, second]),
      5_000,
      "the concurrent host resolutions",
    );

    expect(h1.id).toBe(row.id);
    expect(h2.id).toBe(row.id);
    expect(h1.lastBootId).toBe(fake.identity.bootId);
    expect(fake.callsOf("health")).toHaveLength(1);
    expect(
      lines.filter((l) => l.msg === "execution-host-restarted"),
    ).toHaveLength(1);
    expect(vi.mocked(runReconcileSweep)).not.toHaveBeenCalled();

    // Back on the real child's boot id for the cases below.
    resetResolverForTests();
    const back = await ensureLocalExecutionHost({ db });

    expect(back.status === "registered" && back.action).toBe("restart");
  }, 60_000);

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

  it("G7: a refused identity writes readiness and logs the remediation at most once per 30 s", async () => {
    const active = (await hostRows()).find((r) => r.retiredAt === null)!;
    const runId = await seedRun(testDatabase.db, {
      projectId,
      status: "Running",
    });

    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: active.id,
        reason: "launch",
      }),
    );
    const stranger = createFakeExecutionHost();
    const { logger, lines } = captureLogger();
    let t = Date.now();
    const now = () => new Date(t);
    const mismatches = () =>
      lines.filter((l) => l.msg === "execution-host-identity-mismatch");

    resetRegistrarStateForTests();
    resetResolverForTests();
    const first = await ensureLocalExecutionHost({
      db,
      transport: stranger.transport,
      now,
      logger,
    });

    expect(first.status).toBe("refused");
    const afterFirst = (await hostRows()).find((r) => r.id === active.id)!;

    expect(afterFirst.readiness).toBe("unavailable");
    expect(afterFirst.readinessReason).toBe("identity_changed");
    expect(mismatches()).toHaveLength(1);
    expect(mismatches()[0]).toMatchObject({
      storedHostKey: active.hostKey,
      observedHostKey: stranger.identity.hostKey,
      liveRunIds: [runId],
    });

    t += 1_000;
    const second = await ensureLocalExecutionHost({
      db,
      transport: stranger.transport,
      now,
      logger,
    });

    expect(second.status).toBe("refused");
    expect(second.status === "refused" && second.liveRunIds).toEqual([runId]);
    const afterSecond = (await hostRows()).find((r) => r.id === active.id)!;

    expect(afterSecond.updatedAt.getTime()).toBe(
      afterFirst.updatedAt.getTime(),
    );
    expect(mismatches()).toHaveLength(1);

    t += 30_001;
    const third = await ensureLocalExecutionHost({
      db,
      transport: stranger.transport,
      now,
      logger,
    });

    expect(third.status).toBe("refused");
    const afterWindow = (await hostRows()).find((r) => r.id === active.id)!;

    expect(afterWindow.updatedAt.getTime()).toBeGreaterThan(
      afterFirst.updatedAt.getTime(),
    );
    expect(mismatches()).toHaveLength(2);

    // Cleanup: the run finishes; the sup2 identity registers again → ready.
    await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "test"),
    );
    await db
      .update(schema.runs)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, runId));
    resetRegistrarStateForTests();
    resetResolverForTests();
    const back = await ensureLocalExecutionHost({ db });

    expect(back.status).toBe("registered");
    expect((await hostRows()).find((r) => r.id === active.id)?.readiness).toBe(
      "ready",
    );
  }, 60_000);

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

  it("G7: localHost() activates canonical event ingestion after a web-first startup", async () => {
    resetResolverForTests();
    resetRegistrarStateForTests();
    const fake = createFakeExecutionHost();
    const transport = {
      ...fake.transport,
      capabilities: async (
        opts: Parameters<typeof fake.transport.capabilities>[0],
      ) => {
        const capabilities = await fake.transport.capabilities(opts);

        if (!capabilities) throw new Error("fake capabilities are unavailable");

        return { ...capabilities, eventStream: true };
      },
    };

    await localHost({ db, transport, force: true });

    await vi.waitFor(() =>
      expect(fake.callsOf("streamRuntimeEvents").length).toBeGreaterThan(0),
    );
  });

  it("G8: two concurrent registrations on an empty table → one row, both registered, the loser lands on touch through the 23505 retry", async () => {
    // Empty = no active local row (the partial unique index's domain).
    for (const row of await hostRows()) {
      if (row.retiredAt === null) {
        await db
          .update(schema.executionHosts)
          .set({ retiredAt: new Date() })
          .where(eq(schema.executionHosts.id, row.id));
      }
    }
    expect((await hostRows()).filter((r) => r.retiredAt === null)).toHaveLength(
      0,
    );
    resetResolverForTests();
    resetRegistrarStateForTests();

    const fake = createFakeExecutionHost();
    // Both racers read "no active row" BEFORE either inserts: the INSERT of
    // each transaction waits at a barrier the second arrival releases.
    let arrived = 0;
    const waiters: Array<() => void> = [];
    const barrier = () =>
      new Promise<void>((resolve) => {
        arrived += 1;
        if (arrived >= 2) {
          for (const wake of waiters.splice(0)) wake();
          resolve();

          return;
        }
        waiters.push(resolve);
      });
    const gatedInsert = (tx: Db): Db =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== "insert") return Reflect.get(target, prop, receiver);

          return (table: unknown) => {
            const builder = (
              target as unknown as { insert: (t: unknown) => any }
            ).insert(table);

            return {
              values: (values: unknown) => {
                const withValues = builder.values(values);

                return {
                  returning: (...args: unknown[]) => {
                    const query = withValues.returning(...args);

                    return {
                      then: (
                        onFulfilled?: (v: unknown) => unknown,
                        onRejected?: (e: unknown) => unknown,
                      ) =>
                        barrier()
                          .then(() => query)
                          .then(onFulfilled, onRejected),
                    };
                  },
                };
              },
            };
          };
        },
      });
    const gatedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);

        return (cb: (tx: Db) => Promise<unknown>) =>
          (
            target as unknown as {
              transaction: (
                c: (tx: Db) => Promise<unknown>,
              ) => Promise<unknown>;
            }
          ).transaction((tx) => cb(gatedInsert(tx)));
      },
    }) as Db;
    const { logger, lines } = captureLogger();

    const [a, b] = await withTimeout(
      Promise.all([
        ensureLocalExecutionHost({
          db: gatedDb,
          transport: fake.transport,
          logger,
        }),
        ensureLocalExecutionHost({
          db: gatedDb,
          transport: fake.transport,
          logger,
        }),
      ]),
      15_000,
      "the racing registrations",
    );

    expect(a.status).toBe("registered");
    expect(b.status).toBe("registered");
    const actions = [a, b]
      .map((r) => (r.status === "registered" ? r.action : r.status))
      .sort();

    expect(actions).toEqual(["insert", "touch"]);
    const active = (await hostRows()).filter((r) => r.retiredAt === null);

    expect(active).toHaveLength(1);
    expect(active[0].hostKey).toBe(fake.identity.hostKey);
    expect(a.status === "registered" && a.host.id).toBe(active[0].id);
    expect(b.status === "registered" && b.host.id).toBe(active[0].id);
    // One insert (the row writer and the registrar both log it for the same
    // host id); the loser's retry logged nothing new.
    const registered = lines.filter(
      (l) => l.msg === "execution-host-registered",
    );

    expect(registered.length).toBeGreaterThanOrEqual(1);
    expect(new Set(registered.map((l) => l.hostId))).toEqual(
      new Set([active[0].id]),
    );
    expect(registered.every((l) => l.hostKey === fake.identity.hostKey)).toBe(
      true,
    );
  }, 60_000);
});

it("publishes a pinned remote supervisor outage and re-observes a restart on the same host", async () => {
  const hostKey = "registrar-remote-readiness";
  let remote = await startRealSupervisor({
    env: { MAISTER_EXECUTION_HOST_KEY: hostKey },
  });

  try {
    vi.stubEnv(
      "MAISTER_EXECUTION_HOST_ENDPOINTS",
      JSON.stringify({ [hostKey]: remote.url }),
    );
    const ready = await registerRemoteHost(db, hostKey);

    expect(ready.readiness).toBe("ready");
    await remote.stop();
    await expect(registerRemoteHost(db, hostKey)).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "execution_host_unavailable" },
    });
    expect(await remoteReadiness(ready.id)).toMatchObject({
      readiness: "unavailable",
      readinessReason: "network",
      lastSeenAt: ready.lastSeenAt,
    });
    const stale = new Date(0);

    await db
      .update(fullSchema.executionHosts)
      .set({ updatedAt: stale })
      .where(eq(fullSchema.executionHosts.id, ready.id));
    await expect(registerRemoteHost(db, hostKey)).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
    const refreshed = await remoteReadiness(ready.id);

    expect(refreshed?.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(refreshed?.lastSeenAt).toEqual(ready.lastSeenAt);
    remote = await startRealSupervisor(remote.options);
    const restored = await registerRemoteHost(db, hostKey);

    expect(restored.id).toBe(ready.id);
    expect(restored.lastBootId).not.toBe(ready.lastBootId);
    expect(await remoteReadiness(ready.id)).toMatchObject({
      readiness: "ready",
      readinessReason: null,
    });
  } finally {
    vi.unstubAllEnvs();
    await remote.kill();
  }
}, 120_000);

it("refuses missing smoke evidence on the selected and retained remote supervisor", async () => {
  const hostKey = "registrar-remote-smoke";
  const remote = await startRealSupervisor({
    env: { MAISTER_EXECUTION_HOST_KEY: hostKey },
  });

  try {
    vi.stubEnv(
      "MAISTER_EXECUTION_HOST_ENDPOINTS",
      JSON.stringify({ [hostKey]: remote.url }),
    );
    vi.stubEnv("MAISTER_EXECUTION_HOST_PREFERRED_KEY", hostKey);
    vi.stubEnv("MAISTER_EXECUTION_HOST_SHARED_WORKSPACE", "1");
    const local = createFakeExecutionHost();
    const placement = await localHost({ db, transport: local.transport });
    const observed = await checkAssignedHostDiagnostics(placement);

    if (observed.kind !== "ready") throw new Error(observed.message);
    local.setDiagnostics({
      ...observed,
      diagnostics: {
        ...observed.diagnostics,
        adapters: observed.diagnostics.adapters.map((adapter) => ({
          ...adapter,
          smoke: {
            ...adapter.smoke,
            status: "ok",
            capabilityEnforcement: {
              ...adapter.smoke.capabilityEnforcement,
              status: "ok",
            },
            readOnlySession: {
              ...adapter.smoke.readOnlySession,
              status: "ok",
              staleReason: null,
            },
          },
        })),
      },
    });
    expect(placement.hostKey).toBe(hostKey);

    await expect(
      assertCapabilityGuardEvidence({
        agent: "claude",
        permissionPolicy: "default",
        checkDiagnostics: () =>
          checkAssignedHostDiagnostics(placement, local.transport),
      }),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      message: expect.stringContaining("capabilityEnforcement smoke"),
    });

    const runId = await seedRun(testDatabase.db, {
      projectId,
      status: "Running",
    });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: placement.id,
        reason: "launch",
      }),
    );

    vi.stubEnv("MAISTER_EXECUTION_HOST_PREFERRED_KEY", undefined);
    const bound = await createExecutionHosts({
      db,
      transport: local.transport,
    }).forAssignment({ id: assignment.id });

    expect(bound.host.id).toBe(placement.id);
    await expect(
      bound.createSession({
        stepId: "agent",
        executor: { agent: "gemini", model: "gemini-test" },
        readOnlySession: true,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      message: expect.stringContaining("read-only-session smoke"),
    });
    expect(local.callsOf("diagnostics")).toHaveLength(0);
  } finally {
    vi.unstubAllEnvs();
    await remote.kill();
  }
}, 120_000);
