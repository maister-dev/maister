import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { Writable } from "node:stream";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCcrManager } from "../ccr-manager";

import { writeCcrConfig } from "./_fixtures/write-ccr-config";

const MOCK_PATH = resolvePath(
  fileURLToPath(import.meta.url),
  "..",
  "_fixtures",
  "mock-ccr.mjs",
);

async function findFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createNetServer();

    srv.unref();
    srv.once("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();

      srv.close(() => {
        if (typeof addr === "object" && addr && "port" in addr) {
          resolveP(addr.port);
        } else {
          rejectP(new Error("no address"));
        }
      });
    });
  });
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

let cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanups = [];
});

afterEach(async () => {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
});

describe("ccr-manager (integration with mock-ccr.mjs)", () => {
  it("parses config + starts mock + health-check succeeds + getProxyUrl matches", async () => {
    const port = await findFreePort();
    const configPath = await writeCcrConfig({ host: "127.0.0.1", port });

    const { logger, sink } = captureLogger();
    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH],
      configPath,
      logger,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 5_000,
    });

    cleanups.push(() => mgr.shutdown({ timeoutMs: 2_000 }));

    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");
    expect(mgr.getProxyUrl()).toBe(`http://127.0.0.1:${port}`);
    // Host+port present in logs; no provider key sentinel could leak
    // here since the helper wrote an empty Providers[] (still useful
    // as a baseline).
    expect(sink.lines.join("")).toMatch(/"port":/);
  }, 20_000);

  it("shutdown actually kills the mock process", async () => {
    const port = await findFreePort();
    const configPath = await writeCcrConfig({ host: "127.0.0.1", port });
    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH],
      configPath,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 5_000,
    });

    await mgr.ensureRunning();
    await mgr.shutdown({ timeoutMs: 2_000 });
    expect(mgr.getState()).toBe("idle");

    // After shutdown the port should be free for another listener.
    await new Promise<void>((resolveP, rejectP) => {
      const srv = createNetServer();

      srv.once("error", rejectP);
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolveP());
      });
    });
  }, 20_000);

  it("ensureRunning after a clean shutdown restarts the daemon", async () => {
    const port = await findFreePort();
    const configPath = await writeCcrConfig({ host: "127.0.0.1", port });
    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH],
      configPath,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 5_000,
    });

    cleanups.push(() => mgr.shutdown({ timeoutMs: 2_000 }));

    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");
    await mgr.shutdown({ timeoutMs: 2_000 });
    expect(mgr.getState()).toBe("idle");
    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");
  }, 20_000);

  it("config points at port the mock isn't listening on → health-check times out", async () => {
    const realPort = await findFreePort();
    const wrongPort = await findFreePort();
    const configPath = await writeCcrConfig({
      host: "127.0.0.1",
      port: wrongPort,
    });
    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH],
      configPath,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(realPort) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 800,
    });

    cleanups.push(() => mgr.shutdown({ timeoutMs: 2_000 }));

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(/failed to become ready/);
    expect(mgr.getState()).toBe("failed");
  }, 20_000);

  it("SIGTERM-resistant child still gets SIGKILLed within the grace window", async () => {
    const port = await findFreePort();
    const configPath = await writeCcrConfig({ host: "127.0.0.1", port });
    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH, "--ignore-sigterm"],
      configPath,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 5_000,
    });

    await mgr.ensureRunning();
    expect(mgr.getState()).toBe("ready");

    const startedAt = Date.now();

    await mgr.shutdown({ timeoutMs: 500 });
    const elapsedMs = Date.now() - startedAt;

    // Grace (500ms) + SIGKILL roundtrip (typically <100ms on a healthy
    // host). CI slack budgeted as 2_000ms upper bound. The intent: the
    // call DOES return — does not hang for the SIGTERM-resistant child.
    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsedMs).toBeLessThanOrEqual(2_000);
    expect(mgr.getState()).toBe("idle");

    // Port is free — proves the SIGKILL actually killed the process,
    // not just changed the manager's state.
    await new Promise<void>((resolveP, rejectP) => {
      const srv = createNetServer();

      srv.once("error", rejectP);
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolveP());
      });
    });
  }, 20_000);

  it("another HTTP server holding the port → identity-mismatch / early-exit failure (not transition to ready)", async () => {
    const port = await findFreePort();
    const configPath = await writeCcrConfig({ host: "127.0.0.1", port });

    // Strict variant: bind the port BEFORE starting the manager so the
    // spawned mock-ccr fails with EADDRINUSE. The unrelated server
    // answers GET / with 200 and GET /health with 404 — exactly the
    // shape that fooled the pre-fix probe into reporting `ready`.
    const usurper: HttpServer = createHttpServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(404).end();

        return;
      }
      res.writeHead(200).end("not ccr");
    });

    await new Promise<void>((resolveP, rejectP) => {
      usurper.once("error", rejectP);
      usurper.listen(port, "127.0.0.1", () => resolveP());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolveP) => {
          usurper.close(() => resolveP());
        }),
    );

    const mgr = createCcrManager({
      binaryOverride: process.execPath,
      argsOverride: [MOCK_PATH],
      configPath,
      spawnOptions: {
        env: { ...process.env, MAISTER_MOCK_CCR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
      healthCheckTotalMs: 2_000,
    });

    cleanups.push(() => mgr.shutdown({ timeoutMs: 2_000 }));

    let caught: unknown;

    try {
      await mgr.ensureRunning();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    // Either path is acceptable: the mock-ccr child exits with
    // EADDRINUSE (early-exit guard fires) OR the probe sees 404 from
    // the usurper (identity-check fires). Both are target-aware errors.
    expect((caught as Error).message).toMatch(
      /(CCR child exited before becoming ready|CCR identity check failed)/,
    );
    expect(mgr.getState()).toBe("failed");
  }, 20_000);
});
