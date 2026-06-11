import type { StartSessionRequest } from "../types";
import type { CcrManager } from "../ccr-manager";

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import pino from "pino";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

const mockSpawn = vi.fn();

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) };
});

// Import AFTER mocks so spawn.ts picks up the mocked node:child_process.
const { spawnSession } = await import("../spawn");

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 80_000) + 2_000;
  killed = false;
  stdin = new EventEmitter() as EventEmitter & {
    write: (s: string) => boolean;
    end: () => void;
  };
  stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stderr = null;

  constructor() {
    super();
    this.stdout.setEncoding = () => {};
    this.stdin.write = () => true;
    this.stdin.end = () => {};
  }

  kill(): boolean {
    this.killed = true;

    return true;
  }
}

function makeFakeChild(): FakeChild {
  const c = new FakeChild();

  // Emit `spawn` on next tick so spawnSession's `child.once("spawn",...)`
  // gate resolves.
  setImmediate(() => c.emit("spawn"));

  return c;
}

function makeRequest(
  over: Partial<StartSessionRequest> = {},
): StartSessionRequest {
  return {
    runId: "run-1",
    projectSlug: "demo",
    worktreePath: process.cwd(),
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...over,
  };
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

type MockCcr = CcrManager & {
  ensureRunning: Mock;
  getProxyUrl: Mock;
  getState: Mock;
  shutdown: Mock;
};

function makeCcr(over: Partial<MockCcr> = {}): MockCcr {
  return {
    ensureRunning: vi.fn(async () => undefined),
    getProxyUrl: vi.fn(() => "http://ccr-proxy.local:3456"),
    getState: vi.fn(() => "ready" as const),
    shutdown: vi.fn(async () => undefined),
    ...over,
  } as MockCcr;
}

let runtimeRoot: string;
let originalAuthToken: string | undefined;
let originalGeminiBinary: string | undefined;

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "spawn-ccr-test-"));
  mockSpawn.mockReset();
  originalAuthToken = process.env.MAISTER_CCR_AUTH_TOKEN;
  originalGeminiBinary = process.env.MAISTER_ADAPTER_BINARY_GEMINI;
  delete process.env.MAISTER_CCR_AUTH_TOKEN;
  delete process.env.MAISTER_ADAPTER_BINARY_GEMINI;
});

afterEach(async () => {
  if (originalAuthToken !== undefined) {
    process.env.MAISTER_CCR_AUTH_TOKEN = originalAuthToken;
  } else {
    delete process.env.MAISTER_CCR_AUTH_TOKEN;
  }
  if (originalGeminiBinary !== undefined) {
    process.env.MAISTER_ADAPTER_BINARY_GEMINI = originalGeminiBinary;
  } else {
    delete process.env.MAISTER_ADAPTER_BINARY_GEMINI;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe("spawnSession — adapter registry", () => {
  it("spawns Gemini, OpenCode, and MiMo with adapter-specific ACP argv", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild());

    const { logger } = captureLogger();

    await spawnSession({
      sessionId: "s-gemini",
      request: makeRequest({
        executor: { agent: "gemini", model: "gemini-3-pro" },
      }),
      runtimeRoot,
      logger,
    });
    await spawnSession({
      sessionId: "s-opencode",
      request: makeRequest({
        executor: { agent: "opencode", model: "opencode-default" },
      }),
      runtimeRoot,
      logger,
    });
    await spawnSession({
      sessionId: "s-mimo",
      request: makeRequest({
        executor: { agent: "mimo", model: "mimo-native" },
      }),
      runtimeRoot,
      logger,
    });

    expect(mockSpawn.mock.calls[0]?.[0]).toBe("gemini");
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual(["--acp"]);
    expect(mockSpawn.mock.calls[1]?.[0]).toBe("opencode");
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual(["acp"]);
    expect(mockSpawn.mock.calls[2]?.[0]).toBe("mimo");
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual(["acp"]);
  });

  it("uses the selected adapter binary override env var without affecting other adapters", async () => {
    process.env.MAISTER_ADAPTER_BINARY_GEMINI = "/opt/test/gemini";
    mockSpawn.mockImplementation(() => makeFakeChild());

    const { logger } = captureLogger();

    await spawnSession({
      sessionId: "s-gemini",
      request: makeRequest({
        executor: { agent: "gemini", model: "gemini-3-pro" },
      }),
      runtimeRoot,
      logger,
    });
    await spawnSession({
      sessionId: "s-opencode",
      request: makeRequest({
        executor: { agent: "opencode", model: "opencode-default" },
      }),
      runtimeRoot,
      logger,
    });

    expect(mockSpawn.mock.calls[0]?.[0]).toBe("/opt/test/gemini");
    expect(mockSpawn.mock.calls[1]?.[0]).toBe("opencode");
  });
});

describe("spawnSession — CCR env injection precedence", () => {
  it("router=ccr + MAISTER_CCR_AUTH_TOKEN fallback → injects BASE_URL + TOKEN", async () => {
    process.env.MAISTER_CCR_AUTH_TOKEN = "fallback-token-XYZ";

    let capturedEnv: NodeJS.ProcessEnv | undefined;

    mockSpawn.mockImplementation((_bin, _args, opts) => {
      capturedEnv = opts?.env;

      return makeFakeChild();
    });

    const ccr = makeCcr();
    const { logger } = captureLogger();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
        },
      }),
      runtimeRoot,
      logger,
      binaryOverride: "node",
      ccrManager: ccr,
    });

    expect(ccr.ensureRunning).toHaveBeenCalledTimes(1);
    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("http://ccr-proxy.local:3456");
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("fallback-token-XYZ");
  });

  it("runner sidecar intent starts and reads the keyed CCR instance", async () => {
    process.env.MAISTER_CCR_AUTH_TOKEN = "fallback-token-XYZ";
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    mockSpawn.mockImplementation((_bin, _args, opts) => {
      capturedEnv = opts?.env;

      return makeFakeChild();
    });

    const ccr = makeCcr();
    const { logger } = captureLogger();

    await spawnSession({
      sessionId: "s-keyed",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "legacy",
        },
        runner: {
          version: 1,
          runnerId: "claude-ccr",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "glm",
          provider: { kind: "anthropic_compatible" },
          permissionPolicy: "default",
          sidecar: {
            id: "ccr-glm",
            kind: "ccr",
            lifecycle: "managed",
            configPath: "/tmp/ccr-glm.json",
          },
        },
      }),
      runtimeRoot,
      logger,
      binaryOverride: "node",
      ccrManager: ccr,
    });

    expect(ccr.ensureRunning).toHaveBeenCalledWith({
      instance: {
        id: "ccr-glm",
        lifecycle: "managed",
        configPath: "/tmp/ccr-glm.json",
        baseUrl: undefined,
        healthcheckUrl: undefined,
      },
    });
    expect(ccr.getProxyUrl).toHaveBeenCalledWith("ccr-glm");
    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("http://ccr-proxy.local:3456");
  });

  it("router=ccr + executor.env.ANTHROPIC_BASE_URL=custom → executor.env wins on collision", async () => {
    process.env.MAISTER_CCR_AUTH_TOKEN = "fallback";
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    mockSpawn.mockImplementation((_bin, _args, opts) => {
      capturedEnv = opts?.env;

      return makeFakeChild();
    });

    const ccr = makeCcr();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
          env: { ANTHROPIC_BASE_URL: "https://custom.example.com/anthropic" },
        },
      }),
      runtimeRoot,
      logger: pino({ level: "silent" }),
      binaryOverride: "node",
      ccrManager: ccr,
    });

    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe(
      "https://custom.example.com/anthropic",
    );
    // Token still comes from fallback since executor.env didn't override it.
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("fallback");
  });

  it("router=ccr + executor.env.ANTHROPIC_AUTH_TOKEN=custom → custom value not from MAISTER_CCR_AUTH_TOKEN", async () => {
    process.env.MAISTER_CCR_AUTH_TOKEN = "DO_NOT_USE";
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    mockSpawn.mockImplementation((_bin, _args, opts) => {
      capturedEnv = opts?.env;

      return makeFakeChild();
    });

    const ccr = makeCcr();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
          env: { ANTHROPIC_AUTH_TOKEN: "explicit-from-executor" },
        },
      }),
      runtimeRoot,
      logger: pino({ level: "silent" }),
      binaryOverride: "node",
      ccrManager: ccr,
    });

    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("explicit-from-executor");
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).not.toBe("DO_NOT_USE");
  });

  it("router=ccr + no token anywhere → throws EXECUTOR_UNAVAILABLE AFTER ensureRunning", async () => {
    // No MAISTER_CCR_AUTH_TOKEN set; no executor.env.
    const ccr = makeCcr();

    let caught: unknown;

    try {
      await spawnSession({
        sessionId: "s1",
        request: makeRequest({
          executor: {
            agent: "claude",
            model: "claude-sonnet-4-6",
            router: "ccr",
          },
        }),
        runtimeRoot,
        logger: pino({ level: "silent" }),
        binaryOverride: "node",
        ccrManager: ccr,
      });
    } catch (err) {
      caught = err;
    }

    expect(ccr.ensureRunning).toHaveBeenCalledTimes(1);
    expect((caught as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as Error).message).toMatch(/ANTHROPIC_AUTH_TOKEN missing/);
    // Spawn never called because we throw before child_process.spawn.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("router=undefined → ccrManager.ensureRunning NOT called, no BASE_URL injected", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    mockSpawn.mockImplementation((_bin, _args, opts) => {
      capturedEnv = opts?.env;

      return makeFakeChild();
    });

    const ccr = makeCcr();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
      }),
      runtimeRoot,
      logger: pino({ level: "silent" }),
      binaryOverride: "node",
      ccrManager: ccr,
    });

    expect(ccr.ensureRunning).not.toHaveBeenCalled();
    // Process.env may have ANTHROPIC_BASE_URL set already, but the spawn
    // layer didn't add it. The relevant assertion: no `http://ccr-proxy.local`
    // injection.
    expect(capturedEnv?.ANTHROPIC_BASE_URL).not.toBe(
      "http://ccr-proxy.local:3456",
    );
  });
});

describe("spawnSession — token-leak guards", () => {
  it("never logs ANTHROPIC_AUTH_TOKEN value (sentinel router=ccr case)", async () => {
    const SENTINEL = "sk-test-LEAK_DETECTOR_123";

    mockSpawn.mockImplementation(() => makeFakeChild());

    const ccr = makeCcr();
    const { logger, sink } = captureLogger();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          router: "ccr",
          env: { ANTHROPIC_AUTH_TOKEN: SENTINEL },
        },
      }),
      runtimeRoot,
      logger,
      binaryOverride: "node",
      ccrManager: ccr,
    });

    const joined = sink.lines.join("");

    expect(joined).not.toContain(SENTINEL);
  });

  it("never logs ANTHROPIC_AUTH_TOKEN value (sentinel non-ccr case, defense in depth)", async () => {
    const SENTINEL = "sk-test-LEAK_DETECTOR_456";

    mockSpawn.mockImplementation(() => makeFakeChild());

    const { logger, sink } = captureLogger();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { ANTHROPIC_AUTH_TOKEN: SENTINEL },
        },
      }),
      runtimeRoot,
      logger,
      binaryOverride: "node",
    });

    expect(sink.lines.join("")).not.toContain(SENTINEL);
  });

  it("never logs arbitrary executor.env values (sentinel)", async () => {
    const SENTINEL = "secret-vendor-key-789";

    mockSpawn.mockImplementation(() => makeFakeChild());

    const { logger, sink } = captureLogger();

    await spawnSession({
      sessionId: "s1",
      request: makeRequest({
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { CUSTOM_PROVIDER_KEY: SENTINEL },
        },
      }),
      runtimeRoot,
      logger,
      binaryOverride: "node",
    });

    expect(sink.lines.join("")).not.toContain(SENTINEL);
  });
});
