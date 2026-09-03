import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SupervisorDiagnosticsResponseSchema } from "../types";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const RUN_ID = "run-int";

function boot(fixtureArgs: string[]): Promise<BootedHost> {
  return bootHost({ fixtureArgs });
}

type CreateOpts = { executorEnv?: Record<string, string> };

async function createSession(
  host: BootedHost,
  opts: CreateOpts = {},
): Promise<string> {
  const res = await postJson(
    `${host.url}/sessions`,
    await createEnvelope(
      host,
      { runId: RUN_ID },
      {
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: opts.executorEnv,
        },
      },
    ),
  );

  if (res.status !== 201) {
    throw new Error(
      `POST /sessions failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return (res.body as { sessionId: string }).sessionId;
}

async function sendPrompt(host: BootedHost, sessionId: string): Promise<void> {
  const res = await postJson(
    `${host.url}/sessions/${sessionId}/prompt`,
    envelope("session.prompt", fenceFor(host, RUN_ID), {
      stepId: "step-1",
      prompt: "hello",
    }),
  );

  if (res.status !== 200) {
    throw new Error(
      `POST /sessions/${sessionId}/prompt failed: ${res.status} ${JSON.stringify(res.body)}`,
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

let booted: BootedHost | null = null;

async function bootFor(fixtureArgs: string[]): Promise<BootedHost> {
  booted = await boot(fixtureArgs);

  return booted;
}

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
    booted = null;
  }
});

describe("supervisor lifecycle integration", () => {
  it("GET /health reports readiness and session status counts", async () => {
    const host = await bootFor(["--hang"]);
    const { url, registry } = host;
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
        adapter: "claude",
        runId: "run-health",
        projectSlug: "demo",
        stepId: "step-1",
        sessionName: "default",
        status: "live",
        pid: child.pid ?? 0,
        startedAt: new Date().toISOString(),
        logPath: "/tmp/health-live-session.log",
        worktreePath: "/tmp/health-live-session-wt",
        executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
        assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
        assignmentEpoch: 1,
        createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
        monotonicId: 0,
      },
      child,
      new EventEmitter(),
    );

    const liveRes = await fetch(`${url}/health`);
    const live = (await liveRes.json()) as typeof empty;

    expect(live.sessions).toEqual({ live: 1, exited: 0, crashed: 0 });
  });

  it("GET /diagnostics reports adapters and env-ref presence without secret values", async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousEnvRefs = process.env.MAISTER_DIAGNOSTIC_ENV_REFS;

    process.env.GEMINI_API_KEY = "gemini-secret";
    process.env.MAISTER_DIAGNOSTIC_ENV_REFS = "CUSTOM_RUNNER_TOKEN";
    const host = await bootFor(["--hang"]);
    const { url } = host;
    let res: Response;

    try {
      res = await fetch(`${url}/diagnostics`);
    } finally {
      if (previousGemini === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousGemini;
      }
      if (previousEnvRefs === undefined) {
        delete process.env.MAISTER_DIAGNOSTIC_ENV_REFS;
      } else {
        process.env.MAISTER_DIAGNOSTIC_ENV_REFS = previousEnvRefs;
      }
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      adapters: Array<{
        id: string;
        binary: string;
        source: string;
        path: string | null;
        available: boolean;
        version: string | null;
        error: string | null;
        smoke: {
          status: string;
          reason: string | null;
          checkedAt: string | null;
          protocolVersion: number | null;
        };
      }>;
      envRefs: Array<{ name: string; present: boolean; value?: string }>;
    };

    expect(body.status).toBe("ready");
    expect(body.adapters.map((item) => item.id).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "mimo",
      "opencode",
    ]);
    for (const adapter of body.adapters) {
      expect(adapter.source).toMatch(/^(path|override)$/);
      expect(typeof adapter.available).toBe("boolean");
      expect(adapter).toHaveProperty("path");
      expect(adapter).toHaveProperty("version");
      expect(adapter).toHaveProperty("error");
      expect(adapter).toHaveProperty("smoke");
    }
    expect(
      body.adapters.find((item) => item.id === "gemini")?.smoke,
    ).toMatchObject({
      status: "pending",
      reason: "gemini ACP compatibility smoke has not been cached",
    });
    expect(
      body.adapters.find((item) => item.id === "opencode")?.smoke,
    ).toMatchObject({
      status: "pending",
      reason: "opencode ACP compatibility smoke has not been cached",
    });
    expect(
      body.adapters.find((item) => item.id === "mimo")?.smoke,
    ).toMatchObject({
      status: "pending",
      reason: "mimo ACP compatibility smoke has not been cached",
    });
    expect(body.envRefs).toContainEqual({
      name: "GEMINI_API_KEY",
      present: true,
    });
    expect(body.envRefs).toContainEqual({
      name: "CUSTOM_RUNNER_TOKEN",
      present: false,
    });
    expect(JSON.stringify(body)).not.toContain("diagnostic-secret");
    expect(JSON.stringify(body)).not.toContain("gemini-secret");
  });

  it("GET /diagnostics emits a schema-valid nested stale reason", async () => {
    const host = await bootFor(["--hang"]);
    const { url, runtimeRoot } = host;

    await writeFile(
      join(runtimeRoot, "adapter-smoke-cache.json"),
      JSON.stringify({
        version: 1,
        adapters: {
          opencode: {
            status: "ok",
            checkedAt: "2020-01-01T00:00:00.000Z",
            readOnlySession: {
              status: "ok",
              checkedAt: "2020-01-01T00:00:00.000Z",
              protocolVersion: 1,
            },
          },
        },
      }),
      "utf8",
    );

    const response = await fetch(`${url}/diagnostics`);
    const body = await response.json();
    const parsed = SupervisorDiagnosticsResponseSchema.parse(body);
    const opencode = parsed.adapters.find(
      (adapter) => adapter.id === "opencode",
    );

    expect(opencode?.smoke.readOnlySession).toMatchObject({
      status: "stale",
      staleReason: "probe_contract",
    });
  });

  it("POST /sessions returns 201 with sessionId+pid; GET /sessions lists it", async () => {
    const host = await bootFor(["--hang"]);
    const { url } = host;
    const sessionId = await createSession(host);

    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    const listed = (await (await fetch(`${url}/sessions`)).json()) as unknown[];

    expect(listed.length).toBe(1);
  });

  it("SSE stream emits N line events then session.exited (clean exit)", async () => {
    const host = await bootFor(["--lines", "3", "--emit-usage"]);
    const { url } = host;
    const sessionId = await createSession(host);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);

    const events = await eventPromise;
    const lines = events.filter((e) => e.event === "session.update");
    const terminal = events.find((e) => e.event === "session.exited");

    expect(lines).toHaveLength(3);
    expect(terminal).toBeDefined();
    expect(Number(lines[0].id)).toBeLessThan(Number(lines[1].id));
    expect(Number(lines[1].id)).toBeLessThan(Number(lines[2].id));
  });

  it("session.crashed when fixture exits non-zero", async () => {
    const host = await bootFor(["--lines", "1", "--exit-code", "1"]);
    const { url } = host;
    const sessionId = await createSession(host);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);

    const events = await eventPromise;
    const crashed = events.find((e) => e.event === "session.crashed");

    expect(crashed).toBeDefined();
    expect((crashed?.data as { exitCode: number }).exitCode).toBe(1);
  });

  it("DELETE /sessions/:id returns 204 and the child exits", async () => {
    const host = await bootFor(["--hang"]);
    const { url, registry } = host;
    const sessionId = await createSession(host);
    const res = await postJson(
      `${url}/sessions/${sessionId}`,
      envelope("session.delete", fenceFor(host, RUN_ID), {}),
      "DELETE",
    );

    expect(res.status).toBe(204);
    await new Promise<void>((r) => setTimeout(r, 200));
    const entry = registry.get(sessionId);

    expect(
      entry === undefined ||
        entry.record.status === "exited" ||
        entry.record.status === "crashed",
    ).toBe(true);
  });

  it("POST /sessions returns 503 and cleans up when ACP newSession hangs", async () => {
    const previousTimeout = process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS;

    process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS = "500";

    try {
      const host = await bootFor(["--hang-new-session"]);
      const { url, registry } = host;
      const res = await postJson(
        `${url}/sessions`,
        await createEnvelope(host, { runId: RUN_ID }),
      );

      expect(res.status).toBe(503);
      const body = res.body as { code: string; message: string };

      expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
      expect(body.message).toContain("newSession");
      expect(body.message).toContain("timed out");
      expect(registry.size()).toBe(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("POST /sessions with a bare (unenveloped) body returns 409 PRECONDITION", async () => {
    const host = await bootFor(["--lines", "0"]);
    const { url } = host;
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
    const host = await bootFor(["--hang"]);
    const { url } = host;
    // The body is validated before the session lookup, so the envelope must be
    // well-formed for the 404 to be reachable.
    const res = await postJson(
      `${url}/sessions/unknown-checkpoint/checkpoint`,
      envelope("session.checkpoint", fenceFor(host, RUN_ID), {}),
    );

    expect(res.status).toBe(404);
  });

  it("DELETE for unknown session returns 404", async () => {
    const host = await bootFor(["--hang"]);
    const { url } = host;
    const res = await fetch(`${url}/sessions/unknown-id`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("logs do NOT contain the sentinel ANTHROPIC_AUTH_TOKEN value", async () => {
    const sentinel = "sk-test-redact-sentinel";
    const host = await bootFor(["--lines", "2"]);
    const { url, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      executorEnv: { ANTHROPIC_AUTH_TOKEN: sentinel },
    });
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);
    await eventPromise;

    const logPath = `${runtimeRoot}/.maister/demo/runs/run-int/step-1.log`;
    const logContents = await readFile(logPath, "utf8");

    expect(logContents).not.toContain(sentinel);
  });
});
