// ADR-166 T2.2/T2.4 — receipts (R1–R8) and session.command events (S1–S4).
import type { SessionEvent } from "../types";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SessionContentReferenceSchema,
  type RuntimeEventEnvelope,
} from "../runtime-events";
import {
  openHostState,
  HOST_STATE_FILE,
  HOST_STATE_SCHEMA_VERSION,
} from "../host-state";
import { commandRequestDigest } from "../command-receipts";
import { SESSION_EVENT_CHANNEL } from "../registry";
import { canonicalCommandJson } from "../../../runtime/command-json";
import {
  parseCommandReceiptV2,
  parseCommandOutputReferenceV2,
  parseCommandOutputManifestV2,
} from "../../../runtime/command-evidence";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
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
  const root = await mkdtemp(join(tmpdir(), "eh-receipts-"));

  roots.push(root);

  return root;
}

function fenceFor(host: BootedHost, runId: string, epoch = 1) {
  return { hostKey: host.hostState.hostKey, runId, assignmentEpoch: epoch };
}

function canonicalRuntimeEvents(
  host: BootedHost,
  runId: string,
): Array<Record<string, unknown>> {
  const streamId = host.hostState.getRuntimeEventStreamId();
  const events: RuntimeEventEnvelope[] = [];
  let after: string | null = null;

  for (;;) {
    const page = host.hostState.runtimeEventsAfter(streamId, after, 500);

    if (page.length === 0) break;
    events.push(...page.map((row) => row.envelope as RuntimeEventEnvelope));
    after = page.at(-1)?.sequence ?? null;
  }

  return events
    .filter((event) => event.runId === runId)
    .map((event) => ({
      ...event.payload,
      type: event.eventType,
      sequence: event.sequence,
    }));
}

// Post-terminal completions are appended to the host's durable outbox after
// the route receipt has been persisted; poll the outbox until they arrive.
async function durableCommands(
  host: BootedHost,
  runId: string,
  count: number,
  completedOnly = false,
): Promise<Array<Record<string, unknown>>> {
  let lines: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 200 && lines.length < count; i += 1) {
    lines = canonicalRuntimeEvents(host, runId).filter(
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
      completePrompt(host, sessionId, prompt),
      completePrompt(host, sessionId, prompt),
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
    const first = await completePrompt(
      host,
      sessionId,
      envelope(
        "session.prompt",
        fenceFor(host, runId),
        { stepId: "step-1", prompt: "first request" },
        commandId,
      ),
    );
    const receipt = host.hostState.getReceipt(commandId);
    const mismatched = await postJson(
      `${host.url}/sessions/${sessionId}/prompts`,
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

  it("AT-06: an identical envelope cannot replay a prompt against another URL-selected session", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const first = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const second = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const request = envelope("session.prompt", fenceFor(host, runId), {
      stepId: "identity",
      prompt: "same request, different target",
    });

    await completePrompt(host, first.body.sessionId as string, request);
    const replay = await postJson(
      `${host.url}/sessions/${second.body.sessionId}/prompts`,
      request,
    );

    expect(replay.status).toBe(409);
    expect(replay.body.details?.reason).toBe("command_invariant_conflict");
    expect(host.hostState.getReceipt(request.command.id)?.hostSessionId).toBe(
      first.body.sessionId,
    );
  });

  it("AT-06: a durable receipt preserves the exact request digest and terminal stream position through reopen", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".maister", "execution-host");
    const host = await bootHost({ runtimeRoot: root, stateDir });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const hostSessionId = created.body.sessionId as string;
    const request = envelope("session.prompt", fenceFor(host, runId), {
      stepId: "digest",
      prompt: "private original request",
    });

    await completePrompt(host, hostSessionId, request);
    const expectedDigest = createHash("sha256")
      .update(
        canonicalCommandJson({
          requestVersion: 2,
          ...request,
          target: { hostSessionId },
        }),
        "utf8",
      )
      .digest("hex");
    const receipt = host.hostState.getReceipt(request.command.id);
    const terminal = host.hostState
      .runtimeEventsAfter(host.hostState.getRuntimeEventStreamId(), null)
      .find((event) => event.eventId === receipt?.eventId);

    expect(receipt).toMatchObject({
      requestSchema: "maister.command.request.v2",
      requestDigest: expectedDigest,
      hostKey: host.hostState.hostKey,
      hostSessionId,
      assignmentId: request.fence.assignmentId,
      terminalStreamId: terminal?.streamId,
      terminalSequence: terminal?.sequence,
      acceptedSequence: expect.stringMatching(/^[0-9]+$/),
    });
    await host.stop();
    booted.pop();
    const reopened = openHostState({ stateDir });

    try {
      expect(reopened.getReceipt(request.command.id)).toEqual(receipt);
    } finally {
      reopened.close();
    }
  });

  it("AT-06: a populated v9 receipt upgrades without inventing a v2 digest or terminal position", async () => {
    const stateDir = join(await tempRoot(), "state");
    const initial = openHostState({ stateDir });

    initial.close();
    const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
    const commandId = randomUUID();
    const digest = "a".repeat(64);

    legacy.exec(`BEGIN;
      ALTER TABLE command_receipts DROP COLUMN request_schema;
        ALTER TABLE command_receipts DROP COLUMN request_version;
      ALTER TABLE command_receipts DROP COLUMN host_key;
      ALTER TABLE command_receipts DROP COLUMN accepted_sequence;
      ALTER TABLE command_receipts DROP COLUMN terminal_stream_id;
      ALTER TABLE command_receipts DROP COLUMN terminal_sequence;
      ALTER TABLE command_receipts DROP COLUMN retired_at;
        ALTER TABLE runtime_objects DROP COLUMN producer_path;
        ALTER TABLE runtime_objects DROP COLUMN sealed_device;
        ALTER TABLE runtime_objects DROP COLUMN sealed_inode;
      PRAGMA user_version = 9; COMMIT;`);
    legacy
      .prepare(
        `INSERT INTO command_receipts
      (command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, event_id, phase, http_status, body_json, received_at, completed_at)
      VALUES (?, 'legacy-run', 'session.prompt', ?, 1, 'legacy-session', ?, ?, 'completed', 200, ?, ?, ?)`,
      )
      .run(
        commandId,
        randomUUID(),
        digest,
        randomUUID(),
        JSON.stringify({ stopReason: "end_turn", meta: { original: true } }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    legacy.close();
    const upgraded = openHostState({ stateDir });

    try {
      expect(upgraded.getReceipt(commandId)).toMatchObject({
        requestDigest: digest,
        requestSchema: null,
        hostKey: null,
        acceptedSequence: null,
        terminalStreamId: null,
        terminalSequence: null,
        body: { stopReason: "end_turn", meta: { original: true } },
      });
    } finally {
      upgraded.close();
    }
    const inspected = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
    } finally {
      inspected.close();
    }
  });

  it("AT-06 v2: accepted receipt survives duplicate reads, refuses retargeting/version changes and rejects a concurrent new turn", async () => {
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: ["--hang", "--hang-prompt"],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId }),
    );
    const hostSessionId = created.body.sessionId as string;
    const legacy = envelope("session.prompt", fenceFor(host, runId), {
      stepId: "pending",
      prompt: "original input",
    });
    const request = { ...legacy, requestVersion: 2, target: { hostSessionId } };
    const route = `${host.url}/sessions/${hostSessionId}/prompts`;

    expect((await postJson(route, request)).status).toBe(202);
    const read = async () =>
      parseCommandReceiptV2(
        await (
          await fetch(`${host.url}/commands/${request.command.id}`)
        ).json(),
      );
    const accepted = await read();

    expect(accepted).toMatchObject({
      receiptVersion: 2,
      phase: "accepted",
      terminal: null,
      hostSessionId,
    });
    expect((await postJson(route, request)).status).toBe(202);
    expect(await read()).toEqual(accepted);
    expect((await postJson(route, legacy)).body.details.reason).toBe(
      "command_invariant_conflict",
    );
    expect(
      (
        await postJson(route, {
          ...request,
          target: { hostSessionId: randomUUID() },
        })
      ).body.details.reason,
    ).toBe("command_invariant_conflict");
    const next = {
      ...request,
      command: { ...request.command, id: randomUUID() },
    };

    expect((await postJson(route, next)).body.details.reason).toBe(
      "command_in_progress",
    );
    expect(host.hostState.getReceipt(next.command.id)).toBeNull();
    expect(await read()).toEqual(accepted);
  });

  it("AT-06 v2: preserves exact private nested rejection evidence in a command payload content object", async () => {
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
    const hostSessionId = created.body.sessionId as string;
    const failure = {
      code: "ACP_PROTOCOL" as const,
      message: "required output is incomplete",
      details: {
        reason: "required_output_incomplete" as const,
        original: { api_key: "opaque diagnostic value" },
      },
    };

    host.registry.get(hostSessionId)!.record.outputFailure = failure;
    const request = {
      ...envelope("session.prompt", fenceFor(host, runId), {
        stepId: "failure",
        prompt: "original input",
      }),
      requestVersion: 2,
      target: { hostSessionId },
    };

    expect(
      (await postJson(`${host.url}/sessions/${hostSessionId}/prompts`, request))
        .status,
    ).toBe(202);
    await waitFor(
      () => host.hostState.getReceipt(request.command.id)?.phase === "rejected",
    );
    const receipt = parseCommandReceiptV2(
      await (await fetch(`${host.url}/commands/${request.command.id}`)).json(),
    );
    const canonical = host.hostState
      .runtimeEventsAfter(host.hostState.getRuntimeEventStreamId(), null)
      .find((event) => event.eventId === receipt.terminal?.eventId)!;
    const reference = SessionContentReferenceSchema.parse(
      (canonical.envelope as RuntimeEventEnvelope).payload.contentRef,
    );
    const object = host.hostState.getRuntimeObject(reference.objectId)!;
    const bytes = await readFile(object.privatePath);
    const payload: unknown = JSON.parse(bytes.toString("utf8"));

    expect(reference.sourcePayloadSchema).toBe("maister.session.command.v2");
    expect(canonical.envelope).toMatchObject({
      payloadSchema: "maister.session.content.v2",
      payload: {
        commandId: request.command.id,
        kind: "session.prompt",
        requestSchema: receipt.requestSchema,
        requestSha256: receipt.requestSha256,
      },
    });
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      reference.sha256,
    );
    expect(payload).toMatchObject({
      requestSha256: receipt.requestSha256,
      phase: "rejected",
      terminal: receipt.terminal,
    });
    expect(receipt.terminal?.error).toEqual(failure);
  });

  it("AT-06 v2: publishes a request-bound receipt and immutable original output manifest", async () => {
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
    const hostSessionId = created.body.sessionId as string;
    const request = {
      ...envelope("session.prompt", fenceFor(host, runId), {
        stepId: "v2-output",
        prompt: "original output",
      }),
      requestVersion: 2,
      target: { hostSessionId },
    };
    const admitted = await postJson(
      `${host.url}/sessions/${hostSessionId}/prompts`,
      request,
    );

    expect(admitted.status).toBe(202);
    await waitFor(
      () =>
        host.hostState.getReceipt(request.command.id)?.phase === "completed",
    );
    expect(host.hostState.getReceipt(request.command.id)).toMatchObject({
      phase: "completed",
    });
    const response = await fetch(`${host.url}/commands/${request.command.id}`);
    const json: unknown = await response.json();
    const receipt = parseCommandReceiptV2(json);
    const canonical = host.hostState
      .runtimeEventsAfter(host.hostState.getRuntimeEventStreamId(), null)
      .find((event) => event.eventId === receipt.terminal?.eventId);

    expect(canonical?.envelope).toMatchObject({
      payloadSchema: "maister.session.command.v2",
      payload: {
        commandId: request.command.id,
        kind: "session.prompt",
        phase: "completed",
        requestSchema: receipt.requestSchema,
        requestSha256: receipt.requestSha256,
        terminal: receipt.terminal,
      },
    });
    const output = parseCommandOutputReferenceV2(
      receipt.terminal?.result?.output,
    );
    const stored = host.hostState.getRuntimeObject(output.objectId);

    expect(stored).not.toBeNull();
    if (!stored) throw new Error("output manifest object is missing");
    const bytes = await readFile(stored.privatePath);
    const manifest = parseCommandOutputManifestV2(
      JSON.parse(bytes.toString("utf8")),
    );

    expect(bytes.byteLength).toBe(output.sizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      output.sha256,
    );
    expect(manifest).toMatchObject({
      commandId: request.command.id,
      hostSessionId,
      requestSha256: receipt.requestSha256,
      acceptedSequence: output.acceptedSequence,
      terminalSequence: receipt.terminal?.sequence,
      streamId: receipt.terminal?.streamId,
    });
    const original = host.hostState.getRuntimeObject(
      manifest.response.objectId,
    );

    if (!original)
      throw new Error("original command response object is missing");
    const originalBytes = await readFile(original.privatePath);

    expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
      manifest.response.sha256,
    );
    expect(JSON.parse(originalBytes.toString("utf8"))).toMatchObject({
      schema: "maister.command-response.v2",
      commandId: request.command.id,
      hostSessionId,
      requestSha256: receipt.requestSha256,
      response: { stopReason: "end_turn" },
    });
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

    await waitFor(() => {
      const receipt = host.hostState.getReceipt(commandId);

      return receipt?.phase === "completed";
    });
    const terminal = host.hostState.getReceipt(commandId);

    expect(admitted.status).toBe(202);
    expect(admitted.body).toEqual({ commandId, state: "accepted" });
    expect(terminal?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminal?.body).toMatchObject({ stopReason: "end_turn" });
  });

  it("R3: a legacy receipt without target identity cannot bind to a new session after restart", async () => {
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
      `${second.url}/sessions/${created.body.sessionId}/prompts`,
      envelope(
        "session.prompt",
        fenceFor(second, runId),
        { stepId: "step-1", prompt: "again" },
        commandId,
      ),
    );

    expect(res.body.code).toBe("PRECONDITION");
    expect(res.body.details.reason).toBe("command_invariant_conflict");
    expect(second.hostState.getReceipt(commandId)?.phase).toBe("accepted");
  });

  it.each([1, 2] as const)(
    "R3b: supervisor startup terminalizes a proven v%i async prompt receipt and appends turn_lost",
    async (requestVersion) => {
      const root = await tempRoot();
      const stateDir = join(root, ".maister", "execution-host");
      const first = await bootHost({
        runtimeRoot: root,
        stateDir,
        fixtureArgs: ["--hang"],
      });
      const runId = `run-${randomUUID().slice(0, 8)}`;
      const create = await createEnvelope(first, { runId });
      const created = await postJson(`${first.url}/sessions`, create);
      const commandId = randomUUID();
      const assignmentId = create.fence.assignmentId;

      const request = envelope(
        "session.prompt",
        create.fence,
        { stepId: "lost", prompt: "original lost turn" },
        commandId,
      );
      const hostSessionId = created.body.sessionId as string;

      first.hostState.putReceiptWithRuntimeEvent(
        {
          commandId,
          runId,
          kind: "session.prompt",
          assignmentId,
          epoch: 1,
          hostSessionId: created.body.sessionId as string,
          requestVersion,
          requestSchema: "maister.command.request.v2",
          hostKey: first.hostState.hostKey,
          requestDigest: commandRequestDigest(request, hostSessionId),
          eventId: null,
          phase: "accepted",
          httpStatus: 202,
          body: { commandId, state: "accepted" },
          receivedAt: new Date().toISOString(),
          completedAt: null,
        },
        {
          terminal: false,
          draft: {
            runId,
            assignmentId,
            assignmentEpoch: 1,
            hostSessionId,
            eventType: "session.command",
            occurredAt: new Date().toISOString(),
            payload: { commandId, kind: "session.prompt", phase: "accepted" },
          },
        },
      );
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
      const event = events.find(
        (candidate) => candidate.eventId === receipt?.eventId,
      );

      if (requestVersion === 2) {
        const publicReceipt = parseCommandReceiptV2(
          await (await fetch(`${second.url}/commands/${commandId}`)).json(),
        );

        expect(publicReceipt).toMatchObject({
          receiptVersion: 2,
          requestSha256: commandRequestDigest(request, hostSessionId),
          terminal: {
            status: "failed",
            error: { details: { reason: "turn_lost", runId } },
          },
        });
        expect(event?.envelope).toMatchObject({
          payload: { sourceCommandId: commandId },
        });
      }
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
        payload:
          requestVersion === 2
            ? {
                commandId,
                kind: "session.prompt",
                phase: "rejected",
                terminal: {
                  status: "failed",
                  error: { details: { reason: "turn_lost", runId } },
                },
              }
            : {
                commandId,
                kind: "session.prompt",
                phase: "completed",
                status: "failed",
                error: { details: { reason: "turn_lost", runId } },
              },
      });
    },
  );

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

  it("R6: reopening never reclaims a receipt by age — only the retirement handshake does", async () => {
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

    // Age carries no reclamation authority (D6): the 8-day-old receipt is
    // still whole after a restart, and only the explicit handshake compacts it.
    expect(reopened.getReceipt(old)).not.toBeNull();
    expect(reopened.getReceipt(fresh)).not.toBeNull();
    expect(
      reopened.retireReceipt(old, {
        expectedRequestSha256: null,
        expectedPhase: "completed",
        assignmentEpoch: 1,
      }).outcome,
    ).toBe("retired");
    expect(reopened.getReceipt(old)?.body).toEqual({ retired: true });
    expect(reopened.getReceipt(fresh)?.body).toEqual({});
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
    const first = await completePrompt(host, sessionId, prompt);

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

    const again = await completePrompt(host, sessionId, prompt);

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
    const res = await completePrompt(
      host,
      sessionId,
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

  it("S4: a post-terminal completion is ordered after ACP updates and a delete", async () => {
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
    const prompt = await completePrompt(
      host,
      sessionId,
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
      durable = canonicalRuntimeEvents(host, runId);
      if (
        durable.some(
          (event) =>
            event.commandId === deleteId && event.phase === "completed",
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const deleteEvent = durable.find(
      (event) => event.commandId === deleteId && event.phase === "completed",
    );

    expect(deleteEvent?.type).toBe("session.command");
    expect(deleteEvent?.phase).toBe("completed");
    expect(durable.some((e) => e.type === "session.exited")).toBe(true);

    const ids = durable.map((e) => BigInt(e.sequence as string));

    expect(ids.length).toBeGreaterThan(400);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i], `event ${i}`).toBeGreaterThan(ids[i - 1]);
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

    const durable = canonicalRuntimeEvents(host, runId);
    const exited = durable.find((e) => e.type === "session.exited");

    expect(exited?.reason).toBe("fenced");
  });
});
