// Ownership residuals T2.3 (D-M3): the queued-message invariant's alarm. A
// queued agent message older than 10 minutes on a run with nothing in flight
// is reported — one WARN per run and a count on the system sweep's summary —
// and the admin read model serves the same rows live. Read only: nothing is
// repaired here; the owners are the finalization supersede and the
// continuation worker's arms.

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  reportStrandedAgentTurns,
  STRANDED_AGENT_TURN_MS,
} from "@/lib/agents/stranded-turns";
import { agentTurns, runSessions, schedulerJobRuns } from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDatabase.db,
  closeDb: async () => {},
}));

let projectId: string;
let hostId: string;
// Every run this file leaves stranded: the report is database-wide, so the
// expected count is what was seeded, never the function under test's answer.
const strandedRuns = new Set<string>();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "stranded_agent_turns",
  });
  projectId = randomUUID();
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, 'Stranded', $3, $4, $5)`,
    [
      projectId,
      `stranded-${projectId.slice(0, 8)}`,
      `/tmp/stranded-${projectId}`,
      `/tmp/stranded-${projectId}/maister.yaml`,
      `S${projectId.slice(0, 6)}`.toUpperCase(),
    ],
  );
  hostId = (await fakeExecutionHosts(testDatabase.db)).hostId;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedRun(
  status: string,
  opts: { resumeRequested?: boolean } = {},
): Promise<string> {
  const runId = randomUUID();

  await testDatabase.pool.query(
    `insert into runs (id, project_id, run_kind, status, flow_version, flow_revision, persistent, resume_requested_at)
     values ($1, $2, 'agent', $3, 'agent', 'manual', true, $4)`,
    [runId, projectId, status, opts.resumeRequested ? new Date() : null],
  );

  return runId;
}

async function seedTurn(
  runId: string,
  input: {
    ordinal: number;
    variant: string;
    state: string;
    ageMs: number;
  },
): Promise<string> {
  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into agent_turns (id, run_id, ordinal, variant, logical_key, prompt, state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'hi', $6, now() - ($7 || ' milliseconds')::interval, now())`,
    [
      id,
      runId,
      input.ordinal,
      input.variant,
      `message:auto:${id}`,
      input.state,
      String(input.ageMs),
    ],
  );

  return id;
}

// A generation turn in flight: claimed on the run's current assignment and
// session (the state check refuses a claimed turn without that binding).
async function claimedGeneration(runId: string): Promise<void> {
  const db = testDatabase.db as unknown as Db;
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );
  const sessionId = randomUUID();

  await db.insert(runSessions).values({
    id: sessionId,
    runId,
    sessionName: "default",
    executionAssignmentId: assignment.id,
  });
  await db.insert(agentTurns).values({
    id: randomUUID(),
    runId,
    ordinal: 0,
    variant: "initial",
    logicalKey: `generation:${assignment.id}:initial`,
    prompt: "work",
    state: "claimed",
    executionAssignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    runSessionId: sessionId,
  });
}

describe("stranded agent turns (D-M3)", () => {
  it("reports a queued message on a run with nothing in flight — once per run — and skips a run whose turn is running", async () => {
    const stranded = await seedRun("NeedsInputIdle");

    strandedRuns.add(stranded);
    const oldest = await seedTurn(stranded, {
      ordinal: 1,
      variant: "persistent_message",
      state: "queued",
      ageMs: STRANDED_AGENT_TURN_MS + 60_000,
    });

    await seedTurn(stranded, {
      ordinal: 2,
      variant: "persistent_message",
      state: "queued",
      ageMs: STRANDED_AGENT_TURN_MS + 30_000,
    });
    const busy = await seedRun("Running");

    await claimedGeneration(busy);
    await seedTurn(busy, {
      ordinal: 1,
      variant: "persistent_message",
      state: "queued",
      ageMs: STRANDED_AGENT_TURN_MS + 60_000,
    });
    const fresh = await seedRun("Running");

    await seedTurn(fresh, {
      ordinal: 1,
      variant: "persistent_message",
      state: "queued",
      ageMs: 1_000,
    });
    // Parked with a queue key: the resume arm and the freed-slot gate own it
    // while it waits for capacity, so it is not stranded.
    const waiting = await seedRun("NeedsInputIdle", { resumeRequested: true });

    await seedTurn(waiting, {
      ordinal: 1,
      variant: "persistent_message",
      state: "queued",
      ageMs: STRANDED_AGENT_TURN_MS + 60_000,
    });
    const warn = vi.fn();

    const report = await reportStrandedAgentTurns({
      db: testDatabase.db as unknown as Db,
      logger: { warn, error: vi.fn() } as never,
    });

    expect(report).toMatchObject({ count: 1, errors: [] });
    expect(report.rows).toEqual([
      expect.objectContaining({
        runId: stranded,
        runStatus: "NeedsInputIdle",
        turnId: oldest,
        ordinal: 1,
      }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: stranded, turnId: oldest }),
      "agent-message-stranded",
    );
  });

  it("the system sweep carries the count through the real tick, and the admin lag model serves the rows live", async () => {
    // Its own stranded run: the case does not lean on the one above.
    const mine = await seedRun("NeedsInputIdle");

    strandedRuns.add(mine);
    await seedTurn(mine, {
      ordinal: 1,
      variant: "live_message",
      state: "queued",
      ageMs: STRANDED_AGENT_TURN_MS + 60_000,
    });
    const expected = strandedRuns.size;
    const { runSchedulerTick } = await import("@/lib/scheduler/tick-service");
    const tick = await runSchedulerTick({ jobKind: "system_sweep" });
    const attempt = tick.attempts.find((row) => row.jobKind === "system_sweep");

    expect(attempt).toBeDefined();
    // The attempt persists the sweep's summary whatever its status (no host
    // is registered here, so the event-plane arm reports a bundle error).
    const [run] = await testDatabase.db
      .select({ summary: schedulerJobRuns.summary })
      .from(schedulerJobRuns)
      .where(eq(schedulerJobRuns.id, attempt!.attemptId));

    expect(run.summary).toMatchObject({ strandedAgentTurns: expected });
    const { collectExecutionEventLag } = await import(
      "@/lib/execution-host/events/lag-read-model"
    );
    const model = await collectExecutionEventLag({
      db: testDatabase.db as unknown as Db,
      health: { kind: "unavailable" } as never,
    });

    expect(model.commands.strandedAgentTurns).toBe(expected);
    expect(model.commands.strandedAgentTurnRows).toContainEqual(
      expect.objectContaining({ runId: mine, runStatus: "NeedsInputIdle" }),
    );
  }, 120_000);
});
