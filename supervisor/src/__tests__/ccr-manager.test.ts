import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

// We mock `node:fs/promises` and `node:child_process` so the manager runs
// without a real CCR binary or config file on disk. Each test re-creates
// the manager via `createCcrManager()` to start from a clean state.

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockSpawn = vi.fn();
const mockFetch = vi.fn();

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );

  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

vi.stubGlobal("fetch", mockFetch);

// IMPORTANT: import the manager AFTER mocks are set so it picks up the
// mocked node:fs/promises + node:child_process.
const { createCcrManager, createKeyedCcrManager } = await import(
  "../ccr-manager"
);

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 90_000) + 1_000;
  killed = false;
  stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };

  constructor() {
    super();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
  }

  kill(sig?: NodeJS.Signals | number): boolean {
    this.killed = true;
    // Defer to next tick so callers awaiting `exited` get the event
    // AFTER they registered the listener.
    setImmediate(() => this.emit("exit", null, sig ?? "SIGTERM"));

    return true;
  }
}

function captureLogger(): { logger: pino.Logger; sink: { lines: string[] } } {
  const sink = { lines: [] as string[] };
  const stream = new Writable({
    write(chunk, _enc, cb) {
      sink.lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ level: "trace" }, stream);

  return { logger, sink };
}

beforeEach(() => {
  mockAccess.mockReset();
  mockReadFile.mockReset();
  mockSpawn.mockReset();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ccr-manager (unit)", () => {
  it("keyed facade starts two independent managed CCR instances", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path) => {
      if (String(path) === "/tmp/ccr-a.json") {
        return JSON.stringify({ HOST: "127.0.0.1", PORT: 4567 });
      }

      return JSON.stringify({ HOST: "127.0.0.1", PORT: 5678 });
    });
    mockSpawn.mockImplementation(() => new FakeChild());
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const { logger } = captureLogger();
    const mgr = createKeyedCcrManager({ logger });

    await mgr.ensureRunning({
      instance: {
        id: "ccr-a",
        lifecycle: "managed",
        configPath: "/tmp/ccr-a.json",
      },
    });
    await mgr.ensureRunning({
      instance: {
        id: "ccr-b",
        lifecycle: "managed",
        configPath: "/tmp/ccr-b.json",
      },
    });

    expect(mgr.getProxyUrl("ccr-a")).toBe("http://127.0.0.1:4567");
    expect(mgr.getProxyUrl("ccr-b")).toBe("http://127.0.0.1:5678");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("idle → starting → ready on healthy config + spawn + 200 response", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 4567 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const { logger } = captureLogger();
    const mgr = createCcrManager({
      logger,
      configPath: "/fake/config.json",
    });

    expect(mgr.getState()).toBe("idle");
    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");
    expect(mgr.getProxyUrl()).toBe("http://127.0.0.1:4567");
  });

  it("defaults host/port when keys are absent in valid JSON", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ Providers: [], Router: {} }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const mgr = createCcrManager({ configPath: "/fake/config.json" });

    await mgr.ensureRunning();
    expect(mgr.getProxyUrl()).toBe("http://127.0.0.1:3456");
  });

  it("concurrent ensureRunning calls share the same start promise", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ HOST: "h", PORT: 4321 }));
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const mgr = createCcrManager({ configPath: "/fake/config.json" });

    await Promise.all([
      mgr.ensureRunning(),
      mgr.ensureRunning(),
      mgr.ensureRunning(),
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("ENOENT config → EXECUTOR_UNAVAILABLE + state failed, no spawn", async () => {
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const mgr = createCcrManager({ configPath: "/missing.json" });

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toContain("/missing.json");
    expect(mgr.getState()).toBe("failed");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("malformed JSON → EXECUTOR_UNAVAILABLE with parse reason, no spawn", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("{ bad json");
    const mgr = createCcrManager({ configPath: "/bad.json" });

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(/malformed/);
    expect(mgr.getState()).toBe("failed");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("health check timeout → state failed, child SIGTERMed", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 4567 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const mgr = createCcrManager({
      configPath: "/c.json",
      healthCheckTotalMs: 80, // short total so the test runs fast
    });

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(/failed to become ready/);
    expect(mgr.getState()).toBe("failed");
    expect(child.killed).toBe(true);
  });

  it("shutdown on ready → SIGTERM observed, state returns to idle", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 4567 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const mgr = createCcrManager({ configPath: "/c.json" });

    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");
    await mgr.shutdown({ timeoutMs: 200 });
    expect(child.killed).toBe(true);
    expect(mgr.getState()).toBe("idle");
  });

  it("shutdown on idle is a no-op (no spawn touched)", async () => {
    const mgr = createCcrManager({ configPath: "/c.json" });

    expect(mgr.getState()).toBe("idle");
    await mgr.shutdown();
    expect(mgr.getState()).toBe("idle");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("getProxyUrl throws EXECUTOR_UNAVAILABLE when not ready", () => {
    const mgr = createCcrManager({ configPath: "/c.json" });

    let caught: unknown;

    try {
      mgr.getProxyUrl();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("probes /health (identity-validating) and accepts only 200 as ready", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 9999 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const mgr = createCcrManager({ configPath: "/c.json" });

    await mgr.ensureRunning();
    expect(mockFetch).toHaveBeenCalled();
    const firstCallUrl = mockFetch.mock.calls[0]?.[0];

    expect(String(firstCallUrl)).toBe("http://127.0.0.1:9999/health");
    expect(mgr.getState()).toBe("ready");
  });

  it("/health returning 404 → identity-mismatch failure (wrong process on port)", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 9999 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 404 } as Response);

    const mgr = createCcrManager({
      configPath: "/c.json",
      healthCheckTotalMs: 80,
    });

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(/identity check failed/);
    expect((caught as Error).message).toMatch(
      /another process appears to own the port/,
    );
    expect(mgr.getState()).toBe("failed");
    expect(child.killed).toBe(true);
  });

  it("child exits before probe succeeds → identity-aware EXECUTOR_UNAVAILABLE (early-exit guard)", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ HOST: "127.0.0.1", PORT: 9999 }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    // First fetch hangs long enough for the child-exit to fire.
    mockFetch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("ECONNREFUSED")), 60);
        }),
    );

    const mgr = createCcrManager({
      configPath: "/c.json",
      healthCheckTotalMs: 5_000,
    });

    // Simulate the child exiting with EADDRINUSE shortly after spawn.
    setTimeout(() => child.emit("exit", 1, null), 20);

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(
      /CCR child exited before becoming ready/,
    );
    expect((caught as Error).message).toMatch(/code=1/);
    expect(mgr.getState()).toBe("failed");
  });

  it("does not leak provider config content (full JSON body, API keys) to logs", async () => {
    const SENTINEL = "sk-PROVIDER-secret-XYZ";

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        HOST: "127.0.0.1",
        PORT: 4567,
        Providers: [
          {
            name: "z.ai",
            api_base_url: "https://api.z.ai/api/anthropic",
            api_key: SENTINEL,
          },
        ],
      }),
    );
    const child = new FakeChild();

    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const { logger, sink } = captureLogger();
    const mgr = createCcrManager({ logger, configPath: "/c.json" });

    await mgr.ensureRunning();
    expect(sink.lines.join("")).not.toContain(SENTINEL);
    // host/port should appear (no secrets there)
    expect(sink.lines.join("")).toMatch(/"host":"127\.0\.0\.1"/);
    expect(sink.lines.join("")).toMatch(/"port":4567/);
  });

  it("stop(id) stops ONLY the targeted instance and leaves others running (ADR-094)", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path) =>
      String(path) === "/tmp/ccr-a.json"
        ? JSON.stringify({ HOST: "127.0.0.1", PORT: 4567 })
        : JSON.stringify({ HOST: "127.0.0.1", PORT: 5678 }),
    );
    mockSpawn.mockImplementation(() => new FakeChild());
    mockFetch.mockResolvedValue({ status: 200 } as Response);

    const { logger } = captureLogger();
    const mgr = createKeyedCcrManager({ logger });

    await mgr.ensureRunning({
      instance: {
        id: "ccr-a",
        lifecycle: "managed",
        configPath: "/tmp/ccr-a.json",
      },
    });
    await mgr.ensureRunning({
      instance: {
        id: "ccr-b",
        lifecycle: "managed",
        configPath: "/tmp/ccr-b.json",
      },
    });

    expect(mgr.getState("ccr-a")).toBe("ready");
    expect(mgr.getState("ccr-b")).toBe("ready");

    await mgr.stop("ccr-a");

    // ccr-a stopped and removed from the map; ccr-b untouched.
    expect(mgr.getState("ccr-a")).toBe("idle");
    expect(mgr.getState("ccr-b")).toBe("ready");
  });

  it("stop(unknown id) is a no-op", async () => {
    const { logger } = captureLogger();
    const mgr = createKeyedCcrManager({ logger });

    await expect(mgr.stop("nope")).resolves.toBeUndefined();
    expect(mgr.getState("nope")).toBe("idle");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
