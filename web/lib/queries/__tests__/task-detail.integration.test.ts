import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-119 / T4.3 — the runs-history table renders at most the 10 NEWEST runs,
// while the count chip + token aggregates reflect the TRUE total over ALL runs.
// Real Postgres so the SQL-aggregate split (totals over all, rows limited to 10)
// is exercised end to end.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db, db: () => db }));

let getTaskDetail: typeof import("@/lib/queries/task-detail").getTaskDetail;

const RUN_COUNT = 12;
const PER_RUN = {
  input: 100,
  output: 10,
  cacheRead: 1,
  cacheCreation: 1,
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "task_detail_cap_test",
  });

  db = testDatabase.db;

  await db.insert(schema.users).values({
    id: "u-1",
    email: "u1@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(schema.projects).values({
    id: "proj-cap",
    slug: "proj-cap",
    name: "Cap",
    taskKey: "CAP",
    repoPath: "/repos/proj-cap",
    mainBranch: "main",
    maisterYamlPath: "/repos/proj-cap/maister.yaml",
  });
  await db.insert(schema.projectMembers).values({
    id: "pm-1",
    projectId: "proj-cap",
    userId: "u-1",
    role: "member",
  });
  await db.insert(schema.tasks).values({
    id: "task-cap",
    projectId: "proj-cap",
    number: 42,
    title: "cap task",
    prompt: "do it",
  });

  const base = Date.parse("2026-06-01T00:00:00Z");

  for (let i = 0; i < RUN_COUNT; i += 1) {
    const runId = `run-${String(i).padStart(2, "0")}`;

    await db.insert(schema.runs).values({
      id: runId,
      runKind: "flow",
      projectId: "proj-cap",
      taskId: "task-cap",
      flowVersion: "v1.0.0",
      status: "Done",
      startedAt: new Date(base + i * 60_000),
      endedAt: new Date(base + i * 60_000 + 30_000),
    });
    await db.insert(schema.runCostRollups).values({
      runId,
      projectId: "proj-cap",
      taskId: "task-cap",
      inputTokens: PER_RUN.input,
      outputTokens: PER_RUN.output,
      cacheReadTokens: PER_RUN.cacheRead,
      cacheCreationTokens: PER_RUN.cacheCreation,
    });
  }

  await db.insert(schema.hitlRequests).values({
    id: "hitl-cap-1",
    runId: "run-11",
    stepId: "agent",
    kind: "agent_question",
    taskId: "task-cap",
    activationState: "active",
    reTriggerMode: "agent",
    schema: { schemaVersion: 1, fields: [] },
    prompt: "Which environment?",
  });
  await db.insert(schema.taskClarifications).values({
    id: "clarification-cap-1",
    taskId: "task-cap",
    seq: 1,
    sourceHitlRequestId: "hitl-cap-1",
    originRunId: "run-11",
    originAgentId: "core:triager",
    question: "Which environment?",
    questionSchema: { schemaVersion: 1, fields: [] },
    reTriggerMode: "agent",
    answer: { environment: "production" },
    answeredByUserId: "u-1",
    answeredAt: new Date("2026-07-13T10:00:00.000Z"),
  });

  ({ getTaskDetail } = await import("@/lib/queries/task-detail"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("getTaskDetail — runs-history cap + true totals (ADR-119, integration)", () => {
  it("returns the 10 newest run rows while totals reflect all runs", async () => {
    const detail = await getTaskDetail("proj-cap", 42, "u-1");

    expect(detail).not.toBeNull();
    if (!detail) return;

    // Display rows capped to the 10 NEWEST.
    expect(detail.runs).toHaveLength(10);
    // Newest first (i=11 has the largest startedAt).
    expect(detail.runs[0].id).toBe("run-11");
    expect(detail.runs[9].id).toBe("run-02");
    // The oldest two (run-00, run-01) are NOT in the display set.
    expect(detail.runs.map((r) => r.id)).not.toContain("run-00");
    expect(detail.runs.map((r) => r.id)).not.toContain("run-01");

    // Totals over ALL 12 runs (the chip keeps the true total).
    expect(detail.totals.runCount).toBe(RUN_COUNT);
    expect(detail.totals.inputTokens).toBe(PER_RUN.input * RUN_COUNT);
    expect(detail.totals.outputTokens).toBe(PER_RUN.output * RUN_COUNT);
    expect(detail.totals.cacheReadTokens).toBe(PER_RUN.cacheRead * RUN_COUNT);
    expect(detail.totals.cacheCreationTokens).toBe(
      PER_RUN.cacheCreation * RUN_COUNT,
    );
    expect(detail.totals.tokenTotal).toBe(
      (PER_RUN.input +
        PER_RUN.output +
        PER_RUN.cacheRead +
        PER_RUN.cacheCreation) *
        RUN_COUNT,
    );
    expect(detail.task.awaitingClarification).toBe(true);
    expect(detail.task.clarifications).toEqual([
      expect.objectContaining({
        id: "clarification-cap-1",
        seq: 1,
        question: "Which environment?",
        answer: { environment: "production" },
      }),
    ]);
  });
});
