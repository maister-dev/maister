import type { ChildProcess } from "node:child_process";

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupTestWorktrees: vi.fn(async () => undefined),
  createTestWorktreesRoot: vi.fn(
    () => "/tmp/maister-test-worktrees/e2e/invocation",
  ),
  prepareE2eDatabase: vi.fn(),
  spawn: vi.fn(),
  startBarePostgresTestDb: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return { ...actual, spawn: mocks.spawn };
});

vi.mock("@/test-support/pg-container", () => ({
  startBarePostgresTestDb: mocks.startBarePostgresTestDb,
}));

vi.mock("@/test-support/worktree-test-root", () => ({
  cleanupTestWorktrees: mocks.cleanupTestWorktrees,
  createTestWorktreesRoot: mocks.createTestWorktreesRoot,
}));

vi.mock("../_seed/prepare-db", () => ({
  prepareE2eDatabase: mocks.prepareE2eDatabase,
}));

import {
  buildE2eMigrationEnvironment,
  buildE2ePlaywrightEnvironment,
  installE2eShutdownSignals,
  runE2eInvocation,
} from "../run";

type TestChildProcess = ChildProcess & EventEmitter;

function createChildProcess(): TestChildProcess {
  const child = new EventEmitter() as TestChildProcess;

  Object.assign(child, {
    exitCode: null,
    kill: vi.fn(() => true),
    pid: 12_345,
    signalCode: null,
  });

  return child;
}

function emitChildExit(
  child: TestChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit("exit", code, signal);
}

function configureTestDatabase(): ReturnType<typeof vi.fn> {
  const stop = vi.fn(async () => undefined);

  mocks.startBarePostgresTestDb.mockResolvedValue({
    databaseUrl: "postgres://test",
    stop,
  });
  mocks.prepareE2eDatabase.mockResolvedValue(undefined);

  return stop;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("E2E wrapper environment", () => {
  it("uses test mode only for migrations and seeding", () => {
    const environment = buildE2eMigrationEnvironment(
      { DB_URL: "postgres://old", NODE_ENV: "production", KEEP: "value" },
      "postgres://test",
    );

    expect(environment).toMatchObject({
      DB_URL: "postgres://test",
      NODE_ENV: "test",
      KEEP: "value",
    });
  });

  it("does not force the application server into test mode", () => {
    const environment = buildE2ePlaywrightEnvironment(
      { DB_URL: "postgres://old", NODE_ENV: "test", KEEP: "value" },
      "postgres://test",
    );

    expect(environment).toMatchObject({
      DB_URL: "postgres://test",
      KEEP: "value",
    });
    expect(environment.NODE_ENV).toBeUndefined();
  });

  it("replaces a caller worktree root with an invocation-scoped test root", () => {
    const environment = buildE2ePlaywrightEnvironment(
      {
        DB_URL: "postgres://old",
        MAISTER_WORKTREES_ROOT: "/operator/.maister/worktrees",
        NODE_ENV: "production",
      },
      "postgres://test",
    );

    expect(environment.MAISTER_WORKTREES_ROOT).toMatch(
      /maister-test-worktrees\/e2e\//,
    );
    expect(environment.MAISTER_WORKTREES_ROOT).not.toBe(
      "/operator/.maister/worktrees",
    );
  });

  it("cleans the invocation root after a successful Playwright completion", async () => {
    configureTestDatabase();
    const child = createChildProcess();

    mocks.spawn.mockReturnValue(child);

    const invocation = runE2eInvocation([]);

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    emitChildExit(child, 0, null);

    await expect(invocation).resolves.toBe(0);
    expect(mocks.cleanupTestWorktrees).toHaveBeenCalledWith(
      "/tmp/maister-test-worktrees/e2e/invocation",
    );
  });

  it("uses the separate live invocation root when the live Playwright config is selected", async () => {
    configureTestDatabase();
    const child = createChildProcess();

    mocks.spawn.mockReturnValue(child);

    const invocation = runE2eInvocation([
      "--config",
      "playwright.live.config.ts",
    ]);

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    emitChildExit(child, 0, null);

    await expect(invocation).resolves.toBe(0);
    expect(mocks.createTestWorktreesRoot).toHaveBeenCalledWith("e2e-live");
  });

  it("aborts the CLI controller when an E2E shutdown signal arrives", () => {
    const controller = new AbortController();
    const signalProcess = new EventEmitter() as EventEmitter &
      Pick<NodeJS.Process, "off" | "once">;
    const dispose = installE2eShutdownSignals(controller, signalProcess);

    signalProcess.emit("SIGTERM");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("SIGTERM");

    dispose();

    expect(signalProcess.listenerCount("SIGINT")).toBe(0);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "stops the database only after the Playwright process group exits from %s",
    async (shutdownSignal) => {
      const stop = configureTestDatabase();
      const child = createChildProcess();
      const controller = new AbortController();
      const killProcess = vi
        .spyOn(process, "kill")
        .mockImplementation(() => true);

      mocks.spawn.mockReturnValue(child);

      const invocation = runE2eInvocation([], process.env, controller.signal);

      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      expect(mocks.spawn).toHaveBeenCalledWith(
        "pnpm",
        expect.any(Array),
        expect.objectContaining({ detached: process.platform !== "win32" }),
      );

      controller.abort(shutdownSignal);

      await vi.waitFor(() =>
        expect(killProcess).toHaveBeenCalledWith(-12_345, shutdownSignal),
      );
      expect(child.kill).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();

      emitChildExit(child, null, shutdownSignal);

      await expect(invocation).rejects.toThrow(
        `interrupted by ${shutdownSignal}`,
      );
      expect(stop).toHaveBeenCalledOnce();
      expect(mocks.cleanupTestWorktrees).toHaveBeenCalledWith(
        "/tmp/maister-test-worktrees/e2e/invocation",
      );
    },
  );

  it("stops the database without preparing or spawning after startup is interrupted", async () => {
    const stop = vi.fn(async () => undefined);
    const controller = new AbortController();
    let resolveDatabase:
      | ((database: { databaseUrl: string; stop: typeof stop }) => void)
      | undefined;

    mocks.startBarePostgresTestDb.mockReturnValue(
      new Promise((resolve) => {
        resolveDatabase = resolve;
      }),
    );

    const invocation = runE2eInvocation([], process.env, controller.signal);

    controller.abort("SIGTERM");
    resolveDatabase?.({ databaseUrl: "postgres://test", stop });

    await expect(invocation).rejects.toThrow("interrupted by SIGTERM");
    expect(mocks.prepareE2eDatabase).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the database without spawning Playwright when preparation fails", async () => {
    const stop = configureTestDatabase();

    mocks.prepareE2eDatabase.mockRejectedValue(new Error("migration failed"));

    await expect(runE2eInvocation([])).rejects.toThrow("migration failed");

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.cleanupTestWorktrees).toHaveBeenCalledWith(
      "/tmp/maister-test-worktrees/e2e/invocation",
    );
  });

  it("cleans the invocation root when database startup fails", async () => {
    mocks.startBarePostgresTestDb.mockRejectedValue(
      new Error("database startup failed"),
    );

    await expect(runE2eInvocation([])).rejects.toThrow(
      "database startup failed",
    );

    expect(mocks.cleanupTestWorktrees).toHaveBeenCalledWith(
      "/tmp/maister-test-worktrees/e2e/invocation",
    );
  });

  it("retains the Playwright failure when cleanup also fails", async () => {
    configureTestDatabase();
    const child = createChildProcess();

    mocks.spawn.mockReturnValue(child);
    mocks.cleanupTestWorktrees.mockRejectedValueOnce(
      new Error("worktree cleanup failed"),
    );

    const invocation = runE2eInvocation([]);

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    emitChildExit(child, null, "SIGTERM");

    await expect(invocation).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof AggregateError)) return false;

      return error.errors.some(
        (cause: unknown) =>
          cause instanceof Error &&
          cause.message === "Playwright exited from signal SIGTERM",
      );
    });
  });
});
