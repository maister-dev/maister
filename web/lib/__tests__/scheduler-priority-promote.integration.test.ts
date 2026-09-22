// ADR-121 (T12, C1 source): the Pending-run promote is ordered by the criticality
// dictionary (weight DESC) then FIFO, replacing the blind started_at FIFO.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { promoteNextPending } from "@/lib/scheduler";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;
const { runs } = schema;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let seq = 0;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_priority_promote_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `pp-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `PP ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `P${projectId.slice(0, 8)}`.toUpperCase(),
  });

  return projectId;
}

async function seedPendingRun(
  projectId: string,
  priority: string,
  startedAt: Date,
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    priority,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind: "flow",
    status: "Pending",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt,
  });

  return runId;
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0].status;
}

describe("promoteNextPending priority ordering (ADR-121 C1)", () => {
  it("promotes the higher-criticality Pending run first", async () => {
    const projectId = await seedProject();
    // The 'normal' run is OLDER (would win a blind FIFO), but 'high' must preempt.
    const normalRun = await seedPendingRun(
      projectId,
      "normal",
      new Date(Date.now() - 60_000),
    );
    const highRun = await seedPendingRun(projectId, "high", new Date());

    const promoted: string[] = [];
    const res = await promoteNextPending({
      db,
      runFlow: (id) => void promoted.push(id),
    });

    expect(res.promotedRunId).toBe(highRun);
    expect(promoted).toEqual([highRun]);
    expect(await statusOf(highRun)).toBe("Running");
    expect(await statusOf(normalRun)).toBe("Pending");
  });

  it("breaks equal-criticality ties by FIFO (oldest started_at first)", async () => {
    const projectId = await seedProject();
    const older = await seedPendingRun(
      projectId,
      "normal",
      new Date(Date.now() - 120_000),
    );
    const newer = await seedPendingRun(projectId, "normal", new Date());

    const res = await promoteNextPending({ db, runFlow: () => {} });

    expect(res.promotedRunId).toBe(older);
    expect(await statusOf(newer)).toBe("Pending");
  });

  // The dispatch is fire-and-forget by design — a freed slot must not block on
  // a paid turn — so nothing awaits what the callback hands back, and an
  // unattended rejection escapes as a process-level unhandled rejection that in
  // a Next.js server can take the process down. `runFlow` rejects for ordinary
  // reasons (a task row deleted under the promoted run, a PRECONDITION, a
  // transport blip). One catch here covers every call site; an override cannot
  // be trusted to remember its own, and three of them did not.
  it("catches a rejecting dispatch instead of leaking an unhandled rejection", async () => {
    const projectId = await seedProject();

    await seedPendingRun(projectId, "normal", new Date());

    const dispatched: string[] = [];
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => {
      unhandled.push(reason);
    };

    process.on("unhandledRejection", capture);

    try {
      const res = await promoteNextPending({
        db,
        runFlow: (id) => {
          dispatched.push(id);

          return Promise.reject(new Error(`task not found for run ${id}`));
        },
      });

      // Earlier cases in this file leave their losers Pending, so WHICH row
      // wins is not this case's subject — only that a dispatch fired at all.
      expect(res.promotedRunId).not.toBeNull();
      expect(dispatched).toHaveLength(1);

      // Let the discarded dispatch settle and give Node a turn to deliver
      // `unhandledRejection` for it if nothing attached a handler.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });
});
