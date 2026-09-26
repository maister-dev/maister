import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";

import { prepareE2eDatabase } from "./_seed/prepare-db";

import {
  cleanupTestWorktrees,
  createTestWorktreesRoot,
  type TestWorktreeLane,
} from "@/test-support/worktree-test-root";
import {
  startBarePostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  createInvocation,
  fixtureProcessEnvironment,
  registerProcess,
  registerSpawnedProcess,
  releaseInvocation,
  type Invocation,
  type ProcessRole,
} from "@/test-support/process-invocation";

const E2E_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const PLAYWRIGHT_SHUTDOWN_GRACE_MS = 5_000;
const E2E_INTERRUPTION_EXIT_CODES: Record<E2eShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const logger = pino({ name: "e2e-wrapper" });

export type E2eShutdownSignal = (typeof E2E_SHUTDOWN_SIGNALS)[number];

type E2eSignalProcess = Pick<NodeJS.Process, "off" | "once">;

export class E2eInvocationInterruptedError extends Error {
  readonly name = "E2eInvocationInterruptedError";

  constructor(readonly signal: E2eShutdownSignal) {
    super(`e2e invocation interrupted by ${signal}`);
  }
}

function shutdownSignalFromAbortReason(reason: unknown): E2eShutdownSignal {
  return reason === "SIGINT" ? "SIGINT" : "SIGTERM";
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalPlaywrightProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    process.kill(-child.pid, signal);

    return;
  }

  child.kill(signal);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onError = () => finish(true);
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function terminatePlaywrightChild(
  child: ChildProcess,
  signal: E2eShutdownSignal,
  graceMs = PLAYWRIGHT_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (childHasExited(child)) return;

  signalPlaywrightProcessTree(child, signal);

  if (await waitForChildExit(child, graceMs)) return;

  signalPlaywrightProcessTree(child, "SIGKILL");

  if (await waitForChildExit(child, graceMs)) return;

  throw new Error(
    `Playwright process group did not exit after ${signal} and SIGKILL`,
  );
}

function throwIfE2eInvocationInterrupted(
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;

  throw new E2eInvocationInterruptedError(
    shutdownSignalFromAbortReason(signal.reason),
  );
}

export function installE2eShutdownSignals(
  controller: AbortController,
  signalProcess: E2eSignalProcess = process,
): () => void {
  const handlers = E2E_SHUTDOWN_SIGNALS.map((signal) => {
    const handler = () => {
      logger.warn({ signal }, "[FIX:e2e-shutdown] shutdown requested");
      controller.abort(signal);
    };

    signalProcess.once(signal, handler);

    return { handler, signal };
  });

  return () => {
    for (const { handler, signal } of handlers) {
      signalProcess.off(signal, handler);
    }
  };
}

/**
 * The env the migrations AND the seeder run under.
 *
 * `MAISTER_WORKTREES_ROOT` belongs here as much as in the Playwright env: the
 * seeder builds real git worktrees for the fixtures that need one, and the
 * lifecycle service will only REMOVE a worktree that lives under the root
 * `worktreesRoot()` reports. Passing it to Playwright alone left the seeder
 * writing to a different place than the app would accept, so archive and drop
 * answered `409 PRECONDITION "worktreePath is outside allowed root"` — which a
 * spec waiting on a 200 can only observe as a timeout.
 */
export function buildE2eMigrationEnvironment(
  environment: NodeJS.ProcessEnv,
  databaseUrl: string,
  worktreesRoot = createTestWorktreesRoot("e2e"),
): NodeJS.ProcessEnv {
  return {
    ...environment,
    DB_URL: databaseUrl,
    NODE_ENV: "test",
    MAISTER_WORKTREES_ROOT: worktreesRoot,
  };
}

export function buildE2ePlaywrightEnvironment(
  environment: NodeJS.ProcessEnv,
  databaseUrl: string,
  worktreesRoot = createTestWorktreesRoot("e2e"),
): NodeJS.ProcessEnv {
  const childEnvironment = {
    ...environment,
    DB_URL: databaseUrl,
    MAISTER_WORKTREES_ROOT: worktreesRoot,
  };

  Reflect.deleteProperty(childEnvironment, "NODE_ENV");

  return childEnvironment;
}

function worktreeLaneForE2eArguments(
  arguments_: readonly string[],
): TestWorktreeLane {
  return arguments_.includes("playwright.live.config.ts") ? "e2e-live" : "e2e";
}

type E2eInvocation = {
  invocation: Invocation;
  environment: Record<string, string>;
};

function e2eProcessRecord(
  invocation: Invocation,
  lane: TestWorktreeLane,
  role: ProcessRole,
) {
  return {
    role,
    caseName: lane,
    rootRole: "invocation",
    root: null,
    bootId: invocation.id,
    logFile: null,
  };
}

/**
 * The lane's process-ownership invocation, minted here and never adopted from
 * the caller: a caller's ID may be shared, and this wrapper's final sweep kills
 * whatever carries it. Every process Playwright starts inherits the tag, which
 * is what lets a fixture such as the real supervisor register what it spawns
 * and the sweep find whatever outlives the run.
 */
async function mintE2eInvocation(
  environment: NodeJS.ProcessEnv,
  lane: TestWorktreeLane,
): Promise<E2eInvocation> {
  const invocation = await createInvocation(
    path.join(environment.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(), "maister-e2e"),
  );
  const invocationEnvironment = await fixtureProcessEnvironment(invocation);

  await registerProcess(
    invocation,
    e2eProcessRecord(invocation, lane, "runner"),
    process.pid,
  );
  logger.info(
    { invocationId: invocation.id, ledger: invocation.directory, lane },
    "e2e invocation minted",
  );

  return { invocation, environment: invocationEnvironment };
}

function runPlaywright(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  registerChild: (child: ChildProcess) => Promise<unknown>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "playwright", "test", ...arguments_], {
      detached: process.platform !== "win32",
      env: environment,
      stdio: "inherit",
    });
    let interruption: E2eShutdownSignal | undefined;

    const removeAbortListener = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (interruption !== undefined) return;

      interruption = shutdownSignalFromAbortReason(signal?.reason);
      logger.warn(
        { pid: child.pid ?? null, signal: interruption },
        "[FIX:e2e-shutdown] stopping Playwright process group before database teardown",
      );
      void terminatePlaywrightChild(child, interruption).catch(
        (error: unknown) => {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              pid: child.pid ?? null,
              signal: interruption,
            },
            "[FIX:e2e-shutdown] Playwright termination failed",
          );
        },
      );
    };

    child.once("error", (error) => {
      removeAbortListener();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeAbortListener();

      if (interruption !== undefined) {
        reject(new E2eInvocationInterruptedError(interruption));

        return;
      }

      if (signal !== null) {
        reject(new Error(`Playwright exited from signal ${signal}`));

        return;
      }

      resolve(code ?? 1);
    });

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    // A child whose ownership cannot be verified must not run unwatched; the
    // caller's terminal sweep reaps it by its tag. When the child has already
    // exited, its exit settled this promise first, so the real outcome wins.
    void registerChild(child).catch((error: unknown) => {
      removeAbortListener();
      reject(error);
    });
  });
}

export async function runE2eInvocation(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<number> {
  const lane = worktreeLaneForE2eArguments(arguments_);
  const worktreesRoot = createTestWorktreesRoot(lane);
  let invocationError: unknown;
  let e2eInvocation: E2eInvocation | undefined;
  let testDatabase: StartedPostgresTestDb | undefined;

  try {
    e2eInvocation = await mintE2eInvocation(environment, lane);
    testDatabase = await startBarePostgresTestDb({
      databaseName: "maister_e2e",
      lane: "e2e",
    });
    throwIfE2eInvocationInterrupted(signal);

    await prepareE2eDatabase(
      testDatabase.databaseUrl,
      // The SAME root the Playwright env below gets — seeding somewhere the
      // app cannot reach is the whole defect this argument closes.
      buildE2eMigrationEnvironment(
        environment,
        testDatabase.databaseUrl,
        worktreesRoot,
      ),
    );
    throwIfE2eInvocationInterrupted(signal);

    const { invocation } = e2eInvocation;

    return await runPlaywright(
      arguments_,
      {
        ...buildE2ePlaywrightEnvironment(
          environment,
          testDatabase.databaseUrl,
          worktreesRoot,
        ),
        ...e2eInvocation.environment,
      },
      signal,
      (child) =>
        registerSpawnedProcess(
          invocation,
          e2eProcessRecord(invocation, lane, "playwright"),
          child,
        ),
    );
  } catch (error) {
    invocationError = error;

    throw error;
  } finally {
    // Owned processes, containers and roots go before the database and the
    // worktrees root; the release never throws by contract, and the catch keeps
    // the database teardown reachable if it ever does.
    const invocationCleanupErrors =
      e2eInvocation === undefined
        ? []
        : await releaseInvocation(
            e2eInvocation.invocation,
            "e2e invocation",
          ).catch((error: unknown) => [error]);
    const cleanupOperations: Promise<unknown>[] = [
      cleanupTestWorktrees(worktreesRoot),
    ];

    if (testDatabase !== undefined) {
      cleanupOperations.push(testDatabase.stop());
    }

    const cleanupResults = await Promise.allSettled(cleanupOperations);
    const cleanupErrors = [
      ...invocationCleanupErrors,
      ...cleanupResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ];

    if (cleanupErrors.length > 0) {
      if (invocationError !== undefined) {
        throw new AggregateError(
          [invocationError, ...cleanupErrors],
          "e2e invocation and cleanup failed",
        );
      }

      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }

      throw new AggregateError(cleanupErrors, "e2e cleanup failed");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const removeShutdownSignals = installE2eShutdownSignals(controller);

  void runE2eInvocation(process.argv.slice(2), process.env, controller.signal)
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        if (error instanceof E2eInvocationInterruptedError) {
          process.exitCode = E2E_INTERRUPTION_EXIT_CODES[error.signal];

          return;
        }

        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "e2e wrapper failed",
        );
        process.stderr.write("e2e wrapper failed; inspect preceding logs\n");
        process.exitCode = 1;
      },
    )
    .finally(removeShutdownSignals);
}
