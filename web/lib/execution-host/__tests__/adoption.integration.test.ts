// ADR-166 T3.5 — workspace adoption client (K1–K7) against a REAL supervisor
// (the D7 matrix inspects real git state) plus the fake for the no-loop rule
// and the released-handle re-adoption.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { AdoptWorkspaceWire } from "@/lib/execution-host/contracts";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executionHosts } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  getAssignmentById,
  mintAssignment,
} from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
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
  type FakeExecutionHost,
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
// The adopt payloads as SENT (E-EH-12: the ledger row keeps only the
// projection — kind, slug, mount count — so the path evidence is the wire).
const sentAdopts: AdoptWorkspaceWire[] = [];

function lastAdopt(runId: string): AdoptWorkspaceWire {
  const sent = sentAdopts.filter((p) => p.runId === runId);

  if (sent.length === 0) throw new Error(`no adopt sent for run ${runId}`);

  return sent[sent.length - 1];
}

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

async function mint(runId: string) {
  return db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );
}

// The fake identity must be the ONE active local host (partial unique index):
// the real row is retired for the duration of `fn` and restored afterwards
// (retire the fake BEFORE un-retiring the real row — one active).
async function withFakeLocalHost<T>(
  fake: FakeExecutionHost,
  fn: (fakeHost: { id: string; hostKey: string }) => Promise<T>,
): Promise<T> {
  await db
    .update(executionHosts)
    .set({ retiredAt: new Date() })
    .where(eq(executionHosts.id, hostId));
  const fakeHost = await seedLocalHost(testDatabase.db, {
    hostKey: fake.identity.hostKey,
    bootId: fake.identity.bootId,
  });

  try {
    return await fn(fakeHost);
  } finally {
    await db
      .update(executionHosts)
      .set({ retiredAt: new Date() })
      .where(eq(executionHosts.id, fakeHost.id));
    await db
      .update(executionHosts)
      .set({ retiredAt: null })
      .where(eq(executionHosts.id, hostId));
    resetResolverForTests();
  }
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
  const wire = createLocalDirectTransport();

  hosts = createExecutionHosts({
    db,
    transport: {
      ...wire,
      adoptWorkspace(envelope, opts) {
        sentAdopts.push(envelope.payload);

        return wire.adoptWorkspace(envelope, opts);
      },
    },
  });
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
    expect(lastAdopt(runId)).toEqual({
      runId,
      projectSlug: project.slug,
      kind: "git_worktree",
      path: worktreePath,
      repoPath: project.repoPath,
    });
    // The ledger keeps the projection only — never the path.
    expect(adopt.payload).toEqual({
      runId,
      projectSlug: project.slug,
      kind: "git_worktree",
      contextMountCount: 0,
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
    expect(lastAdopt(runId)).toMatchObject({
      kind: "directory",
      path: workingDir,
    });
    expect(lastAdopt(runId)).not.toHaveProperty("repoPath");
    expect(adopt.payload).toMatchObject({ kind: "directory" });
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
    expect(lastAdopt(runId)).toMatchObject({
      kind: "repo_checkout",
      path: project.repoPath,
      repoPath: project.repoPath,
    });
    expect(adopt.payload).toMatchObject({ kind: "repo_checkout" });
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
    expect(lastAdopt(runId)).toMatchObject({
      kind: "directory",
      path: workdir,
    });
    expect(adopt.payload).toMatchObject({ kind: "directory" });
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

    await withFakeLocalHost(fake, async (fakeHost) => {
      const fakeRunId = await seedRun(testDatabase.db, {
        projectId: project.id,
      });

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
    });
  }, 180_000);

  it("K7: create answers workspace_released → ONE re-adopt → create succeeds under a NEW handle", async () => {
    const fake = createFakeExecutionHost();

    await withFakeLocalHost(fake, async (fakeHost) => {
      const runId = await seedRun(testDatabase.db, { projectId: project.id });

      await seedWorkspace(testDatabase.db, {
        runId,
        projectId: project.id,
        worktreePath: `/tmp/eh/${runId}`,
        parentRepoPath: "/tmp/eh/repo",
      });
      const assignment = await db.transaction((tx) =>
        mintAssignment(tx as unknown as Db, {
          runId,
          hostId: fakeHost.id,
          reason: "launch",
        }),
      );
      const { client } = await fakeBoundClient({ db, fake, assignment });
      const before = await client.ensureWorkspace();

      // The ADR-141 reopen: the handle was released (worktree removed) and
      // the path re-created — the stored handle no longer answers.
      expect(await client.releaseWorkspace(before)).toEqual({ released: true });

      const created = await client.createSession(CREATE_PAYLOAD);

      expect(created.hostSessionId).toBeTruthy();
      const adopts = await adoptRows(runId);
      const creates = (await listCommandsForRun(db, runId)).filter(
        (c) => c.kind === "session.create",
      );

      expect(adopts.map((a) => a.state)).toEqual(["succeeded", "succeeded"]);
      expect(creates.map((c) => c.state)).toEqual(["failed", "succeeded"]);
      expect(creates[0].lastError).toMatchObject({
        reason: "workspace_released",
      });
      const after = (await getAssignmentById(db, assignment.id))!
        .executionWorkspaceId!;

      expect(after).not.toBe(before);
      expect(fake.workspaces.get(before)?.releasedAt).not.toBeNull();
      expect(fake.workspaces.get(after)?.releasedAt).toBeNull();
      expect(fake.sessions.get(created.sessionId)?.executionWorkspaceId).toBe(
        after,
      );
    });
  }, 60_000);

  it("K6: the run's context_mounts snapshot travels in the adopt payload", async () => {
    const siblingRepo = await initRepo(`${sup.runtimeRoot}/sibling`);

    // The host validates every mount as a git checkout it can read: the
    // materialized mount is a linked worktree of the sibling repo.
    await mkdir(path.join(sup.runtimeRoot, "mounts"), { recursive: true });
    const mountPath = await addWorktree(
      siblingRepo,
      path.join(sup.runtimeRoot, "mounts", "sibling"),
      "ctx/sibling",
    );
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
    expect(lastAdopt(runId)).toMatchObject({
      contextMounts: [
        expect.objectContaining({
          slug: "sibling",
          mountPath,
          repoPath: siblingRepo,
        }),
      ],
    });
    // The ledger keeps the count, never the mount paths.
    expect(adopt.payload).toMatchObject({ contextMountCount: 1 });
    expect(JSON.stringify(adopt.payload)).not.toContain(mountPath);
  }, 60_000);
});
