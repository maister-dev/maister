// RED (M16 Phase 4 §E): end-to-end external_check gate loop driven through the
// real runner (runFlow), exercising the review chokepoint.
//
// Derived from the FROZEN spec:
//   - docs/system-analytics/external-operations.md §"Gate-report: gate flip,
//     test_report artifact, review refusal" + §Expectations + §"State machine —
//     external_check gate".
//
// Contract (each step asserts a runner-observable run.status):
//   1. blocking external_check 'pending' → review terminal transition REFUSED
//      (run cannot complete review: assertEvidenceReady not-ready → node Failed
//      with PRECONDITION → run Failed, mirroring the artifact_required path in
//      review-refusal.integration.test.ts).
//   2. after reportExternalGate(status: passed) → review ALLOWED (run → Review).
//   3. after markDownstreamStale re-stales the passed gate (existing path, NO new
//      code) → review REFUSED again.
//   4. after markGateOverridden → review ADMITTED (run → Review).
//
// The flow declares compat.engine_min "1.2.0" so artifactEnforcementActive is on
// and the runner's review-evidence guard (runner-graph.ts ~1244) consults
// assertEvidenceReady("review"), which §C extends for external_check gates.
//
// reportExternalGate does NOT exist yet → import fails → RED. Even with the
// import stubbed, step 1 is RED until §C extends assertEvidenceReady (today a
// pending external_check is ignored and the run wrongly reaches Review).

import type { Run, GateResult } from "@/lib/db/schema";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
import { markDownstreamStale } from "@/lib/flows/graph/ledger";
import { markGateOverridden } from "@/lib/flows/graph/gate-store";
// RED: reportExternalGate does not exist yet (§B).
import { reportExternalGate } from "@/lib/flows/graph/gate-store";
import { runFlow } from "@/lib/flows/runner";

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

type Seeded = { runId: string; slug: string; runtimeRoot: string };

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

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
    manifest,
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
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getExternalGate(runId: string): Promise<GateResult> {
  const rows = (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.runId, runId))) as unknown as GateResult[];

  const ext = rows.find((g) => g.kind === "external_check");

  if (!ext) throw new Error("no external_check gate row found for run");

  return ext;
}

async function writeDecision(
  seeded: Seeded,
  nodeId: string,
  decision: string,
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify({ decision }),
    "utf8",
  );
}

// The external_check gate lives on the `work` node's pre_finish: a cli node
// finishes during the FIRST runFlow pass, so its external_check stub records the
// `pending` gate row up front (before the review HITL pause), modelling a CI gate
// that exists and awaits a report. The review chokepoint
// (assertEvidenceReady("review"), §C-extended) then consults that run-level
// external_check gate when the review node attempts its terminal transition.
function reviewFlowWithExternalGate() {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.2.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "echo work" },
        pre_finish: {
          gates: [
            {
              id: "ci",
              kind: "external_check",
              mode: "blocking",
              external: { description: "CI suite", staleOnNewCommit: true },
            },
          ],
        },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: {
          human: { role: "maintainer", decisions: ["approve"] },
        },
        transitions: { approve: "done" },
      },
    ],
  };
}

describe("external_check gate loop — review chokepoint (M16 §E)", () => {
  it("blocking external_check pending refuses review; passed report allows it; re-stale refuses; override admits", async () => {
    const seeded = await seedGraphRun(reviewFlowWithExternalGate());

    // First pass: work runs, review node pauses for HITL → NeedsInput. The
    // external_check stub records a `pending` gate during pre_finish evaluation.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    const extGate = await getExternalGate(seeded.runId);

    expect(extGate.status).toBe("pending");

    // STEP 1: approve while the external gate is still pending → review REFUSED.
    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).not.toBe("Done");
    expect(run.status).toBe("Failed"); // PRECONDITION review-refusal
  });

  it("STEP 2: a passed external gate report ALLOWS review to complete", async () => {
    const seeded = await seedGraphRun(reviewFlowWithExternalGate());

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const extGate = await getExternalGate(seeded.runId);

    // CI reports a pass against the run's commit.
    await reportExternalGate(
      {
        runId: seeded.runId,
        gateId: extGate.gateId,
        status: "passed",
        verdict: { commitSha: "abc", reporterTokenId: "tok" },
      },
      db,
    );

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
  });

  it("STEP 3: re-staling the passed gate (markDownstreamStale, existing path) REFUSES review again", async () => {
    const seeded = await seedGraphRun(reviewFlowWithExternalGate());

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const extGate = await getExternalGate(seeded.runId);

    await reportExternalGate(
      {
        runId: seeded.runId,
        gateId: extGate.gateId,
        status: "passed",
        verdict: { commitSha: "abc", reporterTokenId: "tok" },
      },
      db,
    );

    // Existing rework/takeover path flips passed → stale. NO new code: assert it
    // actually re-stales the gate, then re-drive review and expect refusal.
    const { staledGates } = await markDownstreamStale(
      seeded.runId,
      ["work"],
      db,
    );

    expect(staledGates).toBeGreaterThan(0);
    expect((await getExternalGate(seeded.runId)).status).toBe("stale");

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).not.toBe("Done");
    expect(run.status).toBe("Failed");
  });

  it("STEP 4: markGateOverridden on the stale gate ADMITS review", async () => {
    const seeded = await seedGraphRun(reviewFlowWithExternalGate());

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let extGate = await getExternalGate(seeded.runId);

    await reportExternalGate(
      {
        runId: seeded.runId,
        gateId: extGate.gateId,
        status: "passed",
        verdict: { commitSha: "abc", reporterTokenId: "tok" },
      },
      db,
    );
    await markDownstreamStale(seeded.runId, ["work"], db);

    extGate = await getExternalGate(seeded.runId);
    expect(extGate.status).toBe("stale");

    // Human override admits the run past the stale external gate (override
    // without erasure — the prior verdict is retained, status → overridden).
    await markGateOverridden(extGate.id, "hitl-override-1", db);
    expect((await getExternalGate(seeded.runId)).status).toBe("overridden");

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
  });
});
