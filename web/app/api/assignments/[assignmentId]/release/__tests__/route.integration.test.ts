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

import {
  claimAssignment,
  createHitlAssignment,
  ensureUserActor,
} from "@/lib/assignments/service";
import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let releasePOST: typeof import("../route").POST;
let takeOverPOST: typeof import("../../take-over/route").POST;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("assignment_release_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ POST: releasePOST } = await import("../route"));
  ({ POST: takeOverPOST } = await import("../../take-over/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedClaimedAssignment(): Promise<{
  assignmentId: string;
  projectId: string;
  runId: string;
  ownerUserId: string;
  takeoverUserId: string;
  ownerActorId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlRequestId = randomUUID();
  const ownerUserId = randomUUID();
  const takeoverUserId = randomUUID();

  await db.insert(schema.users).values([
    {
      id: ownerUserId,
      email: `owner-${ownerUserId.slice(0, 8)}@example.test`,
      name: "Owner User",
      role: "member",
      accountStatus: "active",
    },
    {
      id: takeoverUserId,
      email: `takeover-${takeoverUserId.slice(0, 8)}@example.test`,
      name: "Takeover User",
      role: "member",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `assign-route-${projectId.slice(0, 8)}`,
    name: "Assignment Route",
    repoPath: `/tmp/assign-route-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId,
      userId: ownerUserId,
      role: "member",
    },
    {
      id: randomUUID(),
      projectId,
      userId: takeoverUserId,
      role: "member",
    },
  ]);

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

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

  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "Review",
    prompt: "review",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "NeedsInput",
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: "human",
    schema: { schemaVersion: 1, fields: [] },
    prompt: "Review",
  });

  const ownerActor = await ensureUserActor({
    db,
    projectId,
    userId: ownerUserId,
    label: "Owner User",
  });
  const assignment = await createHitlAssignment({
    db,
    projectId,
    runId,
    hitlRequestId,
    actionKind: "human_review",
    roleRefs: ["reviewer"],
    title: "Review",
    createdByActorId: ownerActor.id,
  });

  await claimAssignment({
    db,
    assignmentId: assignment.id,
    actorId: ownerActor.id,
  });

  return {
    assignmentId: assignment.id,
    projectId,
    runId,
    ownerUserId,
    takeoverUserId,
    ownerActorId: ownerActor.id,
  };
}

describe("assignment lifecycle routes", () => {
  it("releases a claim using server-derived actor and ignores body ids", async () => {
    const ids = await seedClaimedAssignment();

    sessionRef.value = { user: { id: ids.ownerUserId, role: "member" } };

    const res = await releasePOST(
      request("/api/assignments/a/release", {
        actorId: "malicious-actor",
        projectId: "wrong-project",
        reason: "done for now",
      }),
      { params: Promise.resolve({ assignmentId: ids.assignmentId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("open");
    expect(body.assigneeActor).toBeNull();

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, ids.assignmentId));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
      "released",
    ]);
    expect(events.at(-1)?.actorId).toBe(ids.ownerActorId);
  });

  it("deliberately takes over another actor's claim", async () => {
    const ids = await seedClaimedAssignment();

    sessionRef.value = { user: { id: ids.takeoverUserId, role: "member" } };

    const res = await takeOverPOST(
      request("/api/assignments/a/take-over", {
        actorId: "malicious-actor",
        reason: "covering shift",
      }),
      { params: Promise.resolve({ assignmentId: ids.assignmentId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("claimed");
    expect(body.assigneeActor.label).toBe("Takeover User");

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, ids.assignmentId));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
      "taken_over",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      previousActorId: ids.ownerActorId,
      reason: "covering shift",
    });
  });
});
