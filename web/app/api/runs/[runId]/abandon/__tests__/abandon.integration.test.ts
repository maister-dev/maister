// M11b Phase 3.5 (RED → GREEN): the run-abandon route (added in M11b per
// Phase 0.10 — there was no abandon route before). A HumanWorking run abandon
// runs releaseHumanWorking first, then the standard abandon transition, then
// promoteNextPending to free the slot for a queued Pending run.
// Owns matrix row: abandon-humanworking-frees-slot.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;
const { flows, projectMembers, projects, runs, tasks, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// runFlow is invoked by promoteNextPending when a slot frees; mock it.
const runFlowSpy = vi.fn(async (_id: string, _opts?: unknown) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (id: string, opts?: unknown) => runFlowSpy(id, opts),
}));

let abandonPOST: typeof import("../route").POST;

let projectId: string;
let ownerId: string;
let executorId: string;
let flowId: string;

async function seedRun(status: string): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status,
    currentStepId: "review",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });

  return runId;
}

function req(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("abandon_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  ownerId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();

  await db.insert(users).values({
    id: ownerId,
    email: "owner@maister.local",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(projects).values({
    id: projectId,
    slug: "abandon-app",
    name: "Abandon App",
    repoPath: "/repos/abandon-app",
    maisterYamlPath: "/repos/abandon-app/maister.yaml",
  });
  await db.insert(projectMembers).values({
    id: randomUUID(),
    projectId,
    userId: ownerId,
    role: "member",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/cache/flow",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  ({ POST: abandonPOST } = await import("../route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(runs);
  await db.delete(tasks);
  runFlowSpy.mockReset();
  runFlowSpy.mockResolvedValue(undefined);
  sessionRef.value = { user: { id: ownerId, role: "member" } };
});

describe("POST /api/runs/{runId}/abandon", () => {
  it("abandon-humanworking-frees-slot: HumanWorking → Abandoned, queued Pending promoted", async () => {
    const runId = await seedRun("HumanWorking");
    const pendingId = await seedRun("Pending");

    const res = await abandonPOST(req(runId), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);

    const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];

    expect(row.status).toBe("Abandoned");
    expect(row.endedAt).not.toBeNull();

    // promoteNextPending freed the slot → the Pending run was driven.
    expect(runFlowSpy).toHaveBeenCalledWith(pendingId, expect.anything());
  }, 60_000);

  it("abandons a NeedsInput run", async () => {
    const runId = await seedRun("NeedsInput");

    const res = await abandonPOST(req(runId), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);
    const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];

    expect(row.status).toBe("Abandoned");
  }, 60_000);

  it("409 on an already-terminal run", async () => {
    const runId = await seedRun("Done");

    const res = await abandonPOST(req(runId), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(409);
  }, 60_000);

  it("401 when unauthenticated", async () => {
    const runId = await seedRun("NeedsInput");

    sessionRef.value = null;
    const res = await abandonPOST(req(runId), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(401);
  }, 60_000);

  it("404 when the run does not exist", async () => {
    const res = await abandonPOST(req("ghost"), {
      params: Promise.resolve({ runId: "ghost" }),
    });

    expect(res.status).toBe(404);
  }, 60_000);
});
