// ADR-164 T2.2 — fence enforcement (F1–F8). Every assertion checks
// `details.reason` or a state, never a status code alone.
import type { SessionEvent } from "../types";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_EVENT_CHANNEL } from "../registry";

import {
  bootHost,
  cleanupRuntimeRoot,
  envelope,
  legacyCreateBody,
  postJson,
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
  const root = await mkdtemp(join(tmpdir(), "eh-fence-"));

  roots.push(root);

  return root;
}

async function createLegacyEnveloped(
  host: BootedHost,
  runId: string,
  fence: { assignmentId?: string; assignmentEpoch?: number; hostKey?: string },
  commandId?: string,
) {
  return postJson(
    `${host.url}/sessions`,
    envelope(
      "session.create",
      { hostKey: fence.hostKey ?? host.hostState.hostKey, runId, ...fence },
      legacyCreateBody(runId, process.cwd()),
      commandId,
    ),
  );
}

describe("execution fence", () => {
  it("F1: an enveloped create at epoch 1 spawns and persists the run fence", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const assignmentId = randomUUID();
    const res = await createLegacyEnveloped(host, runId, {
      assignmentId,
      assignmentEpoch: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeTruthy();
    expect(host.hostState.getFence(runId)).toMatchObject({
      runId,
      assignmentId,
      epoch: 1,
    });

    const record = host.registry.get(res.body.sessionId)?.record;

    expect(record?.assignmentId).toBe(assignmentId);
    expect(record?.assignmentEpoch).toBe(1);
  });

  it("F2: a lower epoch for the same run is FENCED with the epochs in details", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;

    await createLegacyEnveloped(host, runId, { assignmentEpoch: 2 });
    const res = await createLegacyEnveloped(host, runId, {
      assignmentEpoch: 1,
    });

    expect(res.body.code).toBe("FENCED");
    expect(res.body.details).toEqual({
      reason: "assignment_fenced",
      runId,
      commandEpoch: 1,
      hostEpoch: 2,
    });
    expect(host.hostState.getFence(runId)?.epoch).toBe(2);
  });

  it("F3: the same epoch under a different assignment id is assignment_mismatch", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;

    await createLegacyEnveloped(host, runId, {
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    });
    const res = await createLegacyEnveloped(host, runId, {
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    });

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("assignment_mismatch");
  });

  it("F4: a foreign hostKey is host_mismatch and persists nothing", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const res = await createLegacyEnveloped(host, runId, {
      hostKey: "eh_not_this_host_0",
    });

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("host_mismatch");
    expect(host.hostState.getFence(runId)).toBeNull();
    expect(host.registry.size()).toBe(0);
  });

  it("F5: a prompt whose fence names another run is run_mismatch", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await createLegacyEnveloped(host, runId, {
      assignmentEpoch: 1,
    });
    const res = await postJson(
      `${host.url}/sessions/${created.body.sessionId}/prompt`,
      envelope(
        "session.prompt",
        { hostKey: host.hostState.hostKey, runId: "run-other" },
        { stepId: "step-1", prompt: "hello" },
      ),
    );

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("run_mismatch");
    expect(host.hostState.getFence("run-other")).toBeNull();
  });

  it("F6: a higher-epoch checkpoint evicts the live lower-epoch session; its pending prompt answers FENCED", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--hang-prompt", "--lines", "1"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const a1 = randomUUID();
    const a2 = randomUUID();
    const created = await createLegacyEnveloped(host, runId, {
      assignmentId: a1,
      assignmentEpoch: 1,
    });
    const sessionId = created.body.sessionId as string;
    const entry = host.registry.get(sessionId)!;
    const events: SessionEvent[] = [];

    entry.emitter.on(SESSION_EVENT_CHANNEL, (e: SessionEvent) =>
      events.push(e),
    );

    // Fixture --hang-prompt: the turn never returns, so the HTTP prompt
    // promise is still pending when the eviction lands.
    const promptPromise = postJson(
      `${host.url}/sessions/${sessionId}/prompt`,
      envelope(
        "session.prompt",
        {
          hostKey: host.hostState.hostKey,
          runId,
          assignmentId: a1,
          assignmentEpoch: 1,
        },
        { stepId: "step-1", prompt: "hello" },
      ),
    );

    await waitFor(() => events.some((e) => e.type === "session.update"), 5_000);

    const checkpoint = await postJson(
      `${host.url}/sessions/${sessionId}/checkpoint`,
      envelope(
        "session.checkpoint",
        {
          hostKey: host.hostState.hostKey,
          runId,
          assignmentId: a2,
          assignmentEpoch: 2,
        },
        {},
      ),
    );

    expect(checkpoint.status).toBe(200);
    expect(checkpoint.body.alreadyCheckpointed).toBe(true);
    expect(host.hostState.getFence(runId)).toMatchObject({
      assignmentId: a2,
      epoch: 2,
    });

    const exited = events.find((e) => e.type === "session.exited") as
      | Extract<SessionEvent, { type: "session.exited" }>
      | undefined;

    expect(exited?.reason).toBe("fenced");

    const prompt = await promptPromise;

    expect(prompt.body.code).toBe("FENCED");
    expect(prompt.body.details).toMatchObject({
      reason: "assignment_fenced",
      runId,
      commandEpoch: 1,
      hostEpoch: 2,
    });
  });

  it("F7: the fence survives an in-process restart on the same state dir", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".maister", "execution-host");
    const first = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });
    const runId = `run-${randomUUID().slice(0, 8)}`;

    await createLegacyEnveloped(first, runId, { assignmentEpoch: 3 });
    const key = first.hostState.hostKey;

    await first.stop();

    const second = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });

    booted.push(second);
    expect(second.hostState.hostKey).toBe(key);
    const res = await createLegacyEnveloped(second, runId, {
      assignmentEpoch: 2,
    });

    expect(res.body.code).toBe("FENCED");
    expect(res.body.details).toMatchObject({
      reason: "assignment_fenced",
      commandEpoch: 2,
      hostEpoch: 3,
    });
  });

  it("F8: a missing envelope still executes (transitional) and WARNs legacy-unfenced-command", async () => {
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
      logger,
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const res = await postJson(
      `${host.url}/sessions`,
      legacyCreateBody(runId, process.cwd()),
    );

    expect(res.status).toBe(201);
    expect(host.hostState.getFence(runId)).toBeNull();
    expect(
      warn.mock.calls.some((call) => call[1] === "legacy-unfenced-command"),
    ).toBe(true);
  });
});
