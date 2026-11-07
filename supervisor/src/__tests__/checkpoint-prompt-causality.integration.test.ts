import { afterEach, describe, expect, it } from "vitest";

import {
  bootHost,
  cleanupRuntimeRoot,
  createSession,
  envelope,
  fenceFor,
  postJson,
  waitFor,
  type BootedHost,
} from "./_fixtures/boot-host";

let host: BootedHost | undefined;
const RUN_ID = "checkpoint-prompt-causality";

afterEach(async () => {
  if (!host) return;
  await host.stop();
  await cleanupRuntimeRoot(host.runtimeRoot);
  host = undefined;
});

async function runningPrompt(): Promise<{
  host: BootedHost;
  sessionId: string;
  commandId: string;
}> {
  host = await bootHost({ fixtureArgs: ["--hang-prompt", "--lines", "1"] });
  const { sessionId } = await createSession(host, fenceFor(host, RUN_ID));
  const command = envelope("session.prompt", fenceFor(host, RUN_ID), {
    stepId: "fix",
    prompt: "investigate",
  });
  const admitted = await postJson(
    `${host.url}/sessions/${sessionId}/prompts`,
    command,
  );

  expect(admitted.status).toBe(202);
  const target = host;

  await waitFor(() =>
    target.registry
      .snapshotEvents(sessionId)
      .some((event) => event.type === "session.update"),
  );

  return { host, sessionId, commandId: command.command.id };
}

describe("checkpoint prompt causality", () => {
  it("keeps an explicit adapter rejection even when an outbox checkpoint races it", async () => {
    host = await bootHost({ fixtureArgs: ["--hang"] });
    const target = host;
    const { sessionId } = await createSession(target, fenceFor(target, RUN_ID));
    const entry = target.registry.get(sessionId)!;

    entry.connection!.prompt = async () => {
      target.registry.markIntentionalShutdown(
        sessionId,
        "checkpoint",
        "outbox_pressure",
      );
      throw new Error("adapter rejected bad input");
    };
    const command = envelope("session.prompt", fenceFor(target, RUN_ID), {
      stepId: "fix",
      prompt: "invalid adapter input",
    });

    await postJson(`${target.url}/sessions/${sessionId}/prompts`, command);
    await waitFor(
      () =>
        target.hostState.getReceipt(command.command.id)?.phase === "rejected",
    );
    const body = target.hostState.getReceipt(command.command.id)?.body;

    expect(body).toMatchObject({ code: "ACP_PROTOCOL" });
    expect(body).not.toHaveProperty("details.reason", "session_checkpointed");
    expect(body).toHaveProperty(
      "message",
      expect.stringContaining("adapter rejected bad input"),
    );
  });

  it.each([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ] as const)(
    "classifies an actual %s response from the adapter during checkpoint teardown",
    async (stopReason) => {
      host = await bootHost({
        fixtureArgs: [
          "--complete-on-checkpoint",
          stopReason,
          "--pre-hold-text",
          "ready-for-checkpoint",
          "--lines",
          "1",
        ],
      });
      const target = host;
      const { sessionId } = await createSession(
        target,
        fenceFor(target, RUN_ID),
      );
      const command = envelope("session.prompt", fenceFor(target, RUN_ID), {
        stepId: "fix",
        prompt: "complete during graceful shutdown",
      });

      expect(
        (await postJson(`${target.url}/sessions/${sessionId}/prompts`, command))
          .status,
      ).toBe(202);
      await waitFor(() =>
        target.registry
          .snapshotEvents(sessionId)
          .some((event) => event.type === "session.update"),
      );
      const checkpoint = await postJson(
        `${target.url}/sessions/${sessionId}/checkpoint`,
        envelope("session.checkpoint", fenceFor(target, RUN_ID)),
      );

      expect(checkpoint.status).toBe(200);
      await waitFor(
        () =>
          target.hostState.getReceipt(command.command.id)?.phase !== "accepted",
      );
      expect(target.hostState.getReceipt(command.command.id)).toMatchObject(
        stopReason === "cancelled"
          ? {
              phase: "rejected",
              httpStatus: 500,
              body: {
                code: "CHECKPOINT",
                details: {
                  reason: "session_checkpointed",
                  stopReason: "checkpoint",
                },
              },
            }
          : { phase: "completed", httpStatus: 200, body: { stopReason } },
      );
      expect(target.registry.snapshotEvents(sessionId)).toContainEqual(
        expect.objectContaining({
          type: "session.exited",
          reason: "checkpoint",
        }),
      );
    },
  );

  it("records an intentional checkpoint as a pause rather than ACP_PROTOCOL", async () => {
    const { host, sessionId, commandId } = await runningPrompt();
    const checkpoint = await postJson(
      `${host.url}/sessions/${sessionId}/checkpoint`,
      envelope("session.checkpoint", fenceFor(host, RUN_ID)),
    );

    expect(checkpoint.status).toBe(200);
    await waitFor(
      () => host.hostState.getReceipt(commandId)?.phase === "rejected",
    );
    expect(host.hostState.getReceipt(commandId)?.body).toMatchObject({
      code: "CHECKPOINT",
      details: { reason: "session_checkpointed", stopReason: "checkpoint" },
    });
    expect(host.registry.snapshotEvents(sessionId)).toContainEqual(
      expect.objectContaining({ type: "session.exited", reason: "checkpoint" }),
    );
  });

  it("keeps an unexpected ACP loss as an error with a preceding crash terminal", async () => {
    const { host, sessionId, commandId } = await runningPrompt();

    const adapterPid = host.registry.get(sessionId)!.record.adapterPid;

    if (!adapterPid)
      throw new Error("ACP-loss fixture has no acknowledged adapter process");
    process.kill(adapterPid, "SIGKILL");
    await waitFor(
      () => host.hostState.getReceipt(commandId)?.phase === "rejected",
    );
    expect(host.hostState.getReceipt(commandId)?.body).toMatchObject({
      code: "ACP_PROTOCOL",
    });
    expect(host.registry.snapshotEvents(sessionId)).toContainEqual(
      expect.objectContaining({ type: "session.crashed" }),
    );
    expect(host.registry.snapshotEvents(sessionId)).not.toContainEqual(
      expect.objectContaining({ type: "session.exited", reason: "checkpoint" }),
    );
  });

  it("preserves the guardrail reason in the checkpoint terminal and command receipt", async () => {
    const { host, sessionId, commandId } = await runningPrompt();
    const entry = host.registry.get(sessionId)!;

    entry.record.monotonicId += 1;
    host.registry.emit(sessionId, {
      type: "session.hook_trip",
      sessionId,
      monotonicId: entry.record.monotonicId,
      rule: "no_progress",
      disposition: "halt",
      lifecycle: "post_turn",
      toolCall: null,
    });
    const checkpoint = await postJson(
      `${host.url}/sessions/${sessionId}/checkpoint`,
      envelope("session.checkpoint", fenceFor(host, RUN_ID)),
    );

    expect(checkpoint.status).toBe(200);
    await waitFor(
      () => host.hostState.getReceipt(commandId)?.phase === "rejected",
    );
    expect(host.hostState.getReceipt(commandId)?.body).toMatchObject({
      code: "CHECKPOINT",
      details: { reason: "session_checkpointed", stopReason: "no_progress" },
    });
    expect(host.registry.snapshotEvents(sessionId)).toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        reason: "checkpoint",
        stopReason: "no_progress",
      }),
    );
    const events = host.hostState.runtimeEventsAfter(
      host.hostState.getRuntimeEventStreamId(),
      null,
    );
    const terminalIndex = events.findIndex(
      (event) => event.envelope.eventType === "session.exited",
    );
    const commandIndex = events.findIndex((event) => {
      const payload = event.envelope.payload as {
        commandId?: string;
        phase?: string;
      };

      return (
        event.envelope.eventType === "session.command" &&
        payload.commandId === commandId &&
        payload.phase === "completed"
      );
    });

    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(terminalIndex);
  });
});
