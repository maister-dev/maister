/**
 * M14 T4.3 — sub-cycle C1 (RED): best-effort capability-dir cleanup machinery.
 *
 * Pins the OBSERVABLE contract of the cleanup path on terminal runs:
 *  1. cleanupNodeMaterialization removes the on-disk per-node capability dir and
 *     records cleanup.done in node_attempts.materialization_plan.cleanup —
 *     leaving the plan BODY fields intact.
 *  2. An rm failure NEVER throws; it records cleanup.failed (+ error) and the
 *     plan body stays intact.
 *  3. runCapabilitiesCleanupSweep scans terminal (Abandoned/Done/Failed/Crashed)
 *     runs whose workspace is not yet removed, cleans each run's node dirs, and
 *     does NOT touch a non-terminal (Running) run's dir.
 *  4. updateMaterializationCleanup is a partial update of ONLY the .cleanup
 *     sub-object (read-modify-write), preserving the plan body.
 *
 * Seeding is DIRECT (db.insert) — a full flow is not run. The path helper
 * `capabilityMaterializationRootPath` is the SAME path the materializer wrote
 * (materialize.ts:88-94). `worktreePath` is a mkdtemp temp dir, and the node
 * dir is provisioned with a real file so the rm is observable on disk.
 *
 * Expected RED reason: `@/lib/capabilities/cleanup` does not exist yet, and
 * `capabilityMaterializationRootPath` / `updateMaterializationCleanup` are not
 * exported yet → the import block fails to resolve (feature-absent RED).
 */
import type { MaterializationPlan } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import {
  cleanupNodeMaterialization,
  cleanupRunMaterializations,
  runCapabilitiesCleanupSweep,
} from "@/lib/capabilities/cleanup";
import { updateMaterializationCleanup } from "@/lib/flows/graph/ledger";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cleanup_test")
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

// A minimal but VALID MaterializationPlan body. Mirrors the ledger
// integration test's `first` plan; cleanup defaults to pending.
function makePlan(
  cleanup: MaterializationPlan["cleanup"] = { status: "pending" },
): MaterializationPlan {
  return {
    profileDigest: "digest-c1",
    resolvedRevisions: [{ refId: "github", kind: "mcp", sha: "sha-c1-1111" }],
    materializedFiles: ["/tmp/profile.json", "/tmp/.mcp.json"],
    enforcedClasses: ["github"],
    instructedClasses: ["my-skill"],
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
// materializationPlan. `runStatus` controls the run terminality the sweep keys
// on; `removedAt` controls workspace eligibility. worktreePath is a fresh
// mkdtemp dir (unique per call — workspaces.worktree_path is UNIQUE).
async function seed(opts: {
  runStatus?: string;
  removedAt?: Date | null;
  plan?: MaterializationPlan;
}): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-cleanup-"));

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
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
    status: opts.runStatus ?? "Crashed",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
    removedAt: opts.removedAt ?? null,
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    materializationPlan: opts.plan ?? makePlan(),
  });

  return { runId, nodeAttemptId, worktreePath };
}

// Materialize a REAL per-node capability dir at the helper-derived path, with a
// file inside, so the rm is observable on disk.
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

describe("capability-dir cleanup (M14 T4.3 / C1)", () => {
  it("cleanupNodeMaterialization removes the dir and records cleanup.done (Test 1)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed({});
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    expect(await exists(dir)).toBe(true);

    const result = await cleanupNodeMaterialization({
      nodeAttemptId,
      runId,
      worktreePath,
      db,
    });

    expect(result).toEqual({ removed: true });
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan).not.toBeNull();
    expect(plan!.cleanup.status).toBe("done");
    expect(plan!.cleanup.error).toBeUndefined();
    // The plan BODY fields are unchanged by the cleanup transition.
    expect(plan!.profileDigest).toBe("digest-c1");
    expect(plan!.materializedFiles).toEqual([
      "/tmp/profile.json",
      "/tmp/.mcp.json",
    ]);
    expect(plan!.enforcedClasses).toEqual(["github"]);
    expect(plan!.instructedClasses).toEqual(["my-skill"]);
    expect(plan!.resolvedRevisions).toEqual([
      { refId: "github", kind: "mcp", sha: "sha-c1-1111" },
    ]);
  });

  it("an rm failure records cleanup.failed and NEVER throws (Test 2)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed({});

    await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    // Inject a throwing rm; the call must resolve (not reject) → {removed:false}.
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

    expect(plan).not.toBeNull();
    expect(plan!.cleanup.status).toBe("failed");
    expect(plan!.cleanup.error).toContain("EACCES boom");
    // Plan BODY survives the failure path.
    expect(plan!.profileDigest).toBe("digest-c1");
    expect(plan!.enforcedClasses).toEqual(["github"]);
    expect(plan!.instructedClasses).toEqual(["my-skill"]);
    expect(plan!.materializedFiles).toEqual([
      "/tmp/profile.json",
      "/tmp/.mcp.json",
    ]);
  });

  it("runCapabilitiesCleanupSweep cleans a terminal run and skips a Running run (Test 3)", async () => {
    const terminal = await seed({ runStatus: "Crashed", removedAt: null });
    const terminalDir = await provisionNodeDir(
      terminal.worktreePath,
      terminal.runId,
      terminal.nodeAttemptId,
    );

    const running = await seed({ runStatus: "Running", removedAt: null });
    const runningDir = await provisionNodeDir(
      running.worktreePath,
      running.runId,
      running.nodeAttemptId,
    );

    expect(await exists(terminalDir)).toBe(true);
    expect(await exists(runningDir)).toBe(true);

    const summary = await runCapabilitiesCleanupSweep({ db });

    expect(summary.scanned).toBeGreaterThanOrEqual(1);

    // The terminal run's node dir is removed + recorded done.
    expect(await exists(terminalDir)).toBe(false);
    const terminalPlan = await reloadPlan(terminal.nodeAttemptId);

    expect(terminalPlan!.cleanup.status).toBe("done");

    // The non-terminal (Running) run's dir is left untouched.
    expect(await exists(runningDir)).toBe(true);
    const runningPlan = await reloadPlan(running.nodeAttemptId);

    expect(runningPlan!.cleanup.status).toBe("pending");
  });

  it("updateMaterializationCleanup partially updates only .cleanup, preserving the body (Test 4)", async () => {
    const { nodeAttemptId } = await seed({});

    await updateMaterializationCleanup(
      nodeAttemptId,
      { status: "failed", error: "x", at: "2026-06-02T00:00:00.000Z" },
      db,
    );

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan).not.toBeNull();
    expect(plan!.cleanup).toEqual({
      status: "failed",
      error: "x",
      at: "2026-06-02T00:00:00.000Z",
    });
    // Body fields are untouched by the partial cleanup write.
    expect(plan!.profileDigest).toBe("digest-c1");
    expect(plan!.resolvedRevisions).toEqual([
      { refId: "github", kind: "mcp", sha: "sha-c1-1111" },
    ]);
    expect(plan!.materializedFiles).toEqual([
      "/tmp/profile.json",
      "/tmp/.mcp.json",
    ]);
    expect(plan!.enforcedClasses).toEqual(["github"]);
    expect(plan!.instructedClasses).toEqual(["my-skill"]);
    expect(plan!.refusedClasses).toEqual([]);
  });

  it("cleanupRunMaterializations cleans every plan-bearing node of a run (Test 3 helper)", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seed({});
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    expect(await exists(dir)).toBe(true);

    const res = await cleanupRunMaterializations({ runId, worktreePath, db });

    expect(res.cleaned).toBeGreaterThanOrEqual(1);
    expect(res.failed).toBe(0);
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan!.cleanup.status).toBe("done");
  });
});
