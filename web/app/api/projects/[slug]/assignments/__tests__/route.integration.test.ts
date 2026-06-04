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

import {
  claimAssignment,
  createHitlAssignment,
  ensureUserActor,
} from "@/lib/assignments/service";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let GET: typeof import("../route").GET;

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
    .withDatabase("project_assignments_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ GET } = await import("../route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

function request(slug: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${slug}/assignments`, {
    method: "GET",
  });
}

async function seedProject(slug: string): Promise<{
  projectId: string;
  flowId: string;
  executorId: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
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

  return { projectId, flowId, executorId };
}

async function seedAssignment(args: {
  slug: string;
  title: string;
  userId: string;
  claimed: boolean;
}): Promise<{ projectId: string; assignmentId: string; runId: string }> {
  const project = await seedProject(args.slug);
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlRequestId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: project.projectId,
    title: args.title,
    prompt: "review",
    flowId: project.flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId: project.projectId,
    flowId: project.flowId,
    runnerId: project.executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(project.executorId),
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

  const actor = await ensureUserActor({
    db,
    projectId: project.projectId,
    userId: args.userId,
    label: "Assignment User",
  });
  const assignment = await createHitlAssignment({
    db,
    projectId: project.projectId,
    runId,
    hitlRequestId,
    actionKind: "human_review",
    roleRefs: ["reviewer"],
    title: args.title,
    createdByActorId: actor.id,
  });

  if (args.claimed) {
    await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: actor.id,
    });
  }

  return { projectId: project.projectId, assignmentId: assignment.id, runId };
}

describe("GET /api/projects/{slug}/assignments", () => {
  it("lists only server-state project assignments with assignee DTOs", async () => {
    const userId = randomUUID();

    await db.insert(schema.users).values({
      id: userId,
      email: `list-${userId.slice(0, 8)}@example.test`,
      name: "Assignment User",
      role: "member",
      accountStatus: "active",
    });

    const visible = await seedAssignment({
      slug: "visible-assignments",
      title: "Visible review",
      userId,
      claimed: true,
    });

    await seedAssignment({
      slug: "hidden-assignments",
      title: "Hidden review",
      userId,
      claimed: true,
    });

    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      projectId: visible.projectId,
      userId,
      role: "member",
    });

    sessionRef.value = { user: { id: userId, role: "member" } };

    const res = await GET(request("visible-assignments"), {
      params: Promise.resolve({ slug: "visible-assignments" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      id: visible.assignmentId,
      projectId: visible.projectId,
      runId: visible.runId,
      status: "claimed",
      title: "Visible review",
      assigneeActor: { label: "Assignment User", kind: "user" },
    });
    expect(JSON.stringify(body)).not.toContain("Hidden review");
  });
});
