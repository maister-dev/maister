/**
 * M14 T4.5-E (RED): cleanup must reclaim/restore the worktree enforcement file
 * `<worktree>/.claude/settings.local.json`.
 *
 * Phase 4.5 made `materializeCapabilityProfile` write the SDK "local" settings
 * tier at `<worktree>/.claude/settings.local.json` and copy any PRE-EXISTING
 * file to `<worktree>/.claude/settings.local.json.maister-bak`. T4.3 cleanup
 * reclaims only the node-scoped `.maister/capabilities/...` dir — it does NOT
 * touch the worktree settings.local.json. T4.5-E extends cleanup to reclaim it
 * and fixes a backup-once bug in materialize.
 *
 * Contract under test (DO NOT implement here — RED only):
 *  1. backup-once (materialize): the `.maister-bak` is created ONLY if it does
 *     not already exist, so across multiple materialize calls in one worktree
 *     the backup preserves the FIRST (user's original) settings.local.json,
 *     never a later node's config.
 *  2. cleanup reclaims settings.local.json (cleanup.ts):
 *     `cleanupNodeMaterialization` ALSO handles
 *     `<worktree>/.claude/settings.local.json`:
 *       - if `<...>.maister-bak` exists → restore it (copy bak → settings.local
 *         .json) and remove the bak;
 *       - else → remove `<worktree>/.claude/settings.local.json` (if present);
 *       - best-effort, NEVER throws; the node-dir removal still happens.
 *
 * Mirrors the T4.3 harness (cleanup.integration.test.ts): direct db.insert seed
 * of project/run/workspace + ONE node_attempts row with a materializationPlan,
 * real mkdtemp worktree, real on-disk files. The settings.local.json path
 * cleanup must derive from `worktreePath`:
 *   `<worktreePath>/.claude/settings.local.json` (+ `.maister-bak`).
 *
 * Expected RED:
 *  - Test 1: cleanup does not touch settings.local.json yet → the M14-created
 *    file SURVIVES (expected gone).
 *  - Test 2: cleanup does not restore from `.maister-bak` → settings.local.json
 *    still holds the M14 config, bak still present (expected restored + bak
 *    gone).
 *  - Test 3: materialize backup is UNCONDITIONAL → the 2nd materialize
 *    overwrites the bak with the 1st node's settings.local.json (expected bak
 *    == user's ORIGINAL).
 *  - Test 4: best-effort never-throw across an rm failure that also covers the
 *    settings.local.json path.
 */
import type { MaterializationPlan } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm as fsRm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  capabilityMaterializationRootPath,
  materializeCapabilityProfile,
  SETTINGS_OWNED_MARKER_SUFFIX,
} from "@/lib/capabilities/materialize";
import { resolveCapabilityProfile } from "@/lib/capabilities/resolver";
import {
  cleanupNodeMaterialization,
  cleanupRunMaterializations,
  reclaimWorktreeSettings,
} from "@/lib/capabilities/cleanup";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cleanup_settings_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
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
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-cleanup-sl-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
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
    executorId,
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

    const slPath = settingsLocalPath(worktreePath);

    await writeJson(slPath, { permissions: { allow: ["Read"] } });
    await writeFile(settingsLocalOwnedPath(worktreePath), runId);

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

    const slPath = settingsLocalPath(worktreePath);
    const bakPath = settingsLocalBakPath(worktreePath);

    // M14's live config + the user's original captured as the backup.
    await writeJson(slPath, { user: "current-m14-config" });
    await writeJson(bakPath, { user: "ORIGINAL" });
    await writeFile(settingsLocalOwnedPath(worktreePath), runId);

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

  it("backup-once: the bak preserves the user's ORIGINAL across two materialize calls (Test 3)", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "wt-bak-once-"));
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

  it("reclaim is idempotent: a 2nd pass never re-deletes a restored user original (Test 5, #data-loss)", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "wt-reclaim-idem-"));
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
    expect(await reclaimWorktreeSettings(worktreePath)).toEqual({
      reclaimed: true,
    });
    expect(JSON.parse(await readFile(slPath, "utf8"))).toEqual({
      user: "ORIGINAL",
    });
    expect(await exists(settingsLocalBakPath(worktreePath))).toBe(false);
    expect(await exists(settingsLocalOwnedPath(worktreePath))).toBe(false);

    // Second reclaim (e.g. a later cron sweep over the same lingering run) must
    // be a NO-OP — the marker is gone, so the restored original is preserved.
    expect(await reclaimWorktreeSettings(worktreePath)).toEqual({
      reclaimed: false,
    });
    expect(await exists(slPath)).toBe(true);
    expect(JSON.parse(await readFile(slPath, "utf8"))).toEqual({
      user: "ORIGINAL",
    });

    await fsRm(worktreePath, { recursive: true, force: true });
  });
});
