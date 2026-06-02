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
  createHitlAssignment,
  ensureUserActor,
} from "@/lib/assignments/service";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let POST: typeof import("../route").POST;

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
    .withDatabase("assignment_claim_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ POST } = await import("../route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/assignments/a/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedProject(
  id: string,
  slug: string,
): Promise<{
  flowId: string;
  executorId: string;
}> {
  const executorId = randomUUID();
  const flowId = randomUUID();

  await db.insert(schema.projects).values({
    id,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.executors).values({
    id: executorId,
    projectId: id,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  return { flowId, executorId };
}

async function seedAssignment(): Promise<{
  assignmentId: string;
  realProjectId: string;
  otherProjectId: string;
  realRunId: string;
  otherRunId: string;
  userId: string;
}> {
  const realProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const userId = randomUUID();
  const taskId = randomUUID();
  const realRunId = randomUUID();
  const otherRunId = randomUUID();
  const hitlRequestId = randomUUID();

  const real = await seedProject(realProjectId, "real-project");
  const other = await seedProject(otherProjectId, "other-project");

  await db.insert(schema.users).values({
    id: userId,
    email: `claim-${userId.slice(0, 8)}@example.test`,
    name: "Claim User",
    role: "member",
    accountStatus: "active",
  });

  await db.insert(schema.projectMembers).values({
    id: randomUUID(),
    projectId: realProjectId,
    userId,
    role: "member",
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: realProjectId,
    title: "Review",
    prompt: "review",
    flowId: real.flowId,
  });

  await db.insert(schema.runs).values([
    {
      id: realRunId,
      taskId,
      projectId: realProjectId,
      flowId: real.flowId,
      executorId: real.executorId,
      status: "NeedsInput",
      flowVersion: "v1.0.0",
    },
    {
      id: otherRunId,
      projectId: otherProjectId,
      flowId: other.flowId,
      executorId: other.executorId,
      status: "NeedsInput",
      flowVersion: "v1.0.0",
    },
  ]);

  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId: realRunId,
    stepId: "review",
    kind: "human",
    schema: { schemaVersion: 1, fields: [] },
    prompt: "Review",
  });

  const systemActor = await ensureUserActor({
    db,
    projectId: realProjectId,
    userId,
    label: "Claim User",
  });
  const assignment = await createHitlAssignment({
    db,
    projectId: realProjectId,
    runId: realRunId,
    hitlRequestId,
    actionKind: "human_review",
    roleRefs: ["reviewer"],
    title: "Review",
    createdByActorId: systemActor.id,
  });

  return {
    assignmentId: assignment.id,
    realProjectId,
    otherProjectId,
    realRunId,
    otherRunId,
    userId,
  };
}

describe("POST /api/assignments/{assignmentId}/claim", () => {
  it("derives project/run/actor from server state and ignores body cross-resource ids", async () => {
    const ids = await seedAssignment();

    sessionRef.value = { user: { id: ids.userId, role: "member" } };

    const res = await POST(
      request({
        projectId: ids.otherProjectId,
        runId: ids.otherRunId,
        actorId: "malicious-actor",
      }),
      {
        params: Promise.resolve({ assignmentId: ids.assignmentId }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      id: ids.assignmentId,
      status: "claimed",
      runId: ids.realRunId,
      projectId: ids.realProjectId,
    });
    expect(JSON.stringify(body)).not.toContain("malicious-actor");

    const [assignment] = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.id, ids.assignmentId));
    const [actor] = await db
      .select()
      .from(schema.actorIdentities)
      .where(eq(schema.actorIdentities.id, assignment.assigneeActorId));
    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, ids.assignmentId));

    expect(actor.projectId).toBe(ids.realProjectId);
    expect(actor.kind).toBe("user");
    expect(actor.userId).toBe(ids.userId);
    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
    ]);
  });
});
