// ADR-166 T3.3 — command ledger + deliverer + bound client (L1–L8) over the
// in-memory fake transport.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { BoundClient } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

async function bound(status = "Running") {
  const runId = await seedRun(testDatabase.db, { projectId, status });

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
    const { runId, assignment } = await bound();

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
    // The first command a released assignment issues is the workspace adopt
    // (create implies it) — recorded and fenced locally, never sent.
    const fencedRows = (await listCommandsForRun(db, runId)).filter(
      (c) => c.state === "fenced",
    );

    expect(fencedRows).toHaveLength(1);
    expect(fencedRows[0].kind).toBe("workspace.adopt");

    const checkpoint = await client.checkpoint("sess-none");

    expect(checkpoint.alreadyCheckpointed).toBe(true);
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

  it("L7: prompt — SSE accepted folds accepted_at; SSE completed BEFORE the HTTP response wins and the late fold is a no-op", async () => {
    const { client } = await bound();
    const created = await client.createSession(CREATE_PAYLOAD);
    let httpReturned = false;

    fake.setPromptBehavior(async (ctx) => {
      ctx.emit("accepted");
      await sleep(20);
      ctx.setReceipt("completed", { stopReason: "end_turn", meta: null });
      ctx.emit("completed", {
        status: "succeeded",
        result: { stopReason: "end_turn", meta: null },
      });
      await sleep(150);
      httpReturned = true;

      return { stopReason: "end_turn", meta: null };
    });

    const handle = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "hi",
    });
    const result = await handle.completion;

    expect(result.stopReason).toBe("end_turn");
    expect(httpReturned).toBe(false);

    const settled = await untilState(handle.commandId, ["succeeded"]);

    expect(settled.acceptedAt).not.toBeNull();
    expect(settled.completedAt).not.toBeNull();

    await sleep(250);
    expect(httpReturned).toBe(true);
    const after = await getCommand(db, handle.commandId);

    expect(after!.state).toBe("succeeded");
    expect(after!.completedAt!.getTime()).toBe(settled.completedAt!.getTime());

    // Plain path: SSE accepted, HTTP completes → succeeded via the response.
    fake.setPromptBehavior(async (ctx) => {
      ctx.emit("accepted");

      return { stopReason: "end_turn", meta: null };
    });
    const plain = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "again",
    });

    expect((await plain.completion).stopReason).toBe("end_turn");
    const plainRow = await untilState(plain.commandId, ["succeeded"]);

    expect(plainRow.acceptedAt).not.toBeNull();
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

    expect((await a.completion).stopReason).toBe("end_turn");
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

    await expect(b.completion).rejects.toSatisfy(
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

    // (c) 404 (no receipt) after an SSE accepted → failed{receipt_missing}.
    fake.setPromptBehavior(async (ctx) => {
      ctx.emit("accepted");
      fake.receipts.delete(ctx.envelope.command.id);
      throw unknownOutcomeError("socket hang up");
    });
    r0 = receiptCalls();
    const c = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "c",
    });

    await expect(c.completion).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "receipt_missing",
    );
    expect(receiptCalls() - r0).toBe(1);
    expect((await untilState(c.commandId, ["failed"])).lastError).toMatchObject(
      {
        reason: "receipt_missing",
      },
    );

    // (d) receipt accepted AND in flight → ONE re-send joins the live turn.
    let sends = 0;

    fake.setPromptBehavior(async (ctx) => {
      sends += 1;
      if (sends === 1) {
        ctx.setReceipt("accepted", {}, true);
        throw unknownOutcomeError("socket hang up");
      }

      return { stopReason: "end_turn", meta: null };
    });
    r0 = receiptCalls();
    p0 = promptCalls();
    const d = await client.prompt(created.hostSessionId, {
      stepId: "s1",
      prompt: "d",
    });

    expect((await d.completion).stopReason).toBe("end_turn");
    expect(receiptCalls() - r0).toBe(1);
    expect(promptCalls() - p0).toBe(2);
    expect((await untilState(d.commandId, ["succeeded"])).state).toBe(
      "succeeded",
    );
  });
});

export type { BoundClient };
