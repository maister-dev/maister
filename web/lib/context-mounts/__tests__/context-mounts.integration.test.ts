/**
 * ADR-157 (T33): read-only sibling-repo context mounts, end to end against REAL
 * git repos. Covers T30's launch wiring (resolve → materialize at the right
 * committish → snapshot), T32's terminal release, D10's L3 dirty check, D11's
 * launching-user consent, the `MAISTER_CONTEXT_MOUNT_ENABLED` kill-switch, and
 * — the ★ trap this whole path layout exists to avoid — proof that live mounts
 * are invisible to the workspace reconciler.
 */
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { contextMountPath } from "@/lib/context-mounts/service";
import { releaseRunContextMounts } from "@/lib/context-mounts/terminal";
import { runWorkspaceReconciliationSweep } from "@/lib/gc/workspace-reconciler";
import { worktreesRoot } from "@/lib/instance-config";
import { runFlow } from "@/lib/flows/runner";
import { commitFile, listWorktrees } from "@/lib/worktree";
import {
  schema,
  seedGraphRun,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => undefined,
}));

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const createdPaths: string[] = [];
const originalRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const originalKillSwitch = process.env.MAISTER_CONTEXT_MOUNT_ENABLED;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "context_mounts_test",
  });
  db = testDatabase.db;
}, 180_000);

afterEach(() => {
  if (originalRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = originalRuntimeRoot;
  if (originalKillSwitch === undefined) {
    delete process.env.MAISTER_CONTEXT_MOUNT_ENABLED;
  } else {
    process.env.MAISTER_CONTEXT_MOUNT_ENABLED = originalKillSwitch;
  }
});

afterAll(async () => {
  await Promise.all(
    createdPaths.map((p) => rm(p, { recursive: true, force: true })),
  );
  await testDatabase?.stop();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

type SiblingRepo = {
  slug: string;
  projectId: string;
  repoPath: string;
  headSha: string;
};

// A throwaway donor repo (mirrors real-git.integration.test.ts). Every commit
// goes through the repo's own commitFile helper, so the suite passes under an
// empty HOME + GIT_CONFIG_NOSYSTEM=1.
async function createSiblingProject(marker: string): Promise<SiblingRepo> {
  const repoPath = await mkdtemp(join(tmpdir(), "maister-sibling-"));

  createdPaths.push(repoPath);
  await git(repoPath, "init", "-q", "-b", "main");
  await writeFile(join(repoPath, "CONTRACT.md"), `${marker}\n`);
  await commitFile({
    repo: repoPath,
    file: "CONTRACT.md",
    message: "contract",
  });

  const headSha = (await git(repoPath, "rev-parse", "HEAD")).trim();
  const projectId = randomUUID();
  const slug = `sib-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `SIB${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    id: projectId,
    slug,
    name: "Sibling",
    repoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/sibling.yaml",
  });

  return { slug, projectId, repoPath, headSha };
}

async function createAdminUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `admin-${id.slice(0, 8)}@maister.local`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });

  return id;
}

function mountDeclaringFlow(siblingSlug: string, ref?: string) {
  return {
    schemaVersion: 1,
    name: "ctx",
    // ADR-157 floor: settings.context_repos requires engine_min >= 3.4.0.
    compat: { engine_min: "3.4.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "read the sibling contract" },
        transitions: { success: "done" },
        settings: {
          context_repos: [{ project: siblingSlug, ...(ref ? { ref } : {}) }],
        },
      },
    ],
  };
}

function makeSupervisorSpy(): SupervisorApi & {
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async () => ({
    sessionId: "sup-1",
    pid: 1,
    acpSessionId: "acp-1",
  }));

  async function* endTurnStream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 1,
      exitCode: 0,
    } as SupervisorEvent;
  }

  return {
    createSession: createSpy as unknown as SupervisorApi["createSession"],
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: vi.fn(() =>
      endTurnStream(),
    ) as unknown as SupervisorApi["streamSession"],
    cancelPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
    createSpy,
  };
}

async function seedMountRun(args: {
  sibling: SiblingRepo;
  createdByUserId: string | null;
  ref?: string;
}): Promise<SeededGraphRun> {
  const seeded = await seedGraphRun(
    db,
    mountDeclaringFlow(args.sibling.slug, args.ref),
    {
      flowRefId: "ctx",
      flowRevision: true,
      run: { createdByUserId: args.createdByUserId },
    },
  );

  createdPaths.push(seeded.runtimeRoot, seeded.worktreePath);
  // contextMountPath() reads runtimeRoot() from the env, so pin it to the same
  // root runFlow is handed.
  process.env.MAISTER_RUNTIME_ROOT = seeded.runtimeRoot;

  return seeded;
}

async function loadSnapshot(runId: string): Promise<ContextMountSnapshot[]> {
  const rows = (await db
    .select({ contextMounts: schema.runs.contextMounts })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<{
    contextMounts: ContextMountSnapshot[] | null;
  }>;

  return rows[0]?.contextMounts ?? [];
}

// `git worktree list` reports REALPATHS, and macOS tmpdirs live under the
// /var → /private/var symlink — so both sides are normalized before comparing.
async function realOf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

async function siblingWorktreePaths(repoPath: string): Promise<string[]> {
  const worktrees = await listWorktrees(repoPath);

  return Promise.all(worktrees.map((w) => realOf(w.path)));
}

describe("context mounts — flow launch, snapshot, and terminal release", () => {
  it("materializes the sibling at its default-branch commit under the run dir and snapshots it", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const expectedPath = contextMountPath(
      seeded.slug,
      seeded.runId,
      sibling.slug,
    );

    // Materialized at the resolved committish, with the donor's content.
    expect(
      (await readFile(join(expectedPath, "CONTRACT.md"), "utf8")).trim(),
    ).toBe("CONTRACT-V1");
    expect((await git(expectedPath, "rev-parse", "HEAD")).trim()).toBe(
      sibling.headSha,
    );

    // Path shape: inside the run dir (a prompt-confinement allow-set member),
    // NEVER under worktreesRoot() (the reconciler's scan scope).
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
    );

    expect(expectedPath.startsWith(`${runDir}/`)).toBe(true);
    expect(expectedPath.startsWith(worktreesRoot())).toBe(false);

    // The launch snapshot is on runs.context_mounts, and it rode the session.
    const snapshot = await loadSnapshot(seeded.runId);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      projectId: sibling.projectId,
      slug: sibling.slug,
      repoPath: sibling.repoPath,
      mountPath: expectedPath,
      committish: sibling.headSha,
    });

    const createArg = api.createSpy.mock.calls[0][0] as {
      contextMounts?: ContextMountSnapshot[];
    };

    expect(createArg.contextMounts).toHaveLength(1);
    expect(createArg.contextMounts?.[0].mountPath).toBe(expectedPath);

    // A Review run keeps its mounts (a rework can re-open the session).
    await releaseRunContextMounts({ runId: seeded.runId, db });
    expect(await siblingWorktreePaths(sibling.repoPath)).toContain(
      await realOf(expectedPath),
    );
  }, 120_000);

  it("resolves an explicit ref to that commit, not the default branch head", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const firstSha = sibling.headSha;

    await writeFile(join(sibling.repoPath, "CONTRACT.md"), "CONTRACT-V2\n");
    await commitFile({
      repo: sibling.repoPath,
      file: "CONTRACT.md",
      message: "v2",
    });
    await git(sibling.repoPath, "tag", "v1", firstSha);

    const userId = await createAdminUser();
    const seeded = await seedMountRun({
      sibling,
      createdByUserId: userId,
      ref: "v1",
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const snapshot = await loadSnapshot(seeded.runId);

    expect(snapshot[0]?.committish).toBe(firstSha);
    expect(
      (
        await readFile(join(snapshot[0].mountPath, "CONTRACT.md"), "utf8")
      ).trim(),
    ).toBe("CONTRACT-V1");
  }, 120_000);

  it("the terminal path deregisters the mount from the SIBLING's worktree list", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const [mount] = await loadSnapshot(seeded.runId);

    expect(await siblingWorktreePaths(sibling.repoPath)).toContain(
      await realOf(mount.mountPath),
    );

    // Flip to a terminal status the way runGraph's Failed arm does, then release.
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, seeded.runId));

    const result = await releaseRunContextMounts({ runId: seeded.runId, db });

    expect(result).toMatchObject({ released: 1, dirty: 0, skippedLive: false });
    expect(await siblingWorktreePaths(sibling.repoPath)).not.toContain(
      await realOf(mount.mountPath),
    );
  }, 120_000);

  it("L3: a mount dirtied out of band WARNs with the offending paths and is still removed", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const [mount] = await loadSnapshot(seeded.runId);

    // Simulate an L2 bypass: write into the read-only mount.
    await writeFile(join(mount.mountPath, "ESCAPED.txt"), "written\n");

    await db
      .update(schema.runs)
      .set({ status: "Crashed" })
      .where(eq(schema.runs.id, seeded.runId));

    const result = await releaseRunContextMounts({ runId: seeded.runId, db });

    expect(result.dirty).toBe(1);
    expect(result.released).toBe(1);
    // Removal proceeds regardless — detached, no branch, nothing legitimate lost.
    expect(await siblingWorktreePaths(sibling.repoPath)).not.toContain(
      await realOf(mount.mountPath),
    );
  }, 120_000);

  it("L3 records quarantine evidence in the ADR-090 shape for an agent-driven run", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const [mount] = await loadSnapshot(seeded.runId);
    const agentId = `agent-${randomUUID().slice(0, 8)}`;

    await db.insert(schema.agents).values({
      id: agentId,
      packageName: "ctx-pkg",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Ctx agent",
      description: "d",
      workspace: "worktree",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      sourcePath: "/tmp/ctx-pkg/maister-agents/ctx.md",
    });
    await db
      .update(schema.runs)
      .set({ status: "Failed", agentId })
      .where(eq(schema.runs.id, seeded.runId));
    await writeFile(join(mount.mountPath, "ESCAPED.txt"), "written\n");

    await releaseRunContextMounts({ runId: seeded.runId, db });

    const agentRows = (await db
      .select({
        quarantinedAt: schema.agents.quarantinedAt,
        quarantineReason: schema.agents.quarantineReason,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))) as Array<{
      quarantinedAt: Date | null;
      quarantineReason: string | null;
    }>;

    expect(agentRows[0].quarantinedAt).not.toBeNull();
    expect(agentRows[0].quarantineReason).toContain(sibling.slug);
    expect(agentRows[0].quarantineReason).toContain("ESCAPED.txt");
  }, 120_000);

  it("refuses the launch with PRECONDITION when the launching user lacks readRepoFiles", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const viewerId = randomUUID();

    await db.insert(schema.users).values({
      id: viewerId,
      email: `viewer-${viewerId.slice(0, 8)}@maister.local`,
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    });

    const seeded = await seedMountRun({ sibling, createdByUserId: viewerId });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const attempts = (await db
      .select({
        nodeId: schema.nodeAttempts.nodeId,
        status: schema.nodeAttempts.status,
        errorCode: schema.nodeAttempts.errorCode,
      })
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.runId, seeded.runId))) as Array<{
      nodeId: string;
      status: string;
      errorCode: string | null;
    }>;
    const implement = attempts.find((a) => a.nodeId === "implement");

    expect(implement?.status).toBe("Failed");
    expect(implement?.errorCode).toBe("PRECONDITION");
    expect(await loadSnapshot(seeded.runId)).toHaveLength(0);
  }, 120_000);

  it("kill-switch off: a declaring node launches with NO mounts and no checkout", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });

    process.env.MAISTER_CONTEXT_MOUNT_ENABLED = "false";

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(await loadSnapshot(seeded.runId)).toHaveLength(0);

    const createArg = api.createSpy.mock.calls[0][0] as {
      contextMounts?: ContextMountSnapshot[];
    };

    expect(createArg.contextMounts ?? []).toHaveLength(0);
    // Nothing checked out: the sibling repo still has only its own root worktree.
    expect(await siblingWorktreePaths(sibling.repoPath)).toHaveLength(1);
  }, 120_000);
});

describe("context mounts stay out of the workspace reconciler's scan scope", () => {
  it("a sweep with live mounts present quarantines nothing and names no mount path", async () => {
    const sibling = await createSiblingProject("CONTRACT-V1");
    const userId = await createAdminUser();
    const seeded = await seedMountRun({ sibling, createdByUserId: userId });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    const [mount] = await loadSnapshot(seeded.runId);

    expect(mount).toBeDefined();

    await db.delete(schema.workspaceReconciliationFindings);

    const summary = await runWorkspaceReconciliationSweep({
      // FIXME(any): the reconciler takes the typed schema client; the shared
      // graph-seed suites use the untyped view.
      database: db as any,
      root: worktreesRoot(),
    });

    expect(summary.quarantined).toBe(0);
    // The load-bearing assertion: a mount is not even a CANDIDATE. The
    // reconciler scans exactly `worktreesRoot()/<slug>/<entry>`; a mount lives
    // under the run dir, so it never enters listCandidates(). Moving mounts under
    // worktreesRoot() is a KNOWN-BREAKING change and this is the guard.
    expect(summary.scanned).toBe(0);

    const findings = (await db
      .select({
        relativePath: schema.workspaceReconciliationFindings.relativePath,
      })
      .from(schema.workspaceReconciliationFindings)) as Array<{
      relativePath: string;
    }>;

    for (const finding of findings) {
      expect(finding.relativePath).not.toContain(sibling.slug);
      expect(finding.relativePath).not.toContain("context");
      expect(mount.mountPath.endsWith(finding.relativePath)).toBe(false);
    }

    // Still mounted — the reconciler must not have touched it.
    expect(await siblingWorktreePaths(sibling.repoPath)).toContain(
      await realOf(mount.mountPath),
    );
  }, 120_000);
});
