// DELETE /api/admin/router-sidecars/[sidecarId] against real Postgres.
//
// The unit test (delete.test.ts) mocks the DB, so it cannot prove the two
// guarantees that only hold against a real engine:
//   1. (finding 1) An unconfirmed managed stop must ROLL BACK the delete — the
//      config row, the only handle to stop the process, has to survive.
//   2. (finding 2) The usage-guard → delete window must be serialized so a
//      runner cannot bind to the sidecar (FK onDelete:"set null") between the
//      guard read and the delete and then be silently unbound by the delete.
//
// The FOR UPDATE lock the route holds on the sidecar row is the mechanism for
// (2): a concurrent runner INSERT takes a FOR KEY SHARE lock on the same parent
// row (FK enforcement), which CONFLICTS with FOR UPDATE, so the bind blocks
// until the delete commits — at which point the parent is gone and the bind
// fails its FK. The race test forces that window open with a controllable stop
// barrier and asserts the bind blocks (not "succeeds then gets nulled").

import type { NextRequest } from "next/server";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;
const { platformAcpRunners, platformRouterSidecars } = schema;

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  stopSidecar: vi.fn(),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// The supervisor wire is mocked; loadSidecarUsageReferences stays REAL so the
// guard runs its true query against the seeded runners.
vi.mock("@/lib/supervisor-client", () => ({
  stopSidecar: mocks.stopSidecar,
  checkSupervisorDiagnostics: vi.fn(),
}));

let DELETE: typeof import("../route").DELETE;

function ctx(sidecarId: string): { params: Promise<{ sidecarId: string }> } {
  return { params: Promise.resolve({ sidecarId }) };
}

function req(): NextRequest {
  return new Request("http://x/api/admin/router-sidecars/x", {
    method: "DELETE",
  }) as NextRequest;
}

async function seedSidecar(id: string): Promise<void> {
  await db.insert(platformRouterSidecars).values({
    id,
    kind: "ccr",
    lifecycle: "managed",
    commandPreset: "ccr_start",
    configPath: "~/.claude-code-router/config.json",
    baseUrl: "http://127.0.0.1:3456",
    healthcheckUrl: "http://127.0.0.1:3456/health",
    authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
}

function runnerValues(
  id: string,
  sidecarId: string | null,
): Record<string, unknown> {
  return {
    id,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: {
      kind: "anthropic_compatible",
      baseUrl: "http://127.0.0.1:3456",
    },
    permissionPolicy: "default",
    sidecarId,
    enabled: true,
    readinessStatus: "NotReady",
    readinessReasons: ["sidecar is not ready"],
  };
}

async function sidecarIds(): Promise<string[]> {
  return (await db.select().from(platformRouterSidecars)).map((r: any) => r.id);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("sidecar_delete_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  ({ DELETE } = await import("../route"));
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
  mocks.stopSidecar.mockResolvedValue({ ok: true, state: "idle" });
  await db.delete(platformAcpRunners);
  await db.delete(platformRouterSidecars);
});

describe("admin router sidecar DELETE (integration)", () => {
  it("deletes an unreferenced managed sidecar (204) after a confirmed stop", async () => {
    await seedSidecar("ccr-ok");

    const res = await DELETE(req(), ctx("ccr-ok"));

    expect(res.status).toBe(204);
    expect(mocks.stopSidecar).toHaveBeenCalledWith("ccr-ok");
    expect(await sidecarIds()).not.toContain("ccr-ok");
  });

  it("refuses with 409 CONFLICT and keeps the row when a runner references it; never stops", async () => {
    await seedSidecar("ccr-ref");
    await db.insert(platformAcpRunners).values(runnerValues("r1", "ccr-ref"));

    const res = await DELETE(req(), ctx("ccr-ref"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect(mocks.stopSidecar).not.toHaveBeenCalled();
    expect(await sidecarIds()).toContain("ccr-ref");
  });

  it("rolls back the delete (503) and keeps the row when the managed stop is not confirmed", async () => {
    await seedSidecar("ccr-down");
    const { MaisterError } = await import("@/lib/errors");

    mocks.stopSidecar.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor down"),
    );

    const res = await DELETE(req(), ctx("ccr-down"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
    // The real transaction must have ROLLED BACK — the row is still there.
    expect(await sidecarIds()).toContain("ccr-down");
  });

  it("serializes a concurrent runner bind: the FOR UPDATE lock blocks the bind until the delete commits, then the bind fails its FK", async () => {
    await seedSidecar("ccr-race");

    // Hold the route's transaction open by blocking inside the managed stop
    // (which runs after the FOR UPDATE lock is acquired and the usage-guard has
    // observed zero refs). This is exactly the window finding 2 is about.
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    let signalStopEntered: () => void = () => {};
    const stopEntered = new Promise<void>(
      (resolve) => (signalStopEntered = resolve),
    );

    mocks.stopSidecar.mockImplementation(async () => {
      signalStopEntered();
      await stopGate;

      return { ok: true, state: "idle" };
    });

    const deletePromise = DELETE(req(), ctx("ccr-race"));

    // The lock is now held by the delete transaction.
    await stopEntered;

    // A concurrent runner bind on a separate pool connection. It must BLOCK on
    // the parent-row lock rather than commit-then-get-nulled.
    let bindSettled = false;
    const bindPromise = (async () => {
      try {
        await db
          .insert(platformAcpRunners)
          .values(runnerValues("racer", "ccr-race"));
      } finally {
        bindSettled = true;
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bindSettled).toBe(false); // still blocked on FOR UPDATE

    // Let the delete commit; the lock releases, the parent disappears, and the
    // waiting bind now fails its foreign key (no parent to reference).
    releaseStop();
    await expect(bindPromise).rejects.toThrow();

    const res = await deletePromise;

    expect(res.status).toBe(204);
    // Consistent end state: sidecar gone AND no dangling/nulled runner binding.
    expect(await sidecarIds()).not.toContain("ccr-race");
    const runnerRows = await db.select().from(platformAcpRunners);

    expect(runnerRows.find((r: any) => r.id === "racer")).toBeUndefined();
  });
});
