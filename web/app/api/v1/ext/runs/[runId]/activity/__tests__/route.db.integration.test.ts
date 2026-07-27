import { randomUUID } from "node:crypto";

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

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { issueToken } from "@/lib/tokens/issue";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let GET: typeof import("@/app/api/v1/ext/runs/[runId]/activity/route").GET;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_run_activity_route_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeAll(async () => {
  const routeModule = await import(
    "@/app/api/v1/ext/runs/[runId]/activity/route"
  );

  GET = routeModule.GET;
});

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const runnerId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "assistant-activity",
    source: "github.com/example/assistant-activity",
    version: "v1.0.0",
    installedPath: "/tmp/flows/assistant-activity",
    manifest: {
      schemaVersion: 1,
      name: "Assistant activity",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  return { projectId, flowId, runnerId };
}

async function seedTask(projectId: string, flowId: string) {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "Inspect assistant activity",
    prompt: "Check the replay contract",
    flowId,
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });

  return taskId;
}

async function seedRun(
  projectId: string,
  taskId: string,
  flowId: string,
  runnerId: string,
) {
  const runId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId, "claude"),
    status: "Running",
    flowVersion: "v1.0.0",
  });

  return runId;
}

function makeRequest(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ext/runs/${runId}/activity`, {
    method: "GET",
  });
}

describe("GET /api/v1/ext/runs/[runId]/activity (real DB path)", () => {
  it("returns 404 for a token-bound project when the run belongs to another project", async () => {
    const left = await seedProject(
      `ext-run-activity-left-${randomUUID().slice(0, 8)}`,
    );
    const right = await seedProject(
      `ext-run-activity-right-${randomUUID().slice(0, 8)}`,
    );
    const taskId = await seedTask(right.projectId, right.flowId);
    const runId = await seedRun(
      right.projectId,
      taskId,
      right.flowId,
      right.runnerId,
    );
    const token = await issueToken(
      { projectId: left.projectId, name: "Left project token" },
      db,
    );

    const req = makeRequest(runId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: "NOT_FOUND",
      message: "run not found",
    });

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      scope_used: "runs:read",
    });
  });
});
