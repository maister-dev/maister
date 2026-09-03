// ADR-165 T3.5 — workspace adoption client (K1–K6) against a REAL supervisor
// (the D7 matrix inspects real git state) plus the fake for the no-loop rule.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  getAssignmentById,
  mintAssignment,
} from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  seedLocalHost,
  seedLocalPackage,
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import {
  createFakeExecutionHost,
  fakeBoundClient,
  unknownWorkspaceError,
} from "@/test-support/fake-execution-host";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;
let previousWorktreesRoot: string | undefined;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

async function mint(runId: string) {
  return db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );
}

async function adoptRows(runId: string) {
  return (await listCommandsForRun(db, runId)).filter(
    (c) => c.kind === "workspace.adopt",
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_adoption_test",
  });
  db = testDatabase.db as unknown as Db;
  sup = await startRealSupervisor({ fixtureArgs: ["--hang"] });
  restoreUrl = useRealSupervisorUrl(sup.url);
  // Agent workdirs derive from the instance worktrees root — point it inside
  // the child's adoption roots.
  previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = path.join(sup.runtimeRoot, "worktrees");
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
  const probe = await hosts.forRun(
    await seedRun(testDatabase.db, { projectId: project.id }),
    { reason: "launch" },
  );

  hostId = probe.host.id;
}, 180_000);

afterAll(async () => {
  if (previousWorktreesRoot === undefined) {
    delete process.env.MAISTER_WORKTREES_ROOT;
  } else {
    process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  }
  restoreUrl();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("workspace adoption (real supervisor)", () => {
  it("K1: a flow run adopts its worktree as git_worktree once; the handle is stored and re-used", async () => {
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "flow",
    });
    const worktreePath = await addWorktree(
      project.repoPath,
      `${sup.runtimeRoot}/wt-k1`,
      "maister/k1",
    );

    await seedWorkspace(testDatabase.db, {
      runId,
      projectId: project.id,
      worktreePath,
      parentRepoPath: project.repoPath,
    });
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);

    const first = await client.ensureWorkspace();
    const [adopt] = await adoptRows(runId);

    expect(first).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(adopt.state).toBe("succeeded");
    expect(adopt.payload).toMatchObject({
      kind: "git_worktree",
      path: worktreePath,
      repoPath: project.repoPath,
      projectSlug: project.slug,
    });
    expect(
      (await getAssignmentById(db, assignment.id))?.executionWorkspaceId,
    ).toBe(first);

    const second = await client.ensureWorkspace();

    expect(second).toBe(first);
    expect(await adoptRows(runId)).toHaveLength(1);

    const record = await hosts.local().getWorkspace(first);

    expect(record).toMatchObject({
      runId,
      kind: "git_worktree",
      releasedAt: null,
    });
  }, 120_000);

  it("K2: a local-package assistant adopts the package working dir as directory", async () => {
    const workingDir = path.join(sup.runtimeRoot, "pkg-k2");

    await mkdir(workingDir, { recursive: true });
    const localPackageId = await seedLocalPackage(testDatabase.db, {
      workingDir,
    });
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "scratch",
      localPackageId,
    });
    const client = await hosts.forAssignment(await mint(runId));

    await client.ensureWorkspace();
    const [adopt] = await adoptRows(runId);

    expect(adopt.state).toBe("succeeded");
    expect(adopt.payload).toMatchObject({
      kind: "directory",
      path: workingDir,
    });
    expect(adopt.payload).not.toHaveProperty("repoPath");
  }, 60_000);

  it("K3: a repo_read agent adopts the project checkout as repo_checkout", async () => {
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "agent",
      agentWorkspace: "repo_read",
    });
    const client = await hosts.forAssignment(await mint(runId));

    await client.ensureWorkspace();
    const [adopt] = await adoptRows(runId);

    expect(adopt.state).toBe("succeeded");
    expect(adopt.payload).toMatchObject({
      kind: "repo_checkout",
      path: project.repoPath,
      repoPath: project.repoPath,
    });
  }, 60_000);

  it("K4: an agent with workspace none adopts its workdir as directory", async () => {
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "agent",
      agentWorkspace: "none",
    });
    const { agentWorkdirPath } = await import("@/lib/agents/launch");
    const workdir = agentWorkdirPath(project.slug, runId);

    await mkdir(workdir, { recursive: true });
    const client = await hosts.forAssignment(await mint(runId));

    await client.ensureWorkspace();
    const [adopt] = await adoptRows(runId);

    expect(adopt.state).toBe("succeeded");
    expect(adopt.payload).toMatchObject({ kind: "directory", path: workdir });
  }, 60_000);

  it("K5: a wiped host handle store → create meets unknown_workspace → ONE re-adopt → create succeeds; a second unknown_workspace surfaces", async () => {
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "flow",
    });
    const worktreePath = await addWorktree(
      project.repoPath,
      `${sup.runtimeRoot}/wt-k5`,
      "maister/k5",
    );

    await seedWorkspace(testDatabase.db, {
      runId,
      projectId: project.id,
      worktreePath,
      parentRepoPath: project.repoPath,
    });
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const before = await client.ensureWorkspace();
    const health = await hosts.local().health();

    expect(health.kind).toBe("ready");
    if (health.kind !== "ready") return;

    // Wipe the state dir; restart with the SAME identity pinned so only the
    // handles are lost (an identity change would be X-EH-02, not K5).
    await rm(sup.stateDir, { recursive: true, force: true });
    sup = await sup.restart({
      env: { MAISTER_EXECUTION_HOST_KEY: health.identity!.hostKey },
    });
    resetResolverForTests();

    expect(await hosts.local().getWorkspace(before)).toBeNull();

    const created = await client.createSession(CREATE_PAYLOAD);

    expect(created.hostSessionId).toBeTruthy();
    const adopts = await adoptRows(runId);
    const creates = (await listCommandsForRun(db, runId)).filter(
      (c) => c.kind === "session.create",
    );

    expect(adopts.map((a) => a.state)).toEqual(["succeeded", "succeeded"]);
    expect(creates.map((c) => c.state).sort()).toEqual(["failed", "succeeded"]);
    expect(creates.find((c) => c.state === "failed")?.lastError).toMatchObject({
      reason: "unknown_workspace",
    });
    const after = (await getAssignmentById(db, assignment.id))!
      .executionWorkspaceId;

    expect(after).not.toBe(before);
    expect(await hosts.local().getWorkspace(after!)).not.toBeNull();

    // The no-loop rule, over the fake: two unknown_workspace answers in a
    // row surface the PRECONDITION after exactly one re-adopt.
    const fake = createFakeExecutionHost();
    // The fake identity must be the ONE active local host (partial unique
    // index) — retire the real row for the remainder of this case first.
    const { executionHosts } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    await db
      .update(executionHosts)
      .set({ retiredAt: new Date() })
      .where(eq(executionHosts.id, hostId));
    const fakeHost = await seedLocalHost(testDatabase.db, {
      hostKey: fake.identity.hostKey,
      bootId: fake.identity.bootId,
    });
    const fakeRunId = await seedRun(testDatabase.db, { projectId: project.id });

    await seedWorkspace(testDatabase.db, {
      runId: fakeRunId,
      projectId: project.id,
      worktreePath: `/tmp/eh/${fakeRunId}`,
      parentRepoPath: "/tmp/eh/repo",
    });
    const fakeAssignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId: fakeRunId,
        hostId: fakeHost.id,
        reason: "launch",
      }),
    );
    const { client: fakeClient } = await fakeBoundClient({
      db,
      fake,
      assignment: fakeAssignment,
    });

    fake.failOnce("createSession", unknownWorkspaceError());
    fake.failOnce("createSession", unknownWorkspaceError());

    await expect(fakeClient.createSession(CREATE_PAYLOAD)).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        err.details?.reason === "unknown_workspace",
    );
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(2);
    expect(fake.callsOf("createSession")).toHaveLength(2);

    // Restore: retire the fake BEFORE un-retiring the real row (one active).
    await db
      .update(executionHosts)
      .set({ retiredAt: new Date() })
      .where(eq(executionHosts.id, fakeHost.id));
    await db
      .update(executionHosts)
      .set({ retiredAt: null })
      .where(eq(executionHosts.id, hostId));
    resetResolverForTests();
  }, 180_000);

  it("K6: the run's context_mounts snapshot travels in the adopt payload", async () => {
    const siblingRepo = await initRepo(`${sup.runtimeRoot}/sibling`);
    const mountPath = path.join(sup.runtimeRoot, "mounts", "sibling");

    await mkdir(mountPath, { recursive: true });
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      runKind: "flow",
      contextMounts: [
        {
          projectId: project.id,
          slug: "sibling",
          repoPath: siblingRepo,
          mountPath,
          committish: "0123456789abcdef0123456789abcdef01234567",
          ref: "main",
        },
      ],
    });
    const worktreePath = await addWorktree(
      project.repoPath,
      `${sup.runtimeRoot}/wt-k6`,
      "maister/k6",
    );

    await seedWorkspace(testDatabase.db, {
      runId,
      projectId: project.id,
      worktreePath,
      parentRepoPath: project.repoPath,
    });
    const client = await hosts.forAssignment(await mint(runId));

    await client.ensureWorkspace();
    const [adopt] = await adoptRows(runId);

    expect(adopt.state).toBe("succeeded");
    expect(adopt.payload).toMatchObject({
      contextMounts: [
        expect.objectContaining({
          slug: "sibling",
          mountPath,
          repoPath: siblingRepo,
        }),
      ],
    });
  }, 60_000);
});
