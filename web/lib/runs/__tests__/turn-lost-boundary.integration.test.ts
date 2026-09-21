// ADR-177 D3 — the shared crash boundary's own transaction.
//
// The reconcile and Recover suites assert the boundary's OUTCOME from the
// outside. This one asserts the property that makes it safe to have two
// writers: a loser on any one of the three guards writes NOTHING. A run crashed
// without its attempt closed re-enters the graph on a row the ledger still
// calls `Running`; an attempt closed without its command discharged strands the
// command `owner_unapplied` and blocks ever deleting the run. Both halves have
// to be all-or-nothing, and that is a `WHERE`-clause property — so the database
// is real.

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  seedLostTurn,
  seedTurnLostFlow,
  type SeededFlowGraph,
} from "@/test-support/turn-lost-seed";

const schema = fullSchema as unknown as Record<string, any>;
const { executionCommands, nodeAttempts, runs, workspaces } = schema;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;
let flow: SeededFlowGraph;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "turn_lost_boundary",
  });
  db = testDatabase.db as unknown as Db;
  project = await seedProjectRow(testDatabase.db);
  ({ hostId } = await fakeExecutionHosts(testDatabase.db));
  flow = await seedTurnLostFlow(testDatabase.db, project.id);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.db.delete(nodeAttempts);
  await testDatabase.db.delete(executionCommands);
  await testDatabase.db.delete(workspaces);
  await testDatabase.db.delete(schema.executionEvents);
  await testDatabase.db.delete(schema.executionEventStreams);
  await testDatabase.db.delete(schema.executionAssignments);
  await testDatabase.db.delete(runs);
});

async function seed(
  overrides: Partial<Parameters<typeof seedLostTurn>[0]> = {},
) {
  return seedLostTurn({
    db: testDatabase.db,
    projectId: project.id,
    repoPath: project.repoPath,
    hostId,
    flow,
    ...overrides,
  });
}

async function read(table: any, id: string): Promise<any> {
  const rows = await testDatabase.db
    .select()
    .from(table)
    .where(eq(table.id, id));

  return rows[0];
}

async function boundary(input: Record<string, unknown>) {
  const { applyTurnLostBoundary } = await import(
    "@/lib/runs/turn-lost-boundary"
  );

  return applyTurnLostBoundary({
    db,
    nodeId: "implement",
    reason: "turn-lost",
    ...input,
  } as never);
}

describe("applyTurnLostBoundary — the winner", () => {
  it("moves the run, the attempt and the command together", async () => {
    const seeded = await seed();

    expect(await boundary({ runId: seeded.runId })).toBe("applied");
    const run = await read(runs, seeded.runId);
    const attempt = await read(nodeAttempts, seeded.nodeAttemptId);
    const command = await read(executionCommands, seeded.commandId);

    expect(run.status).toBe("Crashed");
    expect(
      run.resumeTargetStepId,
      "without this the run is Crashed AND unrecoverable — worse than the Failed it replaces",
    ).toBe("implement");
    expect({
      status: attempt.status,
      decision: attempt.decision,
      errorCode: attempt.errorCode,
    }).toEqual({
      status: "Reworked",
      decision: "turn_lost",
      errorCode: "CRASH",
    });
    expect(attempt.endedAt).not.toBeNull();
    expect(command.applicationState).toBe("applied");
    expect(command.completionAppliedAt).not.toBeNull();
  }, 60_000);

  it("owner-poisoned discharges the command and PRESERVES its diagnostic", async () => {
    const seeded = await seed({
      applicationState: "poisoned",
      lastError: { code: "ACP_PROTOCOL" },
    });

    await testDatabase.db
      .update(executionCommands)
      .set({
        applicationError: {
          reason: "owner_invariant",
          phase: "apply",
          causeCode: "x",
        },
      })
      .where(eq(executionCommands.id, seeded.commandId));

    expect(
      await boundary({ runId: seeded.runId, reason: "owner-poisoned" }),
    ).toBe("applied");
    const command = await read(executionCommands, seeded.commandId);

    expect(command.applicationState).toBe("applied");
    expect(
      command.applicationError,
      "retirement eligibility must not cost the operator the reason it was poisoned",
    ).toMatchObject({ reason: "owner_invariant" });
  }, 60_000);

  it("an ALREADY-discharged command still crashes — the obligation is met, not lost", async () => {
    // Reachable on exactly one arm: `quarantine()` writes
    // `application_state = completion_applied_at ? "applied" : "poisoned"`, so
    // a conflict found after application arrives here already stamped. Treating
    // that as a lost race would leave the run `Running` forever with a
    // disagreeing turn nobody can see.
    const seeded = await seed({
      applicationState: "applied",
      completionAppliedAt: new Date(),
    });

    expect(
      await boundary({ runId: seeded.runId, reason: "owner-poisoned" }),
    ).toBe("applied");
    expect((await read(runs, seeded.runId)).status).toBe("Crashed");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).decision).toBe(
      "turn_lost",
    );
  }, 60_000);
});

describe("applyTurnLostBoundary — every loser writes NOTHING", () => {
  it("a closed attempt yields without touching the run", async () => {
    const seeded = await seed({ attemptStatus: "Reworked" });

    expect(await boundary({ runId: seeded.runId })).toBe("not-claimed");
    expect((await read(runs, seeded.runId)).status).toBe("Running");
    expect(
      (await read(executionCommands, seeded.commandId)).applicationState,
    ).toBe("pending");
  }, 60_000);

  it("an attempt that ALREADY carries a completion is never overwritten", async () => {
    // The load-bearing guard. A real result landed between the classification
    // and this write; that result is the node's outcome, and crashing over it
    // would discard a paid turn.
    const seeded = await seed();

    await testDatabase.db
      .update(nodeAttempts)
      .set({
        // `node_attempts_action_completion_check` pins the whole shape: version
        // 1, a `promptOrdinal` equal to the row's own, an object `result` with
        // a boolean `ok`, and an object `originalOutput`. A fixture cannot fake
        // half of a completion, which is the point.
        actionCompletion: {
          version: 1,
          commandId: seeded.commandId,
          promptOrdinal: 0,
          result: { ok: true, stdout: "done", vars: {} },
          originalOutput: { kind: "sentinel", text: "done", truncated: false },
        },
      })
      .where(eq(nodeAttempts.id, seeded.nodeAttemptId));

    expect(await boundary({ runId: seeded.runId })).toBe("lost-cas");
    expect((await read(runs, seeded.runId)).status).toBe("Running");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).status).toBe(
      "Running",
    );
    expect(
      (await read(executionCommands, seeded.commandId)).applicationState,
    ).toBe("pending");
  }, 60_000);

  it("a run that moved since classification rolls the attempt close back too", async () => {
    const seeded = await seed({ status: "Review" });

    // `fromStatuses` defaults to Running, so the run CAS loses — and the
    // attempt close, which had already succeeded inside the transaction, must
    // go back with it.
    expect(await boundary({ runId: seeded.runId })).toBe("lost-cas");
    expect((await read(runs, seeded.runId)).status).toBe("Review");
    expect(
      (await read(nodeAttempts, seeded.nodeAttemptId)).status,
      "the attempt close is inside the same transaction as the run crash — one rolls both back",
    ).toBe("Running");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).endedAt).toBeNull();
  }, 60_000);

  it("an attempt with no owned prompt yields rather than crashing on thin evidence", async () => {
    const seeded = await seed();

    await testDatabase.db
      .delete(executionCommands)
      .where(eq(executionCommands.id, seeded.commandId));

    expect(
      await boundary({ runId: seeded.runId }),
      "without a command there is nothing to discharge, and this would just be agent-session-gone wearing a better name",
    ).toBe("not-claimed");
    expect((await read(runs, seeded.runId)).status).toBe("Running");
  }, 60_000);
});
