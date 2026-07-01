// ADR-121 (INV-1 / C1): the agent idle-resume cap-gate shared by the hook_trip
// (claimAndResumeAgentRun) and budget-raise (scheduleBudgetBreachResume) wakes.
// Before this fix both flipped a checkpointed NeedsInputIdle agent run straight to
// Running with NO cap check, so a burst of hook approvals / budget raises could
// push the agent pool past its cap (the same D2 over-cap class T14 closed on the
// permission path). Real-PG so the advisory lock + count-then-flip serialize.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { claimAgentResumeSlot } from "@/lib/services/hitl";

const schema = fullSchema as unknown as Record<string, any>;
const { runs } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_agent_resume_cap_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  // Engage the real pg_advisory_xact_lock (only active for a postgres DB_URL).
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  delete process.env.DB_URL;
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `arc-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `ARC ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `P${projectId.slice(0, 8)}`.toUpperCase(),
  });

  return projectId;
}

async function seedAgentRun(
  projectId: string,
  status: string,
  opts: { resumeRequestedAt?: Date | null } = {},
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "agent",
    status,
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt: new Date(),
    resumeRequestedAt: opts.resumeRequestedAt ?? null,
  });

  return runId;
}

async function rowOf(
  runId: string,
): Promise<{ status: string; resumeRequestedAt: Date | null }> {
  const rows = await db
    .select({
      status: runs.status,
      resumeRequestedAt: runs.resumeRequestedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0];
}

describe("claimAgentResumeSlot — agent idle-resume cap-gate (INV-1)", () => {
  it("NeedsInputIdle at cap → DEFERS (queued): stamps resume_requested_at, stays idle (no bypass)", async () => {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
    const projectId = await seedProject();

    await seedAgentRun(projectId, "Running"); // fills the agent pool (cap 1)
    const idle = await seedAgentRun(projectId, "NeedsInputIdle");

    const outcome = await claimAgentResumeSlot(db, idle);

    expect(outcome).toBe("queued");
    const row = await rowOf(idle);

    expect(row.status).toBe("NeedsInputIdle"); // NOT flipped to Running (cap honored)
    expect(row.resumeRequestedAt).not.toBeNull(); // deferred to the C3 gate, not dropped
  });

  it("NeedsInputIdle with a free slot → CLAIMS: flips to Running, clears resume_requested_at", async () => {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "2";
    const projectId = await seedProject();

    await seedAgentRun(projectId, "Running"); // 1 live, cap 2 → 1 free slot
    // A run previously deferred at cap carries resume_requested_at; the gate clears it.
    const idle = await seedAgentRun(projectId, "NeedsInputIdle", {
      resumeRequestedAt: new Date(),
    });

    const outcome = await claimAgentResumeSlot(db, idle);

    expect(outcome).toBe("claimed");
    const row = await rowOf(idle);

    expect(row.status).toBe("Running");
    expect(row.resumeRequestedAt).toBeNull();
  });

  it("NeedsInput (slot still held) → CLAIMS directly regardless of cap (flip is slot-neutral)", async () => {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
    const projectId = await seedProject();

    // A NeedsInput run already counts toward the cap; flipping it to Running does
    // not reclaim a freed slot, so no cap gate applies even at cap.
    const awaiting = await seedAgentRun(projectId, "NeedsInput");

    const outcome = await claimAgentResumeSlot(db, awaiting);

    expect(outcome).toBe("claimed");
    expect((await rowOf(awaiting)).status).toBe("Running");
  });

  it("already-advanced run → noop (idempotent; a same-payload retry never double-spawns)", async () => {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "3";
    const projectId = await seedProject();
    const done = await seedAgentRun(projectId, "Done");

    expect(await claimAgentResumeSlot(db, done)).toBe("noop");
    expect((await rowOf(done)).status).toBe("Done");
  });
});
