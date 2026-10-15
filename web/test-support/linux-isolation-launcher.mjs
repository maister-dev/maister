import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeSync } from "node:fs";
import { promisify } from "node:util";

import {
  LINUX_CHILD,
  linuxApplicationEnvironment,
  linuxSandboxArgs,
  revalidateLinuxIsolationPolicy,
  IsolationPolicyError,
} from "./linux-isolation.ts";
import {
  consumeLinuxFrames,
  decodeLinuxChildFrame,
  decodeLinuxCommand,
  decodeLinuxIsolationPolicy,
  serializeLinuxIsolationPolicy,
  IsolationProtocolError,
} from "./linux-isolation-protocol.ts";
import {
  findProcessIdentity,
  InvocationOwnershipError,
  logInvocation,
  processIdentity,
  readProcessSnapshot,
  registerProcess,
  registerSpawnedProcess,
  sameProcess,
  signalInvocationProcess,
} from "./process-invocation.ts";
import { IsolationUnavailableError } from "./process-isolation.ts";

const readFileAsync = promisify(readFile);
const policy = decodeLinuxIsolationPolicy(process.argv[2] ?? "");
const command = decodeLinuxCommand(process.argv[3] ?? "");
const invocation = policy.invocation;

/** @param {import('./linux-isolation-protocol.ts').LinuxLauncherFrame} frame */
function status(frame) {
  writeSync(3, `${JSON.stringify(frame)}\n`);
}

/** @param {number} pid @returns {Promise<readonly number[]>} */
async function namespacePids(pid) {
  const value = await readFileAsync(`/proc/${pid}/status`, "utf8");
  const ids = /^NSpid:\s+([\d\t ]+)$/m.exec(value);

  if (!ids)
    throw new InvocationOwnershipError(
      "namespace process has no inspectable NSpid",
    );
  return ids[1].trim().split(/\s+/).map(Number);
}

/** @param {number} reaperPid @param {number} bridgePid @param {number} appPid */
async function applicationIdentity(reaperPid, bridgePid, appPid) {
  const reaper = await processIdentity(invocation, reaperPid);
  const processes = await readProcessSnapshot(invocation);
  const candidates = processes.filter(
    (entry) => entry.owned && entry.inspected && !entry.zombie,
  );
  let bridge;

  for (const candidate of candidates.filter(
    (entry) => entry.ppid === reaper.pid,
  )) {
    const ids = await namespacePids(candidate.pid);

    if (ids.length >= 2 && ids.at(-1) === bridgePid) {
      if (bridge)
        throw new InvocationOwnershipError(
          "ambiguous namespace bridge identity",
        );
      bridge = candidate;
    }
  }
  if (!bridge)
    throw new InvocationOwnershipError(
      "namespace bridge could not be verified",
    );
  let application;

  for (const candidate of candidates.filter(
    (entry) => entry.ppid === bridge.pid,
  )) {
    const ids = await namespacePids(candidate.pid);

    if (ids.length >= 2 && ids.at(-1) === appPid) {
      if (application)
        throw new InvocationOwnershipError(
          "ambiguous namespace application identity",
        );
      application = candidate;
    }
  }
  if (!application)
    throw new InvocationOwnershipError(
      "namespace application could not be verified",
    );
  for (const identity of [reaper, bridge, application]) {
    if (
      !identity.owned ||
      !identity.inspected ||
      !sameProcess(identity, await processIdentity(invocation, identity.pid))
    )
      throw new InvocationOwnershipError(
        "namespace identity changed before registration",
      );
    await registerProcess(
      invocation,
      {
        role: "fixture",
        caseName: process.env.MAISTER_TEST_CASE_NAME ?? "linux-fixture",
        rootRole: "linux-namespace",
        root: null,
        bootId: `${identity.pid}:${identity.started}`,
        logFile: null,
      },
      identity.pid,
    );
  }

  return application;
}

/** @param {import('./process-invocation.ts').ProcessIdentity} root @param {NodeJS.Signals} signal */
async function forward(root, signal) {
  const current = await findProcessIdentity(invocation, root.pid);

  if (!current) return;
  if (!sameProcess(root, current) || !current.owned || !current.inspected)
    throw new InvocationOwnershipError(
      "application identity changed before signal forwarding",
    );
  const processes = await readProcessSnapshot(invocation);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const descendants = processes
    .filter((entry) => {
      let ancestor = entry;

      for (let depth = 0; depth < 64; depth++) {
        if (ancestor.pid === root.pid) return true;
        const parent = byPid.get(ancestor.ppid);

        if (!parent) return false;
        ancestor = parent;
      }
      throw new InvocationOwnershipError(
        "application ancestry exceeded its bound",
      );
    })
    .filter((entry) => !entry.zombie);

  if (descendants.some((entry) => !entry.owned || !entry.inspected))
    throw new InvocationOwnershipError(
      "refusing to signal an unverifiable application subtree",
    );
  for (const entry of descendants.reverse())
    await signalInvocationProcess(invocation, entry, signal);
}

/** @type {import('./process-invocation.ts').ProcessIdentity | undefined} */
let application;
/** @type {NodeJS.Signals | undefined} */
let pendingSignal;
/** @type {Error | undefined} */
let failure;
/** @type {import('./linux-isolation-protocol.ts').LinuxApplicationOutcome | undefined} */
let outcome;
/** @type {import('./process-invocation.ts').ProcessIdentity | undefined} */
let monitorIdentity;
/** @type {import('node:child_process').ChildProcess | undefined} */
let monitor;
/** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}> | undefined} */
let monitorClosed;
let processing = Promise.resolve();

/** @param {unknown} error */
async function fail(error) {
  failure ??= error instanceof Error ? error : new Error(String(error));
  if (monitorIdentity) {
    try {
      await signalInvocationProcess(invocation, monitorIdentity, "SIGKILL");
    } catch (cleanupError) {
      failure = new AggregateError(
        [failure, cleanupError],
        "isolation failure and monitor containment refusal",
      );
    }
  }
}

/** @param {NodeJS.Signals} signal */
function receiveSignal(signal) {
  if (!application) {
    pendingSignal = signal;
    return;
  }
  processing = processing.then(() => forward(application, signal)).catch(fail);
}

const onTerm = () => receiveSignal("SIGTERM");
const onInt = () => receiveSignal("SIGINT");

process.on("SIGTERM", onTerm);
process.on("SIGINT", onInt);

try {
  revalidateLinuxIsolationPolicy(policy);
  const sandboxArgs = linuxSandboxArgs(policy);

  if (process.env.LOG_LEVEL === "debug" || process.env.LOG_LEVEL === "trace")
    logInvocation(invocation, "linux-isolation-policy", {
      level: "debug",
      role: "fixture",
      rootRole: "linux-namespace",
      pid: process.pid,
      policyDigest: createHash("sha256")
        .update(serializeLinuxIsolationPolicy(policy))
        .digest("hex"),
      readOnlyMounts: policy.mounts.filter(
        (mount) => mount.access === "read-only",
      ).length,
      writableMounts: policy.mounts.filter(
        (mount) => mount.access === "writable",
      ).length,
      deniedRoots: policy.deniedRoots.length,
      protectedFiles: policy.protectedFiles.length,
      dependencyLinks: policy.symlinks.length,
      options: sandboxArgs
        .filter((argument) => argument.startsWith("--"))
        .join(","),
    });
  monitor = spawn(
    "/usr/bin/bwrap",
    [
      ...sandboxArgs,
      "--json-status-fd",
      "3",
      "--",
      process.execPath,
      "--disable-sigusr1",
      LINUX_CHILD,
      serializeLinuxIsolationPolicy(policy),
      JSON.stringify(command),
    ],
    {
      cwd: policy.cwd,
      env: linuxApplicationEnvironment(policy, process.env),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  /** @type {Error | undefined} */
  let spawnFailure;

  monitorClosed = new Promise((resolve) => {
    monitor.once("close", (code, signal) => resolve({ code, signal }));
    monitor.once("error", (error) => {
      spawnFailure = error;
    });
  });
  let reaperPid;
  let statusPending = "";
  let childPending = "";
  let stderr = "";
  let exitStatusSeen = false;

  monitor.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8192);
    writeSync(2, chunk);
  });
  monitor.stdio[3].on("data", (chunk) => {
    try {
      const frames = consumeLinuxFrames(statusPending, chunk);

      statusPending = frames.pending;
      for (const line of frames.lines) {
        const value = JSON.parse(line);

        if (
          value &&
          typeof value === "object" &&
          Number.isSafeInteger(value["child-pid"]) &&
          value["child-pid"] > 1 &&
          reaperPid === undefined &&
          value["exit-code"] === undefined &&
          !exitStatusSeen
        )
          reaperPid = value["child-pid"];
        else if (
          value &&
          typeof value === "object" &&
          Number.isSafeInteger(value["exit-code"]) &&
          value["exit-code"] >= 0 &&
          value["exit-code"] <= 255 &&
          !exitStatusSeen &&
          value["child-pid"] === undefined
        )
          exitStatusSeen = true;
        else
          throw new IsolationProtocolError("invalid Bubblewrap status record");
      }
    } catch (error) {
      processing = processing.then(() => fail(error));
    }
  });
  monitor.stdout.on("data", (chunk) => {
    try {
      const frames = consumeLinuxFrames(childPending, chunk);

      childPending = frames.pending;
      for (const line of frames.lines) {
        const frame = decodeLinuxChildFrame(line);

        processing = processing
          .then(async () => {
            if (frame.type === "ready") {
              if (application || reaperPid === undefined)
                throw new IsolationProtocolError(
                  "namespace ready identity is absent or duplicated",
                );
              revalidateLinuxIsolationPolicy(policy);
              application = await applicationIdentity(
                reaperPid,
                frame.bridgePid,
                frame.appPid,
              );
              monitor.stdin.end(Buffer.from([1]));
              status({ type: "ready", hostPid: application.pid });
              logInvocation(invocation, "linux-namespace-ready", {
                role: "web",
                pid: application.pid,
                pgid: application.pgid,
                rootRole: "linux-namespace",
                bootId: application.started,
                outcome: "verified",
              });
              if (pendingSignal) await forward(application, pendingSignal);
            } else if (frame.type === "output") {
              writeSync(
                frame.stream === "stdout" ? 1 : 2,
                Buffer.from(frame.data, "base64"),
              );
            } else if (frame.type === "exit") {
              if (!application || outcome)
                throw new IsolationProtocolError(
                  "application outcome is premature or duplicated",
                );
              outcome = {
                kind: "observed",
                code: frame.code,
                signal: frame.signal,
              };
            } else {
              throw new IsolationProtocolError(frame.message);
            }
          })
          .catch(fail);
      }
    } catch (error) {
      processing = processing.then(() => fail(error));
    }
  });
  let registered;

  try {
    registered = await registerSpawnedProcess(
      invocation,
      {
        role: "fixture",
        caseName: process.env.MAISTER_TEST_CASE_NAME ?? "linux-fixture",
        rootRole: "linux-monitor",
        root: null,
        bootId: String(monitor.pid),
        logFile: null,
      },
      monitor,
    );
  } catch (error) {
    if (
      spawnFailure ||
      monitor.exitCode !== null ||
      monitor.signalCode !== null
    )
      throw new IsolationUnavailableError(
        `Bubblewrap setup exited before registration: ${stderr}`,
        { cause: spawnFailure ?? error },
      );
    throw error;
  }

  monitorIdentity = registered.identity;
  const result = await monitorClosed;

  await processing;
  if (failure) throw failure;
  if (!application)
    throw new IsolationUnavailableError(
      `namespace did not reach verified application startup: ${stderr}`,
      { cause: spawnFailure },
    );
  if (childPending || statusPending)
    throw new IsolationProtocolError(
      "isolation status stream ended with a partial record",
    );
  if (!outcome)
    outcome = {
      kind: "unobserved",
      reason: result.signal ? "namespace-killed" : "status-unavailable",
    };
  status({ type: "outcome", outcome });
  process.removeListener("SIGTERM", onTerm);
  process.removeListener("SIGINT", onInt);
  if (outcome.kind === "observed" && outcome.signal)
    process.kill(process.pid, outcome.signal);
  else
    process.exitCode =
      outcome.kind === "observed" ? (outcome.code ?? 125) : 125;
} catch (error) {
  const category =
    error instanceof IsolationPolicyError
      ? "policy"
      : error instanceof InvocationOwnershipError
        ? "ownership"
        : error instanceof IsolationProtocolError
          ? "protocol"
          : "capability";

  status({
    type: "error",
    category,
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      8192,
    ),
  });
  await fail(error);
  if (monitorClosed && monitorIdentity) await monitorClosed;
  process.removeListener("SIGTERM", onTerm);
  process.removeListener("SIGINT", onInt);
  process.exitCode = 125;
}
