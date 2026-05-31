// M8 T3: state-transition helpers — atomic UPDATE with status-guard
// in WHERE clause. Uses real Postgres testcontainer because the
// status-guard semantics depend on the actual SQL-level CAS.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  bumpKeepalive,
  crashResumedRun,
  failResumedRun,
  markCheckpointed,
  markCheckpointedFromExit,
  markResumed,
} from "@/lib/runs/state-transitions";

const schema = schemaModule as unknown as Record<string, any>;
const { executors, flows, projects, runs, tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let flowId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("state_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: "state-app",
    name: "State App",
    repoPath: "/repos/state-app",
    maisterYamlPath: "/repos/state-app/maister.yaml",
  });

  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  flowId = randomUUID();

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(runs);
  await db.delete(tasks);
});

async function seedRun(
  status: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status,
    flowVersion: "v1",
    startedAt: new Date(),
    ...fields,
  });

  return runId;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

describe("state-transitions — markCheckpointed", () => {
  it("NeedsInput → NeedsInputIdle on the happy path", async () => {
    const runId = await seedRun("NeedsInput", {
      keepaliveUntil: new Date(Date.now() - 1_000),
    });

    const r = await markCheckpointed(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInputIdle");
    expect(row.checkpointAt).not.toBeNull();
    expect(row.keepaliveUntil).toBeNull();
  }, 60_000);

  it("rejects when row already moved (status-guard mismatch)", async () => {
    const runId = await seedRun("Running");

    const r = await markCheckpointed(runId, { db });

    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toBe("status-guard-mismatch");
    }
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
  }, 60_000);
});

// M8 Codex review fix #1: markCheckpointedFromExit shares the SQL with
// markCheckpointed but is triggered from a different control-plane path
// (the runner-agent's SSE consumer observing session.exited.reason
// = "checkpoint"). Both must be idempotent w.r.t. each other.
describe("state-transitions — markCheckpointedFromExit", () => {
  it("NeedsInput → NeedsInputIdle when runner observes checkpoint exit reason", async () => {
    const runId = await seedRun("NeedsInput", {
      keepaliveUntil: new Date(Date.now() + 60_000),
    });

    const r = await markCheckpointedFromExit(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInputIdle");
    expect(row.checkpointAt).not.toBeNull();
    expect(row.keepaliveUntil).toBeNull();
  }, 60_000);

  it("idempotent with markCheckpointed — second call from a different trigger no-ops cleanly", async () => {
    const runId = await seedRun("NeedsInput", {
      keepaliveUntil: new Date(Date.now() - 1_000),
    });

    const first = await markCheckpointed(runId, { db });

    expect(first.ok).toBe(true);

    const second = await markCheckpointedFromExit(runId, { db });

    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.reason).toBe("status-guard-mismatch");
    }
    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInputIdle");
  }, 60_000);
});

describe("state-transitions — markResumed", () => {
  it("NeedsInputIdle → NeedsInput on the happy path; sets fresh keepalive_until", async () => {
    const runId = await seedRun("NeedsInputIdle", {
      checkpointAt: new Date(Date.now() - 60_000),
    });

    const r = await markResumed(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInput");
    expect(row.checkpointAt).toBeNull();
    expect(row.keepaliveUntil).not.toBeNull();
    expect(new Date(row.keepaliveUntil).getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it("rejects when row is not NeedsInputIdle (status-guard mismatch)", async () => {
    const runId = await seedRun("Running");

    const r = await markResumed(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("state-transitions — bumpKeepalive", () => {
  it("bumps keepalive_until on a Running row without changing status", async () => {
    const runId = await seedRun("Running", {
      keepaliveUntil: new Date(Date.now() - 60_000),
    });
    const before = (await readRun(runId)).keepaliveUntil;

    const r = await bumpKeepalive(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
    expect(new Date(row.keepaliveUntil).getTime()).toBeGreaterThan(
      new Date(before ?? 0).getTime(),
    );
  }, 60_000);

  it("bumps keepalive_until on a NeedsInput row", async () => {
    const runId = await seedRun("NeedsInput");
    const r = await bumpKeepalive(runId, { db });

    expect(r.ok).toBe(true);
  }, 60_000);

  it("rejects bump on a NeedsInputIdle row (the M8 D6 invariant — Idle does NOT accept activity bumps)", async () => {
    const runId = await seedRun("NeedsInputIdle");
    const r = await bumpKeepalive(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);

  it("rejects bump on terminal rows", async () => {
    const runId = await seedRun("Done");
    const r = await bumpKeepalive(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("state-transitions — failResumedRun", () => {
  it("NeedsInputIdle → Failed with endedAt set", async () => {
    const runId = await seedRun("NeedsInputIdle");
    const r = await failResumedRun(runId, "supervisor-400", { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("Failed");
    expect(row.endedAt).not.toBeNull();
  }, 60_000);

  it("rejects if row is no longer NeedsInputIdle", async () => {
    const runId = await seedRun("Running");
    const r = await failResumedRun(runId, "supervisor-400", { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("state-transitions — crashResumedRun", () => {
  it("NeedsInput → Crashed on resume-prompt watchdog timeout", async () => {
    const runId = await seedRun("NeedsInput");
    const r = await crashResumedRun(runId, "resume-prompt-timeout", { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
    expect(row.endedAt).not.toBeNull();
  }, 60_000);

  it("rejects if row is no longer NeedsInput (e.g. operator already responded)", async () => {
    const runId = await seedRun("Running");
    const r = await crashResumedRun(runId, "resume-prompt-timeout", { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});
