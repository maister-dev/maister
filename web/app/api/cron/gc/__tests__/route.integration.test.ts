// M19 Phase 4 (T4.4): the /api/cron/gc route. Auth is a constant-time
// X-Maister-Cron-Token compare against MAISTER_CRON_TOKEN: empty config → 503
// (cron disabled), mismatch → 401, valid → run BOTH sweeps → 200 with
// {workspace, revision}, or 207 if a sub-sweep threw (partial). The token is a
// server-only secret and must NEVER appear in the response body. Real Postgres
// testcontainer so both sweeps run against a live DB on the happy path; the
// sweep modules are spied so the 207 partial-failure case can be forced.
//
// Scenarios (QA contract T4.4 / plan T4.6):
//   1. empty MAISTER_CRON_TOKEN → 503 (disabled).
//   2. wrong token → 401.
//   3. valid token → 200 running both sweeps; body shape {workspace, revision}.
//   4. a forced sub-sweep failure → 207 (partial).
//   5. the response body never contains the token value.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
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

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Spy the two sweeps so the happy path returns deterministic summaries and the
// 207 case can force a throw. The real DB still backs getDb() for any code that
// reaches it.
const workspaceSweepSpy = vi.fn(async () => ({
  scanned: 0,
  preserved: 0,
  pruned: 0,
  skippedUnpreserved: 0,
  failed: 0,
}));
const revisionSweepSpy = vi.fn(async () => ({
  scanned: 0,
  deleted: 0,
  skippedReferenced: 0,
}));

vi.mock("@/lib/gc/workspace-gc", () => ({
  runWorkspaceGcSweep: () => workspaceSweepSpy(),
}));
vi.mock("@/lib/gc/revision-gc", () => ({
  runRevisionGcSweep: () => revisionSweepSpy(),
}));

let cronGET: typeof import("../route").GET;
let cronPOST: typeof import("../route").POST;

const TOKEN = "s3cr3t-cron-token-value";

let savedToken: string | undefined;

function req(token?: string): NextRequest {
  const headers: Record<string, string> = {};

  if (token !== undefined) headers["X-Maister-Cron-Token"] = token;

  return new NextRequest(
    new Request("http://localhost/api/cron/gc", { method: "POST", headers }),
  );
}

function getReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};

  if (token !== undefined) headers["X-Maister-Cron-Token"] = token;

  return new NextRequest(
    new Request("http://localhost/api/cron/gc", { method: "GET", headers }),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cron_gc_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  process.env.DB_URL = container.getConnectionUri();
  savedToken = process.env.MAISTER_CRON_TOKEN;

  ({ GET: cronGET, POST: cronPOST } = await import("../route"));
}, 180_000);

afterAll(async () => {
  if (savedToken === undefined) delete process.env.MAISTER_CRON_TOKEN;
  else process.env.MAISTER_CRON_TOKEN = savedToken;

  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  process.env.MAISTER_CRON_TOKEN = TOKEN;
  workspaceSweepSpy.mockReset();
  workspaceSweepSpy.mockResolvedValue({
    scanned: 0,
    preserved: 0,
    pruned: 0,
    skippedUnpreserved: 0,
    failed: 0,
  });
  revisionSweepSpy.mockReset();
  revisionSweepSpy.mockResolvedValue({
    scanned: 0,
    deleted: 0,
    skippedReferenced: 0,
  });
});

describe("GET/POST /api/cron/gc", () => {
  it("returns 503 when MAISTER_CRON_TOKEN is empty (cron disabled)", async () => {
    process.env.MAISTER_CRON_TOKEN = "";

    const res = await cronPOST(req(TOKEN));

    expect(res.status).toBe(503);
    expect(workspaceSweepSpy).not.toHaveBeenCalled();
    expect(revisionSweepSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("returns 401 on a token mismatch", async () => {
    const res = await cronPOST(req("wrong-token"));

    expect(res.status).toBe(401);
    expect(workspaceSweepSpy).not.toHaveBeenCalled();
    expect(revisionSweepSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("returns 401 when the token header is absent", async () => {
    const res = await cronPOST(req(undefined));

    expect(res.status).toBe(401);
    expect(workspaceSweepSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("returns 200 running BOTH sweeps with body {workspace, revision} on a valid token", async () => {
    const res = await cronPOST(req(TOKEN));

    expect(res.status).toBe(200);
    expect(workspaceSweepSpy).toHaveBeenCalledTimes(1);
    expect(revisionSweepSpy).toHaveBeenCalledTimes(1);

    const body = await res.json();

    expect(body).toMatchObject({
      workspace: {
        scanned: expect.any(Number),
        preserved: expect.any(Number),
        pruned: expect.any(Number),
        skippedUnpreserved: expect.any(Number),
        failed: expect.any(Number),
      },
      revision: {
        scanned: expect.any(Number),
        deleted: expect.any(Number),
        skippedReferenced: expect.any(Number),
      },
    });
  }, 60_000);

  it("GET behaves like POST on a valid token (200, both sweeps)", async () => {
    const res = await cronGET(getReq(TOKEN));

    expect(res.status).toBe(200);
    expect(workspaceSweepSpy).toHaveBeenCalledTimes(1);
    expect(revisionSweepSpy).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("returns 207 when a sub-sweep throws (partial)", async () => {
    workspaceSweepSpy.mockRejectedValueOnce(new Error("workspace sweep boom"));

    const res = await cronPOST(req(TOKEN));

    expect(res.status).toBe(207);
    // The other sweep still ran.
    expect(revisionSweepSpy).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("never leaks the token value in the response body", async () => {
    const res = await cronPOST(req(TOKEN));
    const text = await res.text();

    expect(text).not.toContain(TOKEN);
  }, 60_000);
});
