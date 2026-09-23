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

import { randomUUID } from "node:crypto";

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
  TURN_LOST_NESTED_ERROR as TURN_LOST_NESTED,
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

// ADR-177 T3.3, the gate half. Review found this branch shipped with NO test:
// it writes to three tables (attempt, run, gate evaluation) and nothing
// executed it. Driven here through the REAL adapter rather than a re-implementation.
describe("the flow GATE owner refuses a lost turn (ADR-177 T3.3)", () => {
  async function seedGate(overrides: Record<string, unknown> = {}) {
    const seeded = await seed({ withSession: true, ...overrides });
    const evaluationId = randomUUID();

    await testDatabase.db.insert(schema.gateResults).values({
      id: evaluationId,
      runId: seeded.runId,
      nodeAttemptId: seeded.nodeAttemptId,
      gateId: "ci",
      kind: "ai_judgment",
      mode: "blocking",
      status: "running",
      promptOrdinal: 0,
    });

    return { ...seeded, evaluationId };
  }

  function gateOwner(seeded: Awaited<ReturnType<typeof seedGate>>) {
    return {
      kind: "flow_node_attempt" as const,
      ref: {
        version: 1 as const,
        variant: "gate_ai" as const,
        gateId: "ci",
        evaluationId: seeded.evaluationId,
        nodeAttemptId: seeded.nodeAttemptId,
        promptOrdinal: 0,
        runId: seeded.runId,
        runSessionId: seeded.runSessionId!,
        incarnationId: seeded.incarnationId!,
        assignmentId: seeded.assignmentId,
        assignmentEpoch: seeded.assignmentEpoch,
      },
    };
  }

  async function applyGate(
    seeded: Awaited<ReturnType<typeof seedGate>>,
    error: Record<string, unknown>,
  ): Promise<string> {
    const { flowPromptOwnerAdapter } = await import(
      "@/lib/flows/graph/prompt-owner"
    );
    const command = await read(executionCommands, seeded.commandId);
    const prepared = await flowPromptOwnerAdapter.prepare({
      db,
      owner: gateOwner(seeded) as never,
      command,
      outcome: { state: "failed", error } as never,
      signal: AbortSignal.timeout(30_000),
    } as never);

    return testDatabase.db.transaction(async (tx) =>
      prepared.apply(tx as never),
    );
  }

  it("closes the attempt, crashes the run, and STALES the evaluation", async () => {
    const seeded = await seedGate();

    expect(await applyGate(seeded, { ...TURN_LOST_NESTED })).toBe("applied");
    expect((await read(runs, seeded.runId)).status).toBe("Crashed");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).decision).toBe(
      "turn_lost",
    );
    // NOT `failed`: recording a host restart as a gate verdict would send the
    // run to rework or block promotion on a decision no judge ever made. NOT
    // left `running` either — that is the stuck shape `runGateStepGuarded`
    // exists to prevent.
    expect((await read(schema.gateResults, seeded.evaluationId)).status).toBe(
      "stale",
    );
  }, 60_000);

  it("a gate whose PARENT ACTION already completed still stales and crashes", async () => {
    // The production shape, and the one the first version of this suite missed:
    // gates run AFTER the action persists `action_completion` on the SAME
    // attempt (`runner-graph.ts` — "Run pre_finish.gates after the action
    // succeeds"). The close guard used to require `action_completion IS NULL`,
    // so a real lost gate turn matched zero rows, threw, and the owner retried
    // until the command poisoned — a permanent stall, while the fixture without
    // a completion passed happily.
    const seeded = await seedGate();

    await testDatabase.db
      .update(nodeAttempts)
      .set({
        actionCompletion: {
          version: 1,
          commandId: seeded.commandId,
          promptOrdinal: 0,
          result: { ok: true, stdout: "action done", vars: {} },
          originalOutput: { kind: "sentinel", text: "done", truncated: false },
        },
      })
      .where(eq(nodeAttempts.id, seeded.nodeAttemptId));

    expect(await applyGate(seeded, { ...TURN_LOST_NESTED })).toBe("applied");
    expect((await read(runs, seeded.runId)).status).toBe("Crashed");
    expect((await read(schema.gateResults, seeded.evaluationId)).status).toBe(
      "stale",
    );
    expect(
      (await read(nodeAttempts, seeded.nodeAttemptId)).actionCompletion,
      "the action's own result is NOT discarded by a lost gate turn",
    ).not.toBeNull();
  }, 60_000);

  it("an ordinary gate failure is untouched by this arm", async () => {
    const seeded = await seedGate();

    // Not a lost turn, so the arm must not fire. The verdict path needs a real
    // decoded completion, which this fixture has no output for — asserting the
    // run was NOT crashed is what separates the two arms.
    await applyGate(seeded, { code: "SPAWN" }).catch(() => "threw");
    expect(
      (await read(runs, seeded.runId)).status,
      "only a lost turn takes the crash branch",
    ).toBe("Running");
    expect(
      (await read(nodeAttempts, seeded.nodeAttemptId)).decision,
    ).toBeNull();
  }, 60_000);

  it("yields `superseded` when the run has moved off the gate's node", async () => {
    const seeded = await seedGate();

    await testDatabase.db
      .update(runs)
      .set({ currentStepId: "somewhere-else" })
      .where(eq(runs.id, seeded.runId));

    // The guard that review found missing: without `currentStepId === nodeId`
    // this would crash a run whose cursor had already advanced.
    expect(await applyGate(seeded, { ...TURN_LOST_NESTED })).toBe("superseded");
    expect((await read(runs, seeded.runId)).status).toBe("Running");
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

  it("refuses when the node moved to a DIFFERENT attempt since classification (Codex review)", async () => {
    // The interleaving: the sweep classifies lost attempt A, and before the
    // write lands a Recover closes A and opens attempt B at the same node.
    // Re-deriving "the open attempt" would hand A's diagnosis to B and mark B's
    // healthy in-flight command applied. The classified identity is carried, so
    // the write refuses a moved target instead.
    const a = await seed();

    await testDatabase.db
      .update(nodeAttempts)
      .set({ status: "Reworked", endedAt: new Date() })
      .where(eq(nodeAttempts.id, a.nodeAttemptId));
    const bId = randomUUID();

    await testDatabase.db.insert(nodeAttempts).values({
      id: bId,
      runId: a.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 2,
      status: "Running",
      executionAssignmentId: a.assignmentId,
      actionPromptOrdinal: 0,
      startedAt: new Date(),
    });
    // B's OWN in-flight prompt. Without it the boundary yields for lack of a
    // command and the case passes for the wrong reason — measured: the first
    // version of this test stayed green with the identity check disabled.
    const bCommandId = randomUUID();

    await testDatabase.db.insert(executionCommands).values({
      id: bCommandId,
      runId: a.runId,
      executionAssignmentId: a.assignmentId,
      executionHostId: hostId,
      assignmentEpoch: a.assignmentEpoch,
      kind: "session.prompt",
      targetSessionId: `sess-b-${bId.slice(0, 8)}`,
      payload: {},
      maxAttempts: 3,
      ownerKind: "flow_node_attempt",
      ownerRef: {
        version: 1,
        variant: "node",
        nodeAttemptId: bId,
        promptOrdinal: 0,
        runId: a.runId,
        runSessionId: randomUUID(),
        incarnationId: randomUUID(),
        assignmentId: a.assignmentId,
        assignmentEpoch: a.assignmentEpoch,
      },
      logicalOperationKey: `flow_node_attempt:node:${bId}:0`,
      requestSchema: "maister.command.request.v1",
      requestSha256: "d".repeat(64),
      state: "accepted",
      acceptedAt: new Date(),
    });

    expect(
      await boundary({ runId: a.runId, expectedAttemptId: a.nodeAttemptId }),
    ).toBe("not-claimed");
    expect((await read(runs, a.runId)).status).toBe("Running");
    expect(
      (await read(nodeAttempts, bId)).status,
      "attempt B is a different turn and must be left entirely alone",
    ).toBe("Running");
    expect(
      (await read(executionCommands, bCommandId)).applicationState,
      "B's healthy in-flight command must never be marked applied by A's diagnosis",
    ).toBe("pending");
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

// ADR-177 amendment (2026-09-23): the sweep classifies the attempt's CURRENT
// turn — a permission-resumed action or a gate evaluation is a newer command on
// the same attempt — so the boundary must act on that command, and a gate's
// needs the gate owner's writes.
describe("applyTurnLostBoundary — the attempt's current turn", () => {
  /** A newer command on the seeded attempt, still `accepted` on the host. */
  async function sibling(
    seeded: Awaited<ReturnType<typeof seed>>,
    ref: Record<string, unknown>,
    logicalOperationKey: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const base = await read(executionCommands, seeded.commandId);
    const id = randomUUID();

    await testDatabase.db.insert(executionCommands).values({
      id,
      runId: seeded.runId,
      executionAssignmentId: base.executionAssignmentId,
      executionHostId: base.executionHostId,
      assignmentEpoch: base.assignmentEpoch,
      kind: "session.prompt",
      targetSessionId: base.targetSessionId,
      payload: {},
      maxAttempts: 3,
      ownerKind: "flow_node_attempt",
      ownerRef: { ...base.ownerRef, ...ref },
      logicalOperationKey,
      requestSchema: "maister.command.request.v1",
      requestSha256: "d".repeat(64),
      state: "accepted",
      acceptedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() + 1_000),
      ...overrides,
    });

    return id;
  }

  async function gateEvaluation(
    runId: string,
    nodeAttemptId: string,
    status: string,
  ): Promise<string> {
    const id = randomUUID();

    await testDatabase.db.insert(schema.gateResults).values({
      id,
      runId,
      nodeAttemptId,
      gateId: "ci",
      kind: "ai_judgment",
      mode: "blocking",
      status,
    });

    return id;
  }

  it("with no named command it discharges the live permission_resume turn, not the node turn before it", async () => {
    const seeded = await seed();
    const resumed = await sibling(
      seeded,
      { variant: "permission_resume", hitlRequestId: randomUUID() },
      `flow_node_attempt:permission_resume:${seeded.nodeAttemptId}:0`,
    );

    expect(await boundary({ runId: seeded.runId })).toBe("applied");
    expect((await read(executionCommands, resumed)).applicationState).toBe(
      "applied",
    );
    expect(
      (await read(executionCommands, seeded.commandId)).applicationState,
      "the earlier node turn is not the one this boundary acted on",
    ).toBe("pending");
  }, 60_000);

  it("refuses a gate turn whose evaluation belongs to another attempt, and writes nothing", async () => {
    const seeded = await seed();
    const otherAttempt = randomUUID();

    await testDatabase.db.insert(nodeAttempts).values({
      id: otherAttempt,
      runId: seeded.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 0,
      status: "Reworked",
      executionAssignmentId: seeded.assignmentId,
      actionPromptOrdinal: 0,
      startedAt: new Date(Date.now() - 900_000),
      endedAt: new Date(Date.now() - 800_000),
    });
    const evaluationId = await gateEvaluation(
      seeded.runId,
      otherAttempt,
      "running",
    );
    const gate = await sibling(
      seeded,
      { variant: "gate_ai", gateId: "ci", evaluationId },
      `flow_node_attempt:gate_ai:${evaluationId}:0`,
    );

    expect(await boundary({ runId: seeded.runId, commandId: gate })).toBe(
      "lost-cas",
    );
    expect((await read(runs, seeded.runId)).status).toBe("Running");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).status).toBe(
      "Running",
    );
    expect((await read(schema.gateResults, evaluationId)).status).toBe(
      "running",
    );
    expect((await read(executionCommands, gate)).applicationState).toBe(
      "pending",
    );
  }, 60_000);

  it("keeps a gate verdict already recorded when a post-application conflict crashes the run", async () => {
    const seeded = await seed();
    const evaluationId = await gateEvaluation(
      seeded.runId,
      seeded.nodeAttemptId,
      "passed",
    );
    const appliedAt = new Date(Date.now() - 30_000);
    const gate = await sibling(
      seeded,
      { variant: "gate_ai", gateId: "ci", evaluationId },
      `flow_node_attempt:gate_ai:${evaluationId}:0`,
      {
        state: "succeeded",
        completedAt: appliedAt,
        applicationState: "applied",
        completionAppliedAt: appliedAt,
        applicationError: {
          reason: "prompt_terminal_conflict",
          phase: "prepare",
          causeCode: "terminal_v2_agreement",
        },
      },
    );

    await testDatabase.db
      .update(nodeAttempts)
      .set({
        actionCompletion: {
          version: 1,
          commandId: seeded.commandId,
          promptOrdinal: 0,
          result: { ok: true, stdout: "action done", vars: {} },
          originalOutput: { kind: "sentinel", text: "done", truncated: false },
        },
      })
      .where(eq(nodeAttempts.id, seeded.nodeAttemptId));

    expect(
      await boundary({
        runId: seeded.runId,
        commandId: gate,
        reason: "owner-poisoned",
      }),
    ).toBe("applied");
    expect((await read(runs, seeded.runId)).status).toBe("Crashed");
    expect((await read(nodeAttempts, seeded.nodeAttemptId)).status).toBe(
      "Reworked",
    );
    expect(
      (await read(schema.gateResults, evaluationId)).status,
      "a recorded verdict is evidence; only an undecided gate becomes stale",
    ).toBe("passed");
  }, 60_000);
});
