// ADR-166 T3.3 — command ledger + deliverer + bound client (L1–L9) over the
// in-memory fake transport.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { BoundClient } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";

import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  getAssignmentById,
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { getCommand, listCommandsForRun } from "@/lib/execution-host/commands";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  seedLocalHost,
  seedProject,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import {
  createFakeExecutionHost,
  definitiveUnavailableError,
  fakeBoundClient,
  fencedError,
  unknownOutcomeError,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let hostId: string;
let fake: FakeExecutionHost;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bound(
  status = "Running",
  dataPlaneMode: "canonical_events_v1" = "canonical_events_v1",
) {
  const runId = await seedRun(testDatabase.db, {
    projectId,
    status,
    executionDataPlaneMode: dataPlaneMode,
  });

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId,
    worktreePath: `/tmp/eh/${runId}`,
    parentRepoPath: "/tmp/eh/repo",
  });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );
  const { client } = await fakeBoundClient({ db, fake, assignment });

  return { runId, assignment, client };
}

async function rowsOfKind(
  runId: string,
  kind: string,
): Promise<ExecutionCommand[]> {
  return (await listCommandsForRun(db, runId)).filter((c) => c.kind === kind);
}

async function runSessionRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(
      and(
        eq(schema.runSessions.runId, runId),
        eq(schema.runSessions.sessionName, "default"),
      ),
    )) as unknown as Array<{
    hostSessionId: string | null;
    acpSessionId: string | null;
    executionAssignmentId: string | null;
  }>;

  return rows[0] ?? null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle in ${ms} ms`)), ms),
    ),
  ]);
}

// A db whose `update` calls throw once armed — every ledger transition is an
// UPDATE, so this is "the ledger cannot be written" from the deliverer's view.
function withUpdateFault(base: Db): {
  db: Db;
  arm: () => void;
  disarm: () => void;
} {
  let armed = false;
  const proxied = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "update" && armed) {
        return () => {
          throw new Error("injected: ledger write failed");
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    db: proxied as Db,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}

async function untilState(id: string, states: string[], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const row = await getCommand(db, id);

    if (row && states.includes(row.state)) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `command ${id} never reached ${states.join("|")} (now ${row?.state})`,
      );
    }
    await sleep(20);
  }
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_ledger_test",
  });
  db = testDatabase.db as unknown as Db;
  projectId = await seedProject(testDatabase.db);
  fake = createFakeExecutionHost();
  // Same key AND boot id as the fake → the registrar lands on `touch`, so no
  // restart reconcile fires.
  hostId = (
    await seedLocalHost(testDatabase.db, {
      hostKey: fake.identity.hostKey,
      bootId: fake.identity.bootId,
    })
  ).id;
}, 180_000);

beforeEach(() => {
  resetResolverForTests();
  resetRegistrarStateForTests();
  fake.setPromptBehavior(async () => ({ stopReason: "end_turn", meta: null }));
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("ledger + deliverer (fake transport)", () => {
  it("L1: the ledger row exists (queued → claimed) BEFORE the transport is called", async () => {
    const { client } = await bound();
    let atCall: ExecutionCommand | null | undefined;

    fake.onCall("createSession", async (call) => {
      atCall = await getCommand(db, call.envelope!.command.id);
    });
    await client.createSession(CREATE_PAYLOAD);

    expect(atCall).toBeDefined();
    expect(atCall!.state).toBe("delivering");
    expect(atCall!.attempts).toBe(1);
    expect(atCall!.deliveringSince!.getTime()).toBeGreaterThanOrEqual(
      atCall!.createdAt.getTime(),
    );
  });

  it("L2: an immediate 2xx → succeeded + completed_at; the create ack binds run_sessions in the same tx", async () => {
    const { runId, assignment, client } = await bound();
    const created = await client.createSession(CREATE_PAYLOAD);
    const [createRow] = await rowsOfKind(runId, "session.create");
    const [adoptRow] = await rowsOfKind(runId, "workspace.adopt");

    expect(created.hostSessionId).toBe(created.sessionId);
    expect(createRow.state).toBe("succeeded");
    expect(createRow.completedAt).not.toBeNull();
    expect(createRow.result).toMatchObject({ sessionId: created.sessionId });
    expect(adoptRow.state).toBe("succeeded");

    const session = await runSessionRow(runId);

    expect(session).toMatchObject({
      hostSessionId: created.sessionId,
      acpSessionId: created.acpSessionId,
      executionAssignmentId: assignment.id,
    });
    expect(
      (await getAssignmentById(db, assignment.id))?.executionWorkspaceId,
    ).toMatch(/^ws_/);
  });

  it("L3: unknown-outcome failures retry the SAME command id up to the budget, then fail", async () => {
    const { runId, client } = await bound();
    const before = fake.callsOf("cancelPrompt").length;

    fake.failOnce("cancelPrompt", unknownOutcomeError());
    fake.failOnce("cancelPrompt", unknownOutcomeError());
    fake.failOnce("cancelPrompt", unknownOutcomeError());

    await expect(client.cancelPrompt("sess-none")).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "EXECUTOR_UNAVAILABLE" &&
        err.details?.reason === "delivery_budget_exhausted",
    );

    const rows = await rowsOfKind(runId, "session.cancel");
    const calls = fake.callsOf("cancelPrompt").slice(before);

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("failed");
    expect(rows[0].attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.envelope!.command.id)).size).toBe(1);
    expect(calls[0].envelope!.command.id).toBe(rows[0].id);
  });

  it("L4: a definitive 503 fails after ONE attempt (no same-id retry)", async () => {
    const { runId, client } = await bound();
    const before = fake.callsOf("cancelPrompt").length;

    fake.failOnce("cancelPrompt", definitiveUnavailableError());

    await expect(client.cancelPrompt("sess-none")).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "EXECUTOR_UNAVAILABLE" &&
        err.details?.reason !== "delivery_budget_exhausted",
    );

    const rows = await rowsOfKind(runId, "session.cancel");

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("failed");
    expect(rows[0].attempts).toBe(1);
    expect(fake.callsOf("cancelPrompt").length - before).toBe(1);
  });

  it("L5: a 409 FENCED answer → row fenced, caller gets CONFLICT assignment_fenced", async () => {
    const { runId, client } = await bound();

    fake.failOnce("checkpointSession", fencedError(runId, 1));

    await expect(client.checkpoint("sess-none")).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.details?.reason === "assignment_fenced",
    );

    const rows = await rowsOfKind(runId, "session.checkpoint");

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("fenced");
  });

  it("L6: admission — released fences create locally but sends checkpoint; superseded fences everything", async () => {
    const { runId, assignment, client: live } = await bound();
    // The generation ran a session before it ended (a checkpointed run).
    const created = await live.createSession(CREATE_PAYLOAD);

    await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "test"),
    );
    const released = (await getAssignmentById(db, assignment.id))!;

    expect(released.state).toBe("released");
    const { client } = await fakeBoundClient({
      db,
      fake,
      assignment: released,
    });
    const createsBefore = fake.callsOf("createSession").length;

    await expect(client.createSession(CREATE_PAYLOAD)).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.details?.reason === "assignment_fenced" &&
        err.details?.local === true,
    );
    expect(fake.callsOf("createSession").length).toBe(createsBefore);
    // The handle was adopted by the live generation, so the create itself is
    // the command recorded and fenced locally — never sent.
    const fencedRows = (await listCommandsForRun(db, runId)).filter(
      (c) => c.state === "fenced",
    );

    expect(fencedRows).toHaveLength(1);
    expect(fencedRows[0].kind).toBe("session.create");

    // Teardown stays admissible under `released`: the checkpoint reaches the
    // host and tears the generation's own session down.
    const checkpoint = await client.checkpoint(created.hostSessionId);

    expect(checkpoint.alreadyCheckpointed).toBe(false);
    expect(fake.sessions.get(created.sessionId)?.status).toBe("exited");
    expect((await rowsOfKind(runId, "session.checkpoint"))[0].state).toBe(
      "succeeded",
    );

    // Superseded: bind the OLD assignment snapshot, then mint the next epoch.
    const next = await bound();

    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId: next.runId,
        hostId,
        reason: "resume",
      }),
    );
    const superseded = (await getAssignmentById(db, next.assignment.id))!;

    expect(superseded.state).toBe("superseded");
    const { client: old } = await fakeBoundClient({
      db,
      fake,
      assignment: superseded,
    });
    const cancelsBefore = fake.callsOf("cancelPrompt").length;

    await expect(old.cancelPrompt("sess-none")).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "assignment_fenced",
    );
    expect(fake.callsOf("cancelPrompt").length).toBe(cancelsBefore);
    expect((await rowsOfKind(next.runId, "session.cancel"))[0].state).toBe(
      "fenced",
    );
  });

  it("L7: prompt completion is re-read from the ledger after the legacy host response settles", async () => {
    const { client } = await bound();
    const created = await client.createSession(CREATE_PAYLOAD);
    const httpGate = deferred();
    let httpReturned = false;

    fake.setPromptBehavior(async (ctx) => {
      ctx.setReceipt("completed", { stopReason: "end_turn", meta: null });
      // The compatibility response is held to prove no process-local SSE
      // payload can resolve a prompt handle.
      await httpGate.promise;
      httpReturned = true;

      return { stopReason: "end_turn", meta: null };
    });

    const handle = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "hi",
    });
    const completion = client.waitForPrompt(handle);
    httpGate.resolve();
    const result = await completion;

    expect(result.stopReason).toBe("end_turn");
    expect(httpReturned).toBe(true);

    const settled = await untilState(handle.commandId, ["succeeded"]);

    expect(settled.acceptedAt).toBeNull();
    expect(settled.completedAt).not.toBeNull();

    await vi.waitFor(() => expect(httpReturned).toBe(true));
    // A duplicate completion fold is a no-op on the terminal ledger row.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const after = await getCommand(db, handle.commandId);

    expect(after!.state).toBe("succeeded");
    expect(after!.completedAt!.getTime()).toBe(settled.completedAt!.getTime());

    // Plain compatibility path: HTTP completes → succeeded via the ledger.
    fake.setPromptBehavior(async (ctx) => {
      return { stopReason: "end_turn", meta: null };
    });
    const plain = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "again",
    });

    expect((await client.waitForPrompt(plain)).stopReason).toBe("end_turn");
    const plainRow = await untilState(plain.commandId, ["succeeded"]);

    expect(plainRow.acceptedAt).toBeNull();
  });

  it("L8: prompt post-acceptance transport failure → exactly one receipt lookup decides", async () => {
    const { client } = await bound();
    const created = await client.createSession(CREATE_PAYLOAD);
    const receiptCalls = () => fake.callsOf("getCommandReceipt").length;
    const promptCalls = () => fake.callsOf("sendPrompt").length;

    // (a) receipt completed → succeeded{stopReason} returned to the caller.
    fake.setPromptBehavior(async (ctx) => {
      ctx.emit("accepted");
      ctx.setReceipt("completed", { stopReason: "end_turn", meta: null });
      throw unknownOutcomeError("socket hang up");
    });
    let r0 = receiptCalls();
    let p0 = promptCalls();
    const a = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "a",
    });

    expect((await client.waitForPrompt(a)).stopReason).toBe("end_turn");
    expect(receiptCalls() - r0).toBe(1);
    expect(promptCalls() - p0).toBe(1);
    expect((await untilState(a.commandId, ["succeeded"])).state).toBe(
      "succeeded",
    );

    // (b) receipt accepted, no in-flight execution → failed{turn_lost}.
    fake.setPromptBehavior(async (ctx) => {
      ctx.setReceipt("accepted", {}, false);
      throw unknownOutcomeError("socket hang up");
    });
    r0 = receiptCalls();
    p0 = promptCalls();
    const b = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "b",
    });

    await expect(client.waitForPrompt(b)).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "ACP_PROTOCOL" &&
        err.details?.reason === "turn_lost",
    );
    expect(receiptCalls() - r0).toBe(1);
    expect(promptCalls() - p0).toBe(1);
    expect((await untilState(b.commandId, ["failed"])).lastError).toMatchObject(
      {
        reason: "turn_lost",
      },
    );

    // (c) no receipt is retried under the original command id until the
    // delivery budget is exhausted; an SSE payload cannot make it authoritative.
    fake.setPromptBehavior(async (ctx) => {
      fake.receipts.delete(ctx.envelope.command.id);
      throw unknownOutcomeError("socket hang up");
    });
    r0 = receiptCalls();
    const c = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "c",
    });

    await expect(client.waitForPrompt(c)).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "delivery_budget_exhausted",
    );
    expect(receiptCalls() - r0).toBe(3);
    expect((await untilState(c.commandId, ["failed"])).lastError).toMatchObject(
      {
        reason: "delivery_budget_exhausted",
      },
    );

    // (d) receipt accepted AND in flight → ONE re-send joins the live turn.
    const turnGate = deferred();

    fake.setPromptBehavior(async () => {
      await turnGate.promise;

      return { stopReason: "end_turn", meta: null };
    });
    // The host accepted the turn and keeps running it; the response is lost.
    fake.loseResponseOnce("sendPrompt");
    r0 = receiptCalls();
    p0 = promptCalls();
    const d = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "d",
    });

    // The re-send joined the in-flight execution; only then does the turn end.
    await vi.waitFor(() => expect(promptCalls() - p0).toBe(2));
    turnGate.resolve();
    expect((await client.waitForPrompt(d)).stopReason).toBe("end_turn");
    expect(receiptCalls() - r0).toBe(1);
    expect(promptCalls() - p0).toBe(2);
    expect((await untilState(d.commandId, ["succeeded"])).state).toBe(
      "succeeded",
    );
  });

  it("L9: a ledger write failure leaves no in-memory terminal authority; recovery owns the delivering row", async () => {
    const { assignment } = await bound();
    const faulty = withUpdateFault(db);
    const { client } = await fakeBoundClient({
      db: faulty.db,
      fake,
      assignment,
    });
    const created = await client.createSession(CREATE_PAYLOAD);

    // The host never saw the turn (no receipt): the deliverer's requeue is the
    // first ledger write after the transport failure — and it cannot land.
    fake.setPromptBehavior(async (ctx) => {
      fake.receipts.delete(ctx.envelope.command.id);
      faulty.arm();
      throw unknownOutcomeError("socket hang up");
    });
    const handle = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "l9",
    });

    try {
      await expect(withTimeout(client.waitForPrompt(handle), 250)).rejects.toThrow(
        "did not settle in 250 ms",
      );
    } finally {
      faulty.disarm();
    }
    // No transition could be written: the row is still the claimed attempt,
    // which the recovery pass owns from here.
    expect(await getCommand(db, handle.commandId)).toMatchObject({
      state: "delivering",
      attempts: 1,
    });
  });

  it("L10: a canonical run admits through the short async prompt route and returns a serial handle", async () => {
    const { runId, client } = await bound("Running", "canonical_events_v1");
    const created = await client.createSession(CREATE_PAYLOAD);
    const sendBefore = fake.callsOf("sendPrompt").length;
    const startBefore = fake.callsOf("startPrompt").length;

    const handle = await client.prompt(created.hostSessionId, {
      stepId: "canonical-prompt",
      prompt: "accepted without a long-lived response",
    });
    const row = await getCommand(db, handle.commandId);

    expect(handle).toEqual({ commandId: handle.commandId });
    expect(row).toMatchObject({
      runId,
      state: "accepted",
      kind: "session.prompt",
    });
    expect(fake.callsOf("startPrompt").length - startBefore).toBe(1);
    expect(fake.callsOf("sendPrompt").length - sendBefore).toBe(0);
  });
});

export type { BoundClient };
