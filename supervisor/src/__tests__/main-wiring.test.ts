import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { HostKeyConflictError, openHostState } from "../host-state";
import {
  bootExecutionHost,
  buildRegisterRoutesOptions,
  testProducerPauseMaxMs,
} from "../main";

const silentLogger = pino({ level: "silent" });

// ADR-183: the producer pause bound is a code constant; only a test process
// may shorten it, and production never reads the seam.
describe("testProducerPauseMaxMs", () => {
  it("is ignored outside NODE_ENV=test", () => {
    expect(
      testProducerPauseMaxMs({
        NODE_ENV: "production",
        MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "1500",
      }),
    ).toBeUndefined();
    expect(
      testProducerPauseMaxMs({ MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "1500" }),
    ).toBeUndefined();
  });

  it("shortens the bound in a test process and refuses a malformed value", () => {
    expect(
      testProducerPauseMaxMs({
        NODE_ENV: "test",
        MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "1500",
      }),
    ).toBe(1500);
    expect(testProducerPauseMaxMs({ NODE_ENV: "test" })).toBeUndefined();
    expect(() =>
      testProducerPauseMaxMs({
        NODE_ENV: "test",
        MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "0",
      }),
    ).toThrow(/positive integer/);
  });
});

describe("buildRegisterRoutesOptions", () => {
  it("wires the production model-catalog registry", () => {
    const hostState = openHostState({ inMemory: true });
    const opts = buildRegisterRoutesOptions({
      app: {} as never,
      registry: {} as never,
      logger: silentLogger,
      runtimeRoot: "/tmp/main-wiring-test",
      killGraceMs: 5_000,
      hostState,
      workspaceRoots: [],
    });

    expect(opts.modelCatalog?.registry).toBeDefined();
    hostState.close();
  });

  // ADR-166: the production boot passes the execution-host state store and the
  // realpath'd adoption roots through — registerRoutes has no fallback for
  // either (a missing store is a boot error, never a silently minted identity).
  it("forwards the execution-host state store and workspace roots", () => {
    const hostState = openHostState({ inMemory: true });
    const opts = buildRegisterRoutesOptions({
      app: {} as never,
      registry: {} as never,
      logger: silentLogger,
      runtimeRoot: "/tmp/main-wiring-test",
      killGraceMs: 5_000,
      hostState,
      workspaceRoots: ["/tmp/main-wiring-test/worktrees"],
    });

    expect(opts.hostState).toBe(hostState);
    expect(opts.workspaceRoots).toEqual(["/tmp/main-wiring-test/worktrees"]);
    hostState.close();
  });
});

describe("bootExecutionHost (ADR-166 boot fatals)", () => {
  it("refuses boot on a conflicting pin, logging the remediation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eh-boot-"));
    const first = openHostState({ stateDir: dir });
    const stored = first.hostKey;

    first.close();
    const logger = pino({ level: "silent" });
    const fatal = vi.spyOn(logger, "fatal");

    expect(() =>
      bootExecutionHost({
        runtimeRoot: dir,
        logger,
        env: {
          MAISTER_EXECUTION_HOST_STATE_DIR: dir,
          MAISTER_EXECUTION_HOST_KEY: "eh_conflicting_00",
        },
      }),
    ).toThrow(HostKeyConflictError);
    expect(fatal.mock.calls[0]?.[1]).toBe("execution-host-key-conflict");
    expect(
      (fatal.mock.calls[0]?.[0] as { storedKeyPrefix: string }).storedKeyPrefix,
    ).toBe(stored.slice(0, 8));
    await rm(dir, { recursive: true, force: true });
  });
});
