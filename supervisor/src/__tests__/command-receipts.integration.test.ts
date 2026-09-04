// ADR-166 T2.2/T2.4 — receipts (R1–R8) and session.command events (S1–S4).
import type { SessionEvent } from "../types";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openHostState } from "../host-state";
import { SESSION_EVENT_CHANNEL } from "../registry";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
  postJson,
  readEventsLog,
  waitFor,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eh-receipts-"));

  roots.push(root);

  return root;
}

function fenceFor(host: BootedHost, runId: string, epoch = 1) {
  return { hostKey: host.hostState.hostKey, runId, assignmentEpoch: epoch };
}

// Post-terminal completions reach the durable log asynchronously (after the
// closed writer drained); poll until the expected line count is there.
async function durableCommands(
  host: BootedHost,
  runId: string,
  count: number,
  completedOnly = false,
): Promise<Array<Record<string, unknown>>> {
  let lines: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 200 && lines.length < count; i += 1) {
    lines = (await readEventsLog(host.runtimeRoot, "demo", runId)).filter(
      (e) =>
        e.type === "session.command" &&
        (!completedOnly || e.phase === "completed"),
    );
    if (lines.length < count) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return lines;
}

describe("command receipts", () => {
  it("R1: a duplicate create id replays the same 201 body with the replay header and spawns once", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const commandId = randomUUID();
    const body = await createEnvelope(host, { runId }, {}, commandId);
    const first = await postJson(`${host.url}/sessions`, body);
    const second = await postJson(`${host.url}/sessions`, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("x-maister-command-replayed")).toBe("true");
    expect(first.headers.get("x-maister-command-replayed")).toBeNull();
    expect(host.registry.size()).toBe(1);
  });

  it("R2: a duplicate prompt id while the turn is in flight joins it (same stopReason)", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--lines", "3"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const commandId = randomUUID();
    const prompt = envelope(
      "session.prompt",
      fenceFor(host, runId),
      { stepId: "step-1", prompt: "hello" },
      commandId,
    );
    const [a, b] = await Promise.all([
      postJson(`${host.url}/sessions/${sessionId}/prompt`, prompt),
      postJson(`${host.url}/sessions/${sessionId}/prompt`, prompt),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.stopReason).toBe("end_turn");
    expect(b.body.stopReason).toBe("end_turn");
    expect(
      [a, b].filter(
        (r) => r.headers.get("x-maister-command-replayed") === "true",
      ),
    ).toHaveLength(1);
  });

  it("R2a: a replayed command id rejects a mismatched request and links its receipt to the durable event", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const commandId = randomUUID();
    const first = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      envelope(
        "session.prompt",
        fenceFor(host, runId),
        { stepId: "step-1", prompt: "first request" },
        commandId,
      ),
    );
    const receipt = host.hostState.getReceipt(commandId);
    const mismatched = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      envelope(
        "session.prompt",
        fenceFor(host, runId),
        { stepId: "step-1", prompt: "different request" },
        commandId,
      ),
    );

    expect(first.status).toBe(200);
    expect(receipt?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.details?.reason).toBe("command_invariant_conflict");
  });

  it("R2b: asynchronous prompt admission returns only after the accepted receipt/event and terminalizes later", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const commandId = randomUUID();
    const admitted = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
      envelope(
        "session.prompt",
        fenceFor(host, runId),
        { stepId: "step-async", prompt: "asynchronous command" },
        commandId,
      ),
    );
    await waitFor(
      () => {
        const receipt = host.hostState.getReceipt(commandId);
        return receipt?.phase === "completed";
      },
    );
    const terminal = host.hostState.getReceipt(commandId);

    expect(admitted.status).toBe(202);
    expect(admitted.body).toEqual({ commandId, state: "accepted" });
    expect(terminal?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminal?.body).toMatchObject({ stopReason: "end_turn" });
  });

  it("R3: after a restart between accepted and completion a duplicate prompt id is turn_lost", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".maister", "execution-host");
    const first = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const commandId = randomUUID();

    // Simulate a turn that was accepted and never completed before the restart.
    first.hostState.putReceipt({
      commandId,
      runId,
      kind: "session.prompt",
      assignmentId: null,
      epoch: 1,
      hostSessionId: null,
      requestDigest: null,
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: {},
      receivedAt: new Date().toISOString(),
      completedAt: null,
    });
    await first.stop();

    const second = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });

    booted.push(second);
    const created = await postJson(
      `${second.url}/sessions`,
      await createEnvelope(second, { runId }),
    );
    const res = await postJson(
      `${second.url}/sessions/${created.body.sessionId}/prompt`,
      envelope(
        "session.prompt",
        fenceFor(second, runId),
        { stepId: "step-1", prompt: "again" },
        commandId,
      ),
    );

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("turn_lost");
    expect(second.hostState.getReceipt(commandId)?.phase).toBe("rejected");
  });

  it("R3b: supervisor startup terminalizes a proven async prompt receipt and appends turn_lost", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".maister", "execution-host");
    const first = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${first.url}/sessions`,
      await createEnvelope(first, { runId }),
    );
    const commandId = randomUUID();
    const assignmentId = randomUUID();
    first.hostState.putReceipt({
      commandId,
      runId,
      kind: "session.prompt",
      assignmentId,
      epoch: 1,
      hostSessionId: created.body.sessionId as string,
      requestDigest: null,
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: { commandId, state: "accepted" },
      receivedAt: new Date().toISOString(),
      completedAt: null,
    });
    await first.stop();

    const second = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });
    booted.push(second);
    const receipt = second.hostState.getReceipt(commandId);
    const events = second.hostState.runtimeEventsAfter(
      second.hostState.getRuntimeEventStreamId(),
      null,
    );
    const event = events.find((candidate) => candidate.eventId === receipt?.eventId);

    expect(receipt).toMatchObject({
      phase: "rejected",
      httpStatus: 409,
      body: { details: { reason: "turn_lost", runId } },
    });
    expect(event?.envelope).toMatchObject({
      runId,
      assignmentId,
      hostSessionId: created.body.sessionId,
      eventType: "session.command",
      payload: {
        commandId,
        kind: "session.prompt",
        phase: "completed",
        status: "failed",
        error: { details: { reason: "turn_lost", runId } },
      },
    });
  });

  it("R4: GET /commands/:id returns the receipt fields; unknown is 404", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const commandId = randomUUID();

    await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }, {}, commandId),
    );
    const res = await fetch(`${host.url}/commands/${commandId}`);
    const receipt = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(receipt).toMatchObject({
      commandId,
      runId,
      kind: "session.create",
      assignmentEpoch: 1,
      phase: "completed",
      httpStatus: 201,
    });
    expect((receipt.body as { sessionId?: string }).sessionId).toBeTruthy();
    expect(typeof receipt.receivedAt).toBe("string");
    expect(typeof receipt.completedAt).toBe("string");

    const missing = await fetch(`${host.url}/commands/${randomUUID()}`);

    expect(missing.status).toBe(404);
  });

  it("R5: a receipt write failure is 500 ACP_PROTOCOL and leaves no receipt row", async () => {
    const root = await tempRoot();
    const hostState = openHostState({ stateDir: join(root, "s") });
    const host = await bootHost({
      runtimeRoot: root,
      hostState,
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const commandId = randomUUID();

    // Adopt BEFORE the fault is injected: the failure under test is the
    // create's receipt write, not the adoption's.
    await adoptDirectory(host, { runId });
    vi.spyOn(hostState, "putReceipt").mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }, {}, commandId),
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("ACP_PROTOCOL");
    vi.restoreAllMocks();
    expect(hostState.getReceipt(commandId)).toBeNull();
    expect(host.registry.size()).toBe(0);
  });

  it("R6: receipts older than the TTL are pruned at open (clock injected)", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "s");
    const state = openHostState({ stateDir });
    const old = randomUUID();
    const fresh = randomUUID();
    const now = Date.now();

    state.putReceipt({
      commandId: old,
      runId: "r",
      kind: "session.cancel",
      assignmentId: null,
      epoch: 1,
      hostSessionId: null,
      requestDigest: null,
      eventId: null,
      phase: "completed",
      httpStatus: 200,
      body: {},
      receivedAt: new Date(now - 8 * 24 * 3600_000).toISOString(),
      completedAt: null,
    });
    state.putReceipt({
      commandId: fresh,
      runId: "r",
      kind: "session.cancel",
      assignmentId: null,
      epoch: 1,
      hostSessionId: null,
      requestDigest: null,
      eventId: null,
      phase: "completed",
      httpStatus: 200,
      body: {},
      receivedAt: new Date(now - 6 * 24 * 3600_000).toISOString(),
      completedAt: null,
    });
    state.close();

    const reopened = openHostState({ stateDir, now: () => new Date(now) });

    expect(reopened.getReceipt(old)).toBeNull();
    expect(reopened.getReceipt(fresh)).not.toBeNull();
    reopened.close();
  });

  it("R7: a duplicate prompt id replays its completed receipt after the session exited (replay wins over liveness)", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--lines", "2"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const prompt = envelope(
      "session.prompt",
      fenceFor(host, runId),
      { stepId: "step-1", prompt: "hello" },
      randomUUID(),
    );
    const first = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      prompt,
    );

    expect(first.status).toBe(200);

    const deleted = await postJson(
      `${host.url}/sessions/${sessionId}`,
      envelope("session.delete", fenceFor(host, runId), {}),
      "DELETE",
    );

    expect(deleted.status).toBe(204);
    await waitFor(
      () => host.registry.get(sessionId)?.record.status === "exited",
      5_000,
    );

    const again = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      prompt,
    );

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("x-maister-command-replayed")).toBe("true");
  });

  it("R8: a duplicate create id replays its 201 receipt after its handle was released (replay wins over the handle check)", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const body = await createEnvelope(host, { runId }, {}, randomUUID());
    const first = await postJson(`${host.url}/sessions`, body);

    expect(first.status).toBe(201);

    const release = await postJson(
      `${host.url}/workspaces/${body.payload.executionWorkspaceId as string}`,
      envelope("workspace.release", fenceFor(host, runId), {}),
      "DELETE",
    );

    expect(release.body).toEqual({ released: true });

    const again = await postJson(`${host.url}/sessions`, body);

    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("x-maister-command-replayed")).toBe("true");
    expect(host.registry.size()).toBe(1);

    // A NEW create against the released handle is still refused.
    const fresh = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );

    expect(fresh.body.details.reason).toBe("workspace_released");
  });
});

describe("session.command events", () => {
  it("S1: a prompt turn emits accepted then completed with increasing monotonicIds, both durable", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--lines", "2"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const commandId = randomUUID();
    const res = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      envelope(
        "session.prompt",
        fenceFor(host, runId),
        { stepId: "step-1", prompt: "hello" },
        commandId,
      ),
    );

    expect(res.status).toBe(200);
    const events = host.registry
      .snapshotEvents(sessionId)
      .filter(
        (e): e is Extract<SessionEvent, { type: "session.command" }> =>
          e.type === "session.command",
      );

    expect(events.map((e) => e.phase)).toEqual(["accepted", "completed"]);
    expect(events[0].commandId).toBe(commandId);
    expect(events[1].status).toBe("succeeded");
    expect(events[1].result).toMatchObject({ stopReason: "end_turn" });
    expect(events[1].monotonicId).toBeGreaterThan(events[0].monotonicId);

    const durable = await durableCommands(host, runId, 2);

    expect(durable.map((e) => e.phase)).toEqual(["accepted", "completed"]);
    expect(durable.every((e) => e.sessionName === "default")).toBe(true);
  });

  it("S2: cancel, input, checkpoint, and delete each emit exactly one completed event after their effect", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const base = `${host.url}/sessions/${sessionId}`;
    const ids = {
      cancel: randomUUID(),
      input: randomUUID(),
      checkpoint: randomUUID(),
      delete: randomUUID(),
    };

    await postJson(
      `${base}/cancel`,
      envelope("session.cancel", fenceFor(host, runId), {}, ids.cancel),
    );
    const input = await postJson(
      `${base}/input`,
      envelope(
        "session.input",
        fenceFor(host, runId),
        {
          kind: "permission",
          action: "cancel",
          requestId: randomUUID(),
          reason: "test",
        },
        ids.input,
      ),
    );

    expect(input.body.code).toBe("HITL_TIMEOUT");
    await postJson(
      `${base}/checkpoint`,
      envelope("session.checkpoint", fenceFor(host, runId), {}, ids.checkpoint),
    );
    await postJson(
      base,
      envelope("session.delete", fenceFor(host, runId), {}, ids.delete),
      "DELETE",
    );

    await waitFor(
      () => host.registry.get(sessionId)?.record.status !== "live",
      5_000,
    );
    const events = host.registry
      .snapshotEvents(sessionId)
      .filter(
        (e): e is Extract<SessionEvent, { type: "session.command" }> =>
          e.type === "session.command",
      );
    const byId = new Map(events.map((e) => [e.commandId, e]));

    expect(events.filter((e) => e.phase === "completed")).toHaveLength(4);
    expect(byId.get(ids.cancel)?.status).toBe("succeeded");
    expect(byId.get(ids.input)?.status).toBe("failed");
    expect(byId.get(ids.input)?.error?.code).toBe("HITL_TIMEOUT");
    expect(byId.get(ids.checkpoint)?.status).toBe("succeeded");
    expect(byId.get(ids.delete)?.status).toBe("succeeded");

    // The post-terminal completions reached the durable log too, in order.
    const durable = await durableCommands(host, runId, 4, true);

    expect(durable.map((e) => e.commandId)).toEqual([
      ids.cancel,
      ids.input,
      ids.checkpoint,
      ids.delete,
    ]);
  });

  it("S4: a post-terminal completion lands behind the drained event log — ids stay strictly increasing across many updates and a delete", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--lines", "400"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const sessionId = created.body.sessionId as string;
    const prompt = await postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      envelope("session.prompt", fenceFor(host, runId), {
        stepId: "step-1",
        prompt: "hello",
      }),
    );

    expect(prompt.status).toBe(200);

    const deleteId = randomUUID();

    await postJson(
      `${host.url}/sessions/${sessionId}`,
      envelope("session.delete", fenceFor(host, runId), {}, deleteId),
      "DELETE",
    );

    let durable: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 200; i += 1) {
      durable = await readEventsLog(host.runtimeRoot, "demo", runId);
      if (durable.some((e) => e.commandId === deleteId)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(durable.at(-1)?.commandId).toBe(deleteId);
    expect(durable.some((e) => e.type === "session.exited")).toBe(true);

    const ids = durable.map((e) => e.monotonicId as number);

    expect(ids.length).toBeGreaterThan(400);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i], `line ${i}`).toBeGreaterThan(ids[i - 1]);
    }
  });

  it("S3: a fence eviction lands session.exited{reason:fenced} in the durable log", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId, assignmentEpoch: 1 }),
    );
    const sessionId = created.body.sessionId as string;
    const entry = host.registry.get(sessionId)!;
    const exitedEvents: SessionEvent[] = [];

    entry.emitter.on(SESSION_EVENT_CHANNEL, (e: SessionEvent) =>
      exitedEvents.push(e),
    );
    await postJson(
      `${host.url}/sessions/${sessionId}/cancel`,
      envelope(
        "session.cancel",
        { ...fenceFor(host, runId, 2), assignmentId: randomUUID() },
        {},
      ),
    );
    await waitFor(
      () => exitedEvents.some((e) => e.type === "session.exited"),
      5_000,
    );

    const durable = await readEventsLog(host.runtimeRoot, "demo", runId);
    const exited = durable.find((e) => e.type === "session.exited");

    expect(exited?.reason).toBe("fenced");
  });
});
