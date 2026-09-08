// T3.2/T3.3 — model application + verification. codex pins via the ACP 1.x
// session/set_config_option call on the adapter's "model" select;
// claude is verified only (settings channel); a residual mismatch emits an
// advisory session.update and NEVER fails the run.
import type * as acp from "@agentclientprotocol/sdk";
import type { SessionModelView } from "../session-models";
import type { RunnerLaunch, SessionEvent, SessionRecord } from "../types";

import { EventEmitter } from "node:events";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { applyAndVerifyModel } from "../acp-client";
import { SESSION_EVENT_CHANNEL } from "../registry";

const silent = pino({ level: "silent" });

function runnerFor(
  adapter: "claude" | "codex" | "gemini" | "opencode" | "mimo",
  model: string,
): RunnerLaunch {
  const provider =
    adapter === "codex"
      ? { kind: "openai" as const }
      : adapter === "gemini"
        ? { kind: "google_gemini" as const, apiKeyEnv: "GEMINI_API_KEY" }
        : adapter === "opencode" || adapter === "mimo"
          ? { kind: "agent_native" as const }
          : { kind: "anthropic" as const };

  return {
    version: 1,
    runnerId: "r",
    adapter,
    capabilityAgent: adapter,
    model,
    provider,
    permissionPolicy: "default",
  };
}

function makeRecord(): SessionRecord {
  return {
    sessionId: "s",
    adapter: "claude",
    runId: "run",
    projectSlug: "p",
    stepId: "st",
    sessionName: "default",
    status: "live",
    pid: 1,
    startedAt: new Date(0).toISOString(),
    logPath: "/tmp/x.log",
    worktreePath: "/tmp/x-wt",
    executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
    assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
    assignmentEpoch: 1,
    createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
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
    setSessionConfigOption: setModel,
  } as unknown as acp.ClientSideConnection;
}

const state = (
  currentModelId: string | null,
  configId: string | null = "model",
): SessionModelView => ({
  configId,
  currentModelId,
  availableModels: [],
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
      configId: "model",
      value: "gpt-5-codex",
    });
    expect(events).toHaveLength(0);
  });

  it("codex mismatch without a model config option → advisory (channel set_session_model), no call", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: runnerFor("codex", "gpt-5-codex"),
      models: state("gpt-5", null),
      acpSessionId: "acp-1",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      update: { sessionUpdate: "model_advisory", channel: "set_session_model" },
    });
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

  // ADR-076 apply-gap: codex pins via setSessionModel, so an adapter that omits
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

    await applyAndVerifyModel({ ...base, models: state(null) });
    await applyAndVerifyModel({ ...base, models: state("") });
    await applyAndVerifyModel({
      ...base,
      models: {
        configId: "model",
        availableModels: [],
      } as unknown as SessionModelView,
    });

    expect(setModel).toHaveBeenCalledTimes(3);
    expect(setModel).toHaveBeenCalledWith({
      sessionId: "a",
      configId: "model",
      value: "gpt-5-codex",
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

    await applyAndVerifyModel({ ...base, models: state(null) });
    await applyAndVerifyModel({ ...base, models: state("") });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("Gemini and OpenCode mismatches emit advisory without setSessionModel", async () => {
    const setModel = vi.fn();
    const emitter = new EventEmitter();
    const events = capture(emitter);
    const base = {
      connection: fakeConnection(setModel),
      acpSessionId: "a",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    };

    await applyAndVerifyModel({
      ...base,
      runner: runnerFor("gemini", "gemini-3-pro"),
      models: state("gemini-3-flash"),
    });
    await applyAndVerifyModel({
      ...base,
      runner: runnerFor("opencode", "opencode-default"),
      models: state("opencode-other"),
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === "session.update")
        .map((event) => event.update),
    ).toEqual([
      expect.objectContaining({ channel: "advisory" }),
      expect.objectContaining({ channel: "advisory" }),
    ]);
  });

  // MiMo's ACP adapter exposes a "model" config option (proven by live smoke),
  // so it pins via set_config_option exactly like codex — no advisory on mismatch.
  it("MiMo mismatch → calls setSessionModel, emits NO advisory", async () => {
    const setModel = vi.fn().mockResolvedValue({});
    const emitter = new EventEmitter();
    const events = capture(emitter);

    await applyAndVerifyModel({
      connection: fakeConnection(setModel),
      runner: runnerFor("mimo", "xiaomi/mimo-v2.5-pro"),
      models: state("xiaomi/mimo-v2.5-pro-ultraspeed"),
      acpSessionId: "acp-1",
      sessionId: "s",
      record: makeRecord(),
      emitter,
      logger: silent,
    });

    expect(setModel).toHaveBeenCalledWith({
      sessionId: "acp-1",
      configId: "model",
      value: "xiaomi/mimo-v2.5-pro",
    });
    expect(events).toHaveLength(0);
  });
});
