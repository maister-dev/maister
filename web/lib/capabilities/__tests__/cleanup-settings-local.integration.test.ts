/**
 * Capability-settings lifecycle integration coverage. The settings protocol is
 * run-owned: the manifest leases the capability profile and its settings
 * artifacts; terminal restore reclaims settings exactly once before dropping
 * those leases. An unleased marker is never sufficient authority to mutate a
 * file. The harness seeds real Postgres rows and a real worktree so node cleanup
 * and shared-settings cleanup exercise the production boundary together.
 */
import type { MaterializationPlan } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm as fsRm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  capabilityMaterializationRootPath,
  materializeCapabilityProfile,
  SETTINGS_OWNED_MARKER_SUFFIX,
} from "@/lib/capabilities/materialize";
import { materializeWithAgentLease } from "@/lib/agents/materialization-manifest";
import {
  capabilitySettingsMarker,
  capabilitySettingsOperation,
  SETTINGS_BACKUP_RELATIVE,
  SETTINGS_OPERATION_RELATIVE,
  SETTINGS_RELATIVE,
} from "@/lib/capabilities/settings-ownership";
import { resolveCapabilityProfile } from "@/lib/capabilities/resolver";
import {
  cleanupNodeMaterialization,
  cleanupRunMaterializations,
  reclaimWorktreeSettings,
} from "@/lib/capabilities/cleanup";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cleanup_settings_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

// A minimal but VALID MaterializationPlan body (mirrors the T4.3 harness).
function makePlan(
  cleanup: MaterializationPlan["cleanup"] = { status: "pending" },
): MaterializationPlan {
  return {
    profileDigest: "digest-e",
    resolvedRevisions: [{ refId: "github", kind: "mcp", sha: "sha-e-1111" }],
    materializedFiles: ["/tmp/profile.json"],
    enforcedClasses: ["github"],
    instructedClasses: [],
    refusedClasses: [],
    cleanup,
  };
}

type Seeded = {
  runId: string;
  nodeAttemptId: string;
  worktreePath: string;
};

// Seed project + run + workspace + ONE node_attempts row carrying a
// materializationPlan. worktreePath is a fresh mkdtemp dir (workspaces
// .worktree_path is UNIQUE).
async function seed(): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const worktreePath = await mkdtempReal("wt-cleanup-sl-");

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: { schemaVersion: 1, name: "g", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Crashed",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
    removedAt: null,
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    materializationPlan: makePlan(),
  });

  return { runId, nodeAttemptId, worktreePath };
}

// Provision a REAL per-node capability dir so the node-dir rm stays observable
// on disk (the cleanup still reclaims it; settings.local.json is the new part).
async function provisionNodeDir(
  worktreePath: string,
  runId: string,
  nodeAttemptId: string,
): Promise<string> {
  const dir = capabilityMaterializationRootPath(
    worktreePath,
    runId,
    nodeAttemptId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), "{}");

  return dir;
}

async function provisionCapabilityLease(
  worktreePath: string,
  runId: string,
  hadSettings: boolean,
): Promise<void> {
  const root = capabilityMaterializationRootPath(worktreePath, runId);
  const settingsPath = join(worktreePath, SETTINGS_RELATIVE);
  const markerPath = settingsLocalOwnedPath(worktreePath);
  const backupPath = join(worktreePath, SETTINGS_BACKUP_RELATIVE);
  const operationPath = join(worktreePath, SETTINGS_OPERATION_RELATIVE);

  await materializeWithAgentLease({
    cwd: worktreePath,
    runId,
    materialize: async (_ownedPaths, recordIntent) => {
      await recordIntent([
        root,
        settingsPath,
        markerPath,
        backupPath,
        operationPath,
      ]);
      await mkdir(root, { recursive: true });

      return [root, settingsPath, markerPath, backupPath, operationPath];
    },
  });
  await mkdir(dirname(operationPath), { recursive: true });
  await writeFile(
    operationPath,
    capabilitySettingsOperation(runId, hadSettings, "active"),
  );
}

function settingsLocalPath(worktreePath: string): string {
  return join(worktreePath, ".claude", "settings.local.json");
}

function settingsLocalBakPath(worktreePath: string): string {
  return `${settingsLocalPath(worktreePath)}.maister-bak`;
}

function settingsLocalOwnedPath(worktreePath: string): string {
  return `${settingsLocalPath(worktreePath)}${SETTINGS_OWNED_MARKER_SUFFIX}`;
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(value));
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function reloadPlan(
  nodeAttemptId: string,
): Promise<MaterializationPlan | null> {
  const rows = await db
    .select({ materializationPlan: schema.nodeAttempts.materializationPlan })
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.id, nodeAttemptId));

  return (rows[0]?.materializationPlan as MaterializationPlan | null) ?? null;
}

// A claude profile carrying ONE enforced MCP; `tools` on materialize drives the
// settings.local.json allow-list, so each call can produce a DIFFERENT body.
function claudeProfile() {
  return resolveCapabilityProfile({
    projectId: "project-1",
    executorAgent: "claude",
    planMode: "off",
    selectedMcpIds: ["github"],
    catalog: [
      {
        id: "row-github",
        projectId: "project-1",
        capabilityRefId: "github",
        kind: "mcp",
        label: "github",
        source: "platform",
        version: null,
        revision: null,
        agents: ["claude", "codex"],
        enforceability: "enforced",
        selectedByDefault: true,
        selectable: true,
        material: {
          command: "github-mcp",
          args: [],
          envKeys: ["GITHUB_TOKEN"],
        },
      },
    ],
  });
}

describe("cleanup reclaims worktree settings.local.json (M14 T4.5-E)", () => {
  it("removes a MAIster-created settings.local.json when no .maister-bak exists (Test 1)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed();
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    await provisionCapabilityLease(worktreePath, runId, false);

    const slPath = settingsLocalPath(worktreePath);

    await writeJson(slPath, { permissions: { allow: ["Read"] } });
    await writeFile(
      settingsLocalOwnedPath(worktreePath),
      capabilitySettingsMarker(runId),
    );

    expect(await exists(slPath)).toBe(true);
    expect(await exists(settingsLocalBakPath(worktreePath))).toBe(false);

    // Settings reclaim is run-level (once per run), not per-node.
    const result = await cleanupRunMaterializations({
      runId,
      worktreePath,
      db,
    });

    // No pre-existing user file → cleanup removes the MAIster-created one.
    expect(await exists(slPath)).toBe(false);
    // Node dir is still reclaimed.
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan!.cleanup.status).toBe("done");
    // Never throws — the call resolved; the one node dir was reclaimed.
    expect(result).toEqual({ cleaned: 1, failed: 0 });
  });

  it("restores the user's original from .maister-bak and removes the bak (Test 2)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed();
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    await provisionCapabilityLease(worktreePath, runId, true);

    const slPath = settingsLocalPath(worktreePath);
    const bakPath = settingsLocalBakPath(worktreePath);

    // M14's live config + the user's original captured as the backup.
    await writeJson(slPath, { user: "current-m14-config" });
    await writeJson(bakPath, { user: "ORIGINAL" });
    await writeFile(
      settingsLocalOwnedPath(worktreePath),
      capabilitySettingsMarker(runId),
    );

    // Settings reclaim is run-level (once per run), not per-node.
    await cleanupRunMaterializations({ runId, worktreePath, db });

    // The user's original is back in place...
    expect(await exists(slPath)).toBe(true);
    const restored = JSON.parse(await readFile(slPath, "utf8"));

    expect(restored).toEqual({ user: "ORIGINAL" });

    // ...and the backup is gone (consumed by the restore).
    expect(await exists(bakPath)).toBe(false);
    // Node dir reclaimed.
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan!.cleanup.status).toBe("done");
  });

  it("does not bypass manifest ownership to reclaim unleased settings", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed();
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);
    const slPath = settingsLocalPath(worktreePath);
    const markerPath = settingsLocalOwnedPath(worktreePath);

    await writeJson(slPath, { permissions: { allow: ["Read"] } });
    await writeFile(markerPath, capabilitySettingsMarker(runId));

    const result = await cleanupRunMaterializations({
      runId,
      worktreePath,
      db,
    });

    expect(result).toEqual({ cleaned: 1, failed: 0 });
    expect(await exists(dir)).toBe(false);
    expect(await exists(slPath)).toBe(true);
    expect(await exists(markerPath)).toBe(true);
  });

  it("backup-once: the bak preserves the user's ORIGINAL across two materialize calls (Test 3)", async () => {
    const worktreePath = await mkdtempReal("wt-bak-once-");
    const slPath = settingsLocalPath(worktreePath);
    const bakPath = settingsLocalBakPath(worktreePath);

    // The user's pre-existing settings.local.json.
    await writeJson(slPath, { user: "ORIGINAL" });

    // First node materializes with tools=[Read]; backup must capture ORIGINAL.
    await materializeCapabilityProfile({
      runId: "run-bak",
      worktreePath,
      profile: claudeProfile(),
      nodeAttemptId: "node-1",
      tools: ["Read"],
    });

    // Second node materializes with tools=[Edit] over the SAME worktree.
    await materializeCapabilityProfile({
      runId: "run-bak",
      worktreePath,
      profile: claudeProfile(),
      nodeAttemptId: "node-2",
      tools: ["Edit"],
    });

    // backup-once: the bak still holds the USER's ORIGINAL, NOT node-1's config.
    expect(await exists(bakPath)).toBe(true);
    const bak = JSON.parse(await readFile(bakPath, "utf8"));

    expect(bak).toEqual({ user: "ORIGINAL" });

    // The live settings.local.json reflects the SECOND call (tools Edit).
    const live = JSON.parse(await readFile(slPath, "utf8"));

    expect(live.permissions.allow).toEqual(["Edit"]);

    await fsRm(worktreePath, { recursive: true, force: true });
  });

  it("an rm failure covering settings.local.json never throws and records cleanup.failed (Test 4)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed();

    await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    const slPath = settingsLocalPath(worktreePath);

    await writeJson(slPath, { permissions: { allow: ["Read"] } });

    // Inject a throwing rm; the call must resolve (not reject).
    const result = await cleanupNodeMaterialization({
      nodeAttemptId,
      runId,
      worktreePath,
      db,
      rm: async () => {
        throw new Error("EACCES boom");
      },
    });

    expect(result).toEqual({ removed: false });

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan!.cleanup.status).toBe("failed");
    expect(plan!.cleanup.error).toContain("EACCES boom");
    // Plan body survives the failure path.
    expect(plan!.profileDigest).toBe("digest-e");
    expect(plan!.enforcedClasses).toEqual(["github"]);
  });

  // ADR-076 (decision 5) / T3.1: a claude run with executor.model set writes
  // { model, availableModels } into settings.local.json — always-on, even with
  // zero tools/permissionMode (the always-on regression: settingsLocal was null
  // for a no-permission claude run before).
  it("writes { model, availableModels } into settings.local.json for a claude run with executor.model and NO tools (T3.1)", async () => {
    const worktreePath = await mkdtempReal("wt-model-write-");
    const slPath = settingsLocalPath(worktreePath);

    const materialized = await materializeCapabilityProfile({
      runId: "run-model",
      worktreePath,
      profile: claudeProfile(),
      nodeAttemptId: "node-1",
      executor: {
        executorRefId: "runner-1",
        agent: "claude",
        model: "glm-5.1",
        router: null,
      },
    });

    expect(materialized.settingsLocalPath).toBe(slPath);
    expect(await exists(slPath)).toBe(true);

    const written = JSON.parse(await readFile(slPath, "utf8"));

    expect(written.model).toBe("glm-5.1");
    expect(written.availableModels).toEqual(["glm-5.1"]);
    expect(written.permissions).toEqual({});

    await fsRm(worktreePath, { recursive: true, force: true });
  });

  it("reclaim is idempotent: a 2nd pass never re-deletes a restored user original (Test 5, #data-loss)", async () => {
    const worktreePath = await mkdtempReal("wt-reclaim-idem-");
    const slPath = settingsLocalPath(worktreePath);

    // The user's pre-existing settings.local.json.
    await writeJson(slPath, { user: "ORIGINAL" });

    // M14 materializes → backs the original up to .maister-bak + drops the
    // ownership marker.
    await materializeCapabilityProfile({
      runId: "run-idem",
      worktreePath,
      profile: claudeProfile(),
      nodeAttemptId: "node-1",
      tools: ["Read"],
    });

    expect(await exists(settingsLocalBakPath(worktreePath))).toBe(true);
    expect(await exists(settingsLocalOwnedPath(worktreePath))).toBe(true);

    // First reclaim → restores the user's original, consumes bak + marker.
    expect(
      await reclaimWorktreeSettings({ worktreePath, runId: "run-idem" }),
    ).toEqual({ reclaimed: true, retryable: false });
    expect(JSON.parse(await readFile(slPath, "utf8"))).toEqual({
      user: "ORIGINAL",
    });
    expect(await exists(settingsLocalBakPath(worktreePath))).toBe(false);
    expect(await exists(settingsLocalOwnedPath(worktreePath))).toBe(false);

    // Second reclaim (e.g. a later cron sweep over the same lingering run) must
    // be a NO-OP — the marker is gone, so the restored original is preserved.
    expect(
      await reclaimWorktreeSettings({ worktreePath, runId: "run-idem" }),
    ).toEqual({ reclaimed: false, retryable: false });
    expect(await exists(slPath)).toBe(true);
    expect(JSON.parse(await readFile(slPath, "utf8"))).toEqual({
      user: "ORIGINAL",
    });

    await fsRm(worktreePath, { recursive: true, force: true });
  });
});
