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

import { issueToken } from "@/lib/tokens/issue";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let GET: typeof import("@/app/api/v1/ext/runs/[runId]/readiness/route").GET;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_readiness_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeAll(async () => {
  const routeModule = await import(
    "@/app/api/v1/ext/runs/[runId]/readiness/route"
  );

  GET = routeModule.GET;
});

async function seedProject(slug: string) {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  return { slug, projectId, flowId, executorId };
}

async function seedTask(projectId: string, flowId: string) {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "Test Task",
    prompt: "Do something",
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
  executorId: string,
) {
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    status: "Review",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });

  await db.insert(schema.workspaces as any).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "maister/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/repo`,
  });

  return runId;
}

async function seedNodeAttempt(runId: string) {
  const attemptId = randomUUID();

  await db.insert(schema.nodeAttempts as any).values({
    id: attemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
  });

  return attemptId;
}

function makeRequest(runId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/ext/runs/${runId}/readiness`,
    {
      method: "GET",
    },
  );
}

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

describe("GET /api/v1/ext/runs/[runId]/readiness", () => {
  it("missing/invalid token → 401, no audit row", async () => {
    const { projectId, flowId, executorId } = {
      ...(await seedProject(`ext-ready-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    const req = makeRequest(runId);

    req.headers.set("authorization", "Bearer invalid");

    const res = await GET(req, {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(401);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(0);
  });

  it("valid token, wrong-project runId → 404, audit row", async () => {
    const slug1 = `ext-ready-cross1-${randomUUID().slice(0, 8)}`;
    const slug2 = `ext-ready-cross2-${randomUUID().slice(0, 8)}`;
    const { projectId: proj1 } = await seedProject(slug1);
    const {
      projectId: proj2,
      flowId: flow2,
      executorId: exec2,
    } = await seedProject(slug2);

    const taskId = await seedTask(proj2, flow2);
    const runId = await seedRun(proj2, taskId, flow2, exec2);

    const token = await issueToken(
      { projectId: proj1, name: "Token for Proj1" },
      db,
    );

    const req = makeRequest(runId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(404);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 404,
      scope_used: "readiness:read",
    });
  });

  it("valid token, correct runId → 200 ReadinessDTO, audit row", async () => {
    const { projectId, flowId, executorId } = {
      ...(await seedProject(`ext-ready-ok-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);

    await seedNodeAttempt(runId);

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest(runId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty("readiness");
    expect([
      "ready",
      "blocked",
      "stale",
      "failed",
      "waiting",
      "overridden",
    ]).toContain(body.readiness);
    expect(Array.isArray(body.externalGates)).toBe(true);
    expect(Array.isArray(body.requiredArtifacts)).toBe(true);
    expect(Array.isArray(body.reasons)).toBe(true);

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "ok",
      status_code: 200,
      scope_used: "readiness:read",
    });
  });

  it("readiness with pending external_check gate → externalGates[] contains it with status pending", async () => {
    const { projectId, flowId, executorId } = {
      ...(await seedProject(`ext-ready-gate-${randomUUID().slice(0, 8)}`)),
    };
    const taskId = await seedTask(projectId, flowId);
    const runId = await seedRun(projectId, taskId, flowId, executorId);
    const attemptId = await seedNodeAttempt(runId);

    // Seed a pending external_check gate
    const gateId = randomUUID();

    await db.insert(schema.gateResults as any).values({
      id: gateId,
      runId,
      nodeAttemptId: attemptId,
      gateId: "external-gate",
      kind: "external_check",
      mode: "blocking",
      status: "pending",
    });

    const token = await issueToken({ projectId, name: "Test Token" }, db);

    const req = makeRequest(runId);

    req.headers.set("authorization", `Bearer ${token.secret}`);

    const res = await GET(req, {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(Array.isArray(body.externalGates)).toBe(true);
    expect(body.externalGates.length).toBeGreaterThan(0);

    const externalGate = body.externalGates.find(
      (g: any) => g.gateId === "external-gate",
    );

    expect(externalGate).toBeDefined();
    expect(externalGate.status).toBe("pending");

    const auditRows = await db
      .select()
      .from(schema.tokenAuditLog as any)
      .execute();

    expect(auditRows).toHaveLength(1);
  });
});
