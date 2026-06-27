// M8 T2: scheduler cap semantics — NeedsInputIdle is NOT counted toward
// the global concurrency cap; tryStartRun + promoteNextPending see only
// {Running, NeedsInput} as cap-consuming live rows. Resumes
// (NeedsInputIdle → NeedsInput via markResumed in T3) bypass the cap by
// design (operator-driven; not auto-scheduled).
//
// These tests use a real Postgres testcontainer because the scheduler
// runs inside a `db.transaction` + `pg_advisory_xact_lock` path that is
// not faithfully reproducible against a hand-rolled mock.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  assertAssistantCapacityAvailable,
  assertScratchCapacityAvailable,
  promoteNextPending,
  releaseSlotOnIdle,
  tryStartRun,
} from "@/lib/scheduler";

// M19 Phase 3: promoteNextPending now lazily dispatches the promoted run
// (runFlow for a fresh queue, driveResume for a checkpointed resume). Stub
// both dispatch targets so the fire-and-forget background work never races
// this suite's pool teardown — these tests assert promotion bookkeeping, not
// the downstream launch.
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn(async () => {}) }));
vi.mock("@/lib/runs/recover", () => ({ driveResume: vi.fn(async () => {}) }));

const schema = schemaModule as unknown as Record<string, any>;
const { flows, projects, runs, tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let projectId: string;
let executorId: string;
let flowId: string;
let originalCap: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("scheduler_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Force the postgres path in the scheduler (advisory lock).
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "sched-app",
    name: "Sched App",
    repoPath: "/repos/sched-app",
    maisterYamlPath: "/repos/sched-app/maister.yaml",
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

  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Clean runs + tasks between tests so each scenario starts from a
  // known baseline. Project + executor stay across tests.
  await db.delete(runs);
  await db.delete(tasks);
});

async function seedRun(
  status: string,
  fakeFlowVersion = "v1",
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
    flowVersion: fakeFlowVersion,
    startedAt: new Date(),
  });

  return runId;
}

describe("scheduler — M8 cap semantics", () => {
  it("NeedsInputIdle does NOT count toward the cap: tryStartRun starts when cap is otherwise free", async () => {
    await seedRun("Running");
    await seedRun("NeedsInputIdle");
    await seedRun("NeedsInputIdle");

    const pendingRunId = await seedRun("Pending");

    const r = await tryStartRun(pendingRunId, { db });

    expect(r.started).toBe(true);

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Running");
  }, 60_000);

  // M37 (ADR-098 §3): a parked orchestrator is checkpointed — its agent-pool
  // slot is released, so it must NOT count against the cap (like NeedsInputIdle).
  it("WaitingOnChildren does NOT count toward the cap (parked orchestrator)", async () => {
    // Three would fill the cap-3 if they counted; the Pending still starts.
    await seedRun("WaitingOnChildren");
    await seedRun("WaitingOnChildren");
    await seedRun("WaitingOnChildren");

    const pendingRunId = await seedRun("Pending");

    const r = await tryStartRun(pendingRunId, { db });

    expect(r.started).toBe(true);

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Running");
  }, 60_000);

  it("NeedsInput DOES count toward the cap: tryStartRun queues when 3 NeedsInput rows occupy the cap", async () => {
    await seedRun("NeedsInput");
    await seedRun("NeedsInput");
    await seedRun("NeedsInput");

    const pendingRunId = await seedRun("Pending");

    const r = await tryStartRun(pendingRunId, { db });

    expect(r.started).toBe(false);
    if (r.started === false) {
      expect(r.queuePosition).toBeGreaterThan(0);
    }

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Pending");
  }, 60_000);

  it("promoteNextPending skips NeedsInputIdle in its cap recount and promotes a Pending row", async () => {
    await seedRun("Running");
    await seedRun("NeedsInputIdle");
    // 1 Running + 1 Idle ⇒ live count = 1, cap headroom = 2.
    const pendingRunId = await seedRun("Pending");

    const r = await promoteNextPending({ db });

    expect(r.promotedRunId).toBe(pendingRunId);

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Running");
  }, 60_000);

  it("promoteNextPending refuses to over-commit when cap is full with Running+NeedsInput only", async () => {
    await seedRun("Running");
    await seedRun("NeedsInput");
    await seedRun("NeedsInput");
    // cap = 3, all consumed by Running+NeedsInput; Idle does not change this.
    await seedRun("NeedsInputIdle");

    const pendingRunId = await seedRun("Pending");

    const r = await promoteNextPending({ db });

    expect(r.promotedRunId).toBeNull();

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Pending");
  }, 60_000);

  it("releaseSlotOnIdle delegates to promoteNextPending — Pending row gets promoted after an Idle transition frees a slot", async () => {
    // 2 Running + 1 NeedsInput would cap us if Idle didn't free; we
    // model the post-sweeper state where the third was just flipped
    // to Idle. The remaining Running+NeedsInput count = 2; cap
    // headroom = 1 → promote the Pending row.
    await seedRun("Running");
    await seedRun("NeedsInput");
    const justIdledRunId = await seedRun("NeedsInputIdle");
    const pendingRunId = await seedRun("Pending");

    const r = await releaseSlotOnIdle({ runId: justIdledRunId, db });

    expect(r.promotedRunId).toBe(pendingRunId);
  }, 60_000);
});

// M11b Phase 2.5: HumanWorking counts toward the global cap (ADR-009 — a
// claimed worktree holds a slot) through BOTH cap predicates: the
// tryStartRun initial-promote count (scheduler.ts:78) AND the
// promoteNextPending under-advisory-lock recheck (scheduler.ts:160).
describe("scheduler — M11b HumanWorking cap semantics", () => {
  it("humanworking-occupies-slot-both-paths: tryStartRun queues when 3 HumanWorking rows fill the cap (the :78 predicate)", async () => {
    await seedRun("HumanWorking");
    await seedRun("HumanWorking");
    await seedRun("HumanWorking");

    const pendingRunId = await seedRun("Pending");

    const r = await tryStartRun(pendingRunId, { db });

    expect(r.started).toBe(false);
    if (r.started === false) {
      expect(r.queuePosition).toBeGreaterThan(0);
    }

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Pending");
  }, 60_000);

  it("humanworking-occupies-slot-both-paths: promoteNextPending refuses to over-commit when HumanWorking fills the cap (the :160 recheck predicate)", async () => {
    await seedRun("Running");
    await seedRun("HumanWorking");
    await seedRun("HumanWorking");

    const pendingRunId = await seedRun("Pending");

    const r = await promoteNextPending({ db });

    expect(r.promotedRunId).toBeNull();

    const after = await db.select().from(runs).where(eq(runs.id, pendingRunId));

    expect(after[0].status).toBe("Pending");
  }, 60_000);
});

describe("scheduler — assistant pool separation (Fix 3)", () => {
  it("excludes assistant runs (local_package_id) from the flow/scratch cap and counts them in the separate assistant cap", async () => {
    // cap (MAISTER_MAX_CONCURRENT_RUNS) is 3 in this suite. Three RUNNING
    // assistant runs (run_kind='scratch', project_id NULL, local_package_id set)
    // MUST NOT consume the flow/scratch delivery pool — a real scratch launch is
    // still admitted — and they DO occupy the separate assistant pool.
    const lpId = randomUUID();

    await pool.query(
      `INSERT INTO "local_packages" ("id", "name", "slug", "working_dir") VALUES ($1, 'Sched LP', $2, '/tmp/sched-lp')`,
      [lpId, `sched-lp-${randomUUID().slice(0, 8)}`],
    );
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO "runs" ("id", "run_kind", "local_package_id", "project_id", "task_id", "flow_version", "flow_revision", "status", "current_step_id", "started_at")
         VALUES ($1, 'scratch', $2, NULL, NULL, 'scratch', 'manual', 'Running', 'scratch-dialog', now())`,
        [randomUUID(), lpId],
      );
    }

    // Flow/scratch pool sees zero — assistant runs are excluded.
    const scratchDecision = await assertScratchCapacityAvailable({ db });

    expect(scratchDecision.allowed).toBe(true);
    expect(scratchDecision.liveCount).toBe(0);

    // The assistant pool counts all three, enforced by its OWN cap — set the env
    // explicitly so the assertion is independent of the default cap value.
    const prev = process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS;

    try {
      process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS = "3";
      await expect(assertAssistantCapacityAvailable({ db })).rejects.toThrow(
        /assistant run capacity is full/,
      );

      // Raising the assistant cap admits a 4th.
      process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS = "4";
      const assistantDecision = await assertAssistantCapacityAvailable({ db });

      expect(assistantDecision.allowed).toBe(true);
      expect(assistantDecision.liveCount).toBe(3);
      expect(assistantDecision.cap).toBe(4);
    } finally {
      if (prev === undefined) {
        delete process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS;
      } else {
        process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS = prev;
      }
    }

    // Cascades the three assistant runs.
    await pool.query(`DELETE FROM "local_packages" WHERE "id" = $1`, [lpId]);
  }, 60_000);
});
