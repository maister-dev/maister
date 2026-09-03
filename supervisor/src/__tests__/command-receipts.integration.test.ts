// ADR-166 T2.2/T2.4 — receipts (R1–R6) and session.command events (S1–S3).
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
      epoch: 1,
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
      epoch: 1,
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
      epoch: 1,
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

    await waitFor(() => true);
    const durable = (
      await readEventsLog(host.runtimeRoot, "demo", runId)
    ).filter((e) => e.type === "session.command");

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

    // The post-terminal completions reached the durable log too.
    await waitFor(() => true);
    const durable = (
      await readEventsLog(host.runtimeRoot, "demo", runId)
    ).filter((e) => e.type === "session.command");

    expect(durable.map((e) => e.commandId).sort()).toEqual(
      Object.values(ids).sort(),
    );
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
