import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCcrManager } from "../ccr-manager";
import { registerRoutes } from "../http-api";
import { SessionRegistry } from "../registry";

const silentLogger = pino({ level: "silent" });

type Boot = {
  app: FastifyInstance;
  url: string;
  runtimeRoot: string;
};

async function boot(configPath: string): Promise<Boot> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "supervisor-ccr-e2e-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });

  const ccrManager = createCcrManager({
    configPath,
    logger: silentLogger,
  });

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
    runtimeRoot,
    killGraceMs: 2_000,
    spawnOverrides: { ccrManager },
  });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url, runtimeRoot };
}

let active: Boot | null = null;

beforeEach(() => {
  active = null;
});

afterEach(async () => {
  if (active) {
    await active.app.close();
    await rm(active.runtimeRoot, { recursive: true, force: true });
  }
});

describe("POST /sessions — router=ccr config missing → 503 EXECUTOR_UNAVAILABLE", () => {
  it("returns 503 with EXECUTOR_UNAVAILABLE code and docs pointer when CCR config file is missing", async () => {
    const missingConfigPath = join(
      tmpdir(),
      `nope-ccr-${Date.now()}`,
      "config.json",
    );

    active = await boot(missingConfigPath);

    const res = await fetch(`${active.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-ccr-1",
        projectSlug: "demo",
        worktreePath: process.cwd(),
        stepId: "step-1",
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
        },
      }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; message?: string };

    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(body.message).toMatch(/CCR config not found/);
    expect(body.message).toMatch(
      /docs\/system-analytics\/executors\.md#ccr-setup/,
    );
  });

  it("router=ccr config missing + no MAISTER_CCR_AUTH_TOKEN → still 503 with the config-missing message (ensureRunning fails first)", async () => {
    delete process.env.MAISTER_CCR_AUTH_TOKEN;

    const missingConfigPath = join(
      tmpdir(),
      `nope-ccr-${Date.now()}`,
      "config.json",
    );

    active = await boot(missingConfigPath);

    const res = await fetch(`${active.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-ccr-2",
        projectSlug: "demo",
        worktreePath: process.cwd(),
        stepId: "step-1",
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
        },
      }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; message?: string };

    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    // CCR config missing fires first — ensureRunning throws before the
    // ANTHROPIC_AUTH_TOKEN guard runs.
    expect(body.message).toMatch(/CCR config not found/);
  });
});
