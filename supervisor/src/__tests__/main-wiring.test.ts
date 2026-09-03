import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { HostKeyConflictError, openHostState } from "../host-state";
import { bootExecutionHost, buildRegisterRoutesOptions } from "../main";

const silentLogger = pino({ level: "silent" });

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
