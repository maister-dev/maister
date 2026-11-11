import type { RegistryEntry } from "../registry";

import childProcess, { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  signalOwnedSessionProcess,
  waitForChildExit,
} from "../execution-fence";
import { captureAcpFrames } from "../bounded-acp-stream";
import {
  SupervisorDiagnosticsResponseSchema,
  type SupervisorError,
} from "../types";
import { stopRegisteredSessions } from "../shutdown";

import {
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  createEnvelope,
  envelope,
  fenceFor,
  postJson,
  silentLogger,
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
  const res = await completePrompt(
    host,
    sessionId,
    envelope("session.prompt", fenceFor(host, RUN_ID), {
      stepId: "step-1",
      prompt: "hello",
    }),
  );

  if (res.status !== 200) {
    throw new Error(
      `asynchronous prompt ${sessionId} failed: ${res.status} ${JSON.stringify(res.body)}`,
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
  it("preserves unread stdout when a child exits while its first frame is being consumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "maister-exit-drain-"));
    const logPath = join(root, "stdout.log");
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      'process.stdout.write("first\\n"); process.stdin.once("data", () => process.stdout.write("last\\n", () => process.exit(0)));',
    ]);
    const exited = once(child, "exit");
    const lines: string[] = [];
    const failures: SupervisorError[] = [];
    const captured = captureAcpFrames({
      source: child.stdout,
      directory: root,
      log: createWriteStream(logPath),
      onLine: (line) => lines.push(line),
      onFailure: (error) => failures.push(error),
      onDrained: () => {},
    });
    const iterator = captured[Symbol.asyncIterator]();

    try {
      expect((await iterator.next()).done).toBe(false);
      // The last bytes are flushed by the real child while the consumer holds
      // the first frame. Node resumes child stdio on exit even in this gap.
      child.stdin.end("exit\n");
      await exited;
      await nextTurn();
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(true);
      expect(failures).toEqual([]);
      expect(lines).toEqual(["first", "last"]);
      expect(await readFile(logPath, "utf8")).toBe("first\nlast\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      await iterator.return?.();
      await cleanupRuntimeRoot(root);
    }
  });

  it("shutdown escalates a TERM-resistant child and awaits durable terminal output", async () => {
    const host = await bootFor(["--exit-delay-ms", "60000"]);
    const sessionId = await createSession(host);
    const entry = host.registry.get(sessionId)!;

    // The journalled group contains gate and adapter. Keep a bounded drain
    // budget under the full parallel suite; the adapter resists TERM for 60s.
    await stopRegisteredSessions(host.registry, silentLogger, 250);
    expect(entry.child.signalCode).toBe("SIGKILL");
    expect(entry.record.terminalPublished).toBe(true);
    expect(entry.record.outputTerminal).toBeDefined();
    await entry.record.outputDrained;
    await entry.record.outputTerminal;
    expect(() => process.kill(entry.record.pid, 0)).toThrow();
    const inventory = await fetch(`${host.url}/sessions?runId=${RUN_ID}`);

    expect(inventory.status).toBe(200);
    expect(inventory.headers.get("x-maister-session-ownership-version")).toBe(
      "1",
    );
  });
  it("keeps exit and checkpoint acknowledgment behind the captured-output barrier", async () => {
    const host = await bootFor(["--hang", "--lines", "0"]);
    const sessionId = await createSession(host);
    const entry = host.registry.get(sessionId)!;
    const captured = entry.record.outputDrained;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    entry.record.outputDrained = Promise.all([captured, gate]).then(() => {});
    const exited = once(entry.child, "exit");

    entry.child.kill("SIGTERM");
    try {
      await exited;
      await captured;
      expect(
        host.registry
          .snapshotEvents(sessionId)
          .some(
            (event) =>
              event.type === "session.exited" ||
              event.type === "session.crashed",
          ),
      ).toBe(false);
      expect(await waitForChildExit(entry, 20)).toBe(false);
    } finally {
      release();
    }
    await entry.record.outputTerminal;
    expect(await waitForChildExit(entry, 1000)).toBe(true);
    expect(host.registry.snapshotEvents(sessionId).at(-1)?.type).toBe(
      "session.crashed",
    );
    expect(entry.record.terminalPublished).toBe(true);
  });

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
    const host = await bootFor([
      "--controlled-exit",
      "--lines",
      "3",
      "--emit-usage",
    ]);
    const { url } = host;
    const sessionId = await createSession(host);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);
    const entry = host.registry.get(sessionId);

    expect(entry).toBeDefined();
    process.kill(entry!.record.adapterPid!, "SIGUSR2");

    const events = await eventPromise;
    const lines = events.filter((e) => e.event === "session.update");
    const terminal = events.find((e) => e.event === "session.exited");

    expect(lines).toHaveLength(3);
    expect(terminal).toBeDefined();
    expect(Number(lines[0].id)).toBeLessThan(Number(lines[1].id));
    expect(Number(lines[1].id)).toBeLessThan(Number(lines[2].id));
  });

  it("session.crashed when fixture exits non-zero", async () => {
    const host = await bootFor([
      "--controlled-exit",
      "--lines",
      "1",
      "--exit-code",
      "1",
    ]);
    const { url } = host;
    const sessionId = await createSession(host);
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);
    const entry = host.registry.get(sessionId);

    expect(entry).toBeDefined();
    process.kill(entry!.record.adapterPid!, "SIGUSR2");

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

  it("DELETE awaits a TERM-resistant child's exit and durable terminal before replaying success", async () => {
    booted = await bootHost({
      fixtureArgs: ["--exit-delay-ms", "60000"],
      killGraceMs: 50,
    });
    const host = booted;
    const sessionId = await createSession(host);
    const entry = host.registry.get(sessionId)!;
    const command = envelope("session.delete", fenceFor(host, RUN_ID), {});
    const response = await postJson(
      `${host.url}/sessions/${sessionId}`,
      command,
      "DELETE",
    );

    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(entry.child.signalCode).toBe("SIGKILL");
    expect(() => process.kill(entry.record.pid, 0)).toThrow();
    expect(entry.record.terminalPublished).toBe(true);
    await entry.record.outputTerminal;
    const streamId = host.hostState.getRuntimeEventStreamId();
    const events = host.hostState.runtimeEventsAfter(streamId, null);
    const terminal = events.filter(
      (event) =>
        event.envelope.hostSessionId === sessionId &&
        event.envelope.eventType === "session.exited",
    );
    const receipt = host.hostState.getReceipt(command.command.id);

    expect(terminal).toHaveLength(1);
    expect(receipt?.httpStatus).toBe(204);
    expect(receipt?.phase).toBe("completed");
    const replay = await postJson(
      `${host.url}/sessions/${sessionId}`,
      command,
      "DELETE",
    );

    expect(replay.status).toBe(204);
    expect(replay.headers.get("x-maister-command-replayed")).toBe("true");
    expect(
      host.hostState
        .runtimeEventsAfter(streamId, null)
        .filter(
          (event) =>
            event.envelope.hostSessionId === sessionId &&
            event.envelope.eventType === "session.exited",
        ),
    ).toHaveLength(1);
  });

  it("DELETE refuses success when process exit has no confirmed terminal output", async () => {
    booted = await bootHost({ fixtureArgs: ["--hang"], killGraceMs: 50 });
    const host = booted;
    const sessionId = await createSession(host);
    const entry = host.registry.get(sessionId)!;
    const captured = entry.record.outputDrained;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    entry.record.outputDrained = Promise.all([captured, held]).then(() => {});
    const command = envelope("session.delete", fenceFor(host, RUN_ID), {});

    try {
      const response = await postJson(
        `${host.url}/sessions/${sessionId}`,
        command,
        "DELETE",
      );

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: {
          reason: "session_delete_exit_unconfirmed",
          stage: "terminal_output",
          sessionId,
          runId: RUN_ID,
        },
      });
      expect(entry.record.terminalPublished).not.toBe(true);
      expect(host.hostState.getReceipt(command.command.id)?.httpStatus).toBe(
        503,
      );
    } finally {
      release();
      await entry.record.outputTerminal;
    }
  });

  it("DELETE with a stale assignment cannot terminate the newer session", async () => {
    const host = await bootFor(["--hang"]);
    const created = await postJson(
      `${host.url}/sessions`,
      await createEnvelope(host, { runId: RUN_ID, assignmentEpoch: 2 }),
    );
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const entry = host.registry.get(sessionId)!;
    const response = await postJson(
      `${host.url}/sessions/${sessionId}`,
      envelope("session.delete", fenceFor(host, RUN_ID), {}),
      "DELETE",
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "FENCED" });
    expect(entry.record.status).toBe("live");
    expect(entry.child.exitCode).toBeNull();
    expect(entry.child.signalCode).toBeNull();
  });

  it("holds a higher epoch and its retries before dispatch until the older real process is confirmed retired", async () => {
    booted = await bootHost({
      fixtureArgs: ["--exit-delay-ms", "60000"],
      killGraceMs: 50,
    });
    const host = booted;
    const previousSessionId = await createSession(host);
    const previous = host.registry.get(previousSessionId)!;
    const kill = process.kill.bind(process);
    const intercepted = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) =>
        pid === -previous.record.processGroup! && signal === "SIGKILL"
          ? true
          : kill(pid, signal),
      );
    const command = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 2,
    });
    const competing = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 2,
    });

    try {
      for (const attempt of [command, competing]) {
        const refused = await postJson(`${host.url}/sessions`, attempt);

        expect(refused.status).toBe(503);
        expect(refused.body).toMatchObject({
          code: "EXECUTOR_UNAVAILABLE",
          details: {
            reason: "session_eviction_exit_unconfirmed",
            sessionId: previousSessionId,
            commandEpoch: 2,
            stage: "process_exit",
          },
        });
        expect(host.hostState.getReceipt(attempt.command.id)).toBeNull();
        expect(host.registry.list()).toHaveLength(1);
        expect(previous.child.exitCode).toBeNull();
        expect(previous.child.signalCode).toBeNull();
        expect(() => process.kill(previous.record.pid, 0)).not.toThrow();
      }
      expect(host.hostState.getFence(RUN_ID)?.epoch).toBe(2);
      intercepted.mockRestore();
      signalOwnedSessionProcess(previous, "SIGKILL");
      expect(await waitForChildExit(previous, 2_000)).toBe(true);
      const admitted = await postJson(`${host.url}/sessions`, command);

      expect(admitted.status).toBe(201);
      expect(host.hostState.getReceipt(command.command.id)?.phase).toBe(
        "completed",
      );
      expect(
        host.registry
          .list()
          .filter((record) => record.createdByCommandId === command.command.id),
      ).toHaveLength(1);
      expect(() => process.kill(previous.record.pid, 0)).toThrow();
    } finally {
      intercepted.mockRestore();
      if (
        previous.child.exitCode === null &&
        previous.child.signalCode === null
      )
        signalOwnedSessionProcess(previous, "SIGKILL");
      expect(await waitForChildExit(previous, 2_000)).toBe(true);
    }
  });

  it("fences an older create held before native spawn and preserves the newer owner's process and output", async () => {
    const host = await bootFor(["--hang"]);
    const older = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 1,
    });
    const newer = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 2,
    });
    const writeStream = fs.createWriteStream.bind(fs);
    let releaseOpen: () => void = () => {};
    let captured = false;
    const heldOpen = new Promise<void>((resolve) => {
      vi.spyOn(fs, "createWriteStream").mockImplementation((...args) => {
        const stream = writeStream(...args);

        if (captured) return stream;
        captured = true;
        const emit = stream.emit.bind(stream);

        vi.spyOn(stream, "emit").mockImplementation((event, ...values) => {
          if (event !== "open") return emit(event, ...values);
          releaseOpen = () => {
            emit(event, ...values);
          };
          resolve();

          return true;
        });

        return stream;
      });
    });
    const nativeSpawn = vi.spyOn(childProcess, "spawn");

    syncBuiltinESMExports();
    const pending = postJson(`${host.url}/sessions`, older);

    try {
      await heldOpen;
      expect(host.registry.list()).toHaveLength(0);
      const admitted = await postJson(`${host.url}/sessions`, newer);

      expect(admitted.status).toBe(201);
      const entry = host.registry.get(admitted.body.sessionId)!;

      releaseOpen();
      const refused = await pending;

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "FENCED" });
      expect(nativeSpawn).toHaveBeenCalledTimes(1);
      expect(host.registry.list()).toHaveLength(1);
      expect(entry.record.status).toBe("live");
      expect(() => process.kill(entry.record.pid, 0)).not.toThrow();
      await fs.promises.access(entry.record.logPath);
    } finally {
      releaseOpen();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await pending;
    }
  });

  it("registers a native child before yielding to its spawn notification so a higher epoch can retire it", async () => {
    const host = await bootFor(["--hang"]);
    const older = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 1,
    });
    const newer = await createEnvelope(host, {
      runId: RUN_ID,
      assignmentEpoch: 2,
    });
    const nativeSpawn = childProcess.spawn.bind(childProcess);
    let releaseSpawn: () => void = () => {};
    let captured = false;
    const spawned = new Promise<number>((resolve) => {
      vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const child = nativeSpawn(...args);

        if (captured) return child;
        captured = true;
        const emit = child.emit.bind(child);

        vi.spyOn(child, "emit").mockImplementation((event, ...values) => {
          if (event !== "spawn") return emit(event, ...values);
          releaseSpawn = () => {
            emit(event, ...values);
          };
          resolve(child.pid!);

          return true;
        });

        return child;
      });
    });

    syncBuiltinESMExports();
    const pending = postJson(`${host.url}/sessions`, older);

    try {
      const previousPid = await spawned;

      expect(host.registry.list()).toMatchObject([
        { pid: previousPid, assignmentEpoch: 1 },
      ]);
      const admitted = await postJson(`${host.url}/sessions`, newer);

      expect(admitted.status).toBe(201);
      expect(() => process.kill(previousPid, 0)).toThrow();
    } finally {
      releaseSpawn();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await pending;
    }
  });

  it.each(["late exit", "owned DELETE"] as const)(
    "reconciles an unresolved failed handshake through %s using its original create receipt",
    async (recovery) => {
      vi.stubEnv("MAISTER_ACP_HANDSHAKE_TIMEOUT_MS", "100");
      booted = await bootHost({
        fixtureArgs: ["--hang-new-session", "--exit-delay-ms", "60000"],
        killGraceMs: 50,
      });
      const host = booted;
      const register = host.registry.register.bind(host.registry);
      let restoreKill: () => void = () => {};
      const registered = new Promise<RegistryEntry>((resolve) => {
        vi.spyOn(host.registry, "register").mockImplementation((...args) => {
          register(...args);
          const entry = host.registry.get(args[0].sessionId)!;
          const kill = process.kill.bind(process);
          // Withhold termination of this real group until recovery. The
          // handshake can time out before the adapter installs its TERM handler.
          const intercepted = vi
            .spyOn(process, "kill")
            .mockImplementation((pid, signal) =>
              pid === -entry.record.processGroup! &&
              (signal === "SIGTERM" || signal === "SIGKILL")
                ? true
                : kill(pid, signal),
            );

          restoreKill = () => intercepted.mockRestore();
          resolve(entry);
        });
      });
      const command = await createEnvelope(host, { runId: RUN_ID });
      const response = postJson(`${host.url}/sessions`, command);
      const entry = await registered;

      try {
        const result = await response;
        const originalFailure = result.body.details?.sessionCreateFailure;

        expect(result.status).toBe(503);
        expect(originalFailure).toMatchObject({
          version: 1,
          stage: "acp_handshake",
          causeChain: [
            { name: "SupervisorError", code: "EXECUTOR_UNAVAILABLE" },
          ],
        });
        expect(entry.child.exitCode).toBeNull();
        expect(entry.child.signalCode).toBeNull();
        expect(() => process.kill(entry.record.pid, 0)).not.toThrow();
        expect(host.registry.get(entry.record.sessionId)).toBe(entry);
        expect(result.body).toMatchObject({
          code: "EXECUTOR_UNAVAILABLE",
          details: { reason: "session_create_exit_unconfirmed" },
        });
        expect(result.body).not.toHaveProperty(
          "details.sessionCreateQuiescence",
        );
        const inventory = await fetch(`${host.url}/sessions`);

        expect(await inventory.json()).toMatchObject([
          { sessionId: entry.record.sessionId, status: "live" },
        ]);
        expect(host.hostState.getReceipt(command.command.id)).toMatchObject({
          phase: "accepted",
          completedAt: null,
        });
        const replay = await postJson(`${host.url}/sessions`, command);

        expect(replay.status).toBe(503);
        expect(host.hostState.getReceipt(command.command.id)?.phase).toBe(
          "accepted",
        );
        restoreKill();
        if (recovery === "late exit") {
          signalOwnedSessionProcess(entry, "SIGKILL");
          expect(await waitForChildExit(entry, 2_000)).toBe(true);
        } else {
          const deleted = await postJson(
            `${host.url}/sessions/${entry.record.sessionId}`,
            envelope("session.delete", fenceFor(host, RUN_ID), {}),
            "DELETE",
          );

          expect(deleted.status).toBe(204);
        }
        const original = await fetch(
          `${host.url}/commands/${command.command.id}`,
        );

        expect(await original.json()).toMatchObject({
          commandId: command.command.id,
          phase: "rejected",
          inflight: false,
          body: {
            details: {
              sessionCreateFailure: originalFailure,
              sessionCreateQuiescence: { version: 1, process: "terminated" },
            },
          },
        });
        expect(() => process.kill(entry.record.pid, 0)).toThrow();
      } finally {
        restoreKill();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        signalOwnedSessionProcess(entry, "SIGKILL");
        expect(await waitForChildExit(entry, 2_000)).toBe(true);
        await response;
      }
    },
  );

  it("POST /sessions returns 503 and cleans up when ACP newSession hangs", async () => {
    const previousTimeout = process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS;

    process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS = "500";

    try {
      booted = await bootHost({
        fixtureArgs: ["--hang-new-session", "--exit-delay-ms", "60000"],
        killGraceMs: 50,
      });
      const host = booted;
      const { url, registry } = host;
      const register = registry.register.bind(registry);
      const registered = new Promise<RegistryEntry>((resolve) => {
        vi.spyOn(registry, "register").mockImplementation((...args) => {
          register(...args);
          resolve(registry.get(args[0].sessionId)!);
        });
      });
      const command = await createEnvelope(host, { runId: RUN_ID });
      const res = await postJson(`${url}/sessions`, command);

      expect(res.status).toBe(503);
      const body = res.body as { code: string; message: string };

      expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
      expect(body.message, JSON.stringify(res.body)).toContain("newSession");
      expect(body.message).toContain("timed out");
      expect(res.body).toMatchObject({
        details: {
          sessionCreateQuiescence: { version: 1, process: "terminated" },
        },
      });
      const entry = await registered;

      expect(entry.child.signalCode).toBe("SIGKILL");
      expect(() => process.kill(entry.record.pid, 0)).toThrow();
      expect(entry.record.terminalPublished).toBe(true);
      expect(host.hostState.getReceipt(command.command.id)).toMatchObject({
        phase: "rejected",
        body: {
          details: {
            sessionCreateFailure: res.body.details.sessionCreateFailure,
            sessionCreateQuiescence: { version: 1, process: "terminated" },
          },
        },
      });
      expect(registry.size()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      if (previousTimeout === undefined) {
        delete process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.MAISTER_ACP_HANDSHAKE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it.each(["missing env ref", "unwritable log"] as const)(
    "proves %s failed before any native process and preserves its cause",
    async (failure) => {
      const host = await bootFor(["--hang"]);
      const runDirectory = join(
        host.runtimeRoot,
        ".maister",
        "demo",
        "runs",
        RUN_ID,
      );
      const extra =
        failure === "missing env ref"
          ? {
              runner: {
                version: 1,
                runnerId: "controlled",
                adapter: "claude",
                capabilityAgent: "claude",
                model: "mock",
                provider: {
                  kind: "anthropic_compatible",
                  authTokenEnv: "MAISTER_CONTROLLED_UNSET_TOKEN",
                },
                permissionPolicy: "default",
              },
            }
          : {};
      const command = await createEnvelope(host, { runId: RUN_ID }, extra);

      vi.stubEnv("MAISTER_CONTROLLED_UNSET_TOKEN", "");
      await mkdir(runDirectory, { recursive: true });
      if (failure === "unwritable log") await chmod(runDirectory, 0o500);
      try {
        const response = await postJson(`${host.url}/sessions`, command);

        expect(response.status, JSON.stringify(response.body)).toBe(503);
        expect(response.body).toMatchObject({
          details: {
            sessionCreateQuiescence: { version: 1, process: "not_started" },
            sessionCreateFailure: { version: 1, stage: "spawn" },
          },
        });
        expect(
          response.body.details.sessionCreateFailure.causeChain.some(
            (cause: { code?: string | number }) =>
              cause.code ===
              (failure === "unwritable log"
                ? "EACCES"
                : "EXECUTOR_UNAVAILABLE"),
          ),
        ).toBe(true);
        expect(host.registry.list()).toHaveLength(0);
        expect(host.hostState.sessionProcessesForRun(RUN_ID)).toHaveLength(0);
        expect(host.hostState.getReceipt(command.command.id)).toMatchObject({
          phase: "rejected",
          body: {
            details: {
              sessionCreateQuiescence: { version: 1, process: "not_started" },
            },
          },
        });
      } finally {
        await chmod(runDirectory, 0o700);
        vi.unstubAllEnvs();
      }
    },
  );

  it("retires the real gate after an adapter binary-not-found failure and retains its safe cause", async () => {
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "maister-missing-adapter-"),
    );

    booted = await bootHost({
      runtimeRoot,
      spawnOverrides: {
        binary: join(runtimeRoot, "not-installed"),
        preArgs: [],
      },
    });
    const host = booted;
    const command = await createEnvelope(host, { runId: RUN_ID });
    const response = await postJson(`${host.url}/sessions`, command);

    expect(response.status, JSON.stringify(response.body)).toBe(500);
    expect(response.body).toMatchObject({
      code: "SPAWN",
      details: {
        sessionCreateQuiescence: { version: 1, process: "terminated" },
        sessionCreateFailure: {
          version: 1,
          stage: "spawn",
          causeChain: [{ name: "Error", code: "ENOENT" }],
        },
      },
    });
    expect(host.registry.list()).toMatchObject([{ status: "exited" }]);
    expect(host.hostState.sessionProcessesForRun(RUN_ID)).toMatchObject([
      { phase: "released" },
    ]);
    expect(host.hostState.getReceipt(command.command.id)?.phase).toBe(
      "rejected",
    );
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
    const host = await bootFor(["--lines", "2", "--hang"]);
    const { url } = host;
    const sessionId = await createSession(host, {
      executorEnv: { ANTHROPIC_AUTH_TOKEN: sentinel },
    });
    const eventPromise = collectSSE(`${url}/sessions/${sessionId}/stream`);

    await sendPrompt(host, sessionId);
    await eventPromise;

    const logPath = host.registry.get(sessionId)!.record.logPath;
    const logContents = await readFile(logPath, "utf8");

    expect(logContents).not.toContain(sentinel);
  });
});
