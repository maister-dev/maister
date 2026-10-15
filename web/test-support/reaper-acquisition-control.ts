import type { Socket } from "node:net";

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertInvocationGroupEmpty,
  fixtureProcessEnvironment,
  FIXTURE_WATCHDOG,
  logInvocation,
  registerSpawnedProcess,
  signalInvocationProcess,
  type Invocation,
  type ProcessIdentity,
} from "./process-invocation";

type AcquisitionOutcome = Readonly<{
  outcome: string;
  name: string;
  message: string;
  durationMs: number;
}>;
type AcquisitionScenario = Readonly<{
  invocation: Invocation;
  name: string;
  timeoutMs: number;
  observe: (
    child: ChildProcess,
    outcome: Promise<AcquisitionOutcome>,
  ) => Promise<AcquisitionOutcome>;
}>;

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  subject: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${subject} deadline expired`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function configuredDockerSocket(): Promise<string> {
  const endpoint =
    process.env.DOCKER_HOST ??
    (
      await promisify(execFile)(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { timeout: 10_000 },
      )
    ).stdout.trim();

  if (!endpoint.startsWith("unix:///"))
    throw new Error(
      "real reaper acquisition controls require the configured Unix Docker endpoint",
    );

  return endpoint.slice("unix://".length);
}

/** Hold a real Docker /info response; every byte and other route comes from Docker. */
async function runHeldInfoControl(
  scenario: AcquisitionScenario,
): Promise<void> {
  const socketPath = await configuredDockerSocket();
  const processEnvironment = await fixtureProcessEnvironment(
    scenario.invocation,
  );
  const sockets = new Set<Socket>();
  const upstreams = new Set<ReturnType<typeof request>>();
  const paths: string[] = [];
  const held: Array<() => void> = [];
  let holding = true;
  let proxyFailure: Error | undefined;
  let infoSeenResolve: (() => void) | undefined;
  const infoSeen = new Promise<void>((resolve) => {
    infoSeenResolve = resolve;
  });
  const server = createServer((incoming, outgoing: ServerResponse) => {
    const path = incoming.url ?? "/";

    paths.push(path);
    const upstream = request(
      { socketPath, method: incoming.method, path, headers: incoming.headers },
      (response) => {
        response.once("error", (error) => {
          proxyFailure = error;
          outgoing.destroy(error);
        });
        const statusCode = response.statusCode;

        if (statusCode === undefined) {
          proxyFailure = new Error(
            "real Docker response omitted its status code",
          );
          outgoing.destroy(proxyFailure);

          return;
        }
        const forward = (): void => {
          outgoing.writeHead(statusCode, response.headers);
          response.pipe(outgoing);
        };

        if (/\/info$/u.test(path) && holding) {
          if (response.statusCode !== 200)
            proxyFailure = new Error(
              `real Docker /info returned ${response.statusCode}`,
            );
          held.push(forward);
          infoSeenResolve?.();
        } else forward();
      },
    );

    upstreams.add(upstream);
    upstream.once("close", () => upstreams.delete(upstream));
    upstream.once("error", (error) => {
      proxyFailure = error;
      outgoing.destroy(error);
    });
    incoming.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("real Docker response control has no address");
  const child = spawn(
    process.execPath,
    [
      "--import",
      FIXTURE_WATCHDOG,
      fileURLToPath(
        new URL("./fixtures/reaper-acquisition-worker.mjs", import.meta.url),
      ),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        ...processEnvironment,
        DOCKER_HOST: `tcp://127.0.0.1:${address.port}`,
        TESTCONTAINERS_HOST_OVERRIDE: "127.0.0.1",
        MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS: String(scenario.timeoutMs),
      },
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
  let settledResolve: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settledResolve = resolve;
  });
  const outcome = new Promise<AcquisitionOutcome>((resolve, reject) => {
    child.on("message", (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("event" in message)
      ) {
        reject(new Error("invalid reaper acquisition metadata"));

        return;
      }
      if (message.event === "client-settled") {
        settledResolve?.();

        return;
      }
      if (
        message.event !== "outcome" ||
        !("outcome" in message) ||
        typeof message.outcome !== "string" ||
        !("name" in message) ||
        typeof message.name !== "string" ||
        !("message" in message) ||
        typeof message.message !== "string" ||
        !("durationMs" in message) ||
        typeof message.durationMs !== "number"
      ) {
        reject(new Error("invalid reaper acquisition outcome"));

        return;
      }
      resolve({
        outcome: message.outcome,
        name: message.name,
        message: message.message,
        durationMs: message.durationMs,
      });
    });
    void exited.then(
      (status) =>
        reject(
          new Error(
            `reaper acquisition worker exited: ${JSON.stringify(status)}\n${diagnostics}`,
          ),
        ),
      reject,
    );
  });

  void exited.catch(() => {});
  void outcome.catch(() => {});
  let identity: ProcessIdentity | undefined;
  let failure: unknown;

  try {
    identity = (
      await registerSpawnedProcess(
        scenario.invocation,
        {
          role: "fixture",
          caseName: scenario.name,
          rootRole: "reaper-acquisition",
          root: null,
          bootId: scenario.invocation.id,
          logFile: null,
        },
        child,
      )
    ).identity;
    await bounded(infoSeen, 2_500, "real Docker /info observation");
    const result = await scenario.observe(child, outcome);

    assert.equal(proxyFailure, undefined);
    assert.equal(result.outcome, "rejected");
    assert.equal(result.name, "LaneReaperUnavailableError");
    holding = false;
    for (const forward of held) forward();
    await bounded(settled, 2_500, "late real Docker client acquisition");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(
      paths.some((path) => /\/containers\/json(?:\?|$)/u.test(path)),
      false,
      "an aborted Docker discovery must never start a late reaper lookup",
    );
    assert.equal(proxyFailure, undefined);
    child.send("release");
    assert.deepEqual(
      await bounded(exited, 2_500, "acquisition worker release"),
      { code: 0, signal: null },
    );
    logInvocation(scenario.invocation, "reaper-acquisition-control", {
      role: "fixture",
      caseName: scenario.name,
      pid: process.pid,
      rootRole: "reaper-acquisition",
      outcome: "passed",
      durationMs: result.durationMs,
      realInfoRequests: paths.filter((path) => /\/info$/u.test(path)).length,
      lateReaperLookup: false,
    });
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];

    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (identity)
          await signalInvocationProcess(
            scenario.invocation,
            identity,
            "SIGKILL",
          );
        else child.kill("SIGKILL");
        await bounded(exited, 2_500, "acquisition worker containment");
      }
      if (identity)
        await assertInvocationGroupEmpty(scenario.invocation, identity.pgid);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await writeFile(
        join(scenario.invocation.directory, `${scenario.name}.log`),
        diagnostics,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        "real reaper acquisition control cleanup failed",
      );
  }
  if (failure) throw failure;
}

export async function assertBoundedReaperAcquisition(
  invocation: Invocation,
): Promise<void> {
  await runHeldInfoControl({
    invocation,
    name: "reaper-acquisition-deadline",
    timeoutMs: 500,
    observe: async (_child, outcome) => {
      const result = await bounded(
        outcome,
        1_500,
        "reaper acquisition deadline rejection",
      );

      assert.match(result.message, /deadline|timed out/u);
      assert(
        result.durationMs < 1_500,
        "configured acquisition deadline must bound the helper",
      );

      return result;
    },
  });
  await runHeldInfoControl({
    invocation,
    name: "reaper-acquisition-owner-abort",
    timeoutMs: 5_000,
    observe: async (child, outcome) => {
      const interruptedAt = Date.now();

      child.send("abort");
      const result = await bounded(
        outcome,
        1_000,
        "owner interruption rejection",
      );

      assert.match(result.message, /aborted/u);
      assert(
        Date.now() - interruptedAt < 1_000,
        "owner interruption must reject before the configured deadline",
      );

      return result;
    },
  });
}
