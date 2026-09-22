import type { ChildProcess } from "node:child_process";

import {
  assertInvocationGroupEmpty,
  fixtureLogTail,
  logInvocation,
  preserveFixtureLog,
  readLogTail,
  registerProcess,
  registerSpawnedProcess,
  signalInvocationGroup,
  type Invocation,
} from "./process-invocation";

// The half of a REAL fixture process that is identical for the supervisor and
// the web: register it under the invocation before anything can outlive the
// test, fail its startup loudly with the log tail, and kill it as a GROUP with
// bounded escalation, asserting nothing survives. Only the role, the readiness
// probe and the grace window differ — everything below used to exist twice.

export type OwnedFixture = {
  pid: number;
  bootId: string;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  logTail(maxBytes: number): Promise<string>;
};

export type OwnedFixtureInput = {
  invocation: Invocation;
  child: ChildProcess;
  role: "supervisor" | "web";
  root: string;
  logFile: string;
  bootId: string;
  killGraceMs: number;
  // Resolves when the process is serving. A returned string replaces the
  // provisional boot id and re-registers the process under it.
  ready(exited: Promise<number | null>): Promise<string | undefined>;
};

export async function startOwnedFixture(
  input: OwnedFixtureInput,
): Promise<OwnedFixture> {
  const { invocation, child, role, root, logFile } = input;
  const pid = child.pid ?? -1;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const leaderGone = () => child.exitCode !== null || child.signalCode !== null;
  const caseName = () => process.env.MAISTER_TEST_CASE_NAME ?? "fixture";
  const registration = (bootId: string) => ({
    role,
    caseName: caseName(),
    rootRole: role,
    root,
    bootId,
    logFile,
  });
  let bootId = input.bootId;

  try {
    await registerSpawnedProcess(invocation, registration(bootId), child);

    const confirmed = await input.ready(exited);

    if (confirmed !== undefined && confirmed !== bootId) {
      bootId = confirmed;
      await registerProcess(invocation, registration(bootId), pid);
    }
  } catch (error) {
    const failures: unknown[] = [error];

    try {
      if (pid > 0) await signalInvocationGroup(invocation, pid, "SIGKILL");
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new Error(`${role} startup failed\n${await readLogTail(logFile)}`, {
      cause: new AggregateError(failures, `${role} startup/cleanup`),
    });
  }

  return {
    pid,
    get bootId() {
      return bootId;
    },
    exited,
    async kill(signal: NodeJS.Signals = "SIGKILL") {
      if (!leaderGone()) {
        await signalInvocationGroup(invocation, pid, signal);
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            setTimeout(resolve, input.killGraceMs).unref();
          }),
        ]);
        if (!leaderGone()) {
          await signalInvocationGroup(invocation, pid, "SIGKILL");
          await exited;
        }
      }
      try {
        await assertInvocationGroupEmpty(invocation, pid);
      } finally {
        await preserveFixtureLog(invocation, logFile);
      }
      logInvocation(
        invocation,
        signal === "SIGKILL" ? "fixture-kill" : "fixture-stop",
        {
          role,
          caseName: caseName(),
          pid,
          pgid: pid,
          rootRole: role,
          bootId,
          signal,
          outcome: "stopped",
        },
      );
    },
    async logTail(maxBytes: number) {
      try {
        return await fixtureLogTail(invocation, logFile, maxBytes);
      } catch (err) {
        return `<log unreadable: ${err instanceof Error ? err.message : String(err)}>`;
      }
    },
  };
}

// A restart binds the same port, and the kernel may hold it briefly after a
// SIGKILL, so the bind is retried rather than raced.
export async function retryFixtureStart<T>(
  start: () => Promise<T>,
): Promise<T> {
  let last: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await start();
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
