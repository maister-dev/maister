import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { Db } from "@/lib/execution-host/db";
import type { ReserveRuntimeObjectPayload } from "@/lib/execution-host/contracts";

import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  prepareAgentRunFinalization,
  finalizeAgentRun,
} from "@/lib/agents/finalization";
import {
  operationalWorkspace,
  inspectOperationalRun,
  assertOperationalDispatchIntegrity,
} from "@/lib/agents/operational-context";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "@/lib/agents/operational-integrity";
import {
  releaseRunContextMounts,
  releaseOperationalContextMounts,
} from "@/lib/context-mounts/terminal";
import * as worktreeModule from "@/lib/worktree";
import { withOperationalContextLock } from "@/lib/context-mounts/operational-lock";
import { prepareOperationalContextMounts } from "@/lib/context-mounts/launch";
import { contextMountPath } from "@/lib/context-mounts/service";
import { runReconcileSweep } from "@/lib/reconcile";
import { startAgentSession } from "@/lib/agents/launch";
import { operationalAgentRuntimePath } from "@/lib/agents/workspace-paths";
import {
  agentProjectLinks,
  executionAssignments,
  executionCommands,
  executionRuntimeObjects,
  runs,
  projects,
  workspaces,
} from "@/lib/db/schema";
import {
  disposeOperationalRun,
  sweepOperationalDispositions,
} from "@/lib/gc/operational-disposition";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";
import { runPlainAgentDirectoryGcSweep } from "@/lib/gc/plain-agent-directory-gc";
import { runEphemeralAgentGcSweep } from "@/lib/gc/ephemeral-agent-gc";
import { runAgentMaterializationCleanupSweep } from "@/lib/gc/agent-materialization-gc";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { reconcileAgentPermissionResume } from "@/lib/agents/permission-resume";
import { sweepExpiredRuntimeObjects } from "@/lib/execution-host/runtime-object-retention";
import { addDetachedWorktree } from "@/lib/worktree";
import { gcAgeDays } from "@/lib/instance-config";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { git, initRepo } from "@/test-support/git-fixture";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
let seam: Awaited<ReturnType<typeof fakeExecutionHosts>>;
const previousRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const previousArchivePush = process.env.MAISTER_GC_ARCHIVE_PUSH;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "operational_disposition",
  });
  db = database.db;
  root = await mkdtemp(path.join(tmpdir(), "operational-disposition-"));
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = root;
  seam = await fakeExecutionHosts(db);
}, 180_000);
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousArchivePush === undefined)
    delete process.env.MAISTER_GC_ARCHIVE_PUSH;
  else process.env.MAISTER_GC_ARCHIVE_PUSH = previousArchivePush;
  await database.pool.query("DELETE FROM execution_commands");
  await database.pool.query("DELETE FROM runs");
  await database.pool.query("DELETE FROM projects");
});
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seed(
  workspace: "none" | "repo_read" | "worktree" = "worktree",
  workspaceRef?: "trigger",
  contextCount = 0,
) {
  const runId = await seedAgentRun(db, {
    runtimeRoot: root,
    workspace,
    operational: true,
    resultContract: null,
    definition: `---\nname: Operation\ndescription: d\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: ${workspace}\n${workspaceRef ? `workspace_ref: ${workspaceRef}\n` : ""}mode: session\nplatform_mcp: false\ntriggers: [manual]\nrisk_tier: standard\n---\nPerform operation.\n`,
  });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(db, run);

  if (context.resourceKind === "ephemeral_checkout")
    await addDetachedWorktree({
      projectRepoPath: context.repoPath,
      worktreePath: context.cwd,
      committish: "HEAD",
    });
  else await mkdir(context.cwd, { recursive: true });
  const mounts: ContextMountSnapshot[] = [];

  if (contextCount > 0) {
    const siblingId = randomUUID();
    const siblingRepo = await initRepo(path.join(root, `sibling-${runId}`));

    await db.insert(projects).values({
      id: siblingId,
      slug: `s-${siblingId}`,
      name: "Sibling",
      repoPath: siblingRepo,
      maisterYamlPath: path.join(siblingRepo, "maister.yaml"),
      taskKey: `S${siblingId.slice(0, 7)}`.toUpperCase(),
    });
    await writeFile(
      path.join(siblingRepo, ".git", "info", "exclude"),
      "ignored.bin\n",
    );
    for (let i = 0; i < contextCount; i += 1) {
      const mount: ContextMountSnapshot = {
        projectId: siblingId,
        slug: `context-${i}`,
        repoPath: siblingRepo,
        mountPath: path.join(root, "worktrees", `context-${runId}-${i}`),
        committish: await git(siblingRepo, "rev-parse", "HEAD"),
      };

      await addDetachedWorktree({
        projectRepoPath: mount.repoPath,
        worktreePath: mount.mountPath,
        committish: mount.committish,
      });
      mounts.push(mount);
    }
  }
  const contextMounts = await Promise.all(
    mounts.map(async (mount) => ({
      mount,
      baseline: await captureOperationalGeneration(
        mount.mountPath,
        await captureOperationalBaseline(mount.mountPath, "ephemeral_checkout"),
        [],
      ),
    })),
  );
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, context.resourceKind),
    [],
  );

  await db
    .update(runs)
    .set({
      operationalIntegrityBaseline: { ...baseline, contextMounts },
      contextMounts: mounts,
    })
    .where(eq(runs.id, runId));
  const runtime = operationalAgentRuntimePath(context.projectSlug, runId);

  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "cache"), "native cache");

  return { runId, context, runtime, mounts };
}
async function row(runId: string) {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0];
}
async function seedUnstartedOperation() {
  const runId = await seedAgentRun(db, {
    runtimeRoot: root,
    workspace: "worktree",
    operational: true,
    resultContract: null,
    definition:
      "---\nname: Operation\ndescription: d\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: worktree\nmode: session\nplatform_mcp: false\ntriggers: [manual]\nrisk_tier: standard\n---\nPerform operation.\n",
  });
  const current = await row(runId);
  const context = await operationalWorkspace(db, current);

  return { runId, current, context };
}
const output = `\`\`\`json maister:output\n${JSON.stringify(operationalSuccessFixture())}\n\`\`\``;

describe("operational disposition through existing lifecycle owners", () => {
  it("serializes cancellation with context creation and refuses effects after cancellation wins", async () => {
    const { runId, context } = await seedUnstartedOperation();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = worktreeModule.addDetachedWorktree;
    const creation = vi
      .spyOn(worktreeModule, "addDetachedWorktree")
      .mockImplementation(async (args) => {
        enter();
        await barrier;

        return original(args);
      });
    const preparing = prepareOperationalContextMounts({
      db,
      runId,
      consumingProjectSlug: context.projectSlug,
      decls: [{ project: context.projectSlug }],
      consent: { kind: "attach-time" },
    });

    await entered;
    const cancellation = finalizeAgentRun(runId, "Abandoned", { db });

    try {
      await cancellation;
      expect((await row(runId)).operationalCleanup).toMatchObject({
        state: "retry",
      });
      await expect(
        lstat(
          contextMountPath(context.projectSlug, runId, context.projectSlug),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await preparing;
      await cancellation;
    }
    await disposeOperationalRun(runId, {
      db,
      now: new Date(Date.now() + 120_000),
    });
    expect((await row(runId)).operationalCleanup).toMatchObject({
      state: "released",
    });
    await expect(
      lstat(contextMountPath(context.projectSlug, runId, context.projectSlug)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const createCount = creation.mock.calls.length;

    await expect(
      prepareOperationalContextMounts({
        db,
        runId,
        consumingProjectSlug: context.projectSlug,
        decls: [{ project: context.projectSlug }],
        consent: { kind: "attach-time" },
      }),
    ).rejects.toMatchObject({
      details: { reason: "operational_context_snapshot_changed" },
    });
    expect(creation).toHaveBeenCalledTimes(createCount);
  });

  it("rechecks cancellation after waiting for the context mutex before creating any checkout", async () => {
    const { runId, context } = await seedUnstartedOperation();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withOperationalContextLock(runId, async () => {
      enter();
      await barrier;
    });

    await entered;
    const creation = vi.spyOn(worktreeModule, "addDetachedWorktree");
    const preparing = prepareOperationalContextMounts({
      db,
      runId,
      consumingProjectSlug: context.projectSlug,
      decls: [{ project: context.projectSlug }],
      consent: { kind: "attach-time" },
    });

    // Both callers share the real mutex. Release it after the terminal DB commit,
    // while preparation still waits, so its post-acquisition check must refuse.
    await expect
      .poll(async () => (await row(runId)).contextMounts?.length)
      .toBe(1);
    const cancellation = finalizeAgentRun(runId, "Abandoned", { db });

    try {
      await expect
        .poll(async () => (await row(runId)).status)
        .toBe("Abandoned");
    } finally {
      release();
      await holder;
    }
    await expect(preparing).rejects.toMatchObject({
      details: { reason: "operational_context_snapshot_changed" },
    });
    await cancellation;
    expect(creation).not.toHaveBeenCalled();
    expect((await row(runId)).operationalCleanup).toMatchObject({
      state: "released",
    });
  });

  it("preserves ownership and cleans a partially materialized initial context set", async () => {
    const { runId, current, context } = await seedUnstartedOperation();
    const siblings: Array<{ slug: string; repo: string }> = [];

    for (let i = 0; i < 2; i += 1) {
      const id = randomUUID();
      const slug = `s-${id}`;
      const repo = await initRepo(path.join(root, slug));

      await db.insert(projects).values({
        id,
        slug,
        name: "Sibling",
        repoPath: repo,
        maisterYamlPath: path.join(repo, "maister.yaml"),
        taskKey: `S${id.slice(0, 7)}`.toUpperCase(),
      });
      siblings.push({ slug, repo });
    }
    await writeFile(
      path.join(siblings[1].repo, ".git", "worktrees"),
      "broken Git administration directory",
    );
    await db
      .update(agentProjectLinks)
      .set({ contextRepos: siblings.map(({ slug }) => ({ project: slug })) })
      .where(eq(agentProjectLinks.agentId, current.agentId!));
    await startAgentSession(runId, { db, executionHosts: seam.hosts });
    const failed = await row(runId);

    expect(failed.contextMounts).toHaveLength(2);
    expect(failed).toMatchObject({
      status: "Failed",
      operationalCleanup: { state: "released" },
    });
    expect(failed.operationalCleanup!.evidenceIds.length).toBeGreaterThan(0);
    for (const sibling of siblings)
      await expect(
        lstat(contextMountPath(context.projectSlug, runId, sibling.slug)),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles an orphan queued operational continuation through its terminal receipt and evidence owner", async () => {
    const seeded = await seed("worktree", undefined, 1);
    const parentId = randomUUID();

    await db.insert(runs).values({
      id: parentId,
      runKind: "flow",
      status: "Done",
      flowVersion: "fixture",
      flowRevision: "fixture",
    });
    await db
      .update(runs)
      .set({ status: "Pending", parentRunId: parentId })
      .where(eq(runs.id, seeded.runId));
    await writeFile(
      path.join(seeded.mounts[0].mountPath, "unexpected.bin"),
      "orphan evidence",
    );
    const result = await runReconcileSweep({ db, executionHosts: seam.hosts });

    expect(result.abandoned).toBe(1);
    expect(await row(seeded.runId)).toMatchObject({
      status: "Abandoned",
      operationalTerminal: { effectiveOutcome: "cancelled" },
      operationalCleanup: { state: "released" },
    });
    expect(
      (await row(seeded.runId)).operationalCleanup!.evidenceIds.length,
    ).toBeGreaterThan(0);
    await expect(lstat(seeded.mounts[0].mountPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses rematerialization of a changed context checkout on continuation", async () => {
    const seeded = await seed("worktree", undefined, 1);
    const current = await row(seeded.runId);

    await db
      .update(agentProjectLinks)
      .set({ contextRepos: [{ project: seeded.context.projectSlug }] })
      .where(eq(agentProjectLinks.agentId, current.agentId!));
    const before = seam.fake.callsOf("createSession").length;

    await writeFile(
      path.join(seeded.mounts[0].mountPath, "unexpected.bin"),
      "continuation evidence",
    );
    await startAgentSession(seeded.runId, { db, executionHosts: seam.hosts });
    expect(seam.fake.callsOf("createSession")).toHaveLength(before);
    expect((await row(seeded.runId)).operationalTerminal).toMatchObject({
      successful: false,
      integrity: "changed",
    });
  });

  it.each(["dirty", "ignored", "committed"] as const)(
    "rejects and preserves %s context source changes before successful terminalization",
    async (change) => {
      const seeded = await seed("worktree", undefined, 1);
      const mount = seeded.mounts[0];
      const fileName = change === "ignored" ? "ignored.bin" : "unexpected.bin";

      await writeFile(path.join(mount.mountPath, fileName), "context evidence");
      if (change === "committed") {
        await git(mount.mountPath, "add", ".");
        await git(
          mount.mountPath,
          "commit",
          "-qm",
          "unexpected context commit",
        );
      }
      expect(
        (await inspectOperationalRun(db, await row(seeded.runId))).verdict,
      ).toBe("changed");
      await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
      const current = await row(seeded.runId);

      expect(current).toMatchObject({
        status: "Failed",
        operationalTerminal: { integrity: "changed" },
        operationalCleanup: { state: "released" },
      });
      const contents: string[] = [];

      for (const objectId of current.operationalCleanup!.evidenceIds) {
        const { content } = await readRuntimeObjectContent({
          db,
          runId: seeded.runId,
          objectId,
          transportForHost: async () => seam.fake.transport,
        });

        contents.push(new TextDecoder().decode(content.bytes));
      }
      expect(
        contents.some((content) =>
          content.includes(Buffer.from("context evidence").toString("base64")),
        ),
      ).toBe(true);
      await expect(lstat(mount.mountPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("fails closed for missing witnesses, missing checkouts and changed ownership before dispatch", async () => {
    const seeded = await seed("worktree", undefined, 1);
    const current = await row(seeded.runId);
    const { contextMounts: _witnesses, ...legacyBaseline } =
      current.operationalIntegrityBaseline!;

    expect(
      await inspectOperationalRun(db, {
        ...current,
        operationalIntegrityBaseline: legacyBaseline,
      }),
    ).toMatchObject({
      verdict: "indeterminate",
      reasonCodes: expect.arrayContaining([
        "operational_context_baseline_missing",
      ]),
    });
    await db
      .update(runs)
      .set({
        contextMounts: [
          { ...seeded.mounts[0], mountPath: seeded.context.repoPath },
        ],
      })
      .where(eq(runs.id, seeded.runId));
    await expect(
      assertOperationalDispatchIntegrity(db, seeded.runId),
    ).rejects.toMatchObject({
      details: {
        reasons: expect.arrayContaining([
          "operational_context_snapshot_changed",
        ]),
      },
    });
    await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
    expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
      state: "retry",
      errorCode: "operational_context_snapshot_changed",
    });
    expect((await lstat(seeded.context.repoPath)).isDirectory()).toBe(true);
    expect((await lstat(seeded.mounts[0].mountPath)).isDirectory()).toBe(true);
    await rm(seeded.mounts[0].mountPath, { recursive: true });
    expect((await inspectOperationalRun(db, current)).verdict).toBe(
      "indeterminate",
    );
  });

  it("refuses successful release when Git no longer recognizes a retained context directory", async () => {
    const seeded = await seed("worktree", undefined, 1);
    const mount = seeded.mounts[0];
    const gitDir = (await readFile(path.join(mount.mountPath, ".git"), "utf8"))
      .trim()
      .replace(/^gitdir: /, "");

    await rm(gitDir, { recursive: true });
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Failed", {
      db,
    });

    await db.transaction((tx) => prepared.apply(tx));
    await expect(
      releaseRunContextMounts({ runId: seeded.runId, db }),
    ).rejects.toMatchObject({
      details: { reason: "operational_context_owner_required" },
    });
    await expect(
      releaseOperationalContextMounts({
        runId: seeded.runId,
        mounts: seeded.mounts,
      }),
    ).rejects.toMatchObject({
      details: { reason: "operational_context_cleanup_failed" },
    });
    expect((await lstat(mount.mountPath)).isDirectory()).toBe(true);
  });

  it("retries a failed context removal without misreporting release or rejecting already removed siblings", async () => {
    const seeded = await seed("worktree", undefined, 2);
    const [first, locked] = seeded.mounts;

    await git(locked.repoPath, "worktree", "lock", locked.mountPath);
    await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
    const current = await row(seeded.runId);

    expect(current.status).toBe("Done");
    expect(current.operationalCleanup).toMatchObject({
      state: "retry",
      attempts: 1,
      releasedAt: null,
    });
    await expect(lstat(first.mountPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(locked.mountPath)).isDirectory()).toBe(true);
    await git(locked.repoPath, "worktree", "unlock", locked.mountPath);
    await disposeOperationalRun(seeded.runId, {
      db,
      hosts: seam.hosts,
      now: new Date(Date.now() + 120_000),
    });
    expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
      state: "released",
      attempts: 2,
    });
    await expect(lstat(locked.mountPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["none", "worktree"] as const)(
    "IT-OPL-05 disposes successful %s execution and its native home after commit",
    async (workspace) => {
      const seeded = await seed(workspace);

      await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
      expect((await row(seeded.runId)).status).toBe("Done");
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(seeded.runtime)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
        state: "released",
        removedAt: expect.any(String),
        releasedAt: expect.any(String),
      });
      expect(
        await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
      ).toBe("skipped");
    },
  );

  it.each([undefined, "trigger"] as const)(
    "IT-OPL-06 disposes repo_read resource (%s) without removing its parent",
    async (ref) => {
      const seeded = await seed("repo_read", ref);
      const before = await git(seeded.context.repoPath, "rev-parse", "HEAD");

      await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
      expect((await row(seeded.runId)).status).toBe("Done");
      expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
        "released",
      );
      expect((await lstat(seeded.context.repoPath)).isDirectory()).toBe(true);
      expect(await git(seeded.context.repoPath, "rev-parse", "HEAD")).toBe(
        before,
      );
      if (ref)
        await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it("IT-OPL-07 IT-EDGE-OPL-07 preserves ignored binary bytes before deleting unexpected source, without minting an assignment", async () => {
    const seeded = await seed();
    const remote = path.join(root, `diagnostic-remote-${seeded.runId}.git`);

    await git(root, "init", "--bare", remote);
    await git(seeded.context.repoPath, "remote", "add", "origin", remote);
    process.env.MAISTER_GC_ARCHIVE_PUSH = "true";
    const bytes = Buffer.from([0, 255, 128, 1, 2, 0]);

    await writeFile(
      path.join(seeded.context.cwd, ".gitignore"),
      "ignored.bin\n",
    );
    await writeFile(path.join(seeded.context.cwd, "ignored.bin"), bytes);
    await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
    const current = await row(seeded.runId);

    expect(current).toMatchObject({
      status: "Failed",
      operationalTerminal: { integrity: "changed", successful: false },
      operationalCleanup: { state: "released" },
    });
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const assignments = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.runId, seeded.runId));

    expect(assignments).toHaveLength(1);
    expect(assignments[0].state).toBe("released");
    const ids = current.operationalCleanup!.evidenceIds;

    expect(ids.length).toBeGreaterThan(1);
    const objects = await db
      .select()
      .from(executionRuntimeObjects)
      .where(eq(executionRuntimeObjects.runId, seeded.runId));

    expect(
      objects
        .filter((object) => ids.includes(object.id))
        .every((object) => object.state === "available"),
    ).toBe(true);
    const records: Array<{ path?: string; bytes?: string }> = [];

    for (const objectId of ids.slice(1)) {
      const { content } = await readRuntimeObjectContent({
        db,
        runId: seeded.runId,
        objectId,
        transportForHost: async () => seam.fake.transport,
      });

      records.push(
        ...new TextDecoder()
          .decode(content.bytes)
          .trim()
          .split("\n")
          .map((line: string) => JSON.parse(line)),
      );
    }
    expect(
      Buffer.concat(
        records
          .filter((record) => record.path === "ignored.bin" && record.bytes)
          .map((record) => Buffer.from(record.bytes!, "base64")),
      ),
    ).toEqual(bytes);
    await sweepExpiredRuntimeObjects({
      db,
      hosts: seam.hosts,
      now: new Date(current.endedAt!.getTime() + 60_000),
    });
    expect(
      (
        await db
          .select()
          .from(executionRuntimeObjects)
          .where(eq(executionRuntimeObjects.runId, seeded.runId))
      )
        .filter((object) => ids.includes(object.id))
        .every((object) => object.state === "available"),
    ).toBe(true);
    const expired = await sweepExpiredRuntimeObjects({
      db,
      hosts: seam.hosts,
      now: new Date(
        current.endedAt!.getTime() + (gcAgeDays() + 1) * 86_400_000,
      ),
    });

    expect(expired.scanned).toBeGreaterThan(0);
    expect(expired.failed).toBe(0);
    expect(await git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  it("IT-OPL-05 legacy cleaners cannot bypass crash hold or retry exhaustion", async () => {
    const seeded = await seed();

    await finalizeAgentRun(seeded.runId, "Crashed", { db });
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "retained",
    );
    await runWorkspaceGcSweep({ db });
    await runPlainAgentDirectoryGcSweep();
    await runEphemeralAgentGcSweep({ db });
    await runAgentMaterializationCleanupSweep({ db });
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("skipped");
  });

  it("IT-OPL-03 recognizes a concurrent operation's recorded local archive without trusting an unrecorded ref", async () => {
    const live = await seed();
    const sibling = await seed();
    const retained = await prepareAgentRunFinalization(
      sibling.runId,
      "Crashed",
      { db },
    );

    await db.transaction((tx) => retained.apply(tx));
    const archive = `archive/${sibling.runId}`;
    const source = await row(live.runId);
    const sha = source.operationalIntegrityBaseline!.head!;

    await git(live.context.repoPath, "branch", archive, sha);
    expect((await inspectOperationalRun(db, source)).verdict).toBe(
      "indeterminate",
    );
    await db
      .update(runs)
      .set({ projectId: source.projectId })
      .where(eq(runs.id, sibling.runId));
    await db
      .update(workspaces)
      .set({
        projectId: source.projectId!,
        archivedBranch: archive,
        archivedCommit: sha,
        archivedAt: new Date(),
        preservationOutcome: "snapshot_created",
      })
      .where(eq(workspaces.runId, sibling.runId));
    expect((await inspectOperationalRun(db, source)).verdict).toBe("clean");
    const forged = await git(
      live.context.repoPath,
      "-c",
      "user.name=Operation",
      "-c",
      "user.email=operation@example.test",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "unrecorded archive replacement",
    );

    await git(
      live.context.repoPath,
      "update-ref",
      `refs/heads/${archive}`,
      forged.trim(),
    );
    expect((await inspectOperationalRun(db, source)).verdict).toBe(
      "indeterminate",
    );
  });

  it("IT-OPL-07 released assignments admit only bounded run-owned diagnostic evidence while preserving", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    const current = await row(seeded.runId);

    await db
      .update(runs)
      .set({
        operationalCleanup: {
          ...current.operationalCleanup!,
          state: "preserving",
        },
      })
      .where(eq(runs.id, seeded.runId));
    const client = await seam.hosts.forAssignment({
      id: current.executionAssignmentId!,
    });
    const previousReservations = seam.fake.callsOf(
      "reserveRuntimeObject",
    ).length;
    const reservation = {
      kind: "diagnostic",
      logicalName: "operational-diagnosis-bounded",
      mimeType: "application/x-ndjson",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      generation: 1,
      retentionClass: "run",
      expiresAt: null,
    } satisfies Omit<ReserveRuntimeObjectPayload, "objectId">;

    for (const change of [
      { kind: "generated_artifact" as const },
      { logicalName: "ordinary-output" },
      {
        retentionClass: "ephemeral" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { sizeBytes: 25 * 1024 * 1024 + 1 },
    ]) {
      await expect(
        client.reserveRuntimeObject({
          ...reservation,
          ...change,
          objectId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "assignment_fenced" },
      });
    }
    const admitted = await client.reserveRuntimeObject({
      ...reservation,
      objectId: crypto.randomUUID(),
    });

    expect(admitted.state).toBe("pending");
    expect(seam.fake.callsOf("reserveRuntimeObject")).toHaveLength(
      previousReservations + 1,
    );
    await db
      .update(runs)
      .set({
        operationalCleanup: { ...current.operationalCleanup!, state: "armed" },
      })
      .where(eq(runs.id, seeded.runId));
    await expect(
      client.reserveRuntimeObject({
        ...reservation,
        objectId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
  });

  it("IT-OPL-06 an interrupted parallel reissue with conflicting source generations becomes actionable without replay", async () => {
    const seeded = await seed();

    await database.pool.query(
      "UPDATE runs SET status='NeedsInputIdle' WHERE id=$1",
      [seeded.runId],
    );
    for (const ordinal of [1, 2]) {
      await database.pool.query(
        `INSERT INTO hitl_requests(id,run_id,step_id,kind,schema,prompt) VALUES ($1,$2,'agent','permission',$3::jsonb,'Retained parallel permission')`,
        [
          `mixed-permission-${seeded.runId}-${ordinal}`,
          seeded.runId,
          JSON.stringify({
            requestId: `request-${ordinal}`,
            supervisorSessionId: `session-${ordinal}`,
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            toolCall: { toolCallId: `tool-${ordinal}`, title: "Read provider" },
            agentPrompt: {
              version: 1,
              commandId: `command-${ordinal}`,
              turnId: `turn-${ordinal}`,
              promptOrdinal: ordinal,
              assignmentId: `assignment-${ordinal}`,
              incarnationId: `incarnation-${ordinal}`,
            },
          }),
        ],
      );
    }
    await reconcileAgentPermissionResume(db, seeded.runId, seam.fake.transport);
    expect(await row(seeded.runId)).toMatchObject({
      status: "Crashed",
      operationalTerminal: { successful: false, cause: "operational_crashed" },
      operationalCleanup: { state: "retained" },
    });
    expect(seam.fake.callsOf("deliverInput")).toHaveLength(0);
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
  });

  it("IT-EDGE-OPL-06 fences a second cleaner and refuses stale completion after lease expiry", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = disposeOperationalRun(seeded.runId, {
      db,
      hosts: seam.hosts,
      preserve: async () => {
        enter();
        await blocked;

        return { ok: true, preservationOutcome: "not_needed" };
      },
    });

    await entered;
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("skipped");
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
    await db
      .update(workspaces)
      .set({ lifecycleOperationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workspaces.runId, seeded.runId));
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("released");
    resume();
    expect(await first).toBe("deferred");
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "released",
    );
  });

  it("IT-EDGE-OPL-05 converges after local removal precedes its cleanup receipt without recreating source", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    await database.pool.query(
      `CREATE FUNCTION refuse_operational_removed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operational_cleanup->>'state' = 'removed' THEN RAISE EXCEPTION 'fixture receipt boundary'; END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      "CREATE TRIGGER refuse_operational_removed_receipt BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION refuse_operational_removed_receipt()",
    );
    try {
      expect(
        await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
      ).toBe("deferred");
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
        state: "retry",
        removedAt: null,
      });
    } finally {
      await database.pool.query(
        "DROP TRIGGER refuse_operational_removed_receipt ON runs",
      );
      await database.pool.query(
        "DROP FUNCTION refuse_operational_removed_receipt()",
      );
    }
    const retry = await row(seeded.runId);

    expect(
      await disposeOperationalRun(seeded.runId, {
        db,
        hosts: seam.hosts,
        now: new Date(retry.operationalCleanup!.dueAt!),
      }),
    ).toBe("released");
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await row(seeded.runId)).operationalCleanup?.removedAt,
    ).not.toBeNull();
  });

  it("IT-EDGE-OPL-05 host release acknowledgement loss converges without another assignment or recreated files", async () => {
    const seeded = await seed();
    const initial = await row(seeded.runId);
    const client = await seam.hosts.forAssignment({
      id: initial.executionAssignmentId!,
    });

    await client.ensureWorkspace();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    seam.fake.loseResponseOnce("releaseWorkspace");
    const first = await disposeOperationalRun(seeded.runId, {
      db,
      hosts: seam.hosts,
    });

    if (first === "deferred") {
      const recovery = await recoverExecutionCommands({
        db,
        transport: seam.fake.transport,
        graceMs: 0,
      });

      expect(recovery.errors).toEqual([]);
      const retry = (await row(seeded.runId)).operationalCleanup!;

      expect(retry.removedAt).not.toBeNull();
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await disposeOperationalRun(seeded.runId, {
          db,
          hosts: seam.hosts,
          now: new Date(retry.dueAt!),
        }),
      ).toBe("released");
    } else expect(first).toBe("released");
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "released",
    );
    expect(
      await db
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.runId, seeded.runId)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.runId, seeded.runId))
      ).filter((command) => command.kind === "workspace.adopt"),
    ).toHaveLength(1);
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("IT-OPL-08 rotates a bounded disposition cursor past a poison run", async () => {
    const template = await seed("none");
    const prepared = await prepareAgentRunFinalization(template.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    const original = await row(template.runId);

    await db.delete(runs).where(eq(runs.id, template.runId));
    const inserts = Array.from({ length: 103 }, (_, index) => ({
      id: `zz-fair-${String(index).padStart(4, "0")}`,
      projectId: original.projectId,
      runKind: "agent" as const,
      agentKind: "operational" as const,
      agentWorkspace: "none" as const,
      status: "Done",
      flowVersion: "agent",
      endedAt: new Date(),
      resultContract: original.resultContract,
      operationalTerminal: {
        ...original.operationalTerminal!,
        status: "Abandoned" as const,
        effectiveOutcome: "cancelled" as const,
        successful: false,
        validation: "unchecked" as const,
        resultRevision: null,
      },
      operationalCleanup: {
        ...original.operationalCleanup!,
        workspace: "none" as const,
        resourceKind: "plain_directory" as const,
      },
    }));

    // Missing physical resources are safe to dispose; the first corrupted
    // launch digest must consume its own bounded attempt and not own the page.
    await db.insert(runs).values(
      inserts.map((item, index) => ({
        ...item,
        status: "Abandoned" as const,
        resultContract:
          index === 0
            ? { ...item.resultContract!, sha256: "0".repeat(64) }
            : item.resultContract,
      })),
    );
    const first = await sweepOperationalDispositions({ db, hosts: seam.hosts });
    const second = await sweepOperationalDispositions({
      db,
      hosts: seam.hosts,
    });

    expect(first.scanned).toBe(100);
    expect(second.scanned).toBe(3);
    expect((await row("zz-fair-0000")).operationalCleanup).toMatchObject({
      state: "retry",
      attempts: 1,
    });
    expect((await row("zz-fair-0102")).operationalCleanup?.state).toBe(
      "released",
    );
  });

  it("IT-EDGE-OPL-05 preserves before removal, bounds retries and leaves business completion unchanged", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    let now = new Date();

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await disposeOperationalRun(seeded.runId, {
          db,
          hosts: seam.hosts,
          now,
          preserve: async () => ({
            ok: false,
            failureReason: "workspace_preservation_failed",
          }),
        }),
      ).toBe("deferred");
      const current = await row(seeded.runId);

      expect(current.status).toBe("Done");
      expect(current.operationalCleanup).toMatchObject({
        attempts: attempt,
        state: attempt === 5 ? "exhausted" : "retry",
        errorCode: "workspace_preservation_failed",
      });
      expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
      if (current.operationalCleanup?.dueAt)
        now = new Date(current.operationalCleanup.dueAt);
    }
    expect(
      await disposeOperationalRun(seeded.runId, {
        db,
        hosts: seam.hosts,
        now: new Date(now.getTime() + 86_400_000),
      }),
    ).toBe("skipped");
    expect(
      (
        await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.runId, seeded.runId))
      )[0].removedAt,
    ).toBeNull();
    expect(
      (await sweepOperationalDispositions({ db, hosts: seam.hosts, now }))
        .released,
    ).toBe(0);
  });
});
