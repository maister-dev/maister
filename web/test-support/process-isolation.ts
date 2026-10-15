import type { LinuxIsolationPolicy } from "./linux-isolation";

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  IsolationPolicyError,
  LINUX_LAUNCHER,
  linuxOuterEnvironment,
  revalidateLinuxIsolationPolicy,
} from "./linux-isolation";
import {
  consumeLinuxFrames,
  decodeLinuxLauncherFrame,
  IsolationProtocolError,
  type LinuxApplicationOutcome,
  decodeLinuxCommand,
  serializeLinuxIsolationPolicy,
} from "./linux-isolation-protocol";
import {
  FIXTURE_WATCHDOG,
  InvocationOwnershipError,
  assertInvocationGroupEmpty,
  fixtureProcessEnvironment,
  invocationFromEnvironment,
  registerSpawnedProcess,
  signalInvocationGroup,
} from "./process-invocation";

// D10 (AB-16): a real, kernel-enforced filesystem boundary for the web
// process under test. Choosing different path strings is not isolation — the
// same identity could still open the host's private root — so the harness
// wraps the production web command in a mechanism the process cannot undo.
//
// Only a driver this host can actually enforce is offered. macOS provides
// `sandbox-exec`: a MAC profile inherited by every descendant, whose denial
// surfaces as EPERM. A Linux driver (distinct uid with 0700 roots → EACCES,
// or a mount namespace → ENOENT) uses the same fixture seam. Unsupported
// capabilities fail explicitly before any application launch.

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BUBBLEWRAP = "/usr/bin/bwrap";
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

export type IsolationDriver = Readonly<{
  name: "sandbox-exec" | "bubblewrap";
  // The errno a denied access surfaces as under this driver.
  deniedCode: string;
  wrap(
    command: readonly string[],
    deniedRoots: readonly string[],
    policy?: LinuxIsolationPolicy,
  ): { file: string; args: string[] };
}>;

export class IsolationUnavailableError extends Error {
  readonly name = "IsolationUnavailableError";
}

function sandboxProfile(deniedRoots: readonly string[]): string {
  const deny = deniedRoots.map(
    (root) =>
      `(deny file* (subpath "${root.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"))`,
  );

  return ["(version 1)", "(allow default)", ...deny].join("\n");
}

const sandboxExecDriver: IsolationDriver = {
  name: "sandbox-exec",
  deniedCode: "EPERM",
  wrap(command, deniedRoots) {
    return {
      file: SANDBOX_EXEC,
      args: ["-p", sandboxProfile(deniedRoots), ...command],
    };
  },
};

const bubblewrapDriver: IsolationDriver = {
  name: "bubblewrap",
  deniedCode: "ENOENT",
  wrap(command, deniedRoots, policy) {
    if (!policy)
      throw new IsolationPolicyError(
        "Linux isolation requires an explicit immutable launch policy",
      );
    if (command.length === 0 || !command[0])
      throw new IsolationPolicyError("isolation command is empty");
    if (
      deniedRoots.length !== policy.deniedRoots.length ||
      deniedRoots.some((root) => !policy.deniedRoots.includes(root))
    )
      throw new IsolationPolicyError(
        "Linux denied roots differ from the frozen policy",
      );

    const metadata = serializeLinuxIsolationPolicy(policy);
    const commandMetadata = JSON.stringify(command);

    decodeLinuxCommand(commandMetadata);
    revalidateLinuxIsolationPolicy(policy);
    assertLinuxBridgeAuthority();

    return {
      file: process.execPath,
      args: [
        "--disable-sigusr1",
        "--import",
        FIXTURE_WATCHDOG,
        "--import",
        TSX_LOADER,
        LINUX_LAUNCHER,
        metadata,
        commandMetadata,
      ],
    };
  },
};

/** Yama restricts descendant ptrace/pidfd duplication without hiding host proc identity. */
function assertLinuxBridgeAuthority(): void {
  let scope: string;

  try {
    scope = readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch (cause) {
    throw new IsolationUnavailableError(
      "Linux isolation requires existing Yama ptrace_scope 1–3",
      { cause },
    );
  }
  if (!/^[123]$/u.test(scope))
    throw new IsolationUnavailableError(
      "Linux isolation requires existing Yama ptrace_scope 1–3; do not change host sysctls",
    );
}

export function resolveIsolationDriver(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): IsolationDriver {
  const requested = env.MAISTER_TEST_ISOLATION;

  if (
    (requested === "sandbox-exec" && platform === "darwin") ||
    (requested === undefined && platform === "darwin")
  ) {
    if (existsSync(SANDBOX_EXEC)) return sandboxExecDriver;
    throw new IsolationUnavailableError(
      `${SANDBOX_EXEC} is not present; this host cannot enforce the web/supervisor boundary`,
    );
  }
  if (
    platform === "linux" &&
    (requested === undefined || requested === "bubblewrap")
  ) {
    if (process.getuid?.() === 0)
      throw new IsolationUnavailableError(
        "Linux isolation requires an ordinary non-root test user",
      );
    if (!existsSync(BUBBLEWRAP))
      throw new IsolationUnavailableError(
        `${BUBBLEWRAP} is missing; install the documented Linux test prerequisite`,
      );
    assertLinuxBridgeAuthority();
    let help: string;

    try {
      help = execFileSync(BUBBLEWRAP, ["--help"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch (cause) {
      throw new IsolationUnavailableError(
        "Bubblewrap capability inventory failed",
        { cause },
      );
    }
    for (const option of [
      "--unshare-user",
      "--unshare-pid",
      "--die-with-parent",
      "--disable-userns",
      "--assert-userns-disabled",
      "--cap-drop",
      "--json-status-fd",
      "--remount-ro",
    ])
      if (!help.includes(option))
        throw new IsolationUnavailableError(
          `Bubblewrap lacks required option ${option}`,
        );

    return bubblewrapDriver;
  }
  throw new IsolationUnavailableError(
    `no filesystem isolation driver for platform ${platform}` +
      (requested ? ` (MAISTER_TEST_ISOLATION=${requested})` : "") +
      "; use the documented platform isolation prerequisite",
  );
}

export type AccessProbe =
  | { outcome: "readable"; bytes: number }
  | { outcome: "denied"; code: string };

export type LinuxApplicationObservation = Readonly<{
  ready: Promise<number>;
  outcome: Promise<LinuxApplicationOutcome>;
}>;

export function observeLinuxApplication(
  child: ChildProcess,
): LinuxApplicationObservation {
  let pending = "";
  let readyPid: number | undefined;
  let observed: LinuxApplicationOutcome | undefined;
  let failure: Error | undefined;
  let readyResolve: (pid: number) => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  let outcomeResolve: (outcome: LinuxApplicationOutcome) => void = () =>
    undefined;
  let outcomeReject: (error: Error) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const outcome = new Promise<LinuxApplicationOutcome>((resolve, reject) => {
    outcomeResolve = resolve;
    outcomeReject = reject;
  });
  const status = child.stdio[3];

  // Startup callers await readiness after registering the captured child.
  void ready.catch(() => undefined);
  void outcome.catch(() => undefined);
  if (!status || !("on" in status))
    throw new IsolationProtocolError(
      "Linux launcher requires a dedicated status pipe",
    );
  status.on("data", (chunk: Buffer) => {
    try {
      const frames = consumeLinuxFrames(pending, chunk);

      pending = frames.pending;
      for (const line of frames.lines) {
        const frame = decodeLinuxLauncherFrame(line);

        if (frame.type === "ready") {
          if (readyPid !== undefined)
            throw new IsolationProtocolError(
              "duplicate Linux application readiness",
            );
          readyPid = frame.hostPid;
          readyResolve(frame.hostPid);
        } else if (frame.type === "outcome") {
          if (observed !== undefined)
            throw new IsolationProtocolError(
              "duplicate Linux application outcome",
            );
          observed = frame.outcome;
        } else {
          failure =
            frame.category === "capability"
              ? new IsolationUnavailableError(frame.message)
              : frame.category === "policy"
                ? new IsolationPolicyError(frame.message)
                : frame.category === "ownership"
                  ? new InvocationOwnershipError(frame.message)
                  : new IsolationProtocolError(frame.message);
          readyReject(failure);
        }
      }
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new IsolationProtocolError(String(error));
      readyReject(failure);
    }
  });
  child.once("error", (error) => {
    failure = error;
    readyReject(error);
  });
  child.once("close", (_code, signal) => {
    if (pending && !signal)
      failure ??= new IsolationProtocolError(
        "Linux launcher status ended mid-frame",
      );
    if (readyPid === undefined)
      readyReject(
        failure ??
          new IsolationUnavailableError(
            "Linux launcher exited before verified application readiness",
          ),
      );
    if (failure) {
      outcomeReject(failure);

      return;
    }
    outcomeResolve(
      observed ?? {
        kind: "unobserved",
        reason: signal ? "launcher-killed" : "status-unavailable",
      },
    );
  });

  return { ready, outcome };
}

export async function waitForLinuxApplication(
  observation: LinuxApplicationObservation,
  timeoutMs: number,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      observation.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new IsolationProtocolError(
                "Linux application identity readiness timed out",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeAccessProbe(stdout: string, deniedCode: string): AccessProbe {
  let result: unknown;

  try {
    result = JSON.parse(stdout);
  } catch (cause) {
    throw new IsolationProtocolError(
      "access probe did not emit exactly one JSON result",
      { cause },
    );
  }
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new IsolationProtocolError("access probe result is not a record");
  if (
    "outcome" in result &&
    result.outcome === "readable" &&
    "bytes" in result &&
    typeof result.bytes === "number" &&
    Number.isSafeInteger(result.bytes) &&
    result.bytes >= 0 &&
    Object.keys(result).length === 2
  )
    return { outcome: "readable", bytes: result.bytes };
  if (
    "outcome" in result &&
    result.outcome === "denied" &&
    "code" in result &&
    result.code === deniedCode &&
    Object.keys(result).length === 2
  )
    return { outcome: "denied", code: deniedCode };
  throw new IsolationProtocolError(
    "access probe returned an unexpected result or denial errno",
  );
}

/** Reads an existing file through the production launch policy and owned lifecycle. */
export async function probeFilesystemAccess(
  driver: IsolationDriver,
  deniedRoots: readonly string[],
  target: string,
  policy?: LinuxIsolationPolicy,
): Promise<AccessProbe> {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new InvocationOwnershipError(
      "access probe requires a current test invocation",
    );
  if (
    policy &&
    (policy.invocation.id !== invocation.id ||
      policy.invocation.directory !== invocation.directory)
  )
    throw new InvocationOwnershipError(
      "access probe policy belongs to another invocation",
    );
  if (!(await stat(target)).isFile())
    throw new IsolationPolicyError(
      "access probe target must be an existing regular host file",
    );
  const script = [
    "const fs = require('node:fs');",
    "try { const b = fs.readFileSync(process.argv[1]); process.stdout.write(JSON.stringify({ outcome: 'readable', bytes: b.length })); }",
    "catch (e) { process.stdout.write(JSON.stringify({ outcome: 'denied', code: e.code ?? 'UNKNOWN' })); }",
  ].join(" ");
  const command = [
    process.execPath,
    ...(driver.name === "sandbox-exec" ? ["--import", FIXTURE_WATCHDOG] : []),
    "-e",
    script,
    target,
  ];
  const wrapped = driver.wrap(command, deniedRoots, policy);
  const environment = {
    ...process.env,
    ...(await fixtureProcessEnvironment(invocation)),
  };
  const child = spawn(wrapped.file, wrapped.args, {
    env:
      driver.name === "bubblewrap"
        ? linuxOuterEnvironment(policy!, environment)
        : environment,
    cwd: policy?.cwd,
    detached: true,
    stdio:
      driver.name === "bubblewrap"
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnFailure: Error | undefined;
  let outputFailure: IsolationProtocolError | undefined;
  const closed = new Promise<LinuxApplicationOutcome>((resolve) =>
    child.once("close", (code, signal) =>
      resolve(
        code === null && signal === null
          ? { kind: "unobserved", reason: "status-unavailable" }
          : { kind: "observed", code, signal },
      ),
    ),
  );
  const observation =
    driver.name === "bubblewrap" ? observeLinuxApplication(child) : undefined;

  child.once("error", (error) => {
    spawnFailure = error;
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + chunk.length > 16 * 1024)
      outputFailure ??= new IsolationProtocolError(
        "access probe output exceeded its bound",
      );
    else stdout += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
  });
  const failures: unknown[] = [];
  let result: AccessProbe | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    result = await Promise.race([
      (async (): Promise<AccessProbe> => {
        await registerSpawnedProcess(
          invocation,
          {
            role: "fixture",
            caseName: process.env.MAISTER_TEST_CASE_NAME ?? "access-probe",
            rootRole: "isolation-probe",
            root: null,
            bootId: String(child.pid),
            logFile: null,
          },
          child,
        );
        if (observation) await observation.ready;
        const outcome = observation ? await observation.outcome : await closed;

        if (spawnFailure) throw spawnFailure;
        if (outputFailure) throw outputFailure;
        if (
          outcome.kind !== "observed" ||
          outcome.code !== 0 ||
          outcome.signal !== null
        )
          throw new IsolationProtocolError(
            `access probe application failed: ${JSON.stringify(outcome)}; diagnostics: ${stderr}`,
          );

        return decodeAccessProbe(stdout, driver.deniedCode);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new IsolationProtocolError(
                "access probe exceeded its 20000ms deadline",
              ),
            ),
          20_000,
        );
      }),
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await signalInvocationGroup(invocation, child.pid, "SIGKILL");
      await closed;
      if (child.pid) await assertInvocationGroupEmpty(invocation, child.pid);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "access probe and cleanup failed");
  if (!result)
    throw new IsolationProtocolError("access probe completed without a result");

  return result;
}
