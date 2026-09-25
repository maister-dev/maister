import type { CommandEnvelope, SessionEvent } from "../types";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pendingPermissions } from "../pending-permissions";
import { SESSION_EVENT_CHANNEL } from "../registry";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
  fenceFor,
  postJson,
  waitFor,
  type BootedHost,
} from "./_fixtures/boot-host";

// ADR-182 D-B1…D-B7 (RED S5-host, S5b, S5c, S6, S7-host): `session.steer` on
// the real host routes, driven against the lifecycle mock's steering flags.

type Stack = {
  host: BootedHost;
  log: string;
  root: string;
};

const stacks: Stack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.host.registry.forEach((entry) => {
      pendingPermissions.purgeSession(entry.record.sessionId);
    });
    await stack.host.stop();
    await cleanupRuntimeRoot(stack.root);
  }
});

async function boot(
  fixtureArgs: string[],
  opts: { root?: string; stateDir?: string } = {},
): Promise<Stack> {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "steer-route-")));
  const log = join(root, "invocations.ndjson");
  const host = await bootHost({
    runtimeRoot: root,
    stateDir: opts.stateDir,
    killGraceMs: 1_000,
    fixtureArgs: ["--hang", "--invocation-log", log, ...fixtureArgs],
  });
  const stack = { host, log, root };

  stacks.push(stack);

  return stack;
}

type Session = {
  sessionId: string;
  pid: number;
  fence: CommandEnvelope["fence"];
  events: SessionEvent[];
};

async function openSession(stack: Stack): Promise<Session> {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const create = await createEnvelope(stack.host, fenceFor(stack.host, runId));
  const res = await postJson(`${stack.host.url}/sessions`, create);

  expect(res.status).toBe(201);
  const sessionId = res.body.sessionId as string;
  const events: SessionEvent[] = [];

  stack.host.registry
    .get(sessionId)
    ?.emitter.on(SESSION_EVENT_CHANNEL, (event: SessionEvent) => {
      events.push(event);
    });

  return {
    sessionId,
    pid: res.body.pid as number,
    fence: create.fence,
    events,
  };
}

async function startPrompt(
  stack: Stack,
  session: Session,
  prompt = "work",
): Promise<string> {
  const body = envelope("session.prompt", session.fence, {
    stepId: "step-1",
    prompt,
  });
  const res = await postJson(
    `${stack.host.url}/sessions/${session.sessionId}/prompts`,
    body,
  );

  expect(res.status).toBe(202);

  return body.command.id;
}

function steerBody(
  session: Session,
  parentCommandId: string,
  text: string,
  commandId: string = randomUUID(),
): CommandEnvelope {
  return envelope(
    "session.steer",
    session.fence,
    { contentBlocks: [{ type: "text", text }], parentCommandId },
    commandId,
  );
}

function steer(stack: Stack, session: Session, body: CommandEnvelope) {
  return postJson(
    `${stack.host.url}/sessions/${session.sessionId}/steer`,
    body,
  );
}

async function invocations(
  log: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForInvocations(
  log: string,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const startedAt = Date.now();

  for (;;) {
    const rows = await invocations(log);

    if (predicate(rows)) return rows;
    if (Date.now() - startedAt > 10_000)
      throw new Error(`invocation log never matched: ${JSON.stringify(rows)}`);
    await new Promise((resolveP) => setTimeout(resolveP, 20));
  }
}

function count(rows: Array<Record<string, unknown>>, method: string): number {
  return rows.filter((row) => row.method === method).length;
}

async function releasePrompt(
  stack: Stack,
  session: Session,
  commandId: string,
): Promise<void> {
  process.kill(session.pid, "SIGUSR1");
  await waitFor(
    () => stack.host.hostState.getReceipt(commandId)?.phase === "completed",
    10_000,
  );
}

function agentText(session: Session): string[] {
  return session.events.flatMap((event) => {
    if (event.type !== "session.update") return [];
    const update = event.update as {
      sessionUpdate?: string;
      content?: { text?: string };
    };

    return update.sessionUpdate === "agent_message_chunk" &&
      typeof update.content?.text === "string"
      ? [update.content.text]
      : [];
  });
}

function steerCommandEvents(stack: Stack, commandId: string) {
  return stack.host.hostState
    .runtimeEventsAfter(stack.host.hostState.getRuntimeEventStreamId(), null)
    .map((row) => row.envelope)
    .filter(
      (row) =>
        row.eventType === "session.command" &&
        (row.payload as { commandId?: string }).commandId === commandId,
    )
    .map((row) => row.payload as Record<string, unknown>);
}

describe("POST /sessions/:id/steer (ADR-182)", () => {
  it("refuses a bare body by name and an unknown session as retryable", async () => {
    const stack = await boot(["--steering"]);
    const session = await openSession(stack);
    const bare = await postJson(
      `${stack.host.url}/sessions/${session.sessionId}/steer`,
      {
        contentBlocks: [{ type: "text", text: "x" }],
        parentCommandId: randomUUID(),
      },
    );

    expect(bare.status).toBe(409);
    expect(bare.body).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "missing_envelope" },
    });

    const unknown = await postJson(
      `${stack.host.url}/sessions/${randomUUID()}/steer`,
      steerBody(session, randomUUID(), "x"),
    );

    expect(unknown.status).toBe(503);
    expect(unknown.body.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("refuses steer_unsupported before any ACP call and writes a rejected receipt", async () => {
    const stack = await boot(["--controlled-prompt"]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const body = steerBody(session, parent, "please also X");
    const res = await steer(stack, session, body);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "CONFLICT",
      details: { reason: "steer_unsupported", parentCommandId: parent },
    });
    expect(stack.host.hostState.getReceipt(body.command.id)?.phase).toBe(
      "rejected",
    );
    expect(count(await invocations(stack.log), "_session/steering")).toBe(0);
    await releasePrompt(stack, session, parent);
  });

  it("refuses steer_no_active_turn for no prompt and for a stale parent", async () => {
    const stack = await boot(["--steering", "--controlled-prompt"]);
    const session = await openSession(stack);
    const idle = await steer(
      stack,
      session,
      steerBody(session, randomUUID(), "x"),
    );

    expect(idle.status).toBe(409);
    expect(idle.body).toMatchObject({
      code: "CONFLICT",
      details: { reason: "steer_no_active_turn", activePromptCommandId: null },
    });

    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const stale = randomUUID();
    const mismatch = await steer(
      stack,
      session,
      steerBody(session, stale, "x"),
    );

    expect(mismatch.status).toBe(409);
    expect(mismatch.body.details).toEqual({
      reason: "steer_no_active_turn",
      parentCommandId: stale,
      activePromptCommandId: parent,
    });
    expect(count(await invocations(stack.log), "_session/steering")).toBe(0);
    await releasePrompt(stack, session, parent);
  });

  it("refuses a late steer after the parent completed and leaves the next prompt untouched (S6)", async () => {
    const stack = await boot(["--steering", "--controlled-prompt"]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    await releasePrompt(stack, session, parent);

    const late = await steer(
      stack,
      session,
      steerBody(session, parent, "late"),
    );

    expect(late.status).toBe(409);
    expect(late.body.details).toMatchObject({
      reason: "steer_no_active_turn",
      parentCommandId: parent,
      activePromptCommandId: null,
    });

    const next = await startPrompt(stack, session, "next");

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 2,
    );
    await releasePrompt(stack, session, next);
    expect(count(await invocations(stack.log), "_session/steering")).toBe(0);
    expect(agentText(session).some((text) => text.startsWith("steered:"))).toBe(
      false,
    );
  });

  it("injects into the running prompt, emits the command pair, replays by id and survives a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "steer-route-"));
    const stateDir = join(root, ".maister", "execution-host");
    const stack = await boot(["--steering", "--controlled-prompt"], {
      root,
      stateDir,
    });
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const body = steerBody(session, parent, "also update the changelog");
    const res = await steer(stack, session, body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "injected",
      parentCommandId: parent,
      latencyMs: expect.any(Number),
    });
    expect(res.headers.get("x-maister-command-replayed")).toBeNull();
    expect(stack.host.hostState.getReceipt(body.command.id)?.phase).toBe(
      "completed",
    );
    expect(steerCommandEvents(stack, body.command.id)).toEqual([
      expect.objectContaining({ kind: "session.steer", phase: "accepted" }),
      expect.objectContaining({
        kind: "session.steer",
        phase: "completed",
        status: "succeeded",
        result: expect.objectContaining({ parentCommandId: parent }),
      }),
    ]);

    const replay = await steer(stack, session, body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(res.body);
    expect(replay.headers.get("x-maister-command-replayed")).toBe("true");
    expect(count(await invocations(stack.log), "_session/steering")).toBe(1);

    await releasePrompt(stack, session, parent);
    expect(agentText(session)).toContain("steered:also update the changelog");
    // C4: the steered output is attributed to the PARENT prompt, never to the
    // steer — the parent's span evidence stays whole.
    const updates = stack.host.hostState
      .runtimeEventsAfter(stack.host.hostState.getRuntimeEventStreamId(), null)
      .map((row) => row.envelope)
      .filter(
        (row) =>
          row.eventType === "session.update" &&
          row.hostSessionId === session.sessionId,
      )
      .map(
        (row) => (row.payload as { sourceCommandId?: string }).sourceCommandId,
      );

    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates)).toEqual(new Set([parent]));

    stacks.splice(stacks.indexOf(stack), 1);
    await stack.host.stop();
    const restarted = await boot(["--steering"], { root, stateDir });
    const receipt = await (
      await fetch(`${restarted.host.url}/commands/${body.command.id}`)
    ).json();

    expect(receipt).toMatchObject({
      commandId: body.command.id,
      kind: "session.steer",
      phase: "completed",
      body: res.body,
    });
  });

  it("cancels an unowned turn on startedNewTurn and refuses (S5b)", async () => {
    const stack = await boot([
      "--steering",
      "--controlled-prompt",
      "--steer-outcome",
      "startedNewTurn",
    ]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const res = await steer(stack, session, steerBody(session, parent, "x"));

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({
      reason: "steer_no_active_turn",
      parentCommandId: parent,
      adapterOutcome: "startedNewTurn",
    });
    const rows = await waitForInvocations(
      stack.log,
      (logged) => count(logged, "session/cancel") === 1,
    );
    const steerAt = rows.findIndex((row) => row.method === "_session/steering");
    const cancelAt = rows.findIndex((row) => row.method === "session/cancel");

    expect(steerAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(steerAt);
    expect(rows[cancelAt]).toMatchObject({ unowned: true });

    await new Promise((resolveP) => setTimeout(resolveP, 150));
    const settled = agentText(session).filter((t) => t.startsWith("unowned:"));

    await new Promise((resolveP) => setTimeout(resolveP, 250));
    expect(agentText(session).filter((t) => t.startsWith("unowned:"))).toEqual(
      settled,
    );

    await releasePrompt(stack, session, parent);
    expect(stack.host.hostState.getReceipt(parent)?.body).toMatchObject({
      stopReason: "end_turn",
    });
  });

  it("releases a permission the unowned turn raised (S5b, deferred release)", async () => {
    const stack = await boot([
      "--steering",
      "--controlled-prompt",
      "--hang-permission",
      "--steer-outcome",
      "startedNewTurn",
    ]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const res = await steer(stack, session, steerBody(session, parent, "x"));

    expect(res.status).toBe(409);
    expect(pendingPermissions.requestIds(session.sessionId)).toEqual([]);
    await waitForInvocations(stack.log, (rows) =>
      rows.some(
        (row) =>
          row.method === "unowned/permission" && row.outcome === "cancelled",
      ),
    );
  });

  it("refuses promptRequired without a host cancel", async () => {
    const stack = await boot([
      "--steering",
      "--controlled-prompt",
      "--steer-outcome",
      "promptRequired",
    ]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const res = await steer(stack, session, steerBody(session, parent, "x"));

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      reason: "steer_no_active_turn",
      adapterOutcome: "promptRequired",
    });
    expect(count(await invocations(stack.log), "session/cancel")).toBe(0);
    await releasePrompt(stack, session, parent);
  });

  it("never writes the next prompt before an unanswered steer (S5c)", async () => {
    const stack = await boot([
      "--steering",
      "--controlled-prompt",
      "--steer-delay-ms",
      "1500",
    ]);
    const session = await openSession(stack);
    const parent = await startPrompt(stack, session);

    await waitForInvocations(
      stack.log,
      (rows) => count(rows, "session/prompt") === 1,
    );
    const body = steerBody(session, parent, "in flight");
    const steered = steer(stack, session, body);

    await waitFor(
      () =>
        stack.host.hostState.getReceipt(body.command.id)?.phase === "accepted",
      5_000,
    );
    await releasePrompt(stack, session, parent);
    const next = await startPrompt(stack, session, "next");
    const res = await steered;

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      reason: "steer_no_active_turn",
      adapterOutcome: "promptRequired",
    });
    const rows = await waitForInvocations(
      stack.log,
      (logged) => count(logged, "session/prompt") === 2,
    );
    const steerAt = rows.findIndex((row) => row.method === "_session/steering");
    const secondPromptAt = rows
      .map((row) => row.method)
      .lastIndexOf("session/prompt");

    expect(steerAt).toBeGreaterThanOrEqual(0);
    expect(steerAt).toBeLessThan(secondPromptAt);
    await releasePrompt(stack, session, next);
    expect(agentText(session).some((text) => text.startsWith("steered:"))).toBe(
      false,
    );
  });

  it("injects while the parent waits on a permission without cancelling it (S7-host)", async () => {
    const stack = await boot(["--steering"]);
    const session = await openSession(stack);
    const parent = await startPrompt(
      stack,
      session,
      'fixture-output:{"permission":true,"bytes":0,"text":"done"}',
    );

    await waitFor(
      () => pendingPermissions.requestIds(session.sessionId).length === 1,
      10_000,
    );
    const [requestId] = pendingPermissions.requestIds(session.sessionId);
    const res = await steer(
      stack,
      session,
      steerBody(session, parent, "later"),
    );

    expect(res.status).toBe(200);
    expect(pendingPermissions.requestIds(session.sessionId)).toEqual([
      requestId,
    ]);

    const input = await postJson(
      `${stack.host.url}/sessions/${session.sessionId}/input`,
      envelope("session.input", session.fence, {
        kind: "permission",
        action: "select",
        requestId,
        optionId: "allow",
      }),
    );

    expect(input.status).toBe(200);
    await waitFor(
      () => stack.host.hostState.getReceipt(parent)?.phase === "completed",
      10_000,
    );
    expect(agentText(session)).toEqual(
      expect.arrayContaining(["steered:later", "done"]),
    );
  });
});
