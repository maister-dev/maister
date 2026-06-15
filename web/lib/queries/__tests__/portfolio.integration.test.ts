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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

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
      taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
      number: Math.trunc(Math.random() * 1e9) + 1,
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

  async function createExecutor(_projectId: string): Promise<string> {
    const id = randomUUID();

    await db
      .insert(schema.platformAcpRunners)
      .values(testPlatformRunnerRow(id, "claude"));

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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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

  // T16 (M15, ADR-048): MIGRATED from the M16 externalGatePending boolean to the
  // unified `readiness: ReadinessState`. A blocking external_check gate now
  // contributes through gateStatusContribution like every other kind:
  // pending|running → waiting, failed → failed, stale → stale, skipped → blocked,
  // passed → ready, overridden → overridden. The critical live-attempt +
  // latest-per-gateId collapse semantics (via liveBlockingGates) are preserved.
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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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

  const EXTERNAL_STATUS_TO_READINESS = {
    pending: "waiting",
    failed: "failed",
    stale: "stale",
    skipped: "blocked",
  } as const;

  for (const [gateStatus, expected] of Object.entries(
    EXTERNAL_STATUS_TO_READINESS,
  ) as [
    keyof typeof EXTERNAL_STATUS_TO_READINESS,
    (typeof EXTERNAL_STATUS_TO_READINESS)[keyof typeof EXTERNAL_STATUS_TO_READINESS],
  ][]) {
    it(`active workspace's readiness='${expected}' for a blocking external_check that is ${gateStatus}`, async () => {
      const { userId, projectId, runId } = await seedRunWithExternalGate({
        runStatus: "Review",
        gateStatus,
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe(expected);
    });
  }

  it("active workspace's readiness='ready' for a passed blocking external_check", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Review",
      gateStatus: "passed",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.readiness).toBe("ready");
  });

  it("a Done workspace is not active (readiness not assessed)", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Done",
      gateStatus: "pending",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeUndefined();
  });

  it("an Abandoned workspace is not active (readiness not assessed)", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Abandoned",
      gateStatus: "pending",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeUndefined();
  });

  // L2: advisory (non-blocking) external_check pending must NOT contribute.
  // Exercises the `mode === "blocking"` filter in liveBlockingGates.
  it("active workspace's readiness='ready' for an advisory external_check that is pending", async () => {
    const { userId, projectId, runId } = await seedRunWithExternalGate({
      runStatus: "Review",
      gateStatus: "pending",
      gateMode: "advisory",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.readiness).toBe("ready");
  });

  // M1: overridden clears enforcement but still flags the override in the summary.
  for (const gateStatus of ["overridden"] as const) {
    it(`active workspace's readiness='overridden' for a blocking external_check that is ${gateStatus}`, async () => {
      const { userId, projectId, runId } = await seedRunWithExternalGate({
        runStatus: "Review",
        gateStatus,
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("overridden");
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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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

  it("readiness='ready' when older stale row is superseded by newer passed row on same gateId", async () => {
    const { userId, projectId, runId } = await seedRunWithTwoGateRows({
      olderStatus: "stale",
      newerStatus: "passed",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.readiness).toBe("ready");
  });

  it("readiness='stale' when older passed row is superseded by newer stale row on same gateId", async () => {
    const { userId, projectId, runId } = await seedRunWithTwoGateRows({
      olderStatus: "passed",
      newerStatus: "stale",
    });

    const portfolio = await getPortfolio(userId, "member");
    const proj = portfolio.projects.find((p) => p.id === projectId);
    const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

    expect(ws).toBeDefined();
    expect(ws?.readiness).toBe("stale");
  });

  // M1: live-attempt collapse — a pending gate on a SUPERSEDED (non-live)
  // attempt must not contribute. Seeds two attempts on the same node; the
  // gate row sits on attempt 1 (stale) while attempt 2 is live.
  it("readiness='ready' when the pending external gate sits on a stale (non-live) attempt", async () => {
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
      runnerId: executorId,
      capabilityAgent: "claude",
      runnerSnapshot: testRunnerSnapshot(executorId),
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
    expect(ws?.readiness).toBe("ready");
  });

  // T16 (M15, ADR-048): portfolio readiness unification. The `externalGatePending`
  // boolean is replaced with a unified `readiness: ReadinessState` computed via
  // readiness-core over the same bulk-fetched node_attempts + gate_results +
  // artifact_instances rows. The classifier is SSOT shared with board.ts,
  // getRunReadiness, and assertEvidenceReady — no per-run calls, no N+1.
  //
  // MIGRATED from externalGatePending assertions: a case that had externalGatePending=true
  // for pending external_check → readiness="waiting" (see test labels below);
  // externalGatePending=false for passed/overridden → readiness="ready";
  // externalGatePending=false for other gates → no readiness impact on that dimension.
  //
  // NEW readiness cases (mirroring board.integration.test.ts):
  // - external_check status → readiness contribution (via gateStatusContribution).
  // - required-artifact presence/validity → readiness contribution.
  // - rollup priority: failed > stale > blocked > waiting > overridden > ready.
  describe("portfolio readiness (T16)", () => {
    async function seedReviewRun(opts: {
      runStatus: string;
      gates?: Array<{
        kind: string;
        mode: "blocking" | "advisory";
        status: string;
      }>;
    }): Promise<{ userId: string; projectId: string; runId: string }> {
      const uniqueId = randomUUID().slice(0, 8);
      const user = await createUser(`portfolio-readiness-${uniqueId}@test.com`);
      const project = await createProject(
        `Portfolio Readiness Test ${uniqueId}`,
      );
      const executor = await createExecutor(project);
      const flow = await createFlow(project);
      const task = await createTask(project, flow, "Readiness Test");

      await addProjectMember(user, project, "member");

      const runId = randomUUID();
      const workspaceId = randomUUID();
      const nodeAttemptId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        projectId: project,
        taskId: task,
        flowId: flow,
        runKind: "flow",
        runnerId: executor,
        capabilityAgent: "claude",
        runnerSnapshot: testRunnerSnapshot(executor),
        status: opts.runStatus,
        flowVersion: "v1.0.0",
        startedAt: new Date(),
      });

      await db.insert(schema.workspaces).values({
        id: workspaceId,
        projectId: project,
        runId,
        branch: "readiness-test",
        worktreePath: `/tmp/test-ws-${randomUUID().slice(0, 8)}`,
        parentRepoPath: `/repos/${randomUUID().slice(0, 8)}`,
      });

      await db.insert(schema.nodeAttempts).values({
        id: nodeAttemptId,
        runId,
        nodeId: "test-node",
        nodeType: "agent",
        attempt: 1,
        status: "Running",
        startedAt: new Date(),
      });

      if (opts.gates && opts.gates.length > 0) {
        for (const g of opts.gates) {
          await db.insert(schema.gateResults).values({
            id: randomUUID(),
            runId,
            nodeAttemptId,
            gateId: randomUUID(),
            kind: g.kind,
            mode: g.mode,
            status: g.status,
            createdAt: new Date(),
          });
        }
      }

      return { userId: user, projectId: project, runId };
    }

    // Case 1: MIGRATED — external_check pending → readiness="waiting"
    // (formerly externalGatePending=true). Asserts the blocking external_check's
    // pending status flows through gateStatusContribution → "waiting".
    it("readiness='waiting' for a blocking external_check gate that is pending", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "pending",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("waiting");
    });

    // Case 2: MIGRATED — external_check passed → readiness="ready"
    // (formerly externalGatePending=false). Asserts passed status clears.
    it("readiness='ready' for a blocking external_check gate that is passed", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "passed",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("ready");
    });

    // Case 3: external_check failed → readiness="failed"
    // Asserts failed status blocks via priority (failed > all others).
    it("readiness='failed' for a blocking external_check gate that is failed", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "failed",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("failed");
    });

    // Case 4: external_check stale → readiness="stale"
    // Asserts stale status blocks via priority (stale > blocked, waiting, overridden).
    it("readiness='stale' for a blocking external_check gate that is stale", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "stale",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("stale");
    });

    // Case 5: external_check skipped → readiness="blocked"
    // Asserts skipped status (non-executed gate) blocks.
    it("readiness='blocked' for a blocking external_check gate that is skipped", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "skipped",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("blocked");
    });

    // Case 6: external_check overridden → readiness="overridden"
    // Asserts overridden status allows promotion but flags override.
    it("readiness='overridden' for a blocking external_check gate that is overridden", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "overridden",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("overridden");
    });

    // Case 7: advisory (non-blocking) external_check pending → readiness="ready"
    // Asserts non-blocking gates don't contribute to readiness (filtered out).
    it("readiness='ready' for an advisory external_check gate that is pending", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "advisory",
            status: "pending",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("ready");
    });

    // Case 8: multiple gates with priority rollup (failed > stale > blocked)
    // Two gates: one pending (waiting), one failed (failed) → failed wins.
    it("readiness='failed' when multiple gates include failed (highest priority)", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "pending",
          },
          {
            kind: "command_check",
            mode: "blocking",
            status: "failed",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("failed");
    });

    // Case 9: multiple gates with priority rollup (stale > blocked, waiting)
    // Two gates: one waiting, one stale → stale wins.
    it("readiness='stale' when multiple gates include stale (higher priority than waiting)", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Review",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "pending",
          },
          {
            kind: "command_check",
            mode: "blocking",
            status: "stale",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeDefined();
      expect(ws?.readiness).toBe("stale");
    });

    // Case 10: Done/Abandoned workspaces are not active and should not appear
    // in activeWorkspaces, so readiness is not asserted on them.
    it("Done run is not in activeWorkspaces (readiness not assessed)", async () => {
      const { userId, projectId, runId } = await seedReviewRun({
        runStatus: "Done",
        gates: [
          {
            kind: "external_check",
            mode: "blocking",
            status: "pending",
          },
        ],
      });

      const portfolio = await getPortfolio(userId, "member");
      const proj = portfolio.projects.find((p) => p.id === projectId);
      const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

      expect(ws).toBeUndefined();
    });
  });

  // Active-workspaces redesign (T1.2): the rail row now carries ticket-derived
  // names, linked flow/issue chips, and a null-safe runner detail. These cases
  // exercise the new tasks/flows joins and the null-safe fallbacks.
  describe("rail workspace redesign (T1.2)", () => {
    async function railRow(user: string, project: string, runId: string) {
      const groups = await getRailWorkspaceGroups(user, "member");
      const group = groups.find((g) => g.projectId === project);

      return group?.workspaces.find((w) => w.runId === runId);
    }

    it("flow run surfaces flowRefLabel, ticket-derived name, and KEY-N issue link", async () => {
      const user = await createUser(
        `rail-flow-${randomUUID().slice(0, 8)}@test.com`,
      );
      const project = await createProject("Rail Flow Project");
      const flow = await createFlow(project);
      const executor = await createExecutor(project);

      await addProjectMember(user, project, "member");

      const taskId = await createTask(project, flow, "Fix the thing");
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        taskId,
        projectId: project,
        flowId: flow,
        runKind: "flow",
        runnerId: executor,
        capabilityAgent: "claude",
        runnerSnapshot: testRunnerSnapshot(executor),
        status: "Running",
        flowVersion: "v1.0.0",
        startedAt: new Date(),
      });
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project,
        branch: "maister/fix",
        worktreePath: `/wt/${runId}`,
        parentRepoPath: `/repos/${project}`,
      });

      const [proj] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, project));
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId));

      const row = await railRow(user, project, runId);

      expect(row).toBeDefined();
      expect(row?.flowRefLabel).toBe(`flow-${flow.slice(0, 8)}`);
      expect(row?.flowVersion).toBe("v1.0.0");
      expect(row?.taskKey).toBe(proj.taskKey);
      expect(row?.taskNumber).toBe(task.number);
      expect(row?.name).toBe(`${proj.taskKey}-${task.number} Fix the thing`);
      expect(row?.issueHref).toBe(
        `/projects/${proj.slug}/tasks/${task.number}`,
      );
    });

    it("runnerDetail is parsed null-safe from the runner snapshot", async () => {
      const user = await createUser(
        `rail-runner-${randomUUID().slice(0, 8)}@test.com`,
      );
      const project = await createProject("Rail Runner Project");
      const flow = await createFlow(project);
      const executor = await createExecutor(project);

      await addProjectMember(user, project, "member");

      const taskId = await createTask(project, flow, "Runner Task");
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        taskId,
        projectId: project,
        flowId: flow,
        runKind: "flow",
        runnerId: executor,
        capabilityAgent: "claude",
        runnerSnapshot: testRunnerSnapshot(executor),
        status: "Running",
        flowVersion: "v1.0.0",
        startedAt: new Date(),
      });
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project,
        branch: "maister/runner",
        worktreePath: `/wt/${runId}`,
        parentRepoPath: `/repos/${project}`,
      });

      const row = await railRow(user, project, runId);

      expect(row?.runnerDetail).toEqual({
        agent: "claude",
        model: "claude-sonnet-4-6",
        adapter: "claude",
        provider: "anthropic",
        sidecar: null,
      });
    });

    it("scratch run linked to a task surfaces the KEY-N issue link; scratch name wins; no flow chip", async () => {
      const user = await createUser(
        `rail-scratch-${randomUUID().slice(0, 8)}@test.com`,
      );
      const project = await createProject("Rail Scratch Linked");
      const flow = await createFlow(project);
      const executor = await createExecutor(project);

      await addProjectMember(user, project, "member");

      const taskId = await createTask(project, flow, "Linked Task");
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        runKind: "scratch",
        projectId: project,
        runnerId: executor,
        capabilityAgent: "claude",
        runnerSnapshot: testRunnerSnapshot(executor),
        status: "Running",
        flowVersion: "scratch",
        flowRevision: "manual",
        startedAt: new Date(),
      });
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project,
        branch: "maister/scratch/linked",
        worktreePath: `/wt/${runId}`,
        parentRepoPath: `/repos/${project}`,
      });
      await db.insert(schema.scratchRuns).values({
        runId,
        projectId: project,
        name: "My scratch",
        initialPrompt: "Investigate",
        baseBranch: "main",
        baseCommit: "abc123",
        dialogStatus: "Running",
        createdByUserId: user,
        linkedTaskId: taskId,
      });

      const [proj] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, project));
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId));

      const row = await railRow(user, project, runId);

      expect(row?.issueHref).toBe(
        `/projects/${proj.slug}/tasks/${task.number}`,
      );
      expect(row?.taskNumber).toBe(task.number);
      // The editable scratch name takes precedence over the ticket-derived name.
      expect(row?.name).toBe("My scratch");
      // A scratch run has no flow → the flow chip hides.
      expect(row?.flowRefLabel).toBeNull();
      expect(row?.flowVersion).toBeNull();
    });

    it("agent run with no task and no flow leaves every chip field null and falls back to the branch", async () => {
      const user = await createUser(
        `rail-agent-${randomUUID().slice(0, 8)}@test.com`,
      );
      const project = await createProject("Rail Agent Project");
      const executor = await createExecutor(project);

      await addProjectMember(user, project, "member");

      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        runKind: "agent",
        projectId: project,
        runnerId: executor,
        capabilityAgent: "claude",
        runnerSnapshot: testRunnerSnapshot(executor),
        status: "Running",
        flowVersion: "agent",
        startedAt: new Date(),
      });
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project,
        branch: "maister/agent-branch",
        worktreePath: `/wt/${runId}`,
        parentRepoPath: `/repos/${project}`,
      });

      const row = await railRow(user, project, runId);

      expect(row).toBeDefined();
      expect(row?.flowRefLabel).toBeNull();
      expect(row?.flowVersion).toBeNull();
      expect(row?.taskKey).toBeNull();
      expect(row?.taskNumber).toBeNull();
      expect(row?.issueHref).toBeNull();
      expect(row?.name).toBe("maister/agent-branch");
      expect(row?.runnerDetail).not.toBeNull();
    });
  });
});
