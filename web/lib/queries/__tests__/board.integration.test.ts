// T7.3 (RED): failing integration tests for the board evidence badge.
//
// Contract (Implementor extends FlightCard + getBoardData):
//   FlightCard gains two booleans, computed in the same batched
//   set-of-runIds style as the existing reworking/refused flags:
//   - evidenceStale: ≥1 artifact_instances row with validity = "stale".
//   - mergeBlocked:  (a) ≥1 artifact_instances row whose requiredFor JSONB
//                        contains "merge" AND validity != "current", OR
//                    (b) ≥1 gate_results row kind="artifact_required",
//                        mode="blocking", status IN ('failed','stale').
//
// These flags don't exist on FlightCard yet → RED (undefined at runtime; the
// assertions presuppose the impl). Existing board tests are untouched.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches board-takeover.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getBoardData: typeof import("@/lib/queries/board").getBoardData;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("board_evidence_test")
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

type ArtifactSeed = {
  validity: "current" | "stale" | "superseded" | "failed";
  requiredFor?: ("review" | "merge")[] | null;
};

type GateSeed = {
  kind:
    | "command_check"
    | "skill_check"
    | "ai_judgment"
    | "artifact_required"
    | "external_check"
    | "human_review";
  mode: "blocking" | "advisory";
  status: "pending" | "running" | "passed" | "failed" | "stale" | "skipped";
};

// Seed a Review-status flow run (lands in the OnReview in-flight column),
// with an attached node_attempt, plus optional artifacts and gates so the
// evidence flags can be exercised. Unique ids per call.
async function seedReviewRun(opts: {
  artifacts?: ArtifactSeed[];
  gates?: GateSeed[];
}): Promise<{ projectId: string; runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const attemptId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Board Evidence Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
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
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "evidence task",
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
    executorId,
    status: "Review",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "maister/evidence-1",
    worktreePath: `/tmp/${slug}/wt`,
    parentRepoPath: `/tmp/${slug}`,
  });
  await db.insert(schema.nodeAttempts).values({
    id: attemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
  });

  for (const a of opts.artifacts ?? []) {
    await db.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      nodeId: "review",
      attempt: 1,
      artifactDefId: "impl-diff",
      kind: "diff",
      producer: "runner",
      locator: { kind: "inline", text: "x" },
      validity: a.validity,
      requiredFor: a.requiredFor ?? null,
    });
  }

  for (const g of opts.gates ?? []) {
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      gateId: "artifact-gate",
      kind: g.kind,
      mode: g.mode,
      status: g.status,
    });
  }

  return { projectId, runId };
}

async function flightCard(projectId: string, runId: string) {
  const board = await getBoardData(projectId);
  const flight = board.columns.OnReview.flight;

  return flight.find((c) => c.runId === runId);
}

describe("getBoardData — evidence badge flags (integration)", () => {
  // Case 1: evidenceStale true with a stale artifact; false when all current.
  it("evidenceStale=true when the run has a stale artifact", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.evidenceStale).toBe(true);
  });

  it("evidenceStale=false when all artifacts are current", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current" }, { validity: "current" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.evidenceStale).toBe(false);
  });

  // Case 2: mergeBlocked via path (a) — requiredFor:["merge"] artifact not current.
  it("mergeBlocked=true via a requiredFor:['merge'] artifact with non-current validity", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(true);
  });

  it("mergeBlocked=true when a merge-required artifact is failed", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "failed", requiredFor: ["review", "merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(true);
  });

  it("mergeBlocked=false when the merge-required artifact is current", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(false);
  });

  // Case 3: mergeBlocked via path (b) — blocking artifact_required gate failed/stale.
  it("mergeBlocked=true via a blocking artifact_required gate with status=failed", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "failed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(true);
  });

  it("mergeBlocked=true via a blocking artifact_required gate with status=stale", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "artifact_required", mode: "blocking", status: "stale" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(true);
  });

  it("mergeBlocked=false when the blocking artifact_required gate passed", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "passed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.mergeBlocked).toBe(false);
  });

  // Case 4: neither stale artifacts nor merge-blocking evidence → both false.
  it("both flags false for a run with only current, non-merge-required evidence", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
      gates: [{ kind: "command_check", mode: "blocking", status: "passed" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.evidenceStale).toBe(false);
    expect(card?.mergeBlocked).toBe(false);
  });

  // Case 5: the two flags are independent.
  it("flags are independent: evidenceStale=true while mergeBlocked=false", async () => {
    // A stale artifact that is NOT merge-required, and no blocking gate.
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["review"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.evidenceStale).toBe(true);
    expect(card?.mergeBlocked).toBe(false);
  });

  it("flags are independent: mergeBlocked=true while evidenceStale=false", async () => {
    // No stale artifacts at all; merge blocked purely via the gate.
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current" }],
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "failed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.evidenceStale).toBe(false);
    expect(card?.mergeBlocked).toBe(true);
  });
});
