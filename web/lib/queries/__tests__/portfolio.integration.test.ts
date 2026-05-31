import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getPortfolio: typeof import("@/lib/queries/portfolio").getPortfolio;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("portfolio_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getPortfolio } = await import("@/lib/queries/portfolio"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("portfolio queries (integration)", () => {
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

  async function addProjectMember(
    userId: string,
    projectId: string,
    role: "owner" | "admin" | "member" | "viewer",
  ): Promise<void> {
    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      userId,
      projectId,
      role,
    });
  }

  it("user sees only projects they are a member of", async () => {
    const user = await createUser("member@test.com");
    const memberProj = await createProject("Member Project");
    const otherProj = await createProject("Other Project");

    await addProjectMember(user, memberProj, "member");

    const memberProjects = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, user));

    const projectIds = memberProjects.map((pm) => pm.projectId);

    expect(projectIds).toContain(memberProj);
    expect(projectIds).not.toContain(otherProj);
  });

  it("user with multiple project memberships sees all of them", async () => {
    const user = await createUser("multiproj@test.com");
    const proj1 = await createProject("Project 1");
    const proj2 = await createProject("Project 2");
    const proj3 = await createProject("Project 3");

    await addProjectMember(user, proj1, "member");
    await addProjectMember(user, proj2, "admin");
    await addProjectMember(user, proj3, "viewer");

    const memberProjects = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, user));

    const projectIds = memberProjects.map((pm) => pm.projectId);

    expect(projectIds).toContain(proj1);
    expect(projectIds).toContain(proj2);
    expect(projectIds).toContain(proj3);
    expect(projectIds).toHaveLength(3);
  });

  it("user sees projects with different role assignments", async () => {
    const user = await createUser("roles@test.com");
    const ownerProj = await createProject("Owner Project");
    const adminProj = await createProject("Admin Project");
    const memberProj = await createProject("Member Project");
    const viewerProj = await createProject("Viewer Project");

    await addProjectMember(user, ownerProj, "owner");
    await addProjectMember(user, adminProj, "admin");
    await addProjectMember(user, memberProj, "member");
    await addProjectMember(user, viewerProj, "viewer");

    const memberships = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, user));

    const roleMap = Object.fromEntries(
      memberships.map((m) => [m.projectId, m.role]),
    );

    expect(roleMap[ownerProj]).toBe("owner");
    expect(roleMap[adminProj]).toBe("admin");
    expect(roleMap[memberProj]).toBe("member");
    expect(roleMap[viewerProj]).toBe("viewer");
  });

  it("task backlog count reflects tasks in Backlog status", async () => {
    const user = await createUser("backlog@test.com");
    const project = await createProject("Backlog Test");
    const flow = await createFlow(project);

    await addProjectMember(user, project, "member");

    await createTask(project, flow, "Task 1");
    await createTask(project, flow, "Task 2");

    const backlogTasks = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, project));

    expect(backlogTasks).toHaveLength(2);
  });

  it("multiple users can be members of the same project", async () => {
    const user1 = await createUser("proj-user1@test.com");
    const user2 = await createUser("proj-user2@test.com");
    const user3 = await createUser("proj-user3@test.com");
    const sharedProject = await createProject("Shared Project");

    await addProjectMember(user1, sharedProject, "owner");
    await addProjectMember(user2, sharedProject, "admin");
    await addProjectMember(user3, sharedProject, "member");

    const members = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, sharedProject));

    expect(members).toHaveLength(3);
    expect(members.map((m) => m.userId)).toContain(user1);
    expect(members.map((m) => m.userId)).toContain(user2);
    expect(members.map((m) => m.userId)).toContain(user3);
  });

  it("user with no project memberships sees empty list", async () => {
    const user = await createUser("loner@test.com");

    const memberships = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, user));

    expect(memberships).toHaveLength(0);
  });

  it("getPortfolio exposes the real run id on the Needs-You item (not the slug)", async () => {
    const user = await createUser("needs@test.com");
    const project = await createProject("Needs Project");
    const flow = await createFlow(project);

    await addProjectMember(user, project, "member");

    const executorId = randomUUID();

    await db.insert(schema.executors).values({
      id: executorId,
      projectId: project,
      executorRefId: "claude-sonnet",
      agent: "claude",
      model: "claude-sonnet-4-6",
    });

    const taskId = await createTask(project, flow, "Needs Task");
    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: project,
      flowId: flow,
      executorId,
      status: "NeedsInput",
      flowVersion: "v1.0.0",
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: "maister/needs",
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/needs",
    });
    await db.insert(schema.hitlRequests).values({
      id: randomUUID(),
      runId,
      stepId: "plan",
      kind: "permission",
      prompt: "needs you",
    });

    const portfolio = await getPortfolio(user, "member");
    const proj = portfolio.projects.find((p) => p.id === project);

    expect(proj?.need?.runId).toBe(runId);
    expect(proj?.need?.runId).not.toBe(proj?.slug);
  });

  it("counts a HumanWorking (claimed takeover) run as an active workspace", async () => {
    // FIX #3: a claimed takeover (HumanWorking) holds a worktree + a cap slot,
    // so it MUST surface in the cross-project portfolio active-workspace set and
    // totals. The board (lib/board.ts) already counts HumanWorking; the
    // portfolio read model omitted it (ACTIVE_RUN_STATUSES lacked HumanWorking)
    // → the claimed run vanished from the home grid. This asserts parity.
    const user = await createUser("humanworking@test.com");
    const project = await createProject("HumanWorking Project");
    const flow = await createFlow(project);

    await addProjectMember(user, project, "member");

    const executorId = randomUUID();

    await db.insert(schema.executors).values({
      id: executorId,
      projectId: project,
      executorRefId: "claude-sonnet",
      agent: "claude",
      model: "claude-sonnet-4-6",
    });

    const taskId = await createTask(project, flow, "Claimed Task");
    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: project,
      flowId: flow,
      executorId,
      status: "HumanWorking",
      flowVersion: "v1.0.0",
      currentStepId: "review",
      startedAt: new Date(),
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: "maister/claimed",
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/claimed",
    });

    const portfolio = await getPortfolio(user, "member");
    const proj = portfolio.projects.find((p) => p.id === project);

    expect(proj).toBeDefined();
    const ws = proj?.activeWorkspaces.find(
      (w) => w.branch === "maister/claimed",
    );

    expect(ws).toBeDefined();
    // Mirrors the board's takeover treatment: agent pill = dev, status surfaced
    // as a human-in-the-loop "needs" state.
    expect(ws?.agent).toBe("dev");
    expect(ws?.status).toBe("needs");

    // The claimed run is counted in the cross-project total.
    expect(portfolio.totalActiveWorkspaces).toBeGreaterThanOrEqual(1);
  });
});
