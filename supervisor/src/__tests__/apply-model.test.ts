// T3.2/T3.3 — model application + verification. codex pins via setSessionModel;
// claude is verified only (settings channel); a residual mismatch emits an
// advisory session.update and NEVER fails the run.
import type * as acp from "@agentclientprotocol/sdk";
import type { RunnerLaunch, SessionEvent, SessionRecord } from "../types";

import { EventEmitter } from "node:events";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { applyAndVerifyModel } from "../acp-client";
import { SESSION_EVENT_CHANNEL } from "../registry";

const silent = pino({ level: "silent" });

function runnerFor(adapter: "claude" | "codex", model: string): RunnerLaunch {
  return {
    version: 1,
    runnerId: "r",
    adapter,
    capabilityAgent: adapter,
    model,
    provider: adapter === "codex" ? { kind: "openai" } : { kind: "anthropic" },
    permissionPolicy: "default",
  };
}

function makeRecord(): SessionRecord {
  return {
    sessionId: "s",
    runId: "run",
    projectSlug: "p",
    stepId: "st",
    status: "live",
    pid: 1,
    startedAt: new Date(0).toISOString(),
    logPath: "/tmp/x.log",
    monotonicId: 0,
  };
}

function capture(emitter: EventEmitter): SessionEvent[] {
  const events: SessionEvent[] = [];

  emitter.on(SESSION_EVENT_CHANNEL, (e: SessionEvent) => events.push(e));

  return events;
}

function fakeConnection(
  setModel: ReturnType<typeof vi.fn>,
): acp.ClientSideConnection {
  return {
    unstable_setSessionModel: setModel,
  } as unknown as acp.ClientSideConnection;
}

const state = (currentModelId: string): acp.SessionModelState => ({
  availableModels: [],
  currentModelId,
});

describe("applyAndVerifyModel", () => {
  it("codex mismatch → calls setSessionModel, emits NO advisory", async () => {
    const setModel = vi.fn().mockResolvedValue({});
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: runnerFor("codex", "gpt-5-codex"),
      models: state("gpt-5"),
      acpSessionId: "acp-1",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).toHaveBeenCalledWith({
      sessionId: "acp-1",
      modelId: "gpt-5-codex",
    });
    expect(events).toHaveLength(0);
  });

  it("codex match → no setSessionModel, no advisory", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: runnerFor("codex", "gpt-5"),
      models: state("gpt-5"),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("claude mismatch → no setSessionModel, emits advisory (channel settings_local)", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: runnerFor("claude", "glm-5.1"),
      models: state("claude-sonnet-4-6"),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.update",
      update: {
        sessionUpdate: "model_advisory",
        configuredModel: "glm-5.1",
        observedModelId: "claude-sonnet-4-6",
        channel: "settings_local",
      },
    });
  });

  it("codex setSessionModel failure → emits advisory (channel set_session_model), never throws", async () => {
    const setModel = vi
      .fn()
      .mockRejectedValue(new Error("set model unsupported"));
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await expect(
      applyAndVerifyModel({
        connection: fakeConnection(setModel),
        runner: runnerFor("codex", "gpt-5-codex"),
        models: state("gpt-5"),
        acpSessionId: "a",
        sessionId: "s",
        record: makeRecord(),
        emitter,
        logger: silent,
      }),
    ).resolves.toBeUndefined();

    expect(setModel).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      update: { sessionUpdate: "model_advisory", channel: "set_session_model" },
    });
  });

  it("no runner → no-op regardless of model state", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: undefined,
      models: state("x"),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  // ADR-075 apply-gap: codex pins via setSessionModel, so an adapter that omits
  // currentModelId (null/empty/undefined — version skew) MUST still be pinned;
  // bailing on absent observed would silently run the adapter default.
  it("codex null/empty/undefined currentModelId → applies setSessionModel anyway", async () => {
    const setModel = vi.fn().mockResolvedValue({});
    const emitter = new EventEmitter();
    const events = capture(emitter);
    const base = {
      connection: fakeConnection(setModel),
      runner: runnerFor("codex", "gpt-5-codex"),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    };

    await applyAndVerifyModel({ ...base, models: null });
    await applyAndVerifyModel({ ...base, models: state("") });
    await applyAndVerifyModel({
      ...base,
      models: {
        availableModels: [],
      } as unknown as acp.SessionModelState,
    });

    expect(setModel).toHaveBeenCalledTimes(3);
    expect(setModel).toHaveBeenCalledWith({
      sessionId: "a",
      modelId: "gpt-5-codex",
    });
    expect(events).toHaveLength(0);
  });

  // claude pins ahead of session/new via settings.local.json; this path only
  // VERIFIES. With no observed model there is nothing to verify — stay silent
  // rather than emit an unsubstantiated advisory.
  it("claude null/empty currentModelId → no-op (verify-only, no advisory)", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);
    const base = {
      connection: fakeConnection(setModel),
      runner: runnerFor("claude", "glm-5.1"),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    };

    await applyAndVerifyModel({ ...base, models: null });
    await applyAndVerifyModel({ ...base, models: state("") });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
