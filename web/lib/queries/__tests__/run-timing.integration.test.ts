// ADR-208 loader: maps each evidence table into the pure projection, batched.
// The interval algebra is owned by lib/runs/__tests__/run-timing.test.ts.
import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { loadRunTimings } from "@/lib/queries/run-timing";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;

const T0 = new Date("2026-11-15T10:00:00Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
const MIN = 60_000;

async function seedRun(opts: {
  runKind?: "flow" | "agent" | "scratch";
  endedMin: number | null;
  parentRunId?: string;
  checkpoint?: [number, number];
}): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    projectId,
    runKind: opts.runKind ?? "flow",
    status: opts.endedMin === null ? "Running" : "Done",
    flowVersion: "v1.0.0",
    startedAt: at(0),
    endedAt: opts.endedMin === null ? null : at(opts.endedMin),
    parentRunId: opts.parentRunId ?? null,
    checkpointAt: opts.checkpoint ? at(opts.checkpoint[0]) : null,
    resumeStartedAt: opts.checkpoint ? at(opts.checkpoint[1]) : null,
  });

  return id;
}

async function attempt(
  runId: string,
  nodeType: string,
  from: number,
  to: number | null,
) {
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: `${nodeType}-${from}`,
    nodeType,
    attempt: 1,
    status: to === null ? "running" : "succeeded",
    startedAt: at(from),
    endedAt: to === null ? null : at(to),
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_timing_test",
  });
  db = testDatabase.db;
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "run-timing",
    name: "run-timing",
    repoPath: "/tmp/run-timing",
    maisterYamlPath: "/tmp/run-timing/maister.yaml",
    taskKey: "RTM",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("loadRunTimings (T-1..T-5 evidence mapping)", () => {
  it("maps attempts (human/form excluded), HITL waits, checkpoint idle and child execution for several Runs at once", async () => {
    const flow = await seedRun({ endedMin: 60, checkpoint: [40, 50] });

    await attempt(flow, "ai_coding", 0, 5);
    await attempt(flow, "human", 5, 35);
    await attempt(flow, "check", 35, 40);
    await attempt(flow, "cli", 50, 60);
    await db.insert(schema.hitlRequests).values({
      id: randomUUID(),
      runId: flow,
      stepId: "human-5",
      kind: "human",
      prompt: "review",
      createdAt: at(5),
      respondedAt: at(35),
    });

    const parent = await seedRun({ endedMin: 30 });
    const child = await seedRun({ endedMin: 45, parentRunId: parent });

    await attempt(parent, "orchestrator", 0, 5);
    await attempt(child, "ai_coding", 10, 45);

    const legacy = await seedRun({ endedMin: 10 });
    const timings = await loadRunTimings(
      db,
      [flow, parent, legacy],
      new Date(T0 + 999 * MIN),
    );

    expect(timings.get(flow)).toMatchObject({
      durationMs: 60 * MIN,
      executionMs: 20 * MIN,
      quality: "exact",
      breakdown: { humanInputMs: 30 * MIN, idleMs: 10 * MIN },
    });
    expect(timings.get(parent)).toMatchObject({ executionMs: 25 * MIN });
    expect(timings.get(legacy)).toMatchObject({
      executionMs: null,
      quality: "unavailable",
    });
  });

  it("ignores superseded agent turns (they never ran) and measures a live agent Run to now", async () => {
    const agent = await seedRun({ runKind: "agent", endedMin: null });

    await db.insert(schema.agentTurns).values({
      id: randomUUID(),
      runId: agent,
      ordinal: 1,
      variant: "initial",
      logicalKey: "k-1",
      prompt: "p",
      state: "superseded",
      createdAt: at(1),
      completedAt: at(4),
    });

    const timings = await loadRunTimings(db, [agent], at(10));

    expect(timings.get(agent)).toEqual({
      durationMs: 10 * MIN,
      live: true,
      executionMs: null,
      quality: "unavailable",
      breakdown: null,
    });
  });
});
