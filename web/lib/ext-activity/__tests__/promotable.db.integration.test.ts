import type { ReadinessState } from "@/lib/flows/graph/readiness-core";

import { randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Spy wrappers around the REAL implementations: T-A3 asserts call counts while
// the classifier still runs against real Postgres.
vi.mock("@/lib/queries/readiness-batch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/readiness-batch")>();

  return { computeReadinessByRun: vi.fn(actual.computeReadinessByRun) };
});

vi.mock("@/lib/queries/readiness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/readiness")>();

  return { ...actual, getRunReadiness: vi.fn(actual.getRunReadiness) };
});

import * as schema from "@/lib/db/schema";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { listProjectPromotable } from "@/lib/ext-activity/promotable";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import { getRunReadiness } from "@/lib/queries/readiness";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let projectId: string;

// One blocking gate whose status drives the whole run's rolled-up readiness.
// gateStatusContribution maps each status to exactly one contribution, and a
// single contribution rolls up to itself — so this table IS the six-state
// matrix REQ-A6 requires, `overridden` included.
const GATE_STATUS_BY_STATE: Record<
  ReadinessState,
  "passed" | "overridden" | "failed" | "stale" | "skipped" | "pending"
> = {
  ready: "passed",
  overridden: "overridden",
  failed: "failed",
  stale: "stale",
  blocked: "skipped",
  waiting: "pending",
};

const ALL_READINESS_STATES = Object.keys(
  GATE_STATUS_BY_STATE,
) as ReadinessState[];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_activity_promotable_test",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  vi.mocked(computeReadinessByRun).mockClear();
  vi.mocked(getRunReadiness).mockClear();
  await testDatabase.db.delete(schema.projects);

  projectId = randomUUID();
  await testDatabase.db.insert(schema.projects).values({
    id: projectId,
    slug: `promotable-${randomUUID().slice(0, 8)}`,
    name: "Promotable fixtures",
    repoPath: `/tmp/promotable-${randomUUID().slice(0, 8)}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: `T${randomUUID().slice(0, 7)}`.toUpperCase(),
  });
});

async function seedReviewRun(input: {
  readiness?: ReadinessState;
  status?: string;
  runKind?: "flow" | "scratch" | "agent";
  promotionHold?: boolean;
  launchedParticipant?: boolean;
  reviewEnteredAt?: Date | null;
  targetBranch?: string | null;
}): Promise<string> {
  const db = testDatabase.db;
  const runId = randomUUID();
  const taskId = randomUUID();
  const suffix = runId.slice(0, 8);

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: `Task ${suffix}`,
    prompt: "p",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind: input.runKind ?? "flow",
    status: (input.status ?? "Review") as never,
    flowVersion: "v1.0.0",
    flowRevision: "manual",
    reviewEnteredAt:
      input.reviewEnteredAt === undefined
        ? new Date("2026-07-27T09:00:00.000Z")
        : input.reviewEnteredAt,
    promotionHold: input.promotionHold
      ? { source: "user", createdAt: new Date().toISOString() }
      : null,
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `feature/${suffix}`,
    worktreePath: `/tmp/wt-${suffix}`,
    parentRepoPath: "/tmp/repo",
    targetBranch:
      input.targetBranch === undefined ? "main" : input.targetBranch,
  });

  if (input.readiness) {
    const attemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId,
      nodeId: "review",
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      gateId: "the-gate",
      kind: "command_check",
      mode: "blocking",
      status: GATE_STATUS_BY_STATE[input.readiness],
    });
  }

  if (input.launchedParticipant) {
    const studyId = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: studyId,
      projectId,
      taskId,
      title: `Study ${suffix}`,
      status: "open",
    });
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId,
      sourceType: "launched",
      label: `P-${suffix}`,
    });
  }

  return runId;
}

describe("T-A6 / REQ-A6 — the batched classifier and the merge guard agree on Layer 1", () => {
  it("agrees biconditionally across ALL SIX ReadinessState values, including overridden", async () => {
    const runIdByState = new Map<ReadinessState, string>();

    for (const state of ALL_READINESS_STATES) {
      runIdByState.set(state, await seedReviewRun({ readiness: state }));
    }

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });
    const promotableIds = new Set(promotable.map((item) => item.runId));

    expect(ALL_READINESS_STATES).toHaveLength(6);

    for (const state of ALL_READINESS_STATES) {
      const runId = runIdByState.get(state)!;
      // V9': assertEvidenceReady NEVER throws — it returns {ready, reasons},
      // and every correct consumer reads `.ready`. Comparing "did not throw"
      // would make this whole matrix vacuous.
      const guard = await assertEvidenceReady(runId, "review", testDatabase.db);

      expect({ state, included: promotableIds.has(runId) }).toEqual({
        state,
        included: guard.ready,
      });
    }
  });

  it('REQ-A6 AC2 — the `overridden` run is promotable, which a `state === "ready"` test would have dropped', async () => {
    const overriddenRunId = await seedReviewRun({ readiness: "overridden" });
    const readiness = await computeReadinessByRun(testDatabase.db, [
      overriddenRunId,
    ]);

    expect(readiness.get(overriddenRunId)).toBe("overridden");

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable.map((item) => item.runId)).toContain(overriddenRunId);
  });
});

describe("T-A2b / REQ-A2 AC2 — Layer 2 withholds runs a human promote WOULD accept", () => {
  it("excludes a green Review run under a promotion hold, and the merge guard still reports it ready", async () => {
    const heldRunId = await seedReviewRun({
      readiness: "ready",
      promotionHold: true,
    });
    const plainRunId = await seedReviewRun({ readiness: "ready" });

    // The exclusion and its REASON are asserted separately, so this test
    // documents an intentional divergence rather than encoding one by accident.
    const guard = await assertEvidenceReady(
      heldRunId,
      "review",
      testDatabase.db,
    );

    expect(guard.ready).toBe(true);

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable.map((item) => item.runId)).toEqual([plainRunId]);
  });

  it("excludes a green launched-lineage participant, and the merge guard still reports it ready", async () => {
    const lineageRunId = await seedReviewRun({
      readiness: "ready",
      launchedParticipant: true,
    });
    const plainRunId = await seedReviewRun({ readiness: "ready" });

    const guard = await assertEvidenceReady(
      lineageRunId,
      "review",
      testDatabase.db,
    );

    expect(guard.ready).toBe(true);

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable.map((item) => item.runId)).toEqual([plainRunId]);
  });
});

describe("T-A3 / REQ-A3 — readiness for the pulse is bulk-computed", () => {
  it("calls computeReadinessByRun exactly once and getRunReadiness never, at N = 1", async () => {
    await seedReviewRun({ readiness: "ready" });

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable).toHaveLength(1);
    expect(vi.mocked(computeReadinessByRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getRunReadiness)).not.toHaveBeenCalled();
  });

  it("still calls computeReadinessByRun exactly once at N = 12 (a per-run implementation would call 12)", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedReviewRun({ readiness: "ready" });
    }

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable).toHaveLength(12);
    expect(vi.mocked(computeReadinessByRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(computeReadinessByRun).mock.calls[0][1]).toHaveLength(12);
    expect(vi.mocked(getRunReadiness)).not.toHaveBeenCalled();
  });
});

describe("REQ-A2 AC1 / AC4 — the allow-list and the ordering hold against real rows", () => {
  it("admits only flow runs in Review", async () => {
    const flowReviewId = await seedReviewRun({ readiness: "ready" });

    await seedReviewRun({ readiness: "ready", runKind: "agent" });
    await seedReviewRun({ readiness: "ready", status: "Running" });
    await seedReviewRun({ readiness: "ready", status: "Done" });

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable.map((item) => item.runId)).toEqual([flowReviewId]);
  });

  it("orders by inReviewSince ascending with nulls last", async () => {
    const late = await seedReviewRun({
      readiness: "ready",
      reviewEnteredAt: new Date("2026-07-27T18:00:00.000Z"),
    });
    const nullish = await seedReviewRun({
      readiness: "ready",
      reviewEnteredAt: null,
    });
    const early = await seedReviewRun({
      readiness: "ready",
      reviewEnteredAt: new Date("2026-07-27T06:00:00.000Z"),
    });

    const promotable = await listProjectPromotable(projectId, {
      db: testDatabase.db,
    });

    expect(promotable.map((item) => item.runId)).toEqual([
      early,
      late,
      nullish,
    ]);
  });
});
