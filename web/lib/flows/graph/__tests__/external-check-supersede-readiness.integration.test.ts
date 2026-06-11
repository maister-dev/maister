// RED regression (M16 Phase 4 — supersede dedup): after a supersede-on-new-commit
// report, reportExternalGate leaves the PRIOR passed row `stale` and creates a
// FRESH passed row on the SAME nodeAttemptId (its documented behavior). The two
// readiness readers must collapse external_check rows to the LATEST report per
// gateId on the live attempt and evaluate only that representative — otherwise the
// leftover `stale` row leaks and:
//   - assertEvidenceReady(runId, "review") wrongly returns ready=false, and
//   - getRunReadiness().readiness wrongly resolves to "stale" with the gate
//     listed twice in externalGates[].
//
// Intended semantics (confirmed): the LATEST report per gateId governs. A
// new-commit passing report ⇒ gate effectively passed ⇒ review proceeds.
//
// This test seeds a blocking external_check gate, reports passed@AAA (sanity:
// ready), then reports passed@BBB (supersede). It asserts both readers treat the
// gate as passed. RED until both readers dedup-to-latest-per-gateId.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { appendNodeAttempt, markNodeSucceeded } from "@/lib/flows/graph/ledger";
import {
  createGateResult,
  reportExternalGate,
} from "@/lib/flows/graph/gate-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { getRunReadiness } from "@/lib/queries/readiness";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
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

async function seedRun(): Promise<{ runId: string; projectId: string }> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

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
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    flowVersion: "v1.0.0",
    status: "Review",
  });

  return { runId, projectId };
}

async function seedPendingBlockingExternalGate(runId: string): Promise<void> {
  const { id: nodeAttemptId } = await appendNodeAttempt({
    runId,
    nodeId: "work",
    nodeType: "check",
    db,
  });

  await markNodeSucceeded(nodeAttemptId, { stdout: "" }, db);
  await createGateResult({
    runId,
    nodeAttemptId,
    gateId: "ci",
    kind: "external_check",
    mode: "blocking",
    status: "pending",
    db,
  });
}

describe("external_check supersede — readers dedup to latest-per-gateId", () => {
  it("a new-commit passing report keeps review ready and lists the gate once", async () => {
    const { runId, projectId } = await seedRun();

    await seedPendingBlockingExternalGate(runId);

    // First report passes against commit AAA.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "AAA", reporterTokenId: "tok-aaa" },
      },
      db,
    );

    // Sanity: a single passed external gate ⇒ review ready.
    const sanity = await assertEvidenceReady(runId, "review", db);

    expect(sanity.ready).toBe(true);

    // Fresh report against a DIFFERENT commit BBB ⇒ supersede: the prior passed
    // row goes `stale` and a fresh `passed` row is created on the same attempt.
    await reportExternalGate(
      {
        runId,
        gateId: "ci",
        status: "passed",
        external: { staleOnNewCommit: true },
        verdict: { commitSha: "BBB", reporterTokenId: "tok-bbb" },
      },
      db,
    );

    // (a) evidence-readiness must read the gate as passed (latest report wins),
    // NOT see the leftover stale row and refuse.
    const after = await assertEvidenceReady(runId, "review", db);

    expect(after.ready).toBe(true);
    expect(after.reasons).toHaveLength(0);

    // (b) readiness DTO: ready, with EXACTLY ONE entry for "ci" at status passed.
    const dto = await getRunReadiness(runId, projectId, db);

    expect(dto).not.toBeNull();

    const ciEntries = dto!.externalGates.filter((g) => g.gateId === "ci");

    expect(ciEntries).toHaveLength(1);
    expect(ciEntries[0].status).toBe("passed");
    expect(dto!.readiness).toBe("ready");
  });
});
