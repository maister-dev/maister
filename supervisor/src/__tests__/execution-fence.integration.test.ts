// ADR-165 T2.2 — fence enforcement (F1–F8). Every assertion checks
// `details.reason` or a state, never a status code alone.
import type { SessionEvent } from "../types";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SESSION_EVENT_CHANNEL } from "../registry";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
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

// Adoption fences with the real host key and the FIRST fence seen for the run;
// every create below carries the fence under test.
async function createEnveloped(
  host: BootedHost,
  runId: string,
  fence: { assignmentId?: string; assignmentEpoch?: number; hostKey?: string },
  commandId?: string,
) {
  return postJson(
    `${host.url}/sessions`,
    await createEnvelope(host, { runId, ...fence }, {}, commandId),
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
    const res = await createEnveloped(host, runId, {
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

    await createEnveloped(host, runId, { assignmentEpoch: 2 });
    const res = await createEnveloped(host, runId, {
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

    await createEnveloped(host, runId, {
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    });
    const res = await createEnveloped(host, runId, {
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

    // Adoption (real host key) is the only fence write for this run ...
    await adoptDirectory(host, { runId });
    const fenceAfterAdopt = host.hostState.getFence(runId);

    expect(fenceAfterAdopt).toMatchObject({ runId, epoch: 1 });

    // ... the foreign-keyed create leaves it byte-identical and spawns nothing.
    const res = await createEnveloped(host, runId, {
      hostKey: "eh_not_this_host_0",
    });

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("host_mismatch");
    expect(host.hostState.getFence(runId)).toEqual(fenceAfterAdopt);
    expect(host.registry.size()).toBe(0);
  });

  it("F5: a prompt whose fence names another run is run_mismatch", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await createEnveloped(host, runId, {
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
    const created = await createEnveloped(host, runId, {
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

    await createEnveloped(first, runId, { assignmentEpoch: 3 });
    const key = first.hostState.hostKey;

    await first.stop();

    const second = await bootHost({
      runtimeRoot: root,
      stateDir,
      fixtureArgs: ["--hang"],
    });

    booted.push(second);
    expect(second.hostState.hostKey).toBe(key);
    const res = await createEnveloped(second, runId, {
      assignmentEpoch: 2,
    });

    expect(res.body.code).toBe("FENCED");
    expect(res.body.details).toMatchObject({
      reason: "assignment_fenced",
      commandEpoch: 2,
      hostEpoch: 3,
    });
  });

  it("F8: a missing envelope is refused before any fence or session state is touched", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const enveloped = await createEnvelope(host, { runId });
    const res = await postJson(`${host.url}/sessions`, enveloped.payload);

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ reason: "missing_envelope" });
    // Adoption fenced the run at epoch 1; the bare create advanced nothing.
    expect(host.hostState.getFence(runId)?.epoch).toBe(1);
    expect(host.registry.size()).toBe(0);
  });
});
