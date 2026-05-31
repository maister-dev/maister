import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHeartbeatWatcher } from "../heartbeat";
import { registerRoutes, type SpawnOverrides } from "../http-api";
import { SessionRegistry } from "../registry";

const FIXTURE_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../test/fixtures/mock-acp-lifecycle.mjs",
);
const silentLogger = pino({ level: "silent" });

type BootResult = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  runtimeRoot: string;
  stopHeartbeat: () => void;
};

async function boot(fixtureArgs: string[]): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "supervisor-it-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [FIXTURE_PATH, ...fixtureArgs],
  };

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
    runtimeRoot,
    killGraceMs: 2_000,
    spawnOverrides,
  });

  const stopHeartbeat = startHeartbeatWatcher({
    registry,
    logger: silentLogger,
    intervalMs: 60_000,
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url: address, registry, runtimeRoot, stopHeartbeat };
}

type CreateOpts = { executorEnv?: Record<string, string> };

async function createSession(
  url: string,
  opts: CreateOpts = {},
): Promise<string> {
  const res = await fetch(`${url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "run-int",
      projectSlug: "demo",
      worktreePath: process.cwd(),
      stepId: "step-1",
      executor: {
        agent: "claude",
        model: "claude-sonnet-4-6",
        env: opts.executorEnv,
      },
    }),
  });

  if (res.status !== 201) {
    throw new Error(`POST /sessions failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { sessionId: string };

  return body.sessionId;
}

async function sendPrompt(url: string, sessionId: string): Promise<void> {
  const res = await fetch(`${url}/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stepId: "step-1", prompt: "hello" }),
  });

  if (res.status !== 200) {
    throw new Error(
      `POST /sessions/${sessionId}/prompt failed: ${res.status} ${await res.text()}`,
    );
  }
}

async function collectSSE(
  streamUrl: string,
  maxMs = 4_000,
): Promise<Array<{ event: string; data: unknown; id?: string }>> {
  const events: Array<{ event: string; data: unknown; id?: string }> = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxMs);

  try {
    const res = await fetch(streamUrl, { signal: controller.signal });

    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentId: string | undefined;
    let currentEvent = "";
    let currentData = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");

      while (nl !== -1) {
        const line = buffer.slice(0, nl);

        buffer = buffer.slice(nl + 1);
        if (line === "") {
          if (currentData) {
            events.push({
              event: currentEvent,
              data: JSON.parse(currentData),
              id: currentId,
            });
            currentData = "";
            currentEvent = "";
            currentId = undefined;
          }
        } else if (line.startsWith("id:")) {
          currentId = line.slice(3).trim();
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trimStart();

          currentData = currentData ? `${currentData}\n${chunk}` : chunk;
        }
        nl = buffer.indexOf("\n");
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }

  return events;
}

let booted: BootResult | null = null;

async function bootFor(fixtureArgs: string[]): Promise<BootResult> {
  booted = await boot(fixtureArgs);

  return booted;
}

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    booted.stopHeartbeat();
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
});

describe("supervisor lifecycle integration", () => {
  it("GET /health reports readiness and session status counts", async () => {
    const { url, registry } = await bootFor(["--hang"]);
    const emptyRes = await fetch(`${url}/health`);

    expect(emptyRes.status).toBe(200);
    const empty = (await emptyRes.json()) as {
      status: string;
      version: string;
      uptimeMs: number;
      checkedAt: string;
      sessions: { live: number; exited: number; crashed: number };
      runId?: string;
      projectSlug?: string;
      worktreePath?: string;
      logPath?: string;
    };

    expect(empty.status).toBe("ready");
    expect(empty.version).toMatch(/\d+\.\d+\.\d+/);
    expect(empty.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(empty.checkedAt))).toBe(false);
    expect(empty.sessions).toEqual({ live: 0, exited: 0, crashed: 0 });
    expect(empty.runId).toBeUndefined();
    expect(empty.projectSlug).toBeUndefined();
    expect(empty.worktreePath).toBeUndefined();
    expect(empty.logPath).toBeUndefined();

    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);

    registry.register(
      {
        sessionId: "health-live-session",
        runId: "run-health",
        projectSlug: "demo",
        stepId: "step-1",
        status: "live",
        pid: child.pid ?? 0,
        startedAt: new Date().toISOString(),
        logPath: "/tmp/health-live-session.log",
        monotonicId: 0,
      },
      child,
      new EventEmitter(),
    );

    const liveRes = await fetch(`${url}/health`);
    const live = (await liveRes.json()) as typeof empty;

    expect(live.sessions).toEqual({ live: 1, exited: 0, crashed: 0 });
  });

  it("POST /sessions returns 201 with sessionId+pid; GET /sessions lists it", async () => {
    const { url } = await bootFor(["--hang"]);
    const sessionId = await createSession(url);

    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    const listed = (await (await fetch(`${url}/sessions`)).json()) as unknown[];

    expect(listed.length).toBe(1);
  });

  it("SSE stream emits N line events then session.exited (clean exit)", async () => {
    const { url } = await bootFor(["--lines", "3", "--emit-usage"]);
    const sessionId = await createSession(url);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(url, sessionId);

    const events = await eventPromise;
    const lines = events.filter((e) => e.event === "session.update");
    const terminal = events.find((e) => e.event === "session.exited");

    expect(lines).toHaveLength(3);
    expect(terminal).toBeDefined();
    expect(Number(lines[0].id)).toBeLessThan(Number(lines[1].id));
    expect(Number(lines[1].id)).toBeLessThan(Number(lines[2].id));
  });

  it("session.crashed when fixture exits non-zero", async () => {
    const { url } = await bootFor(["--lines", "1", "--exit-code", "1"]);
    const sessionId = await createSession(url);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(url, sessionId);

    const events = await eventPromise;
    const crashed = events.find((e) => e.event === "session.crashed");

    expect(crashed).toBeDefined();
    expect((crashed?.data as { exitCode: number }).exitCode).toBe(1);
  });

  it("DELETE /sessions/:id returns 204 and the child exits", async () => {
    const { url, registry } = await bootFor(["--hang"]);
    const sessionId = await createSession(url);
    const res = await fetch(`${url}/sessions/${sessionId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    await new Promise<void>((r) => setTimeout(r, 200));
    const entry = registry.get(sessionId);

    expect(
      entry === undefined ||
        entry.record.status === "exited" ||
        entry.record.status === "crashed",
    ).toBe(true);
  });

  it("POST /sessions with malformed body returns 409 PRECONDITION", async () => {
    const { url } = await bootFor(["--lines", "0"]);
    const res = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };

    expect(body.code).toBe("PRECONDITION");
  });

  // M7 input route tests live in permission-roundtrip.integration.test.ts —
  // they use a bypass-spawn boot to avoid the fake-acp.mjs adapter (which
  // does not speak the ACP protocol).

  it("POST /sessions/:id/checkpoint on unknown session returns 404 (M8)", async () => {
    const { url } = await bootFor(["--hang"]);
    const res = await fetch(`${url}/sessions/unknown-checkpoint/checkpoint`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  it("DELETE for unknown session returns 404", async () => {
    const { url } = await bootFor(["--hang"]);
    const res = await fetch(`${url}/sessions/unknown-id`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("logs do NOT contain the sentinel ANTHROPIC_AUTH_TOKEN value", async () => {
    const sentinel = "sk-test-redact-sentinel";
    const { url, runtimeRoot } = await bootFor(["--lines", "2"]);
    const sessionId = await createSession(url, {
      executorEnv: { ANTHROPIC_AUTH_TOKEN: sentinel },
    });
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(url, sessionId);
    await eventPromise;

    const logPath = `${runtimeRoot}/.maister/demo/runs/run-int/step-1.log`;
    const logContents = await readFile(logPath, "utf8");

    expect(logContents).not.toContain(sentinel);
  });
});
