import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { BUILT_IN_LANES } from "@/lib/auto-promotion/config";
import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const mocks = vi.hoisted(() => ({
  diffChangeStats: vi.fn(),
  assertEvidenceReady: vi.fn(),
  requireActiveSession: vi.fn(),
}));

let db: NodePgDatabase;

vi.mock("@/lib/db/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/authz", async (orig) => ({
  ...(await orig<typeof import("@/lib/authz")>()),
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: async () => ({ user: { id: "u1" }, role: "owner" }),
}));
vi.mock("@/lib/worktree", async (orig) => ({
  ...(await orig<typeof import("@/lib/worktree")>()),
  diffChangeStats: mocks.diffChangeStats,
}));
vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: mocks.assertEvidenceReady,
}));

const { PATCH } = await import("@/app/api/projects/[slug]/settings/route");
const holdRoute = await import("@/app/api/runs/[runId]/promotion-hold/route");
const panelRoute = await import("@/app/api/runs/[runId]/auto-promotion/route");

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks, projects } = schema;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let projectId: string;
let slug: string;
let userId: string;
let runnerId: string;
let flowId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "workspaces",
    "runs",
    "tasks",
    "flows",
    "platform_acp_runners",
    "projects",
    "users",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }

  vi.clearAllMocks();
  mocks.diffChangeStats.mockResolvedValue([
    {
      path: "README.md",
      status: "M",
      additions: 1,
      deletions: 0,
      binary: false,
    },
  ]);
  mocks.assertEvidenceReady.mockResolvedValue({ ready: true });
  mocks.requireActiveSession.mockResolvedValue({
    id: "u1",
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });

  projectId = randomUUID();
  slug = `p-${projectId.slice(0, 8)}`;
  userId = randomUUID();
  runnerId = randomUUID();
  flowId = randomUUID();

  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId.slice(0, 8)}@t.test` });
  await db.insert(projects).values({
    id: projectId,
    slug,
    name: "P",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: {},
    schemaVersion: 1,
  });
});

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://x/api/projects/x/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function projectAutoPromotion(): Promise<unknown> {
  const [row] = await db
    .select({ autoPromotion: projects.autoPromotion })
    .from(projects)
    .where(eq(projects.id, projectId));

  return row.autoPromotion;
}

describe("PATCH settings — autoPromotion SET/CLEAR/re-SET symmetry", () => {
  const config = {
    enabled: true,
    lanes: [{ class: "docs", enabled: true, delayMinutes: 10 }],
  };

  it("SET writes the config, CLEAR (null) resets to NULL, re-SET writes again", async () => {
    const set = await PATCH(patchReq({ autoPromotion: config }), {
      params: Promise.resolve({ slug }),
    });

    expect(set.status).toBe(200);
    expect(await projectAutoPromotion()).toMatchObject({ enabled: true });

    const clear = await PATCH(patchReq({ autoPromotion: null }), {
      params: Promise.resolve({ slug }),
    });

    expect(clear.status).toBe(200);
    expect(await projectAutoPromotion()).toBeNull();

    const reset = await PATCH(patchReq({ autoPromotion: config }), {
      params: Promise.resolve({ slug }),
    });

    expect(reset.status).toBe(200);
    expect(await projectAutoPromotion()).toMatchObject({ enabled: true });
  });

  it("rejects an unknown lane key (strict schema) → 422", async () => {
    const res = await PATCH(
      patchReq({ autoPromotion: { enabled: true, lanes: [], surprise: 1 } }),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(422);
  });
});

async function seedRun(status = "Review"): Promise<string> {
  const runId = randomUUID();
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    projectId,
    taskId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    flowVersion: "v1.0.0",
    status,
    runKind: "flow",
    createdByUserId: userId,
    reviewEnteredAt: new Date(Date.now() - 30 * 60_000),
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt/${runId}`,
    parentRepoPath: `/repos/${projectId}`,
    baseCommit: "abc123",
    promotionState: "none",
  });

  return runId;
}

async function runHold(runId: string): Promise<unknown> {
  const [row] = await db
    .select({ hold: runs.promotionHold })
    .from(runs)
    .where(eq(runs.id, runId));

  return row.hold;
}

describe("PUT/DELETE promotion-hold", () => {
  it("PUT sets a user hold with reason; DELETE clears it", async () => {
    const runId = await seedRun();

    const put = await holdRoute.PUT(
      new NextRequest("http://x", {
        method: "PUT",
        body: JSON.stringify({ reason: "wait" }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(put.status).toBe(200);
    expect(await runHold(runId)).toMatchObject({
      source: "user",
      reason: "wait",
    });

    const del = await holdRoute.DELETE(
      new NextRequest("http://x", { method: "DELETE" }),
      {
        params: Promise.resolve({ runId }),
      },
    );

    expect(del.status).toBe(200);
    expect(await runHold(runId)).toBeNull();
  });

  it("PUT on an unknown run → 409", async () => {
    const res = await holdRoute.PUT(
      new NextRequest("http://x", { method: "PUT", body: "{}" }),
      { params: Promise.resolve({ runId: randomUUID() }) },
    );

    expect(res.status).toBe(409);
  });

  it("unauthenticated PUT with an invalid body → 401, never 422 (auth precedes body parse)", async () => {
    const runId = await seedRun();

    mocks.requireActiveSession.mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "no active session"),
    );

    const res = await holdRoute.PUT(
      new NextRequest("http://x", {
        method: "PUT",
        body: JSON.stringify({ reason: 123 }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(res.status).toBe(401);
  });
});

describe("GET auto-promotion panel", () => {
  it("returns an evaluation for a Review flow run + a null promotedLane", async () => {
    // project has auto-promotion enabled so the run is a live candidate
    await db
      .update(projects)
      .set({ autoPromotion: { enabled: true, lanes: BUILT_IN_LANES } })
      .where(eq(projects.id, projectId));
    const runId = await seedRun();

    const res = await panelRoute.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.promotedLane).toBeNull();
    expect(body.evaluation?.verdict).toBe("eligible");
    expect(body.evaluation?.lane).toBe("docs");
  });

  it("returns a null evaluation for a non-Review run", async () => {
    const runId = await seedRun("Done");

    const res = await panelRoute.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ runId }),
    });

    const body = await res.json();

    expect(body.evaluation).toBeNull();
  });
});
