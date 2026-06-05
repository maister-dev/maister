// PR1 / F2 (RED): supersedePrior + markArtifactsStale only touch `current`
// rows, so after a rework the old requiredFor row stays `stale` forever (a NEW
// current row is added, but the stale orphan persists). assertEvidenceReady
// (Check 1 iterates EVERY requiredFor row) + board mergeBlocked/evidenceStale
// (ANY stale / ANY non-current merge-required row) then block forever.
//
// Fix: supersedePrior retires ALL prior rows of the def (not just current);
// readiness + board evaluate PER-DEF-CURRENT (a def is satisfied iff a current
// row exists), ignoring stale/superseded history.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  markArtifactsStale,
  recordArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// getBoardData reads the DB via getDb(); point it at the testcontainer db.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getBoardData: typeof import("@/lib/queries/board").getBoardData;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_rework_readiness")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getBoardData } = await import("@/lib/queries/board"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type Seeded = {
  projectId: string;
  runId: string;
  attempt1Id: string;
  attempt2Id: string;
};

// A Review-status flow run with two node_attempts for the same node (attempt 1
// + attempt 2 — the rework re-run). Lands in the OnReview in-flight column.
async function seedReworkRun(): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const attempt1Id = randomUUID();
  const attempt2Id = randomUUID();

  await db.insert(schema.projects).values({
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
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "Backlog",
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
    status: "Review",
    currentStepId: "review",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "maister/rework-1",
    worktreePath: `/tmp/${slug}/wt`,
    parentRepoPath: `/tmp/${slug}`,
  });
  await db.insert(schema.nodeAttempts).values({
    id: attempt1Id,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Reworked",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
  });
  await db.insert(schema.nodeAttempts).values({
    id: attempt2Id,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 2,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:10:00.000Z"),
  });

  return { projectId, runId, attempt1Id, attempt2Id };
}

async function getArtifacts(runId: string): Promise<any[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(eq(schema.artifactInstances.runId, runId))) as unknown as any[];
}

async function flightCard(projectId: string, runId: string) {
  const board = await getBoardData(projectId);

  return board.columns.OnReview.flight.find((c) => c.runId === runId);
}

// Record attempt-1's impl-diff (current, requiredFor review+merge), supersede
// prior (no-op first time), then stale it (rework).
async function recordAndStaleAttempt1(seeded: Seeded): Promise<string> {
  const firstId = randomUUID();

  await recordArtifact(
    {
      id: firstId,
      runId: seeded.runId,
      nodeId: "implement",
      nodeAttemptId: seeded.attempt1Id,
      kind: "diff",
      producer: "runner",
      artifactDefId: "impl-diff",
      locator: { kind: "inline", text: "v1" },
      validity: "current",
      requiredFor: ["review", "merge"],
    },
    db,
  );
  await supersedePrior(seeded.runId, "implement", "impl-diff", firstId, db);

  // Rework stales the downstream node's current artifacts.
  await markArtifactsStale(seeded.runId, ["implement"], db);

  return firstId;
}

describe("F2: rework re-produce clears merge-block (per-def-current)", () => {
  it("re-producing a stale merge-required def restores readiness and retires the orphan", async () => {
    const seeded = await seedReworkRun();
    const firstId = await recordAndStaleAttempt1(seeded);

    // The orphaned attempt-1 row is now stale.
    let arts = await getArtifacts(seeded.runId);

    expect(arts.find((a) => a.id === firstId)?.validity).toBe("stale");

    // Re-produce a FRESH impl-diff for attempt 2 (new row, current) + supersede.
    const secondId = randomUUID();

    await recordArtifact(
      {
        id: secondId,
        runId: seeded.runId,
        nodeId: "implement",
        nodeAttemptId: seeded.attempt2Id,
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "v2" },
        validity: "current",
        requiredFor: ["review", "merge"],
      },
      db,
    );
    await supersedePrior(seeded.runId, "implement", "impl-diff", secondId, db);

    // (a) evidence readiness for merge is restored.
    const merge = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(merge.ready).toBe(true);
    expect(merge.reasons).toHaveLength(0);

    // (b) board readiness clears (T15: unified state, all current → ready).
    const card = await flightCard(seeded.projectId, seeded.runId);

    expect(card).toBeDefined();
    expect(card?.readiness).toBe("ready");

    // (c) the orphaned attempt-1 row is retired to superseded, not left stale.
    arts = await getArtifacts(seeded.runId);
    const orphan = arts.find((a) => a.id === firstId);

    expect(orphan?.validity).toBe("superseded");

    // The current row is the fresh attempt-2 one.
    const current = arts.find((a) => a.validity === "current");

    expect(current?.id).toBe(secondId);
  });

  it("negative control: a genuinely stale merge def (no re-produce) still blocks", async () => {
    const seeded = await seedReworkRun();

    await recordAndStaleAttempt1(seeded);
    // NO fresh re-produce — the def has only a stale row.

    const merge = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(merge.ready).toBe(false);
    expect(merge.reasons.length).toBeGreaterThan(0);

    const card = await flightCard(seeded.projectId, seeded.runId);

    // T15: a stale-only required def (no current row) rolls up to "blocked"
    // (mirrors getRunReadiness current-row-presence SSOT).
    expect(card?.readiness).toBe("blocked");
  });
});

// F2-gate: the gate analog of per-def-current. markDownstreamStale flips the
// prior attempt's passed artifact_required gate to `stale`; the re-run writes a
// fresh `passed` gate on the new attempt. Readiness + board must evaluate the
// LATEST attempt's gate, ignoring the superseded stale row — keyed on
// node-attempt lineage, not gate id.
describe("F2-gate: re-run gate clears merge-block (latest-attempt gate)", () => {
  async function seedGate(
    runId: string,
    nodeAttemptId: string,
    status: "passed" | "stale" | "failed",
  ): Promise<void> {
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId,
      gateId: "verify-evidence",
      kind: "artifact_required",
      mode: "blocking",
      status,
    });
  }

  it("a stale gate on a prior attempt no longer blocks once the re-run gate passes", async () => {
    const seeded = await seedReworkRun();

    // Attempt 1's gate was flipped stale by the rework; attempt 2 (the re-run)
    // re-evaluated it to passed.
    await seedGate(seeded.runId, seeded.attempt1Id, "stale");
    await seedGate(seeded.runId, seeded.attempt2Id, "passed");

    const merge = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(merge.ready).toBe(true);
    expect(merge.reasons).toHaveLength(0);

    const card = await flightCard(seeded.projectId, seeded.runId);

    // T15: the live (attempt-2) gate passed → readiness clears to "ready".
    expect(card?.readiness).toBe("ready");
  });

  it("negative control: a stale gate on the LATEST attempt (no re-pass) still blocks", async () => {
    const seeded = await seedReworkRun();

    // Only a stale gate on the latest attempt — the node has not re-passed it.
    await seedGate(seeded.runId, seeded.attempt2Id, "stale");

    const merge = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(merge.ready).toBe(false);
    expect(merge.reasons.length).toBeGreaterThan(0);

    const card = await flightCard(seeded.projectId, seeded.runId);

    // T15: the live (attempt-2) artifact_required gate is stale → "stale".
    expect(card?.readiness).toBe("stale");
  });
});
