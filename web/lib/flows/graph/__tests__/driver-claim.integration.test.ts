import type { Db } from "@/lib/execution-host/db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  artifactInstances,
  executionAssignments,
  nodeAttempts,
  runs,
  tasks,
} from "@/lib/db/schema";
import { prepareConsensusInputEvidence } from "@/lib/flows/graph/consensus/input-evidence";
import {
  boundConsensusText,
  CONSENSUS_PROMPT_TEXT_CAP_BYTES,
} from "@/lib/flows/graph/consensus/text";
import {
  claimFlowDriver,
  FlowDriverClaimLost,
  isFlowDriverClaimLost,
  releaseFlowDriverClaim,
  renewFlowDriverClaim,
} from "@/lib/flows/graph/driver-claim";
import { flowDriverDatabase } from "@/lib/flows/graph/driver-db";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { boundedPostgresTransaction } from "@/lib/execution-host/events/projection-transaction";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { runAgentStep } from "@/lib/flows/runner-agent";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { buildContext } from "@/lib/flows/context";

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_driver_claims",
  });
  db = database.db as unknown as Db;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function seedClaim() {
  const seeded = await seedGraphRun(database.db, {
    schemaVersion: 1,
    name: "driver-claim",
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  });
  const { assignment } = await fakeExecutionHosts(db, { runId: seeded.runId });

  if (!assignment) throw new Error("seeded assignment missing");

  return { runId: seeded.runId, assignmentId: assignment.id };
}

describe("Flow traversal database fences", () => {
  it("preserves non-key run locks during evidence preparation and session binding against an event FK reader", async () => {
    const seeded = await seedClaim();
    const attemptId = randomUUID();

    await db
      .update(runs)
      .set({ currentStepId: "work" })
      .where(eq(runs.id, seeded.runId));
    await db.insert(nodeAttempts).values({
      id: attemptId,
      runId: seeded.runId,
      nodeId: "work",
      nodeType: "consensus",
      status: "Running",
    });
    const claim = await claimFlowDriver(db, seeded);

    if (!claim) throw new Error("Expected traversal claim");
    const reader = await database.pool.connect();
    const generationId = `run:${attemptId}:consensus-synthesis:r1:consensus`;
    const bounded = boundConsensusText("plan", CONSENSUS_PROMPT_TEXT_CAP_BYTES);

    try {
      await reader.query("BEGIN");
      // Event insertion retains this FK lock until its run-frontier update.
      await reader.query("SELECT id FROM runs WHERE id=$1 FOR KEY SHARE", [
        seeded.runId,
      ]);
      await prepareConsensusInputEvidence(flowDriverDatabase(db, claim), {
        runId: seeded.runId,
        nodeId: "work",
        nodeAttemptId: attemptId,
        attempt: 1,
        round: 1,
        generationId,
        role: "synthesis",
        sourceId: "selected",
        value: bounded.text,
        renderPrompt: (slot) => `Synthesize ${slot}`,
        textBounds: bounded.bounds,
      });
      expect(
        await flowDriverDatabase(db, claim).transaction((tx) =>
          lockCurrentSessionAssignment(tx, seeded),
        ),
      ).toMatchObject({ id: seeded.assignmentId });
      expect(
        await db
          .select()
          .from(artifactInstances)
          .where(eq(artifactInstances.id, `${generationId}:input`)),
      ).toHaveLength(1);
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
      await releaseFlowDriverClaim(db, claim);
    }
  });

  it("preserves a revoked driver's typed fence through the prompt privacy boundary", async () => {
    const request = "private-revoked-driver-request-sentinel";
    const seeded = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "revoked-prompt-driver",
        nodes: [
          {
            id: "work",
            type: "ai_coding",
            action: { prompt: "Work" },
            transitions: { success: "done" },
          },
        ],
      },
      {
        run: {
          scheduledRequestSnapshot: {
            version: 1,
            scheduleId: randomUUID(),
            triggerAttemptId: randomUUID(),
            requestAtLaunch: request,
          },
        },
      },
    );
    const { assignment } = await fakeExecutionHosts(db, {
      runId: seeded.runId,
    });

    if (!assignment) throw new Error("Expected placed graph assignment");
    const claim = await claimFlowDriver(db, {
      runId: seeded.runId,
      assignmentId: assignment.id,
    });

    if (!claim) throw new Error("Expected traversal claim");
    const loaded = await loadRun(database.db, seeded.runId);
    const controller = new AbortController();

    controller.abort();
    const attemptId = randomUUID();
    const failure: unknown = await runAgentStep(
      { id: "work", type: "agent", mode: "new-session", prompt: "Work" },
      {
        runtimeRoot: seeded.runtimeRoot,
        worktreePath: seeded.worktreePath,
        runId: seeded.runId,
        projectSlug: loaded.projectSlug,
        stepId: "work",
        nodeAttemptId: attemptId,
        promptOwner: {
          variant: "node",
          nodeAttemptId: attemptId,
          promptOrdinal: 1,
        },
        flowDriverClaim: claim,
        scheduledRequestSnapshot: loaded.run.scheduledRequestSnapshot,
        sessionName: "work",
        executor: { ...loaded.executor, env: loaded.executor.env ?? undefined },
        context: buildContext({
          task: loaded.task,
          run: loaded.run,
          executor: loaded.executor,
          nodeAttempts: [],
          projectSlug: loaded.projectSlug,
        }),
        db: flowDriverDatabase(db, claim, controller.signal),
      },
    ).catch((error: unknown) => error);

    expect(isFlowDriverClaimLost(failure)).toBe(true);
    expect(failure).toBeInstanceOf(FlowDriverClaimLost);
    expect(String(failure)).not.toContain("Failed query");
    expect(JSON.stringify(failure)).not.toContain(request);
    expect(
      (
        await db
          .select({ status: runs.status, token: runs.flowDriverToken })
          .from(runs)
          .where(eq(runs.id, seeded.runId))
      )[0],
    ).toEqual({ status: "Running", token: claim.token });
    expect(
      (
        await database.pool.query(
          "SELECT id FROM execution_commands WHERE run_id=$1",
          [seeded.runId],
        )
      ).rows,
    ).toEqual([]);
    await releaseFlowDriverClaim(db, claim);
  });

  it("allocates relational query registries only on demand inside the guarded transaction and savepoint", async () => {
    const seeded = await seedClaim();
    const entries = Object.entries;
    let registries = 0;
    const observer = vi.spyOn(Object, "entries").mockImplementation((value) => {
      if (
        Object.hasOwn(value, "runs") &&
        Object.hasOwn(value, "executionEvents") &&
        Reflect.get(value, "runs")?.tsName === "runs"
      )
        registries += 1;

      return entries(value);
    });

    try {
      await boundedPostgresTransaction(db, async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "outer" })
          .where(eq(runs.id, seeded.runId));
        await tx.transaction(async (nested) => {
          await nested
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.id, seeded.runId));
        });
        expect(registries).toBe(0);
        expect(
          (await tx.query.runs.findFirst({ where: eq(runs.id, seeded.runId) }))
            ?.currentStepId,
        ).toBe("outer");
        expect(registries).toBe(1);
        await expect(
          tx.transaction(async (nested) => {
            await nested
              .update(runs)
              .set({ currentStepId: "nested" })
              .where(eq(runs.id, seeded.runId));
            expect(
              (
                await nested.query.runs.findFirst({
                  where: eq(runs.id, seeded.runId),
                })
              )?.currentStepId,
            ).toBe("nested");
            throw new Error("rollback relational savepoint");
          }),
        ).rejects.toThrow("rollback relational savepoint");
        expect(
          (await tx.query.runs.findFirst({ where: eq(runs.id, seeded.runId) }))
            ?.currentStepId,
        ).toBe("outer");
        expect(registries).toBe(2);
      });
      expect(
        (await db.query.runs.findFirst({ where: eq(runs.id, seeded.runId) }))
          ?.currentStepId,
      ).toBe("outer");
    } finally {
      observer.mockRestore();
    }
  });

  it("reuses immutable schema metadata while each bounded transaction reads fresh rows", async () => {
    const seeded = await seedClaim();
    const key = Object.getOwnPropertySymbols(runs).find(
      (symbol) => symbol.description === "drizzle:ExtraConfigBuilder",
    );

    if (!key) throw new Error("installed Drizzle schema builder is missing");
    const descriptor = Object.getOwnPropertyDescriptor(runs, key);
    const builder: unknown = Reflect.get(runs, key);

    if (!descriptor || typeof builder !== "function")
      throw new Error("installed Drizzle schema builder cannot be observed");
    let compilations = 0;

    Object.defineProperty(runs, key, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]): unknown {
        compilations += 1;

        return Reflect.apply(builder, this, args);
      },
    });
    try {
      await boundedPostgresTransaction(db, async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "first" })
          .where(eq(runs.id, seeded.runId));
        const row = await tx.query.runs.findFirst({
          where: eq(runs.id, seeded.runId),
        });

        expect(row?.currentStepId).toBe("first");
      });
      await boundedPostgresTransaction(db, async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "second" })
          .where(eq(runs.id, seeded.runId));
        const row = await tx.query.runs.findFirst({
          where: eq(runs.id, seeded.runId),
        });

        expect(row?.currentStepId).toBe("second");
      });
      expect(compilations).toBe(0);
    } finally {
      Object.defineProperty(runs, key, descriptor);
    }
  });

  it("admits one concurrent driver and preserves Drizzle join row modes and date parsers", async () => {
    const input = await seedClaim();
    const claims = await Promise.all([
      claimFlowDriver(db, input),
      claimFlowDriver(db, input),
    ]);
    const winners = claims.filter((claim) => claim !== null);

    expect(winners).toHaveLength(1);
    const driver = flowDriverDatabase(db, winners[0]!);

    await driver
      .update(runs)
      .set({ currentStepId: "work" })
      .where(eq(runs.id, input.runId));
    const [row] = await driver
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, input.runId));

    expect(row.run).toMatchObject({ id: input.runId, currentStepId: "work" });
    expect(row.run.startedAt).toBeInstanceOf(Date);
    expect(row.task.id).toBe(row.run.taskId);
    await renewFlowDriverClaim(db, winners[0]!);
    await releaseFlowDriverClaim(db, winners[0]!);
  });

  it("rolls back nested graph writes together", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    const driver = flowDriverDatabase(db, claim);

    await expect(
      driver.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "outer" })
          .where(eq(runs.id, input.runId));
        await tx.transaction(async (nested) => {
          await nested
            .update(runs)
            .set({ currentStepId: "nested" })
            .where(eq(runs.id, input.runId));
        });
        throw new Error("rollback complete continuation");
      }),
    ).rejects.toThrow("rollback complete continuation");
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, claim);
  });

  it("rejects a stale driver and its cleanup after actual lease expiry and successor claim", async () => {
    const input = await seedClaim();
    const original = await claimFlowDriver(db, input);

    if (!original) throw new Error("driver claim missing");
    const stale = flowDriverDatabase(db, original);

    await database.pool.query(
      "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.05) FROM runs WHERE id = $1",
      [input.runId],
    );
    const successor = await claimFlowDriver(db, input);

    expect(successor).not.toBeNull();
    await expect(
      stale
        .update(runs)
        .set({ currentStepId: "stale" })
        .where(eq(runs.id, input.runId)),
    ).rejects.toHaveProperty("cause", expect.any(FlowDriverClaimLost));
    await expect(renewFlowDriverClaim(db, original)).rejects.toThrow(
      FlowDriverClaimLost,
    );
    await releaseFlowDriverClaim(db, original);
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.flowDriverToken).toBe(successor!.token);
    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, successor!);
  }, 45_000);

  it("rolls back a continuation whose lease expires while it holds the run lock", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    const driver = flowDriverDatabase(db, claim);

    await database.pool.query(
      "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp()) - 1.5)) FROM runs WHERE id = $1",
      [input.runId],
    );
    await expect(
      driver.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "expired" })
          .where(eq(runs.id, input.runId));
        await tx.execute(sql`SELECT pg_sleep(2)`);
      }),
    ).rejects.toThrow(FlowDriverClaimLost);
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, claim);
  }, 45_000);

  it("allows its own terminal transaction to release the execution assignment", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    await flowDriverDatabase(db, claim).transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ status: "Review" })
        .where(eq(runs.id, input.runId));
      await releaseAssignmentForRun(tx, input.runId, "run_terminal");
    });
    const [assignment] = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, input.assignmentId));

    expect(assignment.state).toBe("released");
    await releaseFlowDriverClaim(db, claim);
  });

  it("closes the raw query bridge when its transaction callback returns", async () => {
    let query: ((...args: unknown[]) => Promise<unknown>) | undefined;

    await boundedPostgresTransaction(db, async (_tx, boundedQuery) => {
      query = boundedQuery;
    });
    if (!query) throw new Error("query bridge missing");
    await expect(query("SELECT 1")).rejects.toMatchObject({
      details: { reason: "projection_transaction_deadline" },
    });
  });
});
