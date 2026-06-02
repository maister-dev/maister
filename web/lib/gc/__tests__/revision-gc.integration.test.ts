// M19 Phase 4 (T4.3): runRevisionGcSweep against a real Postgres testcontainer
// + real fs. Selects flow_revisions with package_status='Removed' AND
// installed_at <= now - gcAgeDays(); per row, under FOR UPDATE, it re-asserts
// the dual-FK guard mirrored from removeRevision (ZERO runs.flow_revision_id
// refs AND ZERO flows.enabled_revision_id refs). Clear → DELETE the row + rm
// the installedPath dir (deleted++); still referenced → SKIP
// (skippedReferenced++). Mirrors flows.integration.test.ts for the
// testcontainer + on-disk installedPath setup.
//
// Scenarios (QA contract T4.3 / plan T4.6):
//   1. Removed revision past age, ZERO refs → deleted + rm called (dir gone).
//   2. Removed revision still referenced by runs.flow_revision_id → skipped.
//   3. Removed revision still referenced by flows.enabled_revision_id → skipped.
//   4. Removed revision NEWER than age → not scanned.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { gcAgeDays } from "@/lib/instance-config";

const schema = schemaModule as unknown as Record<string, any>;
const { executors, flowRevisions, flows, projects, runs, tasks, users } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let projectId: string;
let executorId: string;
let flowId: string;
let userId: string;

const MANIFEST = { schemaVersion: 1, name: "revgc", steps: [] };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("revision_gc_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  cacheRoot = await mkdtemp(join(tmpdir(), "revgc-cache-"));

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `revgc-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(projects).values({
    id: projectId,
    slug: "revgc-app",
    name: "Rev GC App",
    repoPath: `/repos/revgc-${randomUUID()}`,
    maisterYamlPath: `/repos/revgc/maister.yaml`,
  });

  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "revgc",
    source: "github.com/x/revgc",
    version: "v1.0.0",
    installedPath: join(cacheRoot, "live"),
    manifest: MANIFEST,
    schemaVersion: 1,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Detach any flow enablement pointer before clearing revisions so the FK
  // does not block the delete between tests.
  await db.update(flows).set({ enabledRevisionId: null });
  await db.delete(runs);
  await db.delete(tasks);
  await db.delete(flowRevisions);
});

let revSeq = 0;

// Seed a Removed revision with a real on-disk installedPath dir. `ageDays`
// older means installed_at further in the past.
async function seedRemovedRevision(opts: {
  installedAt: Date;
  packageStatus?: string;
}): Promise<{ revisionId: string; installedPath: string }> {
  const revisionId = randomUUID();
  const installedPath = join(cacheRoot, `rev-${revSeq++}-${revisionId}`);

  await mkdir(installedPath, { recursive: true });

  await db.insert(flowRevisions).values({
    id: revisionId,
    flowRefId: "revgc",
    source: "github.com/x/revgc",
    versionLabel: "v1.0.0",
    resolvedRevision: revisionId.slice(0, 12),
    manifestDigest: `sha256:${revisionId}`,
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath,
    packageStatus: opts.packageStatus ?? "Removed",
    installedAt: opts.installedAt,
  });

  return { revisionId, installedPath };
}

async function seedReferencingRun(revisionId: string): Promise<void> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "Done",
  });
  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId: revisionId,
    executorId,
    status: "Done",
    flowVersion: "v1",
    startedAt: new Date(),
    endedAt: new Date(),
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

async function revisionExists(revisionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: flowRevisions.id })
    .from(flowRevisions)
    .where(eq(flowRevisions.id, revisionId));

  return rows.length > 0;
}

function pastAge(): Date {
  return new Date(Date.now() - (gcAgeDays() + 1) * 86_400_000);
}

describe("runRevisionGcSweep (integration)", () => {
  it("deletes a Removed revision past age with ZERO refs and rm's its installedPath", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: pastAge(),
    });

    const summary = await runRevisionGcSweep({ db });

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(await revisionExists(revisionId)).toBe(false);
    expect(await exists(installedPath)).toBe(false);
  }, 60_000);

  it("counts a cache-dir rm FAILURE as failed (row deleted, dir orphaned) for the cron 207 path", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: pastAge(),
    });

    // Inject a failing rm so the filesystem cleanup throws AFTER the in-tx row
    // delete commits. The revision is gone from the registry (`deleted`), but
    // its cache dir leaks on disk (`failed`) — never swallowed (Codex finding #2).
    const failingRm = async (): Promise<void> => {
      throw new Error("EACCES: simulated cache rm failure");
    };

    const summary = await runRevisionGcSweep({ db, rm: failingRm });

    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    // DB row IS gone (the delete committed before the rm).
    expect(await revisionExists(revisionId)).toBe(false);
    // The dir is still on disk because the injected rm was a no-op throw.
    expect(await exists(installedPath)).toBe(true);
  }, 60_000);

  it("skips a Removed revision still referenced by runs.flow_revision_id", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: pastAge(),
    });

    await seedReferencingRun(revisionId);

    const summary = await runRevisionGcSweep({ db });

    expect(summary.skippedReferenced).toBeGreaterThanOrEqual(1);
    expect(await revisionExists(revisionId)).toBe(true);
    expect(await exists(installedPath)).toBe(true);
  }, 60_000);

  it("skips a Removed revision still referenced by flows.enabled_revision_id", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: pastAge(),
    });

    await db
      .update(flows)
      .set({ enabledRevisionId: revisionId })
      .where(eq(flows.id, flowId));

    const summary = await runRevisionGcSweep({ db });

    expect(summary.skippedReferenced).toBeGreaterThanOrEqual(1);
    expect(await revisionExists(revisionId)).toBe(true);
    expect(await exists(installedPath)).toBe(true);
  }, 60_000);

  it("does not scan a Removed revision installed more recently than gcAgeDays()", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: new Date(),
    });

    const summary = await runRevisionGcSweep({ db });

    expect(summary.scanned).toBe(0);
    expect(summary.deleted).toBe(0);
    expect(await revisionExists(revisionId)).toBe(true);
    expect(await exists(installedPath)).toBe(true);
  }, 60_000);

  it("does not touch a non-Removed (Installed) revision even past age", async () => {
    const { revisionId, installedPath } = await seedRemovedRevision({
      installedAt: pastAge(),
      packageStatus: "Installed",
    });

    const summary = await runRevisionGcSweep({ db });

    expect(summary.scanned).toBe(0);
    expect(await revisionExists(revisionId)).toBe(true);
    expect(await exists(installedPath)).toBe(true);
  }, 60_000);
});
