import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getContainerRuntimeClient } from "testcontainers";
import { expect, it } from "vitest";

import { assertBoundedReaperAcquisition } from "../reaper-acquisition-control";
import {
  assertInvocationGroupEmpty,
  createInvocation,
  fixtureProcessEnvironment,
  FIXTURE_WATCHDOG,
  INVOCATION_CONTAINER_LABEL,
  invocationFromEnvironment,
  registerSpawnedProcess,
  releaseInvocation,
  signalInvocationProcess,
  type Invocation,
  type ProcessIdentity,
} from "../process-invocation";

type WorkerReady = Readonly<{
  containerId: string;
  reaperId: string;
  value: number;
}>;
type Worker = Readonly<{
  child: ChildProcess;
  identity: ProcessIdentity;
  ready: Promise<WorkerReady>;
  exited: Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >;
}>;

/** Direct integration uses the same production lane runner; only it leases Ryuk. */
async function runNestedControl(): Promise<void> {
  const directory = await mkdtemp(
    join(
      process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
      "maister-reaper-direct-",
    ),
  );
  // Mint the exact inner capability before spawn so even an exit before IPC
  // leaves its processes, allocations and roots available for terminal cleanup.
  const invocation = await createInvocation(directory);
  const child = spawn(
    process.execPath,
    [
      "--import",
      FIXTURE_WATCHDOG,
      fileURLToPath(
        new URL("../fixtures/reaper-lane-runner.mjs", import.meta.url),
      ),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        ...(await fixtureProcessEnvironment(invocation)),
        MAISTER_TEST_EVIDENCE_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  let reportPath: string | undefined;
  const recordOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-64 * 1024);
  };

  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);
  child.once("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "event" in message &&
      message.event === "completed" &&
      "reportPath" in message &&
      typeof message.reportPath === "string"
    )
      reportPath = message.reportPath;
  });
  const exited = new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  void exited.catch(() => {});
  let identity: ProcessIdentity | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failure: unknown;

  try {
    identity = (
      await registerSpawnedProcess(
        invocation,
        {
          role: "fixture",
          caseName: "O-reaper-direct",
          rootRole: "runner",
          root: null,
          bootId: invocation.id,
          logFile: null,
        },
        child,
      )
    ).identity;
    const status = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `nested reaper runner deadline expired; evidence: ${directory}`,
              ),
            ),
          50_000,
        );
      }),
    ]);

    expect(status, output).toEqual({ code: 0, signal: null });
    expect(
      reportPath?.startsWith(`${directory}/maister-ab-isolation-`) &&
        reportPath.endsWith("/vitest.json"),
      output,
    ).toBe(true);
  } catch (error) {
    failure = error;
  } finally {
    if (timer) clearTimeout(timer);
    const cleanupErrors: unknown[] = [];

    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (identity)
          await signalInvocationProcess(invocation, identity, "SIGTERM");
        else child.kill("SIGTERM");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          if (identity)
            await signalInvocationProcess(invocation, identity, "SIGKILL");
          else child.kill("SIGKILL");
          await exited;
        }
      }
      if (identity) await assertInvocationGroupEmpty(invocation, identity.pgid);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await writeFile(join(directory, "nested-runner.log"), output);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      cleanupErrors.push(
        ...(await releaseInvocation(invocation, "direct reaper control")),
      );
    } else {
      cleanupErrors.push(
        new Error(
          "refusing inner invocation release while its runner is alive",
        ),
      );
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        "nested reaper control cleanup failed",
      );
  }
  if (failure) throw failure;
}

async function startWorker(
  invocation: Invocation,
  deadline: number,
): Promise<Worker> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      FIXTURE_WATCHDOG,
      fileURLToPath(
        new URL("../fixtures/reaper-database-worker.mjs", import.meta.url),
      ),
    ],
    {
      detached: true,
      env: { ...process.env, ...(await fixtureProcessEnvironment(invocation)) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16 * 1024);
  });
  const exited = new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<WorkerReady>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `real database worker readiness deadline expired\n${diagnostics}`,
          ),
        ),
      Math.max(1, deadline - Date.now()),
    );

    child.once("message", (message: unknown) => {
      clearTimeout(timer);
      if (
        typeof message !== "object" ||
        message === null ||
        !("event" in message) ||
        message.event !== "ready" ||
        !("containerId" in message) ||
        typeof message.containerId !== "string" ||
        !/^[a-f0-9]{64}$/u.test(message.containerId) ||
        !("reaperId" in message) ||
        typeof message.reaperId !== "string" ||
        !/^[a-f0-9]{64}$/u.test(message.reaperId) ||
        !("value" in message) ||
        typeof message.value !== "number"
      ) {
        reject(new Error("invalid real database worker readiness"));

        return;
      }
      resolve({
        containerId: message.containerId,
        reaperId: message.reaperId,
        value: message.value,
      });
    });
    void exited.then(
      (status) => {
        clearTimeout(timer);
        reject(
          new Error(
            `database worker exited before readiness: ${JSON.stringify(status)}\n${diagnostics}`,
          ),
        );
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

  // Registration may fail before readiness; every rejection remains observed.
  void ready.catch(() => {});
  void exited.catch(() => {});
  try {
    const record = await registerSpawnedProcess(
      invocation,
      {
        role: "fixture",
        caseName: "O-reaper",
        rootRole: "database",
        root: null,
        bootId: invocation.id,
        logFile: null,
      },
      child,
    );

    return { child, identity: record.identity, ready, exited };
  } catch (error) {
    // The direct spawn remains ours before registration. Its recorded container
    // allocation still belongs to the actual lane's terminal label cleanup.
    try {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "database worker registration and containment failed",
      );
    }
    throw error;
  }
}

it("O-reaper: the owning runner retains real Ryuk across worker death and the next database start", async () => {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("reaper control requires the real A/B runner");
  // A normal Vitest run allocates a worktree identity but has no owning lane
  // ledger/parent contract. Enter the real runner once instead of acquiring a
  // lease in this worker, which would hide removal of runner enforcement.
  if (
    !process.env.MAISTER_TEST_PROCESS_LEDGER ||
    !process.env.MAISTER_TEST_PROCESS_OWNER
  ) {
    await runNestedControl();

    return;
  }
  await assertBoundedReaperAcquisition(invocation);
  const client = await getContainerRuntimeClient();
  const workers: Worker[] = [];
  const containers: string[] = [];
  const deadline = Date.now() + 45_000;
  let failure: unknown;

  try {
    const first = await startWorker(invocation, deadline);

    workers.push(first);
    const firstReady = await first.ready;

    containers.push(firstReady.containerId);
    expect(firstReady.value).toBe(19);
    await signalInvocationProcess(invocation, first.identity, "SIGKILL");
    expect(await first.exited).toEqual({ code: null, signal: "SIGKILL" });
    await assertInvocationGroupEmpty(invocation, first.identity.pgid);
    // Installed Ryuk 0.11.0 retires after its default 10-second reconnect grace.
    // With only the disposable worker holding a socket, both objects disappear.
    await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
    const running = await client.container.list();

    expect(
      running.some(
        (container) =>
          container.Id === firstReady.reaperId && container.State === "running",
      ),
      "the owning runner must retain the same live reaper after a worker dies",
    ).toBe(true);
    expect(
      running.some(
        (container) =>
          container.Id === firstReady.containerId &&
          container.State === "running",
      ),
      "worker death must not let shared Ryuk collect the next worker's session",
    ).toBe(true);
    const second = await startWorker(invocation, deadline);

    workers.push(second);
    const secondReady = await second.ready;

    containers.push(secondReady.containerId);
    expect(secondReady).toMatchObject({
      reaperId: firstReady.reaperId,
      value: 19,
    });
    second.child.send("stop");
    expect(await second.exited).toEqual({ code: 0, signal: null });
    await assertInvocationGroupEmpty(invocation, second.identity.pgid);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];

    for (const worker of workers) {
      try {
        if (
          worker.child.exitCode === null &&
          worker.child.signalCode === null
        ) {
          await signalInvocationProcess(invocation, worker.identity, "SIGKILL");
          await worker.exited;
        }
        await assertInvocationGroupEmpty(invocation, worker.identity.pgid);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const id of containers) {
      try {
        const remaining = (await client.container.list()).find(
          (container) => container.Id === id,
        );

        if (!remaining) continue;
        if (remaining.Labels[INVOCATION_CONTAINER_LABEL] !== invocation.id)
          throw new Error("refusing cleanup of a foreign database container");
        await client.container.getById(id).remove({ force: true, v: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        "real reaper control cleanup failed",
      );
  }
  if (failure) throw failure;
}, 60_000);
