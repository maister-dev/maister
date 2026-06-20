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
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { getActiveTakeover } from "@/lib/flows/graph/ledger";
import {
  bumpKeepalive,
  crashResumedRun,
  failResumedRun,
  markAbandoned,
  markCheckpointed,
  markCheckpointedFromExit,
  markHumanWorking,
  markResumed,
  markResumedFromWait,
  markReturnedToRunning,
  markWaitingOnChildren,
  releaseHumanWorking,
} from "@/lib/runs/state-transitions";

const schema = schemaModule as unknown as Record<string, any>;
const { flows, nodeAttempts, projects, runs, tasks, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let flowId: string;
let ownerUserId: string;

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
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "state-app",
    name: "State App",
    repoPath: "/repos/state-app",
    maisterYamlPath: "/repos/state-app/maister.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

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

  ownerUserId = randomUUID();

  await db.insert(users).values({
    id: ownerUserId,
    email: "owner@maister.local",
    role: "member",
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
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
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

describe("state-transitions — markWaitingOnChildren / markResumedFromWait (M36)", () => {
  it("Running → WaitingOnChildren on the happy path (checkpointed, keepalive cleared)", async () => {
    const runId = await seedRun("Running");

    const r = await markWaitingOnChildren(runId, { db });

    expect(r.ok).toBe(true);

    const after = await readRun(runId);

    expect(after.status).toBe("WaitingOnChildren");
    expect(after.checkpointAt).not.toBeNull();
    expect(after.keepaliveUntil).toBeNull();
  });

  it("markWaitingOnChildren rejects a non-Running row (status-guard mismatch)", async () => {
    const runId = await seedRun("NeedsInput");

    const r = await markWaitingOnChildren(runId, { db });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("status-guard-mismatch");

    expect((await readRun(runId)).status).toBe("NeedsInput");
  });

  it("WaitingOnChildren → Running on resume (checkpoint cleared)", async () => {
    const runId = await seedRun("WaitingOnChildren", {
      checkpointAt: new Date(),
    });

    const r = await markResumedFromWait(runId, { db });

    expect(r.ok).toBe(true);

    const after = await readRun(runId);

    expect(after.status).toBe("Running");
    expect(after.checkpointAt).toBeNull();
  });

  it("markResumedFromWait rejects a non-WaitingOnChildren row (concurrent resume loses)", async () => {
    const runId = await seedRun("Running");

    const r = await markResumedFromWait(runId, { db });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("status-guard-mismatch");

    expect((await readRun(runId)).status).toBe("Running");
  });

  it("parent_run_id is SET NULL when the parent run is deleted (FK cascade, migration 0055)", async () => {
    const parentId = await seedRun("Running");
    const childId = await seedRun("Running", {
      parentRunId: parentId,
      rootRunId: parentId,
    });

    await db.delete(runs).where(eq(runs.id, parentId));

    const after = await readRun(childId);

    expect(after.parentRunId).toBeNull();
  });
});

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

// M11b Phase 2.4: takeover CAS helpers — status-guarded UPDATEs mirroring
// the M8 pattern. markHumanWorking (NeedsInput→HumanWorking, claim),
// markReturnedToRunning (HumanWorking→Running, return), releaseHumanWorking
// (HumanWorking→NeedsInput, release-without-changes). Each is idempotent via
// the WHERE-clause status guard; a concurrent loser gets {ok:false}.
describe("state-transitions — markHumanWorking (claim)", () => {
  it("NeedsInput → HumanWorking on the happy path", async () => {
    const runId = await seedRun("NeedsInput");

    const r = await markHumanWorking(runId, ownerUserId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("HumanWorking");
  }, 60_000);

  it("concurrent claim: only one CAS wins, the loser gets {ok:false} → 409", async () => {
    const runId = await seedRun("NeedsInput");

    const [a, b] = await Promise.all([
      markHumanWorking(runId, ownerUserId, { db }),
      markHumanWorking(runId, ownerUserId, { db }),
    ]);

    const winners = [a, b].filter((r) => r.ok).length;
    const losers = [a, b].filter((r) => !r.ok).length;

    expect(winners).toBe(1);
    expect(losers).toBe(1);
    const row = await readRun(runId);

    expect(row.status).toBe("HumanWorking");
  }, 60_000);

  it("rejects when the row is not NeedsInput (status-guard mismatch)", async () => {
    const runId = await seedRun("Running");

    const r = await markHumanWorking(runId, ownerUserId, { db });

    expect(r.ok).toBe(false);
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
  }, 60_000);
});

describe("state-transitions — markReturnedToRunning (return)", () => {
  it("HumanWorking → Running on the happy path", async () => {
    const runId = await seedRun("HumanWorking");

    const r = await markReturnedToRunning(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
  }, 60_000);

  it("rejects when already returned (not HumanWorking) — idempotent terminal", async () => {
    const runId = await seedRun("Running");

    const r = await markReturnedToRunning(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("state-transitions — releaseHumanWorking (release, no changes)", () => {
  it("release-humanworking-returns-needsinput: HumanWorking → NeedsInput", async () => {
    const runId = await seedRun("HumanWorking");

    const r = await releaseHumanWorking(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInput");
  }, 60_000);

  it("rejects when the row is not HumanWorking (status-guard mismatch)", async () => {
    const runId = await seedRun("NeedsInput");

    const r = await releaseHumanWorking(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);

  it("release-closes-takeover-ledger-row: getActiveTakeover === null after release", async () => {
    const runId = await seedRun("HumanWorking", { currentStepId: "review" });

    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "review",
      nodeType: "human",
      attempt: 1,
      status: "NeedsInput",
      ownerUserId,
    });

    // Before: the takeover row is active.
    expect(await getActiveTakeover(runId, db)).not.toBeNull();

    const r = await releaseHumanWorking(runId, { db });

    expect(r.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("NeedsInput");
    // After: the takeover ledger row was closed in the SAME transaction — no
    // active handoff lingers on the released run.
    expect(await getActiveTakeover(runId, db)).toBeNull();
  }, 60_000);
});

// M11b Phase 3.5: markAbandoned CAS helper. Abandon is a non-terminal →
// Abandoned transition guarded so a concurrent/duplicate abandon loses. The
// abandon route runs releaseHumanWorking first for a HumanWorking run, so by
// the time markAbandoned fires the row is NeedsInput; the guard accepts the
// abandonable non-terminal set.
describe("state-transitions — markAbandoned", () => {
  it("abandon-humanworking-frees-slot: NeedsInput → Abandoned with endedAt set", async () => {
    const runId = await seedRun("NeedsInput");

    const r = await markAbandoned(runId, { db });

    expect(r.ok).toBe(true);
    const row = await readRun(runId);

    expect(row.status).toBe("Abandoned");
    expect(row.endedAt).not.toBeNull();
  }, 60_000);

  it("abandons a Running run", async () => {
    const runId = await seedRun("Running");

    const r = await markAbandoned(runId, { db });

    expect(r.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Abandoned");
  }, 60_000);

  it("rejects a duplicate abandon (already terminal — status-guard mismatch)", async () => {
    const runId = await seedRun("Done");

    const r = await markAbandoned(runId, { db });

    expect(r.ok).toBe(false);
  }, 60_000);
});
