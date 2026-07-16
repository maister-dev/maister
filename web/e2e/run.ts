import { spawn, type ChildProcess } from "node:child_process";
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

export function buildE2eMigrationEnvironment(
  environment: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  return { ...environment, DB_URL: databaseUrl, NODE_ENV: "test" };
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

function runPlaywright(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
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
  });
}

export async function runE2eInvocation(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<number> {
  const worktreesRoot = createTestWorktreesRoot(
    worktreeLaneForE2eArguments(arguments_),
  );
  let invocationError: unknown;
  let testDatabase: StartedPostgresTestDb | undefined;

  try {
    testDatabase = await startBarePostgresTestDb({
      databaseName: "maister_e2e",
      lane: "e2e",
    });
    throwIfE2eInvocationInterrupted(signal);

    await prepareE2eDatabase(
      testDatabase.databaseUrl,
      buildE2eMigrationEnvironment(environment, testDatabase.databaseUrl),
    );
    throwIfE2eInvocationInterrupted(signal);

    return await runPlaywright(
      arguments_,
      buildE2ePlaywrightEnvironment(
        environment,
        testDatabase.databaseUrl,
        worktreesRoot,
      ),
      signal,
    );
  } catch (error) {
    invocationError = error;

    throw error;
  } finally {
    const cleanupOperations: Promise<unknown>[] = [
      cleanupTestWorktrees(worktreesRoot),
    ];

    if (testDatabase !== undefined) {
      cleanupOperations.push(testDatabase.stop());
    }

    const cleanupResults = await Promise.allSettled(cleanupOperations);
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );

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
