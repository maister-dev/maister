import { randomUUID } from "node:crypto";

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

let getCrossProjectHitlInbox: typeof import("@/lib/queries/portfolio").getCrossProjectHitlInbox;
let getHitlInbox: typeof import("@/lib/queries/hitl").getHitlInbox;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("portfolio_inbox_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getCrossProjectHitlInbox } = await import("@/lib/queries/portfolio"));
  ({ getHitlInbox } = await import("@/lib/queries/hitl"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("getCrossProjectHitlInbox (M17 P5, integration)", () => {
  async function createUser(email: string): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.users).values({
      id,
      name: `User ${email}`,
      email,
      passwordHash: null,
      role: "member",
    });

    return id;
  }

  async function createAdminUser(email: string): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.users).values({
      id,
      name: `Admin ${email}`,
      email,
      passwordHash: null,
      role: "admin",
    });

    return id;
  }

  async function createProject(name: string): Promise<string> {
    const id = randomUUID();
    const slug = `proj-${id.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id,
      slug,
      name,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });

    return id;
  }

  async function addProjectMember(
    userId: string,
    projectId: string,
    role: "owner" | "admin" | "member" | "viewer" = "member",
  ): Promise<void> {
    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      userId,
      projectId,
      role,
    });
  }

  async function createFlow(projectId: string): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.flows).values({
      id,
      projectId,
      flowRefId: `flow-${id.slice(0, 8)}`,
      source: "github.com/x/y",
      version: "v1.0.0",
      revision: "abc123",
      installedPath: "/tmp/flows/test",
      manifest: { schemaVersion: 1, name: "Test Flow", steps: [] },
      schemaVersion: 1,
    });

    return id;
  }

  async function createExecutor(): Promise<string> {
    const id = randomUUID();

    await db
      .insert(schema.platformAcpRunners)
      .values(testPlatformRunnerRow(id, "claude"));

    return id;
  }

  async function createTask(
    projectId: string,
    flowId: string,
    title: string,
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.tasks).values({
      id,
      projectId,
      title,
      prompt: `Prompt for ${title}`,
      flowId,
      status: "Backlog",
      stage: "Backlog",
    });

    return id;
  }

  async function createRun(
    projectId: string,
    taskId: string,
    flowId: string,
    executorId: string,
    status: "Running" | "NeedsInput" | "NeedsInputIdle" = "NeedsInput",
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.runs).values({
      id,
      projectId,
      taskId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
      runKind: "flow",
      status,
      flowVersion: "v1.0.0",
      startedAt: new Date(),
    });

    return id;
  }

  async function createWorkspace(
    runId: string,
    projectId: string,
  ): Promise<void> {
    await db.insert(schema.workspaces).values({
      id: `ws-${runId}`,
      runId,
      projectId,
      branch: `maister/test-${runId.slice(0, 8)}`,
      worktreePath: `/tmp/${projectId}/.maister/${runId}`,
      parentRepoPath: `/tmp/${projectId}`,
    });
  }

  async function createHitlRequest(
    id: string,
    runId: string,
    kind: "permission" | "form" | "human",
    criticality: "low" | "medium" | "high" | "critical" | null = null,
    schema_val: unknown | null = null,
    respondedAt: Date | null = null,
    createdAt: Date = new Date(),
  ): Promise<void> {
    const query = `
      INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality, responded_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;

    await pool.query(query, [
      id,
      runId,
      `step-${id}`,
      kind,
      schema_val ? JSON.stringify(schema_val) : null,
      `Test prompt for ${kind}`,
      criticality,
      respondedAt,
      createdAt,
    ]);
  }

  beforeEach(async () => {
    // Clear all tables between tests.
    await db.delete(schema.assignments);
    await db.delete(schema.hitlRequests);
    await db.delete(schema.workspaces);
    await db.delete(schema.runs);
    await db.delete(schema.tasks);
    await db.delete(schema.flows);
    await db.delete(schema.platformAcpRunners);
    await db.delete(schema.projectMembers);
    await db.delete(schema.projects);
    await db.delete(schema.users);
  });

  it("admin sees ALL pending HITL items across all projects with schema, criticality, projectSlug, projectName", async () => {
    const admin = await createAdminUser("admin@test.com");
    const proj1 = await createProject("Project 1");
    const proj2 = await createProject("Project 2");

    const flow1 = await createFlow(proj1);
    const flow2 = await createFlow(proj2);
    const exec1 = await createExecutor();
    const exec2 = await createExecutor();

    const task1 = await createTask(proj1, flow1, "Task 1");
    const task2 = await createTask(proj2, flow2, "Task 2");

    const run1 = await createRun(proj1, task1, flow1, exec1, "NeedsInput");
    const run2 = await createRun(proj2, task2, flow2, exec2, "NeedsInput");

    await createWorkspace(run1, proj1);
    await createWorkspace(run2, proj2);

    // A real permission schema carries supervisor-internal handles
    // (requestId / supervisorSessionId / toolCall) alongside the options.
    const schema1 = {
      requestId: "req-secret-123",
      supervisorSessionId: "sup-sess-secret-abc",
      toolCall: { name: "bash", input: { command: "rm -rf /" } },
      options: [
        { optionId: "approve", label: "Approve" },
        { optionId: "reject", label: "Reject" },
      ],
    };

    await createHitlRequest("hitl-1", run1, "permission", "high", schema1);
    await createHitlRequest("hitl-2", run2, "permission", "critical", schema1);

    const result = await getCrossProjectHitlInbox(admin, "admin");

    expect(result.items).toHaveLength(2);
    expect(result.count).toBe(2);

    // Verify items carry the required fields: schema, criticality, projectId, projectSlug, projectName.
    const item1 = result.items[0];

    expect(item1).toHaveProperty("schema");
    expect(item1).toHaveProperty("criticality");
    expect(item1).toHaveProperty("projectId");
    expect(item1).toHaveProperty("projectSlug");
    expect(item1).toHaveProperty("projectName");

    // SECURITY: permission schemas carry supervisor-internal handles and MUST
    // NOT cross to the browser. The inbox item exposes options only; schema=null.
    for (const item of result.items) {
      expect(item.kind).toBe("permission");
      expect(item.schema).toBeNull();
      expect(item.options).toHaveLength(2);
    }
    const serialized = JSON.stringify(result.items);

    expect(serialized).not.toContain("req-secret-123");
    expect(serialized).not.toContain("sup-sess-secret-abc");

    // Verify content is correct.
    const criticalItem = result.items.find((i) => i.criticality === "critical");

    expect(criticalItem?.projectName).toBe("Project 2");
  });

  it("member sees ONLY their projects' HITL; projects they are NOT a member of are absent (RBAC strict)", async () => {
    const memberUser = await createUser("member@test.com");
    const memberProj = await createProject("Member Project");
    const otherProj = await createProject("Other Project");

    // Add member to only one project.
    await addProjectMember(memberUser, memberProj, "member");

    const flow1 = await createFlow(memberProj);
    const flow2 = await createFlow(otherProj);
    const exec1 = await createExecutor();
    const exec2 = await createExecutor();

    const task1 = await createTask(memberProj, flow1, "Task 1");
    const task2 = await createTask(otherProj, flow2, "Task 2");

    const run1 = await createRun(memberProj, task1, flow1, exec1, "NeedsInput");
    const run2 = await createRun(otherProj, task2, flow2, exec2, "NeedsInput");

    await createWorkspace(run1, memberProj);
    await createWorkspace(run2, otherProj);

    await createHitlRequest("hitl-member", run1, "permission", "high");
    await createHitlRequest("hitl-other", run2, "permission", "high");

    const result = await getCrossProjectHitlInbox(memberUser, "member");

    // Member should see exactly 1 item (from memberProj), NOT the otherProj item.
    expect(result.items).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.items[0].projectId).toBe(memberProj);
    expect(result.items[0].projectName).toBe("Member Project");
  });

  it("sorts by criticality DESC (critical>high>medium>low>null) then by createdAt ASC (oldest first)", async () => {
    const admin = await createAdminUser("admin@test.com");
    const proj = await createProject("Test Project");
    const flow = await createFlow(proj);
    const exec = await createExecutor();

    const task1 = await createTask(proj, flow, "Task 1");
    const task2 = await createTask(proj, flow, "Task 2");
    const task3 = await createTask(proj, flow, "Task 3");
    const task4 = await createTask(proj, flow, "Task 4");
    const task5 = await createTask(proj, flow, "Task 5");

    const run1 = await createRun(proj, task1, flow, exec, "NeedsInput");
    const run2 = await createRun(proj, task2, flow, exec, "NeedsInput");
    const run3 = await createRun(proj, task3, flow, exec, "NeedsInput");
    const run4 = await createRun(proj, task4, flow, exec, "NeedsInput");
    const run5 = await createRun(proj, task5, flow, exec, "NeedsInput");

    await createWorkspace(run1, proj);
    await createWorkspace(run2, proj);
    await createWorkspace(run3, proj);
    await createWorkspace(run4, proj);
    await createWorkspace(run5, proj);

    // Create HITL with varying criticalities and creation times (to test both sort axes).
    const baseTime = new Date("2026-01-01T00:00:00Z");

    // medium, created first
    await createHitlRequest(
      "hitl-1",
      run1,
      "permission",
      "medium",
      null,
      null,
      new Date(baseTime.getTime() + 0),
    );
    // low, created second
    await createHitlRequest(
      "hitl-2",
      run2,
      "permission",
      "low",
      null,
      null,
      new Date(baseTime.getTime() + 1000),
    );
    // critical, created third
    await createHitlRequest(
      "hitl-3",
      run3,
      "permission",
      "critical",
      null,
      null,
      new Date(baseTime.getTime() + 2000),
    );
    // high, created fourth (older than another high)
    await createHitlRequest(
      "hitl-4",
      run4,
      "permission",
      "high",
      null,
      null,
      new Date(baseTime.getTime() + 3000),
    );
    // high, created fifth (newer than hitl-4)
    await createHitlRequest(
      "hitl-5",
      run5,
      "permission",
      "high",
      null,
      null,
      new Date(baseTime.getTime() + 4000),
    );

    const result = await getCrossProjectHitlInbox(admin, "admin");

    expect(result.items).toHaveLength(5);

    // Verify the sort order: critical > high (oldest first) > medium > low.
    const criticalities = result.items.map((i) => i.criticality);

    expect(criticalities).toEqual([
      "critical",
      "high", // hitl-4, older
      "high", // hitl-5, newer
      "medium",
      "low",
    ]);
  });

  it("excludes answered HITL (respondedAt IS NOT NULL)", async () => {
    const admin = await createAdminUser("admin@test.com");
    const proj = await createProject("Test Project");
    const flow = await createFlow(proj);
    const exec = await createExecutor();

    const task1 = await createTask(proj, flow, "Task 1");
    const task2 = await createTask(proj, flow, "Task 2");

    const run1 = await createRun(proj, task1, flow, exec, "NeedsInput");
    const run2 = await createRun(proj, task2, flow, exec, "NeedsInput");

    await createWorkspace(run1, proj);
    await createWorkspace(run2, proj);

    // Pending (no respondedAt).
    await createHitlRequest("hitl-pending", run1, "permission", "high");
    // Answered (respondedAt set).
    await createHitlRequest(
      "hitl-answered",
      run2,
      "permission",
      "high",
      null,
      new Date("2026-01-05T00:00:00Z"),
    );

    const result = await getCrossProjectHitlInbox(admin, "admin");

    // Should only see the pending one, not the answered one.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].hitlRequestId).toBe("hitl-pending");
  });

  it("getHitlInbox (single-project) now carries schema and criticality on each item", async () => {
    const proj = await createProject("Test Project");
    const flow = await createFlow(proj);
    const exec = await createExecutor();

    const task = await createTask(proj, flow, "Task");
    const run = await createRun(proj, task, flow, exec, "NeedsInput");

    await createWorkspace(run, proj);

    const schema = {
      options: [
        { optionId: "option1", label: "Label 1" },
        { optionId: "option2", label: "Label 2" },
      ],
    };

    await createHitlRequest("hitl-1", run, "form", "medium", schema);

    const result = await getHitlInbox(proj);

    expect(result.items).toHaveLength(1);
    const item = result.items[0];

    // Verify that HitlItem now carries schema and criticality.
    expect(item).toHaveProperty("schema");
    expect(item).toHaveProperty("criticality");
    expect(item.schema).toEqual(schema);
    expect(item.criticality).toBe("medium");
  });
});
