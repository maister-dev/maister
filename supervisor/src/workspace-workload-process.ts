import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { inspectProcessGroup } from "../../runtime/process-group";

import {
  SESSION_PROCESS_GATE_PATH,
  sessionGateEnvironment,
} from "./session-process-ownership";
import { SupervisorError } from "./types";

type WorkloadProcessResult = Readonly<{
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processOutcome:
    "exited" | "signalled" | "timedOut" | "cancelled" | "interrupted";
  truncated: boolean;
  retired: boolean;
}>;

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const GROUP_RETIREMENT_GRACE_MS = 1_000;
const HOST_ENVIRONMENT =
  /^(?:HOME|LANG|LC_[A-Z_]+|LOGNAME|PATH|SHELL|TERM|TMPDIR|TZ|USER|NODE_ENV|SSH_AUTH_SOCK|MAISTER_(?:MAX_CONCURRENT_HEAVY_CHECKS|HEAVY_CHECK_DIR|BUILD_PROFILE|BUILD_MAX_WORKERS|TEST_MAX_WORKERS))$/u;

function selectWorkloadEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !entry[1].startsWith("()") &&
        HOST_ENVIRONMENT.test(entry[0]),
    ),
  );
}

/** Child close can precede the kernel retiring other members of the same group. */
async function workloadGroupRetired(group: number): Promise<boolean> {
  const deadline = performance.now() + GROUP_RETIREMENT_GRACE_MS;
  let remaining = GROUP_RETIREMENT_GRACE_MS;
  while (remaining > 0) {
    if ((await inspectProcessGroup(group, Math.ceil(remaining))).state === "retired")
      return true;
    remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(25, Math.ceil(remaining)));
    remaining = deadline - performance.now();
  }

  return (await inspectProcessGroup(group, 0)).state === "retired";
}

/** Start a shell only after the process-group owner is durably recorded. */
export async function executeWorkspaceWorkloadProcess(
  input: Readonly<{
    cwd: string;
    launch: Readonly<{ binary: string; arguments: string[] }>;
    timeoutMs: number;
    signal: AbortSignal;
    register: (group: number) => void;
    outputFile?: string;
    flowInstallPath?: string;
  }>,
): Promise<WorkloadProcessResult> {
  input.signal.throwIfAborted();
  const child = spawn(process.execPath, [SESSION_PROCESS_GATE_PATH], {
    cwd: input.cwd,
    env: {
      ...sessionGateEnvironment(),
      MAISTER_WORKLOAD_EXIT_ON_DISCONNECT: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let collected = 0;
  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let authorized = false;
  let started = false;
  let signalFailure: unknown;
  let processFailure: unknown;

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        signalFailure = error;
    }
  };
  const collect = (target: Buffer[], chunk: Buffer): void => {
    const available = Math.max(0, OUTPUT_LIMIT - collected);

    if (available > 0) target.push(chunk.subarray(0, available));
    collected += chunk.byteLength;
    if (collected > OUTPUT_LIMIT && !truncated) {
      truncated = true;
      signalGroup("SIGKILL");
    }
  };
  const cancel = (): void => {
    cancelled = true;
    signalGroup("SIGKILL");
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGKILL");
  }, input.timeoutMs);
  input.signal.addEventListener("abort", cancel, { once: true });
  child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.on("error", (error) => {
    processFailure = error;
  });
  child.on("exit", () => {
    // Bash can finish while grandchildren still hold inherited output pipes.
    signalGroup("SIGKILL");
  });
  child.on("message", (message: unknown) => {
    if (
      authorized &&
      message &&
      typeof message === "object" &&
      "kind" in message &&
      message.kind === "execution_started"
    )
      started = true;
    if (
      authorized ||
      timedOut ||
      cancelled ||
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "ready" ||
      child.pid === undefined
    )
      return;

    try {
      input.register(child.pid);
      authorized = true;
      child.send(
        {
          kind: "execute",
          binary: input.launch.binary,
          arguments: input.launch.arguments,
          environment: {
            ...selectWorkloadEnvironment(),
            ...(input.outputFile
              ? { MAISTER_OUTPUT_FILE: input.outputFile }
              : {}),
            ...(input.flowInstallPath
              ? { MAISTER_FLOW_DIR: input.flowInstallPath }
              : {}),
          },
        },
        (error) => {
          if (!error) return;
          processFailure = error;
          signalGroup("SIGKILL");
        },
      );
    } catch (error) {
      processFailure = error;
      signalGroup("SIGKILL");
    }
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (input.signal.aborted) cancel();
  const { code, signal } = await completion.finally(() => {
    input.signal.removeEventListener("abort", cancel);
    clearTimeout(deadline);
  });

  const retired =
    child.pid === undefined ||
    (await workloadGroupRetired(child.pid));
  if (processFailure instanceof SupervisorError && retired)
    throw processFailure;

  return {
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    exitCode: timedOut || cancelled || truncated ? null : code,
    signal,
    processOutcome: cancelled
      ? "cancelled"
      : timedOut
        ? "timedOut"
        : processFailure || !started
          ? "interrupted"
          : signal
            ? "signalled"
            : "exited",
    truncated,
    retired: retired && signalFailure === undefined,
  };
}
