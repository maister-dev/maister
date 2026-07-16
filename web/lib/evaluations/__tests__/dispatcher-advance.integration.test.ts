import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  advanceExecution,
  createRetryExecution,
} from "@/lib/evaluations/dispatcher/advance";
import {
  formatSseFrame,
  readEvaluationEvents,
} from "@/lib/evaluations/dispatcher/events";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let studyId: string;

async function newExecution(status = "queued"): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationExecutions).values({ id, studyId, status });

  return id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_dispatch_test",
  });
  db = testDatabase.db;

  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const flowId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });

  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("advanceExecution + replayable events", () => {
  it("walks the lifecycle, emitting one monotonic event per step", async () => {
    const executionId = await newExecution();

    const steps: Array<[string, string]> = [
      ["queued", "capturing"],
      ["capturing", "checking"],
      ["checking", "judging"],
      ["judging", "aggregating"],
      ["aggregating", "completed"],
    ];

    let version = 1;

    for (const [from, to] of steps) {
      const res = await advanceExecution(
        {
          studyId,
          executionId,
          from: from as never,
          to: to as never,
          expectedVersion: version,
        },
        db,
      );

      version = res.version;
    }

    const [row] = await db
      .select({
        status: schema.evaluationExecutions.status,
        terminalAt: schema.evaluationExecutions.terminalAt,
      })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, executionId));

    expect(row.status).toBe("completed");
    expect(row.terminalAt).not.toBeNull();

    const events = await readEvaluationEvents({ studyId }, db);
    const forExecution = events.filter((e) => e.executionId === executionId);

    expect(forExecution.map((e) => e.eventType)).toEqual([
      "evidence.capture_started",
      "evidence.snapshot_sealed",
      "objective_check.completed",
      "panel.quorum_reached",
      "evaluation.completed",
    ]);
    // Sequences are strictly increasing (per-Study monotonic).
    const seqs = forExecution.map((e) => e.sequence);

    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("rejects an illegal transition (CONFIG) before any write", async () => {
    const executionId = await newExecution();

    await expect(
      advanceExecution(
        {
          studyId,
          executionId,
          from: "queued",
          to: "completed",
          expectedVersion: 1,
        },
        db,
      ),
    ).rejects.toThrow(/illegal/);
  });

  it("loses a stale-version CAS as CONFLICT, not a raw error", async () => {
    const executionId = await newExecution();

    await advanceExecution(
      {
        studyId,
        executionId,
        from: "queued",
        to: "capturing",
        expectedVersion: 1,
      },
      db,
    );

    // Replaying the same claim at the old version must 409, not silently re-run.
    await expect(
      advanceExecution(
        {
          studyId,
          executionId,
          from: "queued",
          to: "capturing",
          expectedVersion: 1,
        },
        db,
      ),
    ).rejects.toThrow(/not queued@v1/);
  });

  it("replays only after the client's Last-Event-ID sequence", async () => {
    const all = await readEvaluationEvents({ studyId }, db);
    const mid = all[Math.floor(all.length / 2)].sequence;
    const tail = await readEvaluationEvents(
      { studyId, afterSequence: mid },
      db,
    );

    expect(tail.every((e) => e.sequence > mid)).toBe(true);
    expect(formatSseFrame(all[0])).toContain(`id: ${all[0].sequence}`);
  });

  it("retry creates a NEW queued execution from a terminal row, never re-enters it", async () => {
    const failed = await newExecution();

    await advanceExecution(
      {
        studyId,
        executionId: failed,
        from: "queued",
        to: "capturing",
        expectedVersion: 1,
      },
      db,
    );
    await advanceExecution(
      {
        studyId,
        executionId: failed,
        from: "capturing",
        to: "failed",
        expectedVersion: 2,
      },
      db,
    );

    const retry = await createRetryExecution({ studyId, retryOf: failed }, db);
    const [row] = await db
      .select({
        status: schema.evaluationExecutions.status,
        retryOf: schema.evaluationExecutions.retryOf,
      })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, retry.executionId));

    expect(row.status).toBe("queued");
    expect(row.retryOf).toBe(failed);

    // The original terminal row stays terminal (never re-entered).
    const [orig] = await db
      .select({ status: schema.evaluationExecutions.status })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, failed));

    expect(orig.status).toBe("failed");
  });

  it("refuses to retry a non-terminal execution", async () => {
    const running = await newExecution();

    await advanceExecution(
      {
        studyId,
        executionId: running,
        from: "queued",
        to: "capturing",
        expectedVersion: 1,
      },
      db,
    );

    await expect(
      createRetryExecution({ studyId, retryOf: running }, db),
    ).rejects.toThrow(/non-terminal/);
  });
});
