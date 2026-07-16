import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let savedToken: string | undefined;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const workspaceSweepSpy = vi.fn(async () => ({
  scanned: 0,
  preserved: 0,
  pruned: 0,
  skippedUnpreserved: 0,
  skippedClaimed: 0,
  retryableFailed: 0,
  failed: 0,
}));
const revisionSweepSpy = vi.fn(async () => ({
  scanned: 0,
  deleted: 0,
  skippedReferenced: 0,
  failed: 0,
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

function request(method: "GET" | "POST", token?: string): NextRequest {
  const headers: Record<string, string> = {};

  if (token !== undefined) headers["X-Maister-Cron-Token"] = token;

  return new NextRequest("http://localhost/api/cron/gc", {
    method,
    headers,
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cron_gc_test",
  });
  db = testDatabase.db;
  savedToken = process.env.MAISTER_CRON_TOKEN;
  ({ GET: cronGET, POST: cronPOST } = await import("../route"));
}, 180_000);

afterAll(async () => {
  if (savedToken === undefined) delete process.env.MAISTER_CRON_TOKEN;
  else process.env.MAISTER_CRON_TOKEN = savedToken;

  await testDatabase?.stop();
});

beforeEach(async () => {
  process.env.MAISTER_CRON_TOKEN = TOKEN;
  workspaceSweepSpy.mockReset();
  workspaceSweepSpy.mockResolvedValue({
    scanned: 0,
    preserved: 0,
    pruned: 0,
    skippedUnpreserved: 0,
    skippedClaimed: 0,
    retryableFailed: 0,
    failed: 0,
  });
  revisionSweepSpy.mockReset();
  revisionSweepSpy.mockResolvedValue({
    scanned: 0,
    deleted: 0,
    skippedReferenced: 0,
    failed: 0,
  });
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
});

describe("GET/POST /api/cron/gc", () => {
  it("returns 503 when the cron token is not configured", async () => {
    process.env.MAISTER_CRON_TOKEN = "";

    const response = await cronPOST(request("POST", TOKEN));

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("CONFIG");
    expect(workspaceSweepSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("returns 401 when the cron token is invalid", async () => {
    const response = await cronPOST(request("POST", "wrong-token"));

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHENTICATED");
    expect(workspaceSweepSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("claims the canonical system sweep and persists its detailed summary", async () => {
    const response = await cronPOST(request("POST", TOKEN));

    expect(response.status).toBe(200);
    expect(workspaceSweepSpy).toHaveBeenCalledOnce();
    expect(revisionSweepSpy).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });

    const attempts = await db.select().from(schema.schedulerJobRuns);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      jobId: "system_sweep.default",
      status: "Succeeded",
    });
    expect(attempts[0].summary).toMatchObject({
      workspace: { scanned: 0, pruned: 0 },
      revision: { scanned: 0, deleted: 0 },
    });
  }, 60_000);

  it("runs GET through the same scheduler claim path", async () => {
    const response = await cronGET(request("GET", TOKEN));

    expect(response.status).toBe(200);
    expect(workspaceSweepSpy).toHaveBeenCalledOnce();
  }, 60_000);

  it("keeps a partial cleanup failure in the durable scheduler summary", async () => {
    workspaceSweepSpy.mockRejectedValueOnce(new Error("workspace sweep boom"));

    const response = await cronPOST(request("POST", TOKEN));

    expect(response.status).toBe(200);
    const attempts = await db.select().from(schema.schedulerJobRuns);

    expect(attempts[0].summary).toMatchObject({
      errors: expect.arrayContaining([
        expect.stringContaining("workspace sweep failed"),
      ]),
    });
  }, 60_000);

  it("never leaks the cron token in the response body", async () => {
    const response = await cronPOST(request("POST", TOKEN));

    expect(await response.text()).not.toContain(TOKEN);
  }, 60_000);
});
