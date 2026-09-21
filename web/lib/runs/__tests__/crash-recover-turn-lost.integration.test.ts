// ADR-177 D5 — Recover declines a `turn_lost` result AND discharges it.
//
// ADR-175 made `applyCrashedTurnEvidence` adopt agreeing terminal evidence the
// owner never applied, so a Recover never pays twice for one turn. A LOST turn
// is not a result: adopting it decodes into a failed node action, the graph
// terminalizes the run `Failed`, and `isRunRecoverable` then refuses it — the
// operator has no remedy at all. This suite owns that one arm and the discharge
// that has to ride with it.
//
// Reachability (why this is its OWN control, not a corollary of the sweep's
// RED 1): `applyCrashedTurnEvidence` only looks at attempts
// `openRunningAttempts` returns, and the ADR-177 boundary CLOSES the attempt.
// A run crashed `turn-lost` therefore presents no open attempt and never
// reaches this code. The exposed population is a run crashed for some OTHER
// reason — `worktree-gone`, `orphaned-child`, `cli-not-retry-safe` — plus every
// row already crashed `agent-session-gone` before this ships.
//
// Mocked suites ignore `WHERE` clauses and every property here is one, so the
// database is real.

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { classifyCommandRetirement } from "@/lib/execution-host/retirement";
import { applyCrashedTurnEvidence } from "@/lib/runs/crash-recover";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  retirementRow,
  seedLostTurn,
  seedTurnLostFlow,
  TURN_LOST_FLAT_ERROR,
  type SeededFlowGraph,
} from "@/test-support/turn-lost-seed";

const schema = fullSchema as unknown as Record<string, any>;
const { executionCommands, nodeAttempts, runs, workspaces } = schema;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;
let flow: SeededFlowGraph;

const FAR_FUTURE = { now: new Date(Date.now() + 86_400_000), graceMs: 0 };

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "crash_recover_turn_lost",
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

async function seedCrashed(
  overrides: Partial<Parameters<typeof seedLostTurn>[0]> = {},
) {
  return seedLostTurn({
    db: testDatabase.db,
    projectId: project.id,
    repoPath: project.repoPath,
    hostId,
    flow,
    status: "Crashed",
    ...overrides,
  });
}

async function mintResume(runId: string): Promise<string> {
  const assignment = await testDatabase.db.transaction(async (tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "resume" }),
  );

  return assignment.id;
}

async function read(table: any, id: string): Promise<any> {
  const rows = await testDatabase.db
    .select()
    .from(table)
    .where(eq(table.id, id));

  return rows[0];
}

describe("Recover and a lost turn (ADR-177 D5)", () => {
  it("AC-T3.5.1: a lost turn is DECLINED, never decoded onto the attempt", async () => {
    const seeded = await seedCrashed();
    const assignmentId = await mintResume(seeded.runId);

    const outcome = await applyCrashedTurnEvidence(db, {
      runId: seeded.runId,
      nodeId: "implement",
      assignmentId,
    });

    expect(
      outcome,
      "adopting a lost turn fails the node and burns the run into an unrecoverable Failed",
    ).toBe("turn-lost");
    expect(
      (await read(nodeAttempts, seeded.nodeAttemptId)).actionCompletion,
    ).toBeNull();
  }, 60_000);

  it("AC-T3.5.1b: the FLAT turn_lost shape foldReceipt writes is declined too", async () => {
    const seeded = await seedCrashed({
      lastError: { ...TURN_LOST_FLAT_ERROR },
    });
    const assignmentId = await mintResume(seeded.runId);

    expect(
      await applyCrashedTurnEvidence(db, {
        runId: seeded.runId,
        nodeId: "implement",
        assignmentId,
      }),
      "a matcher keyed only on details.reason misses foldReceipt's flattened error",
    ).toBe("turn-lost");
  }, 60_000);

  it("AC-T3.5.2: the declined command is SUPERSEDED, so retirement discharges it", async () => {
    const seeded = await seedCrashed();
    const assignmentId = await mintResume(seeded.runId);

    await applyCrashedTurnEvidence(db, {
      runId: seeded.runId,
      nodeId: "implement",
      assignmentId,
    });
    const command = await read(executionCommands, seeded.commandId);

    expect(
      command.applicationState,
      "declining without settling strands it owner_unapplied forever — the exact failure C3 exists to prevent",
    ).toBe("superseded");
    expect(
      command.completionAppliedAt,
      "execution_commands_application_shape_check is an EQUIVALENCE: only `applied` may carry completion_applied_at",
    ).toBeNull();
    expect(
      classifyCommandRetirement(
        retirementRow(command, "Done") as never,
        FAR_FUTURE,
      ),
    ).toBeNull();
  }, 60_000);

  it("AC-T3.5.3: an ordinary agreeing failed result is still ADOPTED — the ADR-175 arm is untouched", async () => {
    const seeded = await seedCrashed({
      lastError: { code: "SPAWN", details: { reason: "adapter_exit" } },
    });
    const assignmentId = await mintResume(seeded.runId);

    expect(
      await applyCrashedTurnEvidence(db, {
        runId: seeded.runId,
        nodeId: "implement",
        assignmentId,
      }),
      "only turn_lost is declined; every other agreeing terminal result is applied exactly as before",
    ).toBe("applied");
  }, 60_000);

  it("AC-T3.5.3b: an already-quarantined turn still answers quarantined, never turn-lost", async () => {
    const seeded = await seedCrashed({ applicationState: "poisoned" });

    await testDatabase.db
      .update(executionCommands)
      .set({
        applicationError: {
          reason: "prompt_terminal_conflict",
          phase: "prepare",
          causeCode: "x",
        },
      })
      .where(eq(executionCommands.id, seeded.commandId));
    const assignmentId = await mintResume(seeded.runId);

    expect(
      await applyCrashedTurnEvidence(db, {
        runId: seeded.runId,
        nodeId: "implement",
        assignmentId,
      }),
      "the quarantine arm is checked before the settle, and ADR-177 must not reorder it",
    ).toBe("quarantined");
  }, 60_000);
});

describe("agent and scratch leave no owner_unapplied command (ADR-177 D4)", () => {
  it.each(["agent", "scratch"] as const)(
    "a %s run whose turn was lost still discharges its command",
    async (runKind) => {
      // Phase 0 verified both owners already settle on EVERY outcome, so this
      // is the regression guard on that fact rather than a new requirement:
      // a writer that forgets blocks deleting the run forever
      // (`execution_commands_protected_evidence`).
      const seeded = await seedLostTurn({
        db: testDatabase.db,
        projectId: project.id,
        repoPath: project.repoPath,
        hostId,
        flow,
        runKind,
        applicationState: "applied",
        completionAppliedAt: new Date(),
      });
      const command = await read(executionCommands, seeded.commandId);

      expect(
        classifyCommandRetirement(
          retirementRow(command, "Crashed") as never,
          FAR_FUTURE,
        ),
      ).toBeNull();
    },
    60_000,
  );

  it("an agent run whose turn was lost finalizes Crashed — recoverable-shaped, not a dead Failed", async () => {
    const { finalizeAgentRun } = await import("@/lib/agents/launch");
    const seeded = await seedLostTurn({
      db: testDatabase.db,
      projectId: project.id,
      repoPath: project.repoPath,
      hostId,
      flow,
      runKind: "agent",
    });

    await testDatabase.db
      .update(runs)
      .set({ agentWorkspace: "worktree" })
      .where(eq(runs.id, seeded.runId));

    const result = await finalizeAgentRun(seeded.runId, "Crashed", {
      db,
      reason: "turn_lost",
      closeOpenHitl: true,
    });

    expect(result.finalized).toBe(true);
    expect((await read(runs, seeded.runId)).status).toBe("Crashed");
  }, 60_000);
});

describe("evidence is attempt-scoped, which is WHY T3.5 must discharge (ADR-177 D1)", () => {
  it("a command owned by a CLOSED earlier attempt is invisible to the current one", async () => {
    const seeded = await seedLostTurn({
      db: testDatabase.db,
      projectId: project.id,
      repoPath: project.repoPath,
      hostId,
      flow,
    });

    await testDatabase.db
      .update(nodeAttempts)
      .set({ status: "Reworked", endedAt: new Date() })
      .where(eq(nodeAttempts.id, seeded.nodeAttemptId));
    const freshAttemptId = randomUUID();

    await testDatabase.db.insert(nodeAttempts).values({
      id: freshAttemptId,
      runId: seeded.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 2,
      status: "Running",
      executionAssignmentId: seeded.assignmentId,
      actionPromptOrdinal: 0,
      startedAt: new Date(Date.now() - 600_000),
    });

    // The sweep's probe filters `owner_ref->>'nodeAttemptId' = <current>`, so
    // the orphan belongs to the closed attempt and simply leaks. Nothing else
    // in the system will ever settle it — hence the discharge in T3.5.
    const visible = await testDatabase.db
      .select({ id: executionCommands.id })
      .from(executionCommands)
      .where(
        sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${freshAttemptId}`,
      );

    expect(visible).toHaveLength(0);
    const orphaned = await testDatabase.db
      .select({ id: executionCommands.id })
      .from(executionCommands)
      .where(eq(executionCommands.applicationState, "pending"));

    expect(
      orphaned,
      "the orphan is real and unreachable from the sweep — T3.5 is the only thing that can settle it",
    ).toHaveLength(1);
  }, 60_000);
});
