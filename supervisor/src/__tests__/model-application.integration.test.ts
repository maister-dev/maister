// T5.3 — model application + advisory through the full POST /sessions → spawn →
// ACP handshake path. The mock adapter (mock-acp-models.mjs) advertises
// currentModelId "glm-5.1" on session/new. A claude runner whose configured
// model differs is verified via the settings channel here, so the supervisor
// emits a model_advisory session.update (informational, never fails the run);
// a matching model emits none. Asserted against the durable run.events.jsonl.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerLaunch } from "../types";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRoutes, type SpawnOverrides } from "../http-api";
import { modelCatalogCache } from "../model-catalog/cache";
import { draftFromRunner } from "../model-catalog/harvest";
import { SessionRegistry } from "../registry";

const FIXTURE_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../test/fixtures/mock-acp-models.mjs",
);
const silent = pino({ level: "silent" });

type BootResult = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  runtimeRoot: string;
};

async function boot(): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "supervisor-model-app-"));
  const registry = new SessionRegistry(silent);
  const app = Fastify({ logger: false });
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [FIXTURE_PATH],
  };

  registerRoutes({
    app,
    registry,
    logger: silent,
    runtimeRoot,
    killGraceMs: 2_000,
    spawnOverrides,
  });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url, registry, runtimeRoot };
}

async function createSession(url: string, model: string): Promise<Response> {
  return fetch(`${url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "run-adv",
      projectSlug: "demo",
      worktreePath: process.cwd(),
      stepId: "step-1",
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
    }),
  });
}

async function readEvents(
  eventsPath: string,
  maxMs = 5_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + maxMs;

  for (;;) {
    try {
      const text = await readFile(eventsPath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);

      if (lines.length > 0) return lines.map((l) => JSON.parse(l));
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) return [];
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

function advisoryOf(
  events: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return events.find((e) => {
    const update = e.update as { sessionUpdate?: string } | undefined;

    return e.type === "session.update" && update?.sessionUpdate === "model_advisory";
  });
}

let booted: BootResult | null = null;

beforeEach(async () => {
  process.env.MOCK_ACP_MODELS_MODE = "ok";
  booted = await boot();
});

afterEach(async () => {
  if (booted) {
    booted.registry.forEach((entry) => {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    });
    await booted.app.close();
    await rm(booted.runtimeRoot, { recursive: true, force: true });
    booted = null;
  }
  delete process.env.MOCK_ACP_MODELS_MODE;
});

describe("T5.3 — configured model application + advisory", () => {
  it("emits a model_advisory session.update when the configured model differs (mismatch is non-fatal)", async () => {
    if (!booted) throw new Error("not booted");
    const eventsPath = join(
      booted.runtimeRoot,
      ".maister/demo/runs/run-adv/run.events.jsonl",
    );

    // mock advertises currentModelId "glm-5.1"; configure a different model.
    const res = await createSession(booted.url, "glm-5-turbo");

    expect(res.status).toBe(201);

    const advisory = advisoryOf(await readEvents(eventsPath));

    expect(advisory).toBeDefined();
    expect(advisory?.update).toMatchObject({
      sessionUpdate: "model_advisory",
      configuredModel: "glm-5-turbo",
      observedModelId: "glm-5.1",
      channel: "settings_local",
    });
    // The run was NOT failed — the session spawned successfully (201) and the
    // event is a session.update, not session.crashed.
    const terminal = (await readEvents(eventsPath)).find(
      (e) => e.type === "session.crashed",
    );

    expect(terminal).toBeUndefined();
  });

  it("emits NO advisory when the configured model matches the adapter", async () => {
    if (!booted) throw new Error("not booted");
    const eventsPath = join(
      booted.runtimeRoot,
      ".maister/demo/runs/run-adv/run.events.jsonl",
    );

    const res = await createSession(booted.url, "glm-5.1");

    expect(res.status).toBe(201);
    // Give the handshake a beat, then confirm no advisory was written.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(advisoryOf(await readEvents(eventsPath))).toBeUndefined();
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
    const eventsPath = join(
      booted.runtimeRoot,
      ".maister/demo/runs/run-resume/run.events.jsonl",
    );

    const res = await fetch(`${booted.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-resume",
        projectSlug: "demo",
        worktreePath: process.cwd(),
        stepId: "step-1",
        resumeSessionId: "prior-acp-session-id",
        executor: { agent: "codex", model: codexRunner.model },
        runner: codexRunner,
      }),
    });

    expect(res.status).toBe(201);

    const advisory = advisoryOf(await readEvents(eventsPath));

    expect(advisory).toBeDefined();
    expect(advisory?.update).toMatchObject({
      sessionUpdate: "model_advisory",
      configuredModel: "glm-5-turbo",
      observedModelId: "glm-5.1",
      channel: "set_session_model",
    });
    expect(
      (await readEvents(eventsPath)).find((e) => e.type === "session.crashed"),
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
