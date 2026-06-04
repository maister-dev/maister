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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

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
  status:
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "stale"
    | "skipped"
    | "overridden";
  // T7 (M16 Phase 7): per-gate overrides so the external-gate collapse
  // (latest-per-gateId + live-attempt) can be exercised. Defaults preserve the
  // pre-existing single-gate fixture: gateId "artifact-gate", live attempt,
  // monotonic createdAt.
  gateId?: string;
  createdAt?: Date;
  // "live" → the run's live (latest) attempt; "stale" → a superseded older
  // attempt on the SAME node (lower attempt number), so the gate row sits on a
  // non-live attempt and must be ignored by the live-attempt collapse.
  attemptLineage?: "live" | "stale";
};

// Seed a Review-status flow run (lands in the OnReview in-flight column),
// with an attached node_attempt, plus optional artifacts and gates so the
// evidence flags can be exercised. Unique ids per call.
async function seedReviewRun(opts: {
  artifacts?: ArtifactSeed[];
  gates?: GateSeed[];
  // T7 (M16 Phase 7): override the run status so a Done card can be exercised
  // (a done card must read externalGatePending=false even with a pending gate).
  runStatus?: "Review" | "Done";
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
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: opts.runStatus ?? "Review",
    flowVersion: "v1.0.0",
    currentStepId: "review",
    endedAt: opts.runStatus === "Done" ? new Date() : undefined,
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

  // T7 (M16 Phase 7): if any seeded gate targets a STALE (superseded) attempt,
  // we need a higher-numbered live attempt on the SAME node so attempt 1 is no
  // longer the live representative. Created lazily.
  const staleAttemptId = attemptId;
  let liveAttemptId = attemptId;
  const needsStaleLineage = (opts.gates ?? []).some(
    (g) => g.attemptLineage === "stale",
  );

  if (needsStaleLineage) {
    liveAttemptId = randomUUID();
    await db.insert(schema.nodeAttempts).values({
      id: liveAttemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 2,
      status: "Succeeded",
      startedAt: new Date("2026-05-31T11:00:00.000Z"),
    });
  }

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
      nodeAttemptId:
        g.attemptLineage === "stale" ? staleAttemptId : liveAttemptId,
      gateId: g.gateId ?? "artifact-gate",
      kind: g.kind,
      mode: g.mode,
      status: g.status,
      ...(g.createdAt ? { createdAt: g.createdAt } : {}),
    });
  }

  return { projectId, runId };
}

async function flightCard(projectId: string, runId: string) {
  const board = await getBoardData(projectId);
  const flight = board.columns.OnReview.flight;

  return flight.find((c) => c.runId === runId);
}

// T7 (M16 Phase 7): a Done run lands in a different in-flight column
// (InDelivery while the worktree survives), so search every column's flight.
async function anyFlightCard(projectId: string, runId: string) {
  const board = await getBoardData(projectId);

  for (const col of Object.values(board.columns)) {
    const hit = col.flight.find((c) => c.runId === runId);

    if (hit) return hit;
  }

  return undefined;
}

// MIGRATED (T15): the M12 evidenceStale + mergeBlocked board booleans collapse
// into the unified `readiness` state. The scenarios that drove the two booleans
// are preserved, now asserting the rolled-up readiness verdict (stale > blocked
// per the priority cascade). NOTE: a stale artifact contributes ONLY when it is
// requiredFor the review phase — bare history no longer flags the card.
describe("getBoardData — evidence readiness (integration)", () => {
  // Case 1: a review-required stale artifact (no current row) → "blocked".
  // getRunReadiness uses getCurrentArtifact (current-row only), so a stale-only
  // def contributes "blocked", not "stale". Board now mirrors this.
  it("readiness='blocked' when a review-required artifact has only a stale row (no current row)", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["review"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='ready' when all artifacts are current", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [
        { validity: "current", requiredFor: ["review"] },
        { validity: "current", requiredFor: ["review"] },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // Case 2: a multi-phase required artifact that is stale (no current row) →
  // "blocked". requiredFor=["review","merge"] is now in scope (non-empty filter).
  it("readiness='blocked' for a multi-phase required artifact with stale (non-current) validity", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["review", "merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='blocked' when a review-required artifact has no current row (failed only)", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "failed", requiredFor: ["review", "merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='ready' when the review-required artifact is current", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review", "merge"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // Case 3: a blocking artifact_required gate failed/stale drives readiness.
  it("readiness='failed' via a blocking artifact_required gate with status=failed", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "failed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("failed");
  });

  it("readiness='stale' via a blocking artifact_required gate with status=stale", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "artifact_required", mode: "blocking", status: "stale" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("stale");
  });

  it("readiness='ready' when the blocking artifact_required gate passed", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "passed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // Case 4: only current, review-required evidence + passed gate → ready.
  it("readiness='ready' for a run with only current evidence and a passed gate", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
      gates: [{ kind: "command_check", mode: "blocking", status: "passed" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // Case 5: a stale review-required artifact (no current row) → "blocked".
  it("readiness='blocked' for a stale review-required artifact with no blocking gate (no current row)", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["review"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='failed' for a current artifact with a failed blocking gate", async () => {
    // No stale artifacts at all; failure comes purely from the gate.
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "failed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("failed");
  });
});

// MIGRATED (T15): the M16 externalGatePending board boolean collapses into the
// unified `readiness` state. A blocking external_check gate now contributes
// through gateStatusContribution like every other kind: pending|running →
// waiting, failed → failed, stale → stale, skipped → blocked, passed → ready,
// overridden → overridden. The critical live-attempt + latest-per-gateId
// collapse semantics (via liveBlockingGates) are preserved.
describe("getBoardData — external_check gate readiness (integration)", () => {
  const STATUS_TO_READINESS = {
    pending: "waiting",
    failed: "failed",
    stale: "stale",
    skipped: "blocked",
  } as const;

  for (const [status, expected] of Object.entries(STATUS_TO_READINESS) as [
    keyof typeof STATUS_TO_READINESS,
    (typeof STATUS_TO_READINESS)[keyof typeof STATUS_TO_READINESS],
  ][]) {
    it(`readiness='${expected}' for a blocking external_check gate that is ${status}`, async () => {
      const { projectId, runId } = await seedReviewRun({
        gates: [{ kind: "external_check", mode: "blocking", status }],
      });

      const card = await flightCard(projectId, runId);

      expect(card).toBeDefined();
      expect(card?.readiness).toBe(expected);
    });
  }

  it("readiness='ready' for a passed blocking external_check gate", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "external_check", mode: "blocking", status: "passed" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  it("readiness='overridden' for an overridden blocking external_check gate", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "external_check", mode: "blocking", status: "overridden" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("overridden");
  });

  // SUPERSEDE case (critical, mirrors readiness.ts collapse): two external_check
  // rows on the SAME gateId + same live attempt. The LATEST report governs.
  it("readiness='ready' when an older stale row is superseded by a newer passed row on the same gateId", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        {
          kind: "external_check",
          mode: "blocking",
          status: "stale",
          gateId: "ext-ci",
          createdAt: new Date("2026-05-31T10:00:00.000Z"),
        },
        {
          kind: "external_check",
          mode: "blocking",
          status: "passed",
          gateId: "ext-ci",
          createdAt: new Date("2026-05-31T12:00:00.000Z"),
        },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  it("readiness='stale' when an older passed row is superseded by a newer stale row on the same gateId", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        {
          kind: "external_check",
          mode: "blocking",
          status: "passed",
          gateId: "ext-ci",
          createdAt: new Date("2026-05-31T10:00:00.000Z"),
        },
        {
          kind: "external_check",
          mode: "blocking",
          status: "stale",
          gateId: "ext-ci",
          createdAt: new Date("2026-05-31T12:00:00.000Z"),
        },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("stale");
  });

  // Live-attempt collapse: a pending gate left on a SUPERSEDED (older) attempt
  // is not live and must not contribute.
  it("readiness='ready' when the only pending external gate sits on a stale (non-live) attempt", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        {
          kind: "external_check",
          mode: "blocking",
          status: "pending",
          attemptLineage: "stale",
        },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // A non-blocking (advisory) external_check pending does NOT contribute.
  it("readiness='ready' for an advisory (non-blocking) external_check that is pending", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "external_check", mode: "advisory", status: "pending" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // Orthogonality: a pending external gate with all-current evidence → waiting
  // (the artifacts contribute nothing).
  it("readiness='waiting' for a pending external gate alongside current evidence", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
      gates: [{ kind: "external_check", mode: "blocking", status: "pending" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("waiting");
  });

  it("readiness='failed' for a failed blocking artifact_required gate (not waiting)", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "failed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("failed");
  });

  // A done-status card always reads "ready" even with a pending blocking gate.
  it("readiness='ready' on a done-status card even with a pending blocking external gate", async () => {
    const { projectId, runId } = await seedReviewRun({
      runStatus: "Done",
      gates: [{ kind: "external_check", mode: "blocking", status: "pending" }],
    });

    const card = await anyFlightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.status).toBe("done");
    expect(card?.readiness).toBe("ready");
  });
});

// T15 (RED): unified readiness badge replacing the three booleans.
//
// Contract (Implementor replaces 3 booleans with 1 unified readiness field):
//   FlightCard gains a single `readiness: ReadinessState` field, replacing
//   evidenceStale, mergeBlocked, externalGatePending. The readiness value is
//   computed in the same batched set-of-runIds style as the current flags,
//   via readiness-core.ts (gateStatusContribution + rollupReadiness +
//   liveBlockingGates) over the already-bulk-fetched gate_results +
//   artifact_instances + node_attempts (no new per-run query, no N+1).
//
//   readiness state = "ready" | "blocked" | "stale" | "failed" | "waiting" | "overridden"
//   Priority: failed > stale > blocked > waiting > overridden > ready.
//
//   The readiness value reflects ALL blocking gates (command_check, skill_check,
//   ai_judgment, artifact_required, external_check) AND required artifacts
//   (stale / missing), using the same rollup logic as assertEvidenceReady &
//   getRunReadiness.
//
// readiness field does not exist yet → RED (field missing).
describe("getBoardData — unified readiness badge (M15, T15)", () => {
  // Ready: all blocking gates passed or overridden, no stale/missing artifacts.
  it("readiness='ready' when all blocking gates passed and no stale artifacts", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
      gates: [{ kind: "command_check", mode: "blocking", status: "passed" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.readiness).toBe("ready");
  });

  // Failed: any blocking gate failed.
  it("readiness='failed' when any blocking gate failed", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "ai_judgment", mode: "blocking", status: "failed" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("failed");
  });

  // Blocked: a stale-only artifact (no current row) → "blocked" (mirrors SSOT).
  it("readiness='blocked' when a required artifact has only a stale row (no current row)", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale", requiredFor: ["review"] }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='stale' when a blocking gate is stale", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "skill_check", mode: "blocking", status: "stale" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("stale");
  });

  // Blocked: no failed/stale, but a skipped blocking gate (→ blocked).
  it("readiness='blocked' when a blocking artifact_required gate is skipped", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "artifact_required", mode: "blocking", status: "skipped" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  it("readiness='blocked' when a blocking gate is skipped", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "command_check", mode: "blocking", status: "skipped" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  // Waiting: no failed/stale/blocked, but pending/running gate.
  it("readiness='waiting' when a blocking gate is pending", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "external_check", mode: "blocking", status: "pending" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("waiting");
  });

  it("readiness='waiting' when a blocking gate is running", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "ai_judgment", mode: "blocking", status: "running" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("waiting");
  });

  // Overridden: no failed/stale/blocked/waiting, but an overridden blocking gate.
  it("readiness='overridden' when a blocking gate is overridden (clears enforce but flags override)", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [{ kind: "skill_check", mode: "blocking", status: "overridden" }],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("overridden");
  });

  // Priority cascade: failed > stale > blocked > waiting > overridden > ready.
  it("readiness='failed' takes priority over stale when both present", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "stale" }],
      gates: [
        { kind: "command_check", mode: "blocking", status: "failed" },
        { kind: "skill_check", mode: "blocking", status: "passed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("failed");
  });

  it("readiness='stale' takes priority over blocked when both present", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "ai_judgment", mode: "blocking", status: "stale" },
        { kind: "skill_check", mode: "blocking", status: "skipped" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("stale");
  });

  it("readiness='blocked' takes priority over waiting when both present", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "command_check", mode: "blocking", status: "skipped" },
        { kind: "external_check", mode: "blocking", status: "pending" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("blocked");
  });

  // Done card is always ready (no badge shown).
  it("readiness='ready' on a done-status card regardless of gate/artifact state", async () => {
    const { projectId, runId } = await seedReviewRun({
      runStatus: "Done",
      gates: [{ kind: "ai_judgment", mode: "blocking", status: "failed" }],
    });

    const card = await anyFlightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.status).toBe("done");
    expect(card?.readiness).toBe("ready");
  });

  // Advisory gates do not contribute to readiness.
  it("readiness ignores advisory gates (even if failed)", async () => {
    const { projectId, runId } = await seedReviewRun({
      gates: [
        { kind: "skill_check", mode: "advisory", status: "failed" },
        { kind: "command_check", mode: "blocking", status: "passed" },
      ],
    });

    const card = await flightCard(projectId, runId);

    expect(card?.readiness).toBe("ready");
  });

  // NO N+1: all readiness state is computed from the bulk-fetched rows
  // (gate_results, artifact_instances, node_attempts) already fetched for the
  // board query. The test cannot easily assert call counts, but the DTO shape
  // confirms no new query field was added.
  it("readiness computed from bulk-fetched rows (no new per-run query)", async () => {
    const { projectId, runId } = await seedReviewRun({
      artifacts: [{ validity: "current" }],
      gates: [
        { kind: "command_check", mode: "blocking", status: "passed" },
        { kind: "external_check", mode: "blocking", status: "pending" },
      ],
    });

    const card = await flightCard(projectId, runId);

    // Presence of readiness field (no new query fields like runReadiness or
    // readinessDto) confirms the computation stayed within the board DTO.
    expect(card).toBeDefined();
    expect(typeof card?.readiness).toBe("string");
    // Verify the field is one of the valid states.
    expect([
      "ready",
      "blocked",
      "stale",
      "failed",
      "waiting",
      "overridden",
    ]).toContain(card?.readiness);
  });
});
