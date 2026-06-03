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
let getRailWorkspaceGroups: typeof import("@/lib/queries/portfolio").getRailWorkspaceGroups;
let getRailWorkspaces: typeof import("@/lib/queries/portfolio").getRailWorkspaces;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("portfolio_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getPortfolio, getRailWorkspaceGroups, getRailWorkspaces } = await import(
    "@/lib/queries/portfolio"
  ));
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

  async function createExecutor(projectId: string): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.executors).values({
      id,
      projectId,
      executorRefId: `claude-${id.slice(0, 8)}`,
      agent: "claude",
      model: "claude-sonnet-4-6",
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

    const executorId = await createExecutor(project);

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
    const user = await createUser("humanworking@test.com");
    const project = await createProject("HumanWorking Project");
    const flow = await createFlow(project);
    const executorId = await createExecutor(project);

    await addProjectMember(user, project, "member");

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
    expect(ws?.agent).toBe("dev");
    expect(ws?.status).toBe("needs");
    expect(portfolio.totalActiveWorkspaces).toBeGreaterThanOrEqual(1);
  });

  it("shows scratch runs as active workspaces linked to the scratch dialog", async () => {
    const user = await createUser("scratch@test.com");
    const project = await createProject("Scratch Project");
    const executorId = await createExecutor(project);

    await addProjectMember(user, project, "member");

    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      runKind: "scratch",
      projectId: project,
      executorId,
      status: "Crashed",
      acpSessionId: "acp-resume-1",
      flowVersion: "scratch",
      flowRevision: "manual",
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: "maister/scratch/recover-me",
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/scratch",
    });
    await db.insert(schema.scratchRuns).values({
      runId,
      projectId: project,
      name: "Recover me",
      initialPrompt: "Investigate this",
      baseBranch: "main",
      baseCommit: "abc123",
      dialogStatus: "Crashed",
      createdByUserId: user,
    });

    const portfolio = await getPortfolio(user, "member");
    const proj = portfolio.projects.find((p) => p.id === project);
    const scratchWorkspace = proj?.activeWorkspaces.find(
      (workspace) => workspace.runId === runId,
    );
    const groups = await getRailWorkspaceGroups(user, "member");
    const group = groups.find((candidate) => candidate.projectId === project);
    const rail = await getRailWorkspaces(user, "member");

    expect(scratchWorkspace).toMatchObject({
      runId,
      runKind: "scratch",
      href: `/scratch-runs/${runId}`,
      scratchAction: "recover",
      scratchDialogStatus: "Crashed",
    });
    expect(portfolio.totalActiveWorkspaces).toBeGreaterThanOrEqual(1);
    expect(group).toMatchObject({
      projectId: project,
      projectName: "Scratch Project",
      activeCount: 1,
      launchHref: `/scratch-runs/new?projectId=${project}`,
    });
    expect(group?.workspaces[0]).toMatchObject({
      runId,
      runKind: "scratch",
      href: `/scratch-runs/${runId}`,
      name: "Recover me",
      statusLabel: "Crashed",
      statusTone: "crashed",
      launchedBy: "User scratch@test.com",
    });
    expect(
      rail.find((workspace) => workspace.href === `/scratch-runs/${runId}`),
    ).toBeDefined();
  });

  // T7 (M16 Phase 7): the external_check gate-readiness flag fanned into the
  // portfolio. PortfolioWorkspace gains `externalGatePending?: boolean`,
  // computed per active workspace's latest run with the SAME semantics as the
  // board reader: true iff ≥1 BLOCKING external_check gate whose latest-per-
  // gateId, live-attempt representative status is NOT passed|overridden
  // (pending|failed|stale|skipped → true), mirroring assertEvidenceReady's
  // passed/overridden allow-list. The field does not exist yet →
  // RED (undefined at runtime). Existing portfolio tests are untouched.
  async function seedRunWithExternalGate(opts: {
    runStatus: "Review" | "Done" | "Abandoned";
    gateStatus:
      | "pending"
      | "failed"
      | "stale"
      | "passed"
      | "overridden"
      | "skipped";
    gateMode?: "blocking" | "advisory";
  }): Promise<{ userId: string; projectId: string; runId: string }> {
    const user = await createUser(`ext-${randomUUID().slice(0, 8)}@test.com`);
    const project = await createProject("External Gate Project");
    const flow = await createFlow(project);
    const executorId = await createExecutor(project);

    await addProjectMember(user, project, "member");

    const taskId = await createTask(project, flow, "External Gate Task");
    const runId = randomUUID();
    const attemptId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: project,
      flowId: flow,
      executorId,
      status: opts.runStatus,
      flowVersion: "v1.0.0",
      currentStepId: "review",
      startedAt: new Date(),
      endedAt: opts.runStatus === "Review" ? undefined : new Date(),
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: `maister/ext-${runId.slice(0, 8)}`,
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/ext",
    });
    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date(),
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      gateId: "ext-ci",
      kind: "external_check",
      mode: opts.gateMode ?? "blocking",
      status: opts.gateStatus,
    });

    return { userId: user, projectId: project, runId };
  }

  for (const gateStatus of ["pending", "failed", "stale", "skipped"] as const) {
    it(`active workspace's externalGatePending=true for a blocking external_check that is ${gateStatus}`, async () => {
      const { userId, projectId, runId } = await seedRunWithExternalGate({
        runStatus: "Review",
        gateStatus,
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.externalGatePending).toBe(true);
    });
  }

  it("active workspace's externalGatePending=false for a passed blocking external_check", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Review",
      gateStatus: "passed",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.externalGatePending).toBe(false);
  });

  it("a Done workspace is not active and never reads externalGatePending=true", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Done",
      gateStatus: "pending",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws?.externalGatePending ?? false).toBe(false);
  });

  it("an Abandoned workspace is not active and never reads externalGatePending=true", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Abandoned",
      gateStatus: "pending",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws?.externalGatePending ?? false).toBe(false);
  });

  // L2: advisory (non-blocking) external_check pending must NOT set the flag.
  // Exercises the `mode === "blocking"` filter in the portfolio collapse path.
  it("active workspace's externalGatePending=false for an advisory external_check that is pending", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Review",
      gateStatus: "pending",
      gateMode: "advisory",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.externalGatePending).toBe(false);
  });

  // M1: additional ready-status coverage. Only passed/overridden are ready;
  // skipped is asserted as pending=true in the loop above (it blocks like
  // assertEvidenceReady's passed/overridden allow-list).
  for (const gateStatus of ["overridden"] as const) {
    it(`active workspace's externalGatePending=false for a blocking external_check that is ${gateStatus}`, async () => {
      const { userId, projectId, runId } = await seedRunWithExternalGate({
        runStatus: "Review",
        gateStatus,
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.externalGatePending).toBe(false);
    });
  }

  // M1: supersede collapse — two rows on the same gateId, same live attempt.
  // Seeds a run with TWO external_check gate rows sharing the same gateId but
  // different createdAt so the latest-per-gateId collapse is exercised.
  async function seedRunWithTwoGateRows(opts: {
    olderStatus: "passed" | "stale";
    newerStatus: "passed" | "stale";
  }): Promise<{ userId: string; projectId: string; runId: string }> {
    const user = await createUser(
      `supersede-${randomUUID().slice(0, 8)}@test.com`,
    );
    const project = await createProject("Supersede Gate Project");
    const flow = await createFlow(project);
    const executorId = await createExecutor(project);

    await addProjectMember(user, project, "member");

    const taskId = await createTask(project, flow, "Supersede Gate Task");
    const runId = randomUUID();
    const attemptId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: project,
      flowId: flow,
      executorId,
      status: "Review",
      flowVersion: "v1.0.0",
      currentStepId: "review",
      startedAt: new Date(),
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: `maister/sup-${runId.slice(0, 8)}`,
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/sup",
    });
    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date(),
    });
    // Older row on the same gateId.
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      gateId: "ext-ci",
      kind: "external_check",
      mode: "blocking",
      status: opts.olderStatus,
      createdAt: new Date("2026-05-31T10:00:00.000Z"),
    });
    // Newer row on the same gateId — must win the collapse.
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      gateId: "ext-ci",
      kind: "external_check",
      mode: "blocking",
      status: opts.newerStatus,
      createdAt: new Date("2026-05-31T12:00:00.000Z"),
    });

    return { userId: user, projectId: project, runId };
  }

  it("externalGatePending=false when older stale row is superseded by newer passed row on same gateId", async () => {
    const { userId, projectId, runId } = await seedRunWithTwoGateRows({
      olderStatus: "stale",
      newerStatus: "passed",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.externalGatePending).toBe(false);
  });

  it("externalGatePending=true when older passed row is superseded by newer stale row on same gateId", async () => {
    const { userId, projectId, runId } = await seedRunWithTwoGateRows({
      olderStatus: "passed",
      newerStatus: "stale",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.externalGatePending).toBe(true);
  });

  // M1: live-attempt collapse — a pending gate on a SUPERSEDED (non-live)
  // attempt must not set the flag. Seeds two attempts on the same node; the
  // gate row sits on attempt 1 (stale) while attempt 2 is live.
  it("externalGatePending=false when the pending external gate sits on a stale (non-live) attempt", async () => {
    const user = await createUser(
      `stale-attempt-${randomUUID().slice(0, 8)}@test.com`,
    );
    const project = await createProject("Stale Attempt Gate Project");
    const flow = await createFlow(project);
    const executorId = await createExecutor(project);

    await addProjectMember(user, project, "member");

    const taskId = await createTask(project, flow, "Stale Attempt Gate Task");
    const runId = randomUUID();
    const staleAttemptId = randomUUID();
    const liveAttemptId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: project,
      flowId: flow,
      executorId,
      status: "Review",
      flowVersion: "v1.0.0",
      currentStepId: "review",
      startedAt: new Date(),
    });
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project,
      branch: `maister/sta-${runId.slice(0, 8)}`,
      worktreePath: `/wt/${runId}`,
      parentRepoPath: "/repos/sta",
    });
    // Superseded attempt (lower attempt number — not live).
    await db.insert(schema.nodeAttempts).values({
      id: staleAttemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date("2026-05-31T10:00:00.000Z"),
    });
    // Live attempt (higher attempt number).
    await db.insert(schema.nodeAttempts).values({
      id: liveAttemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 2,
      status: "Succeeded",
      startedAt: new Date("2026-05-31T11:00:00.000Z"),
    });
    // Gate row sits on the STALE (non-live) attempt — must be ignored.
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: staleAttemptId,
      gateId: "ext-ci",
      kind: "external_check",
      mode: "blocking",
      status: "pending",
    });

    const portfolio = await getPortfolio(user, "member");
    const proj = portfolio.projects.find((p) => p.id === project);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.externalGatePending).toBe(false);
  });
});
