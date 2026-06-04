// SSOT-invariant test (M15, Task 21):
// getRunReadiness / getBoardData / getPortfolio MUST agree on readiness for
// every seeded state. This is the executable form of the SSOT invariant
// documented in docs/system-analytics/readiness.md.
//
// Critical scenario: MISSING required artifact. Before the present-fix
// (current !== null → current != null), getRunReadiness returned "ready" while
// board and portfolio returned "blocked". This test catches that class of
// divergence by asserting all three surfaces return the same value.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { getRunReadiness } from "@/lib/queries/readiness";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getBoardData: typeof import("@/lib/queries/board").getBoardData;
let getPortfolio: typeof import("@/lib/queries/portfolio").getPortfolio;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("readiness_ssot_consistency_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getBoardData } = await import("@/lib/queries/board"));
  ({ getPortfolio } = await import("@/lib/queries/portfolio"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seed a Review-status run that belongs to a project whose single member is
// the returned userId. Returns runId, projectId, userId.
async function seedRunWithGatesAndArtifacts(opts: {
  gates?: Array<{
    kind: string;
    mode: "blocking" | "advisory";
    status: string;
    inputArtifactRefs?: string[];
  }>;
  artifacts?: Array<{
    validity: "current" | "stale" | "failed";
    requiredFor: string[] | null;
    artifactDefId?: string;
  }>;
}): Promise<{ runId: string; projectId: string; userId: string }> {
  const userId = randomUUID();
  const projectId = randomUUID();
  const slug = `ssot-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    name: "SSOT Test User",
    email: `ssot-${userId.slice(0, 8)}@test.com`,
    passwordHash: null,
    role: "member",
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `SSOT Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.projectMembers).values({
    id: randomUUID(),
    userId,
    projectId,
    role: "member",
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
    flowRefId: "ssot-flow",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/ssot",
    manifest: { schemaVersion: 1, name: "ssot", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "SSOT task",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "InFlight",
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
    startedAt: new Date(),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/ssot-${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/${slug}`,
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-06-03T10:00:00.000Z"),
  });

  for (const g of opts.gates ?? []) {
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId,
      gateId: `gate-${randomUUID().slice(0, 8)}`,
      kind: g.kind,
      mode: g.mode,
      status: g.status,
      inputArtifactRefs: g.inputArtifactRefs ?? null,
    });
  }

  for (const a of opts.artifacts ?? []) {
    const defId = a.artifactDefId ?? `def-${randomUUID().slice(0, 8)}`;

    await db.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      nodeAttemptId,
      nodeId: "review",
      attempt: 1,
      artifactDefId: defId,
      kind: "diff",
      producer: "runner",
      locator: { kind: "inline", text: "x" },
      validity: a.validity,
      requiredFor: a.requiredFor,
    });
  }

  return { runId, projectId, userId };
}

// Retrieve the readiness from all three surfaces for a single run.
async function readinessFromAllSurfaces(
  runId: string,
  projectId: string,
  userId: string,
): Promise<{
  readinessQuery: string;
  readinessBoard: string;
  readinessPortfolio: string;
}> {
  const dto = await getRunReadiness(runId, projectId, db);
  const readinessQuery = dto?.readiness ?? "(null dto)";

  const board = await getBoardData(projectId);
  let readinessBoard = "(not found)";

  for (const col of Object.values(board.columns)) {
    const card = col.flight.find((c) => c.runId === runId);

    if (card) {
      readinessBoard = card.readiness;
      break;
    }
  }

  const portfolio = await getPortfolio(userId, "member");
  const proj = portfolio.projects.find((p) => p.id === projectId);
  const ws = proj?.activeWorkspaces.find((w) => w.runId === runId);

  const readinessPortfolio = ws?.readiness ?? "(not found)";

  return { readinessQuery, readinessBoard, readinessPortfolio };
}

describe("SSOT-invariant: getRunReadiness == board == portfolio for every readiness state", () => {
  it("ready: all gates passed → all three surfaces agree on 'ready'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [
        { kind: "command_check", mode: "blocking", status: "passed" },
        { kind: "external_check", mode: "blocking", status: "passed" },
      ],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("ready");
    expect(readinessBoard).toBe("ready");
    expect(readinessPortfolio).toBe("ready");
  });

  it("failed: blocking gate failed → all three surfaces agree on 'failed'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [{ kind: "ai_judgment", mode: "blocking", status: "failed" }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("failed");
    expect(readinessBoard).toBe("failed");
    expect(readinessPortfolio).toBe("failed");
  });

  it("waiting: pending external gate → all three surfaces agree on 'waiting'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [{ kind: "external_check", mode: "blocking", status: "pending" }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("waiting");
    expect(readinessBoard).toBe("waiting");
    expect(readinessPortfolio).toBe("waiting");
  });

  it("overridden: blocking gate overridden → all three surfaces agree on 'overridden'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [{ kind: "skill_check", mode: "blocking", status: "overridden" }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("overridden");
    expect(readinessBoard).toBe("overridden");
    expect(readinessPortfolio).toBe("overridden");
  });

  // Critical regression guard (Task 21 present-fix):
  // Before the fix: getRunReadiness returned "ready" (present: undefined !== null → true)
  // while board and portfolio returned "blocked" (validity !== "current" check).
  // After the fix: all three agree on "blocked".
  it("blocked: MISSING required artifact (no current row) → all three surfaces agree on 'blocked' [Task 21 regression guard]", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      // A stale artifact with requiredFor non-empty. No current-validity row
      // exists for this def → getCurrentArtifact returns undefined → present=false.
      artifacts: [{ validity: "stale", requiredFor: ["review"] }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    // Before the present-fix this was:
    //   readinessQuery: "ready" (BUG — undefined !== null → present=true → not in missingArtifacts)
    //   readinessBoard: "blocked" (correct — validity !== "current")
    //   readinessPortfolio: "blocked" (correct)
    // After the fix all three must be "blocked".
    expect(readinessQuery).toBe("blocked");
    expect(readinessBoard).toBe("blocked");
    expect(readinessPortfolio).toBe("blocked");
  });

  it("blocked: failed-validity required artifact (no current row) → all three agree on 'blocked'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      artifacts: [{ validity: "failed", requiredFor: ["review", "merge"] }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("blocked");
    expect(readinessBoard).toBe("blocked");
    expect(readinessPortfolio).toBe("blocked");
  });

  it("ready: current required artifact → all three surfaces agree on 'ready'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      artifacts: [{ validity: "current", requiredFor: ["review"] }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("ready");
    expect(readinessBoard).toBe("ready");
    expect(readinessPortfolio).toBe("ready");
  });

  it("stale: blocking gate stale → all three surfaces agree on 'stale'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [{ kind: "external_check", mode: "blocking", status: "stale" }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);

    expect(readinessQuery).toBe("stale");
    expect(readinessBoard).toBe("stale");
    expect(readinessPortfolio).toBe("stale");
  });

  // Task 21: a failed artifact_required gate whose inputArtifactRefs are all
  // current again must read CLEAR on every surface AND on the merge guard —
  // assertEvidenceReady re-evaluates, so the read models must too or the badge
  // shows "failed" for a run the engine will merge.
  it("re-eval ready: failed artifact_required gate with refs now current → merge guard + all three surfaces agree on 'ready'", async () => {
    const defId = `def-${randomUUID().slice(0, 8)}`;
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [
        {
          kind: "artifact_required",
          mode: "blocking",
          status: "failed",
          inputArtifactRefs: [defId],
        },
      ],
      artifacts: [
        { validity: "current", requiredFor: null, artifactDefId: defId },
      ],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);
    const guard = await assertEvidenceReady(runId, "merge", db);

    expect(guard.ready).toBe(true);
    expect(readinessQuery).toBe("ready");
    expect(readinessBoard).toBe("ready");
    expect(readinessPortfolio).toBe("ready");
  });

  it("re-eval blocked: failed artifact_required gate with refs still missing → merge guard + all three surfaces agree on 'failed'", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      gates: [
        {
          kind: "artifact_required",
          mode: "blocking",
          status: "failed",
          inputArtifactRefs: [`def-${randomUUID().slice(0, 8)}`],
        },
      ],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);
    const guard = await assertEvidenceReady(runId, "merge", db);

    expect(guard.ready).toBe(false);
    expect(readinessQuery).toBe("failed");
    expect(readinessBoard).toBe("failed");
    expect(readinessPortfolio).toBe("failed");
  });

  // Finding 2 (codex adversarial review): the read-models are an any-phase
  // fail-closed SUPERSET of the phase-scoped enforcer. A merge-only required
  // artifact (no current row) blocks all three read-model badges, but the
  // phase-scoped Review enforcer ignores it (it is not requiredFor:["review"]).
  // The merge enforcer DOES block. This divergence is intentional and documented
  // in readiness.md (Readiness classifier → artifact phase-scope). Pinning it
  // here prevents the any-phase read-model semantics from being silently narrowed.
  it("merge-only missing artifact: read-models 'blocked', review enforcer ready, merge enforcer blocked [Finding 2]", async () => {
    const { runId, projectId, userId } = await seedRunWithGatesAndArtifacts({
      // requiredFor: ["merge"] only; stale (no current row) → not satisfied.
      artifacts: [{ validity: "stale", requiredFor: ["merge"] }],
    });

    const { readinessQuery, readinessBoard, readinessPortfolio } =
      await readinessFromAllSurfaces(runId, projectId, userId);
    const reviewGuard = await assertEvidenceReady(runId, "review", db);
    const mergeGuard = await assertEvidenceReady(runId, "merge", db);

    // Any-phase read-models: a merge-required missing artifact still blocks the badge.
    expect(readinessQuery).toBe("blocked");
    expect(readinessBoard).toBe("blocked");
    expect(readinessPortfolio).toBe("blocked");

    // Phase-scoped enforcer: Review does NOT require the merge-only artifact…
    expect(reviewGuard.ready).toBe(true);
    // …but Merge does.
    expect(mergeGuard.ready).toBe(false);
  });
});
