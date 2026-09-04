// T5.3 — model application + advisory through the full POST /sessions → spawn →
// ACP handshake path. The mock adapter (mock-acp-models.mjs) advertises
// currentModelId "glm-5.1" on session/new. A claude runner whose configured
// model differs is verified via the settings channel here, so the supervisor
// emits a model_advisory session.update (informational, never fails the run);
// a matching model emits none. Asserted against the host's durable outbox,
// which is the only execution-event replay source in Stage B.
import type { RunnerLaunch } from "../types";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { modelCatalogCache } from "../model-catalog/cache";
import { draftFromRunner } from "../model-catalog/harvest";
import type { RuntimeEventEnvelope } from "../runtime-events";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

function boot(): Promise<BootedHost> {
  return bootHost({ fixture: "mock-acp-models.mjs" });
}

async function createSession(host: BootedHost, model: string) {
  return postJson(
    `${host.url}/sessions`,
    await createEnvelope(
      host,
      { runId: "run-adv" },
      {
        executor: { agent: "claude", model },
        runner: {
          version: 1,
          runnerId: "r-adv",
          adapter: "claude",
          capabilityAgent: "claude",
          model,
          provider: { kind: "anthropic" },
          permissionPolicy: "default",
        },
      },
    ),
  );
}

async function readEvents(
  host: BootedHost,
  runId: string,
  maxMs = 5_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + maxMs;

  for (;;) {
    const streamId = host.hostState.getRuntimeEventStreamId();
    const events = host.hostState
      .runtimeEventsAfter(streamId, null, 500)
      .map((row) => row.envelope as RuntimeEventEnvelope)
      .filter((event) => event.runId === runId)
      .map((event) => ({ ...event.payload, type: event.eventType }));

    if (events.length > 0) return events;
    if (Date.now() > deadline) return [];
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

function advisoryOf(
  events: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return events.find((e) => {
    const update = e.update as { sessionUpdate?: string } | undefined;

    return (
      e.type === "session.update" && update?.sessionUpdate === "model_advisory"
    );
  });
}

let booted: BootedHost | null = null;

beforeEach(async () => {
  process.env.MOCK_ACP_MODELS_MODE = "ok";
  booted = await boot();
});

afterEach(async () => {
  if (booted) {
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
    booted = null;
  }
  delete process.env.MOCK_ACP_MODELS_MODE;
});

describe("T5.3 — configured model application + advisory", () => {
  it("emits a model_advisory session.update when the configured model differs (mismatch is non-fatal)", async () => {
    if (!booted) throw new Error("not booted");

    // mock advertises currentModelId "glm-5.1"; configure a different model.
    const res = await createSession(booted, "glm-5-turbo");

    expect(res.status).toBe(201);

    const events = await readEvents(booted, "run-adv");
    const advisory = advisoryOf(events);

    expect(advisory).toBeDefined();
    expect(advisory?.update).toMatchObject({
      sessionUpdate: "model_advisory",
      configuredModel: "glm-5-turbo",
      observedModelId: "glm-5.1",
      channel: "settings_local",
    });
    // The run was NOT failed — the session spawned successfully (201) and the
    // event is a session.update, not session.crashed.
    const terminal = events.find(
      (e) => e.type === "session.crashed",
    );

    expect(terminal).toBeUndefined();
  });

  it("emits NO advisory when the configured model matches the adapter", async () => {
    if (!booted) throw new Error("not booted");

    const res = await createSession(booted, "glm-5.1");

    expect(res.status).toBe(201);
    // Give the handshake a beat, then confirm no advisory was written.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(advisoryOf(await readEvents(booted, "run-adv"))).toBeUndefined();
  });
});

// T3.2 resumed-session regression: every resume is a fresh adapter process, so
// application + harvest must also run on the `session/resume` response. codex
// pins via unstable_setSessionModel; the mock adapter does not implement it
// (SDK answers methodNotFound), so the attempted apply on the RESUMED session
// deterministically degrades to the advisory — observable proof the resume
// path invoked applyAndVerifyModel with the resume response's model state.
describe("T3.2 — resumed-session model application + harvest (codex)", () => {
  // Plain `openai` provider: `openai_compatible` is refused by
  // provisionRunnerLaunch before spawn (requires Codex profile
  // materialization), which is out of scope for this resume regression.
  const codexRunner: RunnerLaunch = {
    version: 1,
    runnerId: "r-resume",
    adapter: "codex",
    capabilityAgent: "codex",
    model: "glm-5-turbo",
    provider: { kind: "openai" },
    permissionPolicy: "default",
  };

  it("applies the configured model and harvests models on session/resume (advisory is non-fatal)", async () => {
    if (!booted) throw new Error("not booted");

    const res = await postJson(
      `${booted.url}/sessions`,
      await createEnvelope(
        booted,
        { runId: "run-resume" },
        {
          resumeSessionId: "prior-acp-session-id",
          executor: { agent: "codex", model: codexRunner.model },
          runner: codexRunner,
        },
      ),
    );

    expect(res.status).toBe(201);

    const events = await readEvents(booted, "run-resume");
    const advisory = advisoryOf(events);

    expect(advisory).toBeDefined();
    expect(advisory?.update).toMatchObject({
      sessionUpdate: "model_advisory",
      configuredModel: "glm-5-turbo",
      observedModelId: "glm-5.1",
      channel: "set_session_model",
    });
    expect(
      events.find((e) => e.type === "session.crashed"),
    ).toBeUndefined();

    // Passive harvest of ResumeSessionResponse.models into the shared cache.
    const harvested = modelCatalogCache.get(draftFromRunner(codexRunner));

    expect(harvested?.models.map((m) => m.id).sort()).toEqual([
      "glm-5",
      "glm-5.1",
    ]);
    expect(harvested?.models[0]?.origins).toEqual(["agent_observed"]);
    expect(harvested?.sources).toEqual([
      { kind: "agent_observed", status: "ok", count: 2 },
    ]);
  });
});
