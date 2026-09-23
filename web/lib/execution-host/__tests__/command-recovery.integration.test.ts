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
import { isTurnLostError } from "@/lib/reconcile-evidence";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { MaisterError } from "@/lib/errors";
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

// ─── ADR-177: evidence-first crash classification, against a REAL restart ───
//
// V3 above proves the LEDGER half of W4 (the host's own `turn_lost` terminal
// survives a SIGKILL + restart). It cannot prove the RUN half: its row is a
// SCRATCH run (`seedRun` defaults `run_kind`), so it is classified by the
// scratch arm and never reaches the flow agent-node arm this contract edits.
// The family below seeds the shape that arm requires — `run_kind='flow'`, a
// pinned revision whose manifest carries an `ai_coding` node, and
// `current_step_id` pointing at it — and asserts ONE terminal row set across
// three ingest orders.

const ADR177_MANIFEST = {
  schemaVersion: 1,
  name: "adr177",
  nodes: [
    {
      id: "s1",
      type: "ai_coding",
      action: { prompt: "/work" },
      transitions: { success: "s2" },
    },
    { id: "s2", type: "check", action: { command: "true" }, transitions: {} },
  ],
};

let adr177FlowId: string | undefined;
let adr177RevisionId: string | undefined;

async function ensureAdr177Flow(): Promise<{
  flowId: string;
  flowRevisionId: string;
}> {
  if (adr177FlowId && adr177RevisionId)
    return { flowId: adr177FlowId, flowRevisionId: adr177RevisionId };
  adr177FlowId = randomUUID();
  adr177RevisionId = randomUUID();
  await db.insert(schema.flowRevisions).values({
    id: adr177RevisionId,
    flowRefId: "adr177",
    source: "github.com/x/adr177",
    versionLabel: "v1.0.0",
    resolvedRevision: "cafebabe",
    manifestDigest: "sha256:adr177",
    manifest: ADR177_MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/adr177",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: adr177FlowId,
    projectId: project.id,
    flowRefId: "adr177",
    source: "github.com/x/adr177",
    version: "v1.0.0",
    installedPath: "/tmp/flows/adr177",
    manifest: ADR177_MANIFEST,
    schemaVersion: 1,
  });

  return { flowId: adr177FlowId, flowRevisionId: adr177RevisionId };
}

// A run the flow agent-node arm actually classifies. `seedFlowRun` is reused
// for the project/worktree spine, then promoted to a graph flow run.
async function seedFlowGraphRun(name: string): Promise<string> {
  const runId = await seedFlowRun(name);
  const { flowId, flowRevisionId } = await ensureAdr177Flow();

  await db
    .update(schema.runs)
    .set({
      runKind: "flow",
      flowId,
      flowRevisionId,
      currentStepId: "s1",
    })
    .where(eq(schema.runs.id, runId));

  return runId;
}

async function adr177Rows(runId: string) {
  const [run] = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;
  const [attempt] = (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as Array<Record<string, any>>;
  const prompts = (await listCommandsForRun(db, runId)).filter(
    (row) => row.kind === "session.prompt",
  );

  return { run, attempt, prompts };
}

describe("evidence-first crash classification after a real supervisor restart (ADR-177)", () => {
  // `preSettle` = the BOOT order (recovery before reconcile, which is what V3
  // does and what `instrumentation-node.ts` does). `false` = the production
  // TICK order, in which `runReconcileSweep` runs BEFORE
  // `executionCommandReconcilePass` and the evidence is up to 60 s stale.
  // `probeOnly` additionally stops ingestion, so the command is still
  // `accepted` with no terminal event and the receipt probe is the ONLY path
  // to the classification.
  const CELLS = [
    { name: "boot order (recovery first)", preSettle: true, probeOnly: false },
    { name: "production tick order", preSettle: false, probeOnly: false },
    { name: "probe-only (ingest held)", preSettle: false, probeOnly: true },
  ] as const;

  for (const cell of CELLS) {
    it(`RED 1/3 — SIGKILL mid-prompt + restart, ${cell.name} → Crashed turn-lost, attempt closed, command discharged, recoverable`, async () => {
      const runId = await seedFlowGraphRun(
        `a177-${cell.name.replace(/[^a-z]/gi, "")}`,
      );
      const assignment = await mint(runId);
      const client = await hosts.forAssignment(assignment);
      const created = await client.createSession(CREATE_PAYLOAD);
      const handle = await client.prompt(
        created.hostSessionId,
        { stepId: "s1", prompt: "hang" },
        {
          admitOwner: await seedNodePromptOwner(
            db,
            client,
            created.hostSessionId,
          ),
        },
      );

      await untilState(handle.commandId, ["accepted"]);
      if (cell.probeOnly) await projectionWorker.stop();
      sup = await sup.restart();
      if (cell.preSettle) await recoverExecutionCommands({ db, graceMs: 0 });

      await runReconcileSweep({ db });
      const { run, attempt, prompts } = await adr177Rows(runId);

      // On this HEAD every cell fails here: with no evidence arm the sweep
      // answers `agent-session-gone` by age, leaves the attempt Running with a
      // NULL decision, and strands the command. With the owner worker running
      // instead, the same restart lands `Failed` — which is NOT recoverable.
      expect(run.status).toBe("Crashed");
      expect(
        run.resumeTargetStepId,
        "a lost turn MUST stay recoverable — Failed is a dead end for the operator",
      ).toBe("s1");
      expect({
        status: attempt.status,
        decision: attempt.decision,
        errorCode: attempt.errorCode,
      }).toEqual({
        status: "Reworked",
        decision: "turn_lost",
        errorCode: "CRASH",
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0].applicationState).toBe("applied");
      expect(
        prompts[0].completionAppliedAt,
        "applied exactly once, by whichever writer won the CAS",
      ).not.toBeNull();
      if (cell.probeOnly) {
        projectionWorker = startProjectionWorker({
          db,
          projectors: canonicalProjectors,
        });
      }
    }, 180_000);
  }
});

describe("evidence-first classification vs a LIVE prompt-owner worker (ADR-177)", () => {
  // RED 3, worker-first half. The other cells let the sweep reach the lost turn
  // first; here the real flow prompt owner settles it first, which is the order
  // production produces whenever the ~1s worker beats the 60s tick. Attribution
  // is by AUTHORSHIP: the worker is the only applier running, and the sweep is
  // not started until the command has left `pending`.
  it("RED 3 — worker-first: the owner settles the lost turn before the sweep, and the terminal row set is IDENTICAL", async () => {
    const { flowPromptOwners } = await import("@/lib/flows/graph/prompt-owner");
    const { startPromptOwnerWorker } = await import(
      "@/lib/execution-host/prompt-owner-recovery"
    );
    const runId = await seedFlowGraphRun("a177-worker-first");
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const created = await client.createSession(CREATE_PAYLOAD);
    const handle = await client.prompt(
      created.hostSessionId,
      { stepId: "s1", prompt: "hang" },
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
    await recoverExecutionCommands({ db, graceMs: 0 });

    const worker = startPromptOwnerWorker({ db, owners: flowPromptOwners });

    try {
      // The worker, not the sweep, is what moves the command off `pending`.
      await expect
        .poll(
          async () =>
            (await getCommand(db, handle.commandId))?.applicationState,
          { timeout: 30_000, interval: 250 },
        )
        .not.toBe("pending");
    } finally {
      await worker.stop();
    }
    await runReconcileSweep({ db });
    const { run, attempt, prompts } = await adr177Rows(runId);

    // On this HEAD the owner decodes the lost turn into a failed node action,
    // and the graph would terminalize the run `Failed` — unrecoverable. The
    // boundary is what makes BOTH orders land on this one row set.
    expect(run.status).toBe("Crashed");
    expect(run.resumeTargetStepId).toBe("s1");
    expect({
      status: attempt.status,
      decision: attempt.decision,
      errorCode: attempt.errorCode,
    }).toEqual({
      status: "Reworked",
      decision: "turn_lost",
      errorCode: "CRASH",
    });
    expect(
      attempt.actionCompletion,
      "a lost turn is not a result — it must never be decoded onto the attempt",
    ).toBeNull();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].applicationState).toBe("applied");
  }, 180_000);

  // RED 2. A skip must not be a leak: the run has to SETTLE once the evidence
  // changes, and settle through the boundary rather than by ageing out.
  //
  // What this case does NOT own, and why. Two earlier shapes were tried and
  // both were wrong about the mechanism:
  //   * holding INGEST does not produce `pending_ingest` — the probe asks the
  //     HOST, so a restarted supervisor reports the lost turn however ingest is
  //     held (that is the whole point of having a probe);
  //   * a live host turn does not produce `evidence-inflight` either, because a
  //     run with a live session record never reaches the evidence arms at all —
  //     the pre-existing live-session guard skips it first, correctly.
  // Reaching `evidence-inflight` needs a live host turn with NO live session
  // record, which is a post-web-death state this harness cannot make. The
  // seeded case in `reconcile-sweep.integration.test.ts` owns that arm with an
  // injected receipt, deterministically. What is left here is the end-to-end
  // half nothing else proves: skip, then settle, against a real host.
  it("RED 2 — a run holding a live turn is not crashed past grace, and the SAME sweep settles it through the boundary once the host loses it", async () => {
    const runId = await seedFlowGraphRun("a177-inflight");
    const assignment = await mint(runId);
    const client = await hosts.forAssignment(assignment);
    const created = await client.createSession(CREATE_PAYLOAD);
    const handle = await client.prompt(
      created.hostSessionId,
      { stepId: "s1", prompt: "hang" },
      {
        admitOwner: await seedNodePromptOwner(
          db,
          client,
          created.hostSessionId,
        ),
      },
    );

    await untilState(handle.commandId, ["accepted"]);

    // The attempt is seeded an hour old, so the run is definitively OUTSIDE the
    // 90 s grace — no grace override. The live-session guard must preserve it.
    await runReconcileSweep({ db });
    const live = await adr177Rows(runId);

    expect(
      live.run.status,
      "the turn is still running — crashing it discards a turn that is still being paid for",
    ).toBe("Running");
    expect(live.attempt.status).toBe("Running");
    // Sweep counters include unrelated fixture runs; the target row above is
    // the live-turn invariant this case owns.

    // Not a leak: once the turn is genuinely lost the SAME sweep settles it.
    sup = await sup.restart();
    await recoverExecutionCommands({ db, graceMs: 0 });
    await runReconcileSweep({ db });
    const settled = await adr177Rows(runId);

    expect(settled.run.status).toBe("Crashed");
    expect(settled.attempt.decision).toBe("turn_lost");
    expect(settled.prompts[0].applicationState).toBe("applied");
  }, 180_000);
});

// D2c (S5.2). The window BETWEEN D2a and D2b: the host wrote its `accepted`
// receipt and then died before the turn finished. `accepted` + `inflight:false`
// is the turn_lost signature (`contracts.ts`), and the supervisor settles such
// a receipt only when the SAME command id is re-sent — which `session.create`,
// absent from `RESTARTABLE_OBJECT_KINDS`, answers turn_lost rather than with a
// session. The driver therefore reissues the stored bytes under a new
// generation, exactly as D2a does one step earlier. The lost turn is staged
// through the transport (a request lost in flight, then the restarted host's
// receipt); the reissue itself goes to the REAL supervisor, so "one logical
// session" is observed and not assumed.
describe("owned create after a host restart on an accepted receipt (D2c)", () => {
  it("reissues one new generation from the stored bytes and binds one session", async () => {
    const runId = await seedFlowGraphRun("d2c");
    const assignment = await mint(runId);
    const nodeAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "s1",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
      executionAssignmentId: assignment.id,
      actionPromptOrdinal: 0,
    });
    const owner = {
      variant: "node",
      nodeAttemptId,
      promptOrdinal: 0,
    } as const;
    const base = defaultTransport();
    const creates = async () =>
      (await listCommandsForRun(db, runId)).filter(
        (row) => row.kind === "session.create",
      );
    // W2 with the request lost in flight: one attempt is spent, the row stays
    // `delivering`, and the manager never learns the outcome.
    const stranding = await createExecutionHosts({
      db,
      transport: {
        ...base,
        createSession: async () => {
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "connection lost mid-create",
            { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
          );
        },
      },
    }).forAssignment(assignment);

    await stranding.ensureWorkspace();
    let prepared = 0;

    await expect(
      stranding.createOwnedSession(owner, async () => {
        prepared += 1;

        return { ...CREATE_PAYLOAD, nodeAttemptId };
      }),
    ).rejects.toBeTruthy();
    const [admitted] = await creates();

    expect(admitted).toMatchObject({ state: "queued", attempts: 1 });
    expect(prepared).toBe(1);
    expect(await runSessionRow(runId)).toBeNull();
    // The driver re-enters once the delivery backoff has elapsed.
    await db
      .update(schema.executionCommands)
      .set({ nextAttemptAt: null })
      .where(eq(schema.executionCommands.id, admitted.id));

    const reentered = await createExecutionHosts({
      db,
      transport: {
        ...base,
        getCommandReceipt: async (commandId: string) =>
          commandId === admitted.id
            ? {
                commandId,
                runId,
                kind: "session.create" as const,
                assignmentEpoch: admitted.assignmentEpoch,
                phase: "accepted" as const,
                httpStatus: 202,
                body: {},
                receivedAt: new Date().toISOString(),
                completedAt: null,
                eventId: null,
                // The host restarted: the receipt survived, the turn did not.
                inflight: false,
              }
            : base.getCommandReceipt(commandId),
      },
    }).forAssignment(assignment);
    const result = await reentered.createOwnedSession(owner, async () => {
      throw new Error("a reissue must reuse the stored create bytes");
    });
    const rows = await creates();
    const lost = rows.find((row) => row.id === admitted.id)!;
    const reissued = rows.find((row) => row.id !== admitted.id)!;

    expect(rows).toHaveLength(2);
    expect(lost.state).toBe("failed");
    expect(
      isTurnLostError(lost.lastError),
      "the driver must record WHY the original create was abandoned",
    ).toBe(true);
    expect(reissued.state).toBe("succeeded");
    expect(reissued.createIntent).toMatchObject({
      generation: 1,
      supersedesCommandId: admitted.id,
    });
    expect((await runSessionRow(runId))?.hostSessionId).toBe(
      result.hostSessionId,
    );

    const live = (await hosts.local().listSessions()).filter(
      (session) => session.runId === runId && session.status === "live",
    );

    expect(live).toHaveLength(1);
    expect(live[0].sessionId).toBe(result.hostSessionId);
  }, 120_000);
});
