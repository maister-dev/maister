import { randomUUID } from "node:crypto";

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
    await db.insert(schema.executionEvents).values({
      id: randomUUID(),
      source: "manager",
      sourceKey: `task-detail:${runId}:0`,
      runId,
      eventType: "usage.recorded",
      payloadSchema: "maister.usage.recorded.v1",
      payload: {
        sessionName: "default",
        model: "claude-sonnet-4-6",
        inputTokens: PER_RUN.input,
        outputTokens: PER_RUN.output,
        cacheReadInputTokens: PER_RUN.cacheRead,
        cacheCreationInputTokens: PER_RUN.cacheCreation,
        resumed: false,
      },
      occurredAt: new Date(base + i * 60_000 + 29_000),
      receivedAt: new Date(base + i * 60_000 + 29_000),
      runSequence: BigInt(0),
      ingestDisposition: "accepted",
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
    originKind: "agent_run",
    question: "Which environment?",
    questionSchema: { schemaVersion: 1, fields: [] },
    reTriggerMode: "agent",
    status: "answered",
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

// P-1/P-2 (D10): the task page's data model — resolving attempt from the
// completion activity, intended strategy vs actual artifact, the source chip and
// a refused automatic completion.
describe("getTaskDetail — result model (D10)", () => {
  async function seedTask(number: number, status: "InFlight" | "Done") {
    const id = `task-d10-${number}`;

    await db.insert(schema.tasks).values({
      id,
      projectId: "proj-cap",
      number,
      title: `d10 ${number}`,
      prompt: "p",
      status,
    });

    return id;
  }

  async function seedRun(
    taskId: string,
    runId: string,
    minute: number,
    opts: {
      status: string;
      strategy: string;
      workspace?: Record<string, unknown>;
      mergeCommitSha?: string;
    },
  ) {
    await db.insert(schema.runs).values({
      id: runId,
      runKind: "flow",
      projectId: "proj-cap",
      taskId,
      flowVersion: "v1.0.0",
      status: opts.status,
      startedAt: new Date(Date.UTC(2026, 10, 1, 10, minute)),
      endedAt: new Date(Date.UTC(2026, 10, 1, 11, minute)),
      mergeCommitSha: opts.mergeCommitSha ?? null,
      deliveryPolicySnapshot: {
        strategy: opts.strategy,
        push: "on_success",
        trigger: "manual",
        targetBranch: "main",
      },
    });
    await db.insert(schema.workspaces).values({
      id: `ws-${runId}`,
      runId,
      projectId: "proj-cap",
      branch: `b-${runId}`,
      worktreePath: `/tmp/${runId}`,
      parentRepoPath: "/repos/proj-cap",
      ...opts.workspace,
    });
  }

  it("P-1: a Done task's resolving attempt comes from its completion activity, not the newest Run", async () => {
    const taskId = await seedTask(501, "Done");

    await seedRun(taskId, "d10-merged", 1, {
      status: "Done",
      strategy: "pull_request",
      workspace: {
        promotionMode: "pull_request",
        promotionState: "done",
        prNumber: 5,
        prUrl: "https://github.com/a/b/pull/5",
        prState: "merged",
      },
    });
    await seedRun(taskId, "d10-later-failed", 2, {
      status: "Failed",
      strategy: "pull_request",
    });
    await db.insert(schema.taskActivity).values({
      taskId,
      projectId: "proj-cap",
      actorType: "system",
      eventKind: "task_completed",
      payload: { runId: "d10-merged", cause: "pr_merged", prNumber: 5 },
    });
    await db.insert(schema.taskExternalSources).values({
      projectId: "proj-cap",
      taskId,
      sourceKind: "github",
      sourceInstance: "github.com",
      scopeKey: "a/b",
      externalId: "I_501",
      externalKey: "#7",
      origin: "import",
      createdByActorType: "system",
    });

    const detail = (await getTaskDetail("proj-cap", 501, "u-1"))!;

    expect(detail.displayStatus).toEqual({ key: "done", label: "Done", tone: "success" });

    expect(detail.resolvingRunId).toBe("d10-merged");
    expect(detail.task.source).toEqual({
      kind: "github",
      instance: "github.com",
      scope: "a/b",
      externalId: "I_501",
      externalKey: "#7",
      url: null,
    });
    expect(
      detail.runs.map(({ id, resolving, delivery }) => ({
        id,
        resolving,
        delivery,
      })),
    ).toEqual([
      {
        id: "d10-later-failed",
        resolving: false,
        delivery: { strategy: "pull_request", artifact: { kind: "none" } },
      },
      {
        id: "d10-merged",
        resolving: true,
        delivery: {
          strategy: "pull_request",
          artifact: {
            kind: "pr",
            number: 5,
            url: "https://github.com/a/b/pull/5",
            state: "merged",
          },
        },
      },
    ]);
  });

  it("P-1: a legacy completion without a runId leaves the resolving attempt unknown", async () => {
    const taskId = await seedTask(502, "Done");

    await seedRun(taskId, "d10-legacy", 1, {
      status: "Done",
      strategy: "merge",
    });
    await db.insert(schema.taskActivity).values({
      taskId,
      projectId: "proj-cap",
      actorType: "system",
      eventKind: "task_completed",
      payload: {},
    });

    expect(
      (await getTaskDetail("proj-cap", 502, "u-1"))!.resolvingRunId,
    ).toBeNull();
  });

  it("P-2: delivery separates the intended strategy from the actual artifact, and exposes a refused completion", async () => {
    const taskId = await seedTask(503, "InFlight");

    await seedRun(taskId, "d10-local", 1, {
      status: "Done",
      strategy: "merge",
      mergeCommitSha: "abc1234",
      workspace: { promotionMode: "local_merge", promotionState: "done" },
    });
    await seedRun(taskId, "d10-published", 2, {
      status: "Done",
      strategy: "publish_branch",
      workspace: {
        promotionState: "done",
        publishedBranch: "feature/x",
        publishedRemote: "origin",
        publishedAt: new Date(),
      },
    });
    await seedRun(taskId, "d10-partial", 3, {
      status: "Done",
      strategy: "pull_request",
      workspace: {
        promotionState: "done",
        prNumber: 9,
        prUrl: "https://github.com/a/b/pull/9",
        prState: "merged",
      },
    });
    await db.insert(schema.taskActivity).values({
      taskId,
      projectId: "proj-cap",
      actorType: "system",
      eventKind: "delivery_completion_not_applied",
      payload: { runId: "d10-partial", reason: "partial_resolution" },
    });

    const detail = (await getTaskDetail("proj-cap", 503, "u-1"))!;
    const artifacts = Object.fromEntries(
      detail.runs.map((r) => [r.id, r.delivery.artifact]),
    );

    expect(artifacts).toEqual({
      "d10-partial": {
        kind: "pr",
        number: 9,
        url: "https://github.com/a/b/pull/9",
        state: "merged",
      },
      "d10-published": { kind: "published", branch: "feature/x" },
      "d10-local": { kind: "merged", commit: "abc1234" },
    });
    expect(detail.completionRefusal).toEqual({
      runId: "d10-partial",
      reason: "partial_resolution",
    });
  });
});
