import type { ChildProcess } from "node:child_process";
import type { LinuxApplicationOutcome } from "./linux-isolation-protocol";
import type { ProcessIdentity } from "./process-invocation";

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
  outcome: Promise<LinuxApplicationOutcome>;
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
  outcome?: Promise<LinuxApplicationOutcome>;
  gracefulSignal?(
    identity: ProcessIdentity,
    signal: NodeJS.Signals,
  ): Promise<void>;
  // Resolves when the process is serving. A returned string replaces the
  // provisional boot id and re-registers the process under it.
  ready(exited: Promise<number | null>): Promise<string | undefined>;
};

export async function startOwnedFixture(
  input: OwnedFixtureInput,
): Promise<OwnedFixture> {
  const { invocation, child, role, root, logFile } = input;
  const pid = child.pid ?? -1;
  const nativeOutcome = new Promise<LinuxApplicationOutcome>((resolve) => {
    child.once("close", (code, signal) =>
      resolve(
        code === null && signal === null
          ? { kind: "unobserved", reason: "status-unavailable" }
          : { kind: "observed", code, signal },
      ),
    );
  });
  const outcome = input.outcome ?? nativeOutcome;
  const exited = outcome.then((result) =>
    result.kind === "observed" ? result.code : null,
  );

  // Keep the public rejection observable without a pre-readiness unhandled rejection.
  void exited.catch(() => undefined);
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
  let identity: ProcessIdentity | undefined;

  try {
    identity = (
      await registerSpawnedProcess(invocation, registration(bootId), child)
    ).identity;

    const confirmed = await input.ready(exited);

    if (confirmed !== undefined && confirmed !== bootId) {
      bootId = confirmed;
      await registerProcess(invocation, registration(bootId), pid);
    }
  } catch (error) {
    const failures: unknown[] = [error];

    try {
      if (pid > 0) {
        await signalInvocationGroup(invocation, pid, "SIGKILL");
        await nativeOutcome;
        await assertInvocationGroupEmpty(invocation, pid);
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new Error(`${role} startup failed\n${await readLogTail(logFile)}`, {
      cause: new AggregateError(failures, `${role} startup/cleanup`),
    });
  }
  const capturedIdentity = identity;

  if (!capturedIdentity)
    throw new Error(
      "fixture startup completed without a registered process identity",
    );

  return {
    pid,
    get bootId() {
      return bootId;
    },
    exited,
    outcome,
    async kill(signal: NodeJS.Signals = "SIGKILL") {
      if (!leaderGone()) {
        if (signal !== "SIGKILL" && input.gracefulSignal)
          await input.gracefulSignal(capturedIdentity, signal);
        else await signalInvocationGroup(invocation, pid, signal);
        // Closure and namespace status are separate: a rejected status frame
        // must still contain the captured child and preserve its log.
        await Promise.race([
          nativeOutcome,
          new Promise<void>((resolve) => {
            setTimeout(resolve, input.killGraceMs).unref();
          }),
        ]);
        if (!leaderGone()) {
          await signalInvocationGroup(invocation, pid, "SIGKILL");
          await nativeOutcome;
        }
      }
      const failures: unknown[] = [];

      try {
        await outcome;
      } catch (error) {
        failures.push(error);
      }
      try {
        await assertInvocationGroupEmpty(invocation, pid);
      } catch (error) {
        failures.push(error);
      } finally {
        await preserveFixtureLog(invocation, logFile);
      }
      if (failures.length)
        throw new AggregateError(failures, `${role} status/cleanup failed`);
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
