// ADR-166 T3.4 — startup + periodic recovery + retention (V1–V8) against a
// REAL supervisor child (SIGKILL + restart on the same state dir for W4); V8
// pages a fake host keyed like the real one.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  getAssignmentById,
  mintAssignment,
} from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import {
  getCommand,
  insertCommand,
  listCommandsForRun,
} from "@/lib/execution-host/commands";
import {
  recoverExecutionCommands,
  releaseStaleAssignments,
} from "@/lib/execution-host/recovery";
import { retireEligibleCommands } from "@/lib/execution-host/retirement";
import { OPEN_COMMANDS_PAGE_SIZE } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  publishRuntimeObject,
  readRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";
import { runReconcileSweep } from "@/lib/reconcile";
import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { createFakeExecutionHost } from "@/test-support/fake-execution-host";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };
let hostId: string;
let projectionWorker: ProjectionWorker;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedFlowRun(name: string, status = "Running") {
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status,
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });

  return runId;
}

async function mint(runId: string, reason: "launch" | "resume" = "launch") {
  return db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason }),
  );
}

async function attemptRow(id: string) {
  const rows = (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.id, id))) as unknown as Array<{
    executionAssignmentId: string | null;
  }>;

  return rows[0] ?? null;
}

async function runSessionRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as unknown as Array<{
    hostSessionId: string | null;
    acpSessionId: string | null;
    executionAssignmentId: string | null;
  }>;

  return rows[0] ?? null;
}

async function untilState(id: string, states: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const row = await getCommand(db, id);

    if (row && states.includes(row.state)) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `command ${id} never reached ${states.join("|")} (now ${row?.state})`,
      );
    }
    await sleep(50);
  }
}

// A db whose NEXT `transaction` call fails — the ack-write crash window (W2).
function withAckFault(base: Db): { db: Db; arm: () => void } {
  let armed = false;
  const proxied = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "transaction" && armed) {
        armed = false;

        return async () => {
          throw new Error("injected: connection lost before the ack write");
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  return { db: proxied as Db, arm: () => (armed = true) };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_recovery_test",
  });
  db = testDatabase.db as unknown as Db;
  // `--hang-prompt` never completes a turn: the W4 window needs a prompt that
  // is still `accepted` when the host is killed.
  sup = await startRealSupervisor({ fixtureArgs: ["--hang-prompt"] });
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
  const probe = await hosts.forRun(await seedFlowRun("probe"), {
    reason: "launch",
  });

  hostId = probe.host.id;
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("execution-command recovery (real supervisor)", () => {
  it("V1 (W2): a create whose ack write died is folded from the receipt — no second session; the fold stamps the attempt's driver generation", async () => {
    const runId = await seedFlowRun("v1");
    const assignment = await mint(runId);
    const faulty = withAckFault(db);
    const faultyHosts = createExecutionHosts({ db: faulty.db });
    const client = await faultyHosts.forAssignment(assignment);
    // The flow attempt the session serves — stamped in the ack transaction
    // (the client's or the fold's, never at append time).
    const nodeAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "s1",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    });

    // Adopt first (clean), then arm the fault for the create's ack tx.
    await client.ensureWorkspace();
    faulty.arm();
    await expect(
      client.createSession({ ...CREATE_PAYLOAD, nodeAttemptId }),
    ).rejects.toThrow(/injected/);

    const [createRow] = (await listCommandsForRun(db, runId)).filter(
      (r) => r.kind === "session.create",
    );

    expect(createRow.state).toBe("delivering");
    expect(createRow.payload).toMatchObject({ nodeAttemptId });
    expect(await runSessionRow(runId)).toBeNull();
    expect((await attemptRow(nodeAttemptId))?.executionAssignmentId).toBeNull();

    const summary = await recoverExecutionCommands({ db, graceMs: 0 });

    expect(summary.folded).toBe(1);
    const folded = await getCommand(db, createRow.id);

    expect(folded!.state).toBe("succeeded");
    const session = await runSessionRow(runId);

    expect(session?.hostSessionId).toBeTruthy();
    expect(session?.executionAssignmentId).toBe(assignment.id);
    expect((await attemptRow(nodeAttemptId))?.executionAssignmentId).toBe(
      assignment.id,
    );

    const live = (await hosts.local().listSessions()).filter(
      (s) => s.runId === runId,
    );

    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe(session!.hostSessionId);
  }, 120_000);

  it("V2 (W1): a queued driverless delete is delivered; a queued create is orphaned without a wire call", async () => {
    const runId = await seedFlowRun("v2");
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const created = await client.createSession(CREATE_PAYLOAD);
    const deleteRow = await insertCommand(db, {
      id: randomUUID(),
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.delete",
      targetSessionId: created.sessionId,
      payload: {},
      maxAttempts: 3,
      driverless: true,
    });
    const createRow = await insertCommand(db, {
      id: randomUUID(),
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.create",
      payload: {
        ...CREATE_PAYLOAD,
        executionWorkspaceId: "ws_" + "0".repeat(32),
      },
      maxAttempts: 3,
    });
    // The supervisor lists exited sessions too — count LIVE ones.
    const liveSessions = async () =>
      (await hosts.local().listSessions()).filter((s) => s.status === "live");
    const sessionsBefore = (await liveSessions()).length;

    const summary = await recoverExecutionCommands({ db, graceMs: 0 });

    expect(summary.redelivered).toBe(1);
    expect(summary.orphaned).toBe(1);
    expect((await getCommand(db, deleteRow.id))!.state).toBe("succeeded");
    expect((await getCommand(db, createRow.id))!).toMatchObject({
      state: "failed",
      lastError: { reason: "ORPHANED" },
    });

    const sessionsAfter = await liveSessions();

    expect(sessionsAfter.length).toBe(sessionsBefore - 1);
    expect(sessionsAfter.map((s) => s.sessionId)).not.toContain(
      created.sessionId,
    );
  }, 120_000);

  it("V3 (W4): SIGKILL mid-prompt + restart on the same state dir → turn_lost, same key, new boot id, run reconciled Crashed", async () => {
    const runId = await seedFlowRun("v3");
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const created = await client.createSession(CREATE_PAYLOAD);
    const beforeHealth = await hosts.local().health();

    // Durable prompt recovery must work without a process-local SSE subscriber.
    const handle = await client.prompt(
      created.hostSessionId,
      {
        stepId: "s1",
        prompt: "hang",
      },
      {
        admitOwner: await seedNodePromptOwner(
          db,
          client,
          created.hostSessionId,
        ),
      },
    );

    await untilState(handle.commandId, ["accepted"]);

    sup = await sup.restart();
    const afterHealth = await hosts.local().health();

    expect(beforeHealth.kind).toBe("ready");
    expect(afterHealth.kind).toBe("ready");
    if (beforeHealth.kind !== "ready" || afterHealth.kind !== "ready") return;
    expect(afterHealth.identity?.hostKey).toBe(beforeHealth.identity?.hostKey);
    expect(afterHealth.identity?.bootId).not.toBe(
      beforeHealth.identity?.bootId,
    );

    // The live driver observes the loss through its own receipt lookup.
    await expect(
      client.waitForPrompt(handle, { signal: AbortSignal.timeout(15_000) }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "turn_lost",
    );

    // Startup already committed a rejected receipt and canonical terminal.
    // A second recovery pass preserves that exact nested error and evidence;
    // it cannot reset a verified command to synthesize a second failure.
    await recoverExecutionCommands({ db, graceMs: 0 });
    expect(await getCommand(db, handle.commandId)).toMatchObject({
      state: "failed",
      lastError: { code: "PRECONDITION", details: { reason: "turn_lost" } },
      terminalEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      receiptEvidence: {
        phase: "rejected",
        body: { details: { reason: "turn_lost" } },
      },
    });

    // The existing reconcile classifies the run: Running, no live session,
    // no checkpoint → Crashed.
    await runReconcileSweep({ db });
    const [run] = (await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))) as Array<{ status: string }>;

    expect(run.status).toBe("Crashed");
  }, 180_000);

  it("V4: a delivering row younger than the grace is left alone", async () => {
    const runId = await seedFlowRun("v4");
    const assignment = await mint(runId);
    const row = await insertCommand(db, {
      id: randomUUID(),
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.cancel",
      targetSessionId: "sess-none",
      payload: {},
      maxAttempts: 3,
    });

    await db
      .update(schema.executionCommands)
      .set({ state: "delivering", deliveringSince: new Date(), attempts: 1 })
      .where(eq(schema.executionCommands.id, row.id));

    const summary = await recoverExecutionCommands({ db });

    expect(summary.skippedInFlight).toBeGreaterThanOrEqual(1);
    expect((await getCommand(db, row.id))!.state).toBe("delivering");
  });

  it("V5: the sweep releases active assignments under non-owned statuses only — Pending and Running keep theirs; NeedsInputIdle, Review and Crashed lose them", async () => {
    const seedWith = (status: string) =>
      seedRun(testDatabase.db, { projectId: project.id, status });
    const owned = {
      Pending: await mint(await seedWith("Pending")),
      Running: await mint(await seedWith("Running")),
    };
    const stale = {
      NeedsInputIdle: await mint(await seedWith("NeedsInputIdle")),
      Review: await mint(await seedWith("Review")),
      Crashed: await mint(await seedWith("Crashed")),
    };

    const released = await releaseStaleAssignments({ db, graceMs: 0 });

    expect(released).toBeGreaterThanOrEqual(Object.keys(stale).length);
    for (const [status, assignment] of Object.entries(stale)) {
      expect(await getAssignmentById(db, assignment.id), status).toMatchObject({
        state: "released",
        releasedReason: "sweep",
      });
    }
    for (const [status, assignment] of Object.entries(owned)) {
      expect((await getAssignmentById(db, assignment.id))!.state, status).toBe(
        "active",
      );
    }
  });

  it("V6: age alone retires nothing — an 8-day-old terminal row with no owner disposition stays whole", async () => {
    const runId = await seedRun(testDatabase.db, { projectId: project.id });
    const assignment = await mint(runId);
    const insertTerminal = async (ageDays: number) => {
      const row = await insertCommand(db, {
        id: randomUUID(),
        runId,
        assignmentId: assignment.id,
        hostId,
        assignmentEpoch: assignment.epoch,
        kind: "session.cancel",
        payload: {},
        maxAttempts: 3,
      });
      const completedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);

      await db
        .update(schema.executionCommands)
        .set({ state: "succeeded", completedAt })
        .where(eq(schema.executionCommands.id, row.id));

      return row.id;
    };
    const old = await insertTerminal(8);
    const recent = await insertTerminal(6);

    const summary = await retireEligibleCommands({ db, hosts });

    // The run is still live, so BOTH are protected by state, not by age; the
    // scan still advanced past them.
    expect(summary.retired).toBe(0);
    expect(summary.reasons.run_retained).toBeGreaterThanOrEqual(2);
    expect(await getCommand(db, old)).not.toBeNull();
    expect(await getCommand(db, recent)).not.toBeNull();
  });

  it("V7 (W2, no receipt): a delivering driverless row is requeued and re-delivered; a delivering non-driverless row is orphaned", async () => {
    const runId = await seedFlowRun("v7");
    const assignment = await mint(runId);
    const insertDelivering = async (
      kind: "session.delete" | "session.cancel",
      driverless: boolean,
    ) => {
      const row = await insertCommand(db, {
        id: randomUUID(),
        runId,
        assignmentId: assignment.id,
        hostId,
        assignmentEpoch: assignment.epoch,
        kind,
        targetSessionId: `sess-v7-${randomUUID()}`,
        payload: {},
        maxAttempts: 3,
        driverless,
      });

      // Sent before the crash, never acknowledged — and the host never saw it.
      await db
        .update(schema.executionCommands)
        .set({
          state: "delivering",
          deliveringSince: new Date(Date.now() - 120_000),
          attempts: 1,
        })
        .where(eq(schema.executionCommands.id, row.id));

      return row;
    };
    const driverless = await insertDelivering("session.delete", true);
    const driven = await insertDelivering("session.cancel", false);

    const summary = await recoverExecutionCommands({ db, graceMs: 0 });

    expect(summary.redelivered).toBeGreaterThanOrEqual(1);
    expect(summary.orphaned).toBeGreaterThanOrEqual(1);
    // Requeued (attempts kept), claimed again, delivered: the host's 404 for
    // the unknown session is the `gone` outcome.
    expect(await getCommand(db, driverless.id)).toMatchObject({
      state: "succeeded",
      attempts: 2,
      result: { outcome: "gone" },
    });
    expect(await getCommand(db, driven.id)).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: { reason: "ORPHANED" },
    });
  }, 60_000);

  it("V7b: recovery re-delivers a queued runtime-object deletion and folds catalogue state", async () => {
    const runId = await seedFlowRun("v7-runtime-object");
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const objectId = randomUUID();
    const bytes = new TextEncoder().encode("recover deletion\u0000é");

    await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: "recovery.txt",
      mimeType: "text/plain",
      retentionClass: "run",
      bytes,
    });
    // Upload ACK persists the seal; content opens only after canonical projection.
    await expect
      .poll(
        async () => {
          const [object] = await db
            .select({ state: fullSchema.executionRuntimeObjects.state })
            .from(fullSchema.executionRuntimeObjects)
            .where(eq(fullSchema.executionRuntimeObjects.id, objectId));

          return object?.state;
        },
        { timeout: 10_000 },
      )
      .toBe("available");
    const full = await readRuntimeObjectContent({ db, runId, objectId });
    const partial = await readRuntimeObjectContent({
      db,
      runId,
      objectId,
      range: { start: 3, end: 9 },
    });

    expect(full.content.bytes).toEqual(bytes);
    expect(partial.content.bytes).toEqual(bytes.slice(3, 10));
    const command = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "runtime_object.delete",
      targetSessionId: objectId,
      payload: { generation: 1 },
      maxAttempts: 3,
      driverless: true,
    });

    await db
      .update(schema.executionRuntimeObjects)
      .set({ state: "deleting" })
      .where(eq(schema.executionRuntimeObjects.id, objectId));

    const summary = await recoverExecutionCommands({ db, graceMs: 0 });
    const [object] = (await db
      .select()
      .from(schema.executionRuntimeObjects)
      .where(eq(schema.executionRuntimeObjects.id, objectId))) as Array<{
      state: string;
      deletedAt: Date | null;
    }>;

    expect(summary.redelivered).toBeGreaterThanOrEqual(1);
    expect(await getCommand(db, command.id)).toMatchObject({
      state: "succeeded",
    });
    expect(object.state).toBe("deleted");
    expect(object.deletedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("V8: recovery pages past the open-row page size — every queued driverless row of a 501-row backlog is re-delivered", async () => {
    const runId = await seedRun(testDatabase.db, { projectId: project.id });
    const assignment = await mint(runId);
    const [hostRow] = (await db
      .select({ hostKey: schema.executionHosts.hostKey })
      .from(schema.executionHosts)
      .where(eq(schema.executionHosts.id, hostId))) as Array<{
      hostKey: string;
    }>;
    // A fake host wearing the registered key: the recovered envelopes carry
    // the real row's fence, and the fake answers every delete `gone`.
    const fake = createFakeExecutionHost({ hostKey: hostRow.hostKey });
    const total = OPEN_COMMANDS_PAGE_SIZE + 1;
    const ids = Array.from({ length: total }, () => randomUUID());
    const now = new Date();

    await db.insert(schema.executionCommands).values(
      ids.map((id, i) => ({
        id,
        runId,
        executionAssignmentId: assignment.id,
        executionHostId: hostId,
        assignmentEpoch: assignment.epoch,
        kind: "session.delete",
        targetSessionId: `sess-v8-${i}`,
        payload: {},
        state: "queued",
        attempts: 0,
        maxAttempts: 3,
        driverless: true,
        createdAt: now,
        updatedAt: now,
      })),
    );

    const summary = await recoverExecutionCommands({
      db,
      transport: fake.transport,
      graceMs: 0,
    });

    expect(summary.scanned).toBeGreaterThanOrEqual(total);
    expect(summary.redelivered).toBeGreaterThanOrEqual(total);
    expect(
      fake
        .callsOf("deleteSession")
        .filter((c) => c.envelope?.fence.runId === runId),
    ).toHaveLength(total);
    const states = (await listCommandsForRun(db, runId)).map((c) => c.state);

    expect(states).toHaveLength(total);
    expect(new Set(states)).toEqual(new Set(["succeeded"]));
  }, 120_000);
});
