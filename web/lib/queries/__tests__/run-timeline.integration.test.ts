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
// the type-only clash (matches ledger.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getRunTimeline: typeof import("@/lib/queries/run").getRunTimeline;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("run_timeline_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getRunTimeline } = await import("@/lib/queries/run"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seed a real flows + users row and thread the non-null flowId, per the
// project test-hygiene rule (tasks/runs.flow_id is NOT NULL + FK since 0000).
async function seedRun(): Promise<{ runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Timeline Test",
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
    status: "Running",
    flowVersion: "v1.0.0",
  });

  return { runId };
}

async function seedUser(name: string | null): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    name,
    email: `owner-${userId.slice(0, 8)}@maister.local`,
    role: "member",
  });

  return userId;
}

describe("getRunTimeline (integration)", () => {
  it("returns ordered entries with current-vs-stale gates and the takeover handoff block", async () => {
    const { runId } = await seedRun();
    const ownerId = await seedUser("Reviewer Rae");

    // implement (ai_coding) attempt 1 — Succeeded, gate-free.
    const implementId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: implementId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      acpSessionId: "sess-implement-1",
      startedAt: new Date("2026-05-31T10:00:00.000Z"),
      endedAt: new Date("2026-05-31T10:05:00.000Z"),
    });

    // checks (check) attempt 1 — a STALE gate (its prior PASS was invalidated
    // by the takeover return).
    const checksStaleId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: checksStaleId,
      runId,
      nodeId: "checks",
      nodeType: "check",
      attempt: 1,
      status: "Stale",
      startedAt: new Date("2026-05-31T10:06:00.000Z"),
      endedAt: new Date("2026-05-31T10:07:00.000Z"),
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: checksStaleId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "stale",
      verdict: { verdict: "pass" },
      createdAt: new Date("2026-05-31T10:06:30.000Z"),
    });

    // review (human) attempt 1 — the takeover handoff: owner + returned
    // commits/diff/base ref recorded on the takeover row.
    const takeoverId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: takeoverId,
      runId,
      nodeId: "review",
      nodeType: "human",
      attempt: 1,
      status: "NeedsInput",
      ownerUserId: ownerId,
      baseRef: "base000",
      returnedCommits: "abc123 fix the thing\ndef456 add a test",
      returnedDiff: "diff --git a/x b/x\n+changed line",
      startedAt: new Date("2026-05-31T10:08:00.000Z"),
    });

    // checks (check) attempt 2 — the RERUN over the human's commits: a CURRENT
    // (passed) gate, the fresh evidence after the return.
    const checksFreshId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: checksFreshId,
      runId,
      nodeId: "checks",
      nodeType: "check",
      attempt: 2,
      status: "Succeeded",
      startedAt: new Date("2026-05-31T10:10:00.000Z"),
      endedAt: new Date("2026-05-31T10:11:00.000Z"),
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: checksFreshId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
      verdict: { verdict: "pass" },
      createdAt: new Date("2026-05-31T10:10:30.000Z"),
    });

    const timeline = await getRunTimeline(runId);

    // Ordered chronologically by (started_at, attempt): implement, checks#1,
    // review(takeover), checks#2.
    expect(timeline.entries.map((e) => e.nodeId)).toEqual([
      "implement",
      "checks",
      "review",
      "checks",
    ]);
    expect(timeline.entries.map((e) => e.attempt)).toEqual([1, 1, 1, 2]);

    // implement: checkpoint ref surfaced, no gates, no handoff.
    const implement = timeline.entries[0];

    expect(implement.nodeType).toBe("ai_coding");
    expect(implement.acpSessionId).toBe("sess-implement-1");
    expect(implement.gates).toHaveLength(0);
    expect(implement.handoff).toBeNull();

    // checks#1: the gate is flagged STALE (current=false).
    const staleEntry = timeline.entries[1];

    expect(staleEntry.gates).toHaveLength(1);
    expect(staleEntry.gates[0].status).toBe("stale");
    expect(staleEntry.gates[0].stale).toBe(true);

    // review: the takeover handoff block carries owner (name) + branch-agnostic
    // returned commits + raw diff + base ref.
    const handoffEntry = timeline.entries[2];

    expect(handoffEntry.handoff).not.toBeNull();
    expect(handoffEntry.handoff?.ownerUserId).toBe(ownerId);
    expect(handoffEntry.handoff?.ownerName).toBe("Reviewer Rae");
    expect(handoffEntry.handoff?.baseRef).toBe("base000");
    expect(handoffEntry.handoff?.returnedCommits).toContain(
      "abc123 fix the thing",
    );
    expect(handoffEntry.handoff?.returnedDiff).toContain("+changed line");
    expect(handoffEntry.decision).toBeNull();

    // checks#2: a CURRENT (non-stale) passed gate — the rerun evidence.
    const freshEntry = timeline.entries[3];

    expect(freshEntry.gates).toHaveLength(1);
    expect(freshEntry.gates[0].status).toBe("passed");
    expect(freshEntry.gates[0].stale).toBe(false);
  });

  it("falls back to owner email when the user name is null", async () => {
    const { runId } = await seedRun();
    const ownerId = await seedUser(null);

    const takeoverId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: takeoverId,
      runId,
      nodeId: "review",
      nodeType: "human",
      attempt: 1,
      status: "NeedsInput",
      ownerUserId: ownerId,
      baseRef: "base000",
      returnedCommits: "abc fix",
      returnedDiff: "diff",
      startedAt: new Date("2026-05-31T11:00:00.000Z"),
    });

    const timeline = await getRunTimeline(runId);
    const handoff = timeline.entries[0].handoff;

    expect(handoff?.ownerName).toBeNull();
    expect(handoff?.ownerEmail).toContain("@maister.local");
  });

  it("returns an empty timeline for a legacy linear run with no node_attempts", async () => {
    const { runId } = await seedRun();

    const timeline = await getRunTimeline(runId);

    expect(timeline.entries).toEqual([]);
  });
});
