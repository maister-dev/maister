import type { LinuxIsolationPolicy } from "./linux-isolation";

import { readFileSync, statSync } from "node:fs";

export type LinuxApplicationOutcome =
  | Readonly<{
      kind: "observed";
      code: number | null;
      signal: NodeJS.Signals | null;
    }>
  | Readonly<{
      kind: "unobserved";
      reason: "namespace-killed" | "launcher-killed" | "status-unavailable";
    }>;

export type LinuxChildFrame =
  | Readonly<{ type: "ready"; bridgePid: number; appPid: number }>
  | Readonly<{ type: "output"; stream: "stdout" | "stderr"; data: string }>
  | Readonly<{
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    }>
  | Readonly<{ type: "error"; message: string }>;

export type LinuxLauncherFrame =
  | Readonly<{ type: "ready"; hostPid: number }>
  | Readonly<{ type: "outcome"; outcome: LinuxApplicationOutcome }>
  | Readonly<{
      type: "error";
      category: "capability" | "policy" | "ownership" | "protocol";
      message: string;
    }>;

export class IsolationProtocolError extends Error {
  readonly name = "IsolationProtocolError";
}

const FRAME_LIMIT = 64 * 1024;
const POLICY_LIMIT = 112 * 1024;
const COMMAND_LIMIT = 32 * 1024;
const SIGNALS = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function pathValue(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("/") && !value.includes("\0")
  );
}

function validExit(value: Record<string, unknown>): boolean {
  const codeValid =
    value.code === null ||
    (typeof value.code === "number" &&
      Number.isSafeInteger(value.code) &&
      value.code >= 0 &&
      value.code <= 255);
  const signalValid =
    value.signal === null ||
    (typeof value.signal === "string" && SIGNALS.has(value.signal));

  return (
    codeValid &&
    signalValid &&
    (value.code === null) !== (value.signal === null)
  );
}

function parseRecord(line: string): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new IsolationProtocolError("malformed isolation status JSON", {
      cause,
    });
  }
  if (!record(value))
    throw new IsolationProtocolError("isolation status is not a record");

  return value;
}

function jsonRecord(line: string): Record<string, unknown> {
  if (Buffer.byteLength(line) > FRAME_LIMIT)
    throw new IsolationProtocolError(
      "isolation status frame exceeded its bound",
    );

  return parseRecord(line);
}

export function serializeLinuxIsolationPolicy(
  policy: LinuxIsolationPolicy,
): string {
  const line = JSON.stringify(policy);

  if (Buffer.byteLength(line) > POLICY_LIMIT)
    throw new IsolationProtocolError(
      "isolation launch policy exceeded its 112KiB bound",
    );

  return line;
}

export function decodeLinuxIsolationPolicy(line: string): LinuxIsolationPolicy {
  if (Buffer.byteLength(line) > POLICY_LIMIT)
    throw new IsolationProtocolError(
      "isolation launch policy exceeded its 112KiB bound",
    );
  const value = parseRecord(line);

  if (
    value.version !== 1 ||
    !record(value.invocation) ||
    typeof value.invocation.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,160}$/u.test(value.invocation.id) ||
    !pathValue(value.invocation.directory) ||
    !pathValue(value.cwd) ||
    !Array.isArray(value.mounts) ||
    value.mounts.length === 0 ||
    !Array.isArray(value.deniedRoots) ||
    !value.deniedRoots.every(pathValue) ||
    !Array.isArray(value.protectedFiles) ||
    !Array.isArray(value.symlinks) ||
    !Array.isArray(value.writableOwners) ||
    !Array.isArray(value.environmentKeys) ||
    !value.environmentKeys.every(
      (key) => typeof key === "string" && /^[A-Z][A-Z0-9_]*$/u.test(key),
    )
  )
    throw new IsolationProtocolError(
      "invalid immutable isolation policy record",
    );
  for (const mount of value.mounts) {
    if (
      !record(mount) ||
      !pathValue(mount.source) ||
      !pathValue(mount.destination) ||
      typeof mount.device !== "number" ||
      !Number.isSafeInteger(mount.device) ||
      !positiveInteger(mount.inode) ||
      typeof mount.directory !== "boolean" ||
      (mount.access !== "read-only" && mount.access !== "writable")
    )
      throw new IsolationProtocolError("invalid isolation mount record");
  }
  for (const file of value.protectedFiles) {
    if (
      !record(file) ||
      !pathValue(file.path) ||
      typeof file.device !== "number" ||
      !Number.isSafeInteger(file.device) ||
      !positiveInteger(file.inode)
    )
      throw new IsolationProtocolError("invalid protected inode record");
  }
  for (const owner of value.writableOwners) {
    if (
      !record(owner) ||
      !pathValue(owner.root) ||
      typeof owner.device !== "number" ||
      !Number.isSafeInteger(owner.device) ||
      !positiveInteger(owner.inode)
    )
      throw new IsolationProtocolError("invalid writable ownership record");
  }

  for (const link of value.symlinks) {
    if (
      !record(link) ||
      !pathValue(link.path) ||
      typeof link.target !== "string" ||
      link.target.includes("\0") ||
      !pathValue(link.canonicalTarget) ||
      typeof link.device !== "number" ||
      !Number.isSafeInteger(link.device) ||
      !positiveInteger(link.inode)
    )
      throw new IsolationProtocolError("invalid dependency symlink record");
  }

  const policy = value as unknown as LinuxIsolationPolicy;

  return Object.freeze({
    ...policy,
    invocation: Object.freeze({ ...policy.invocation }),
    mounts: Object.freeze(
      policy.mounts.map((mount) => Object.freeze({ ...mount })),
    ),
    deniedRoots: Object.freeze([...policy.deniedRoots]),
    protectedFiles: Object.freeze(
      policy.protectedFiles.map((file) => Object.freeze({ ...file })),
    ),
    symlinks: Object.freeze(
      policy.symlinks.map((link) => Object.freeze({ ...link })),
    ),
    writableOwners: Object.freeze(
      policy.writableOwners.map((owner) => Object.freeze({ ...owner })),
    ),
    environmentKeys: Object.freeze([...policy.environmentKeys]),
  });
}

export function decodeLinuxCommand(line: string): readonly string[] {
  if (Buffer.byteLength(line) > COMMAND_LIMIT)
    throw new IsolationProtocolError(
      "isolation command exceeded its 32KiB bound",
    );
  const value: unknown = JSON.parse(line);

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (entry) => typeof entry === "string" && !entry.includes("\0"),
    ) ||
    !pathValue(value[0])
  )
    throw new IsolationProtocolError(
      "isolation application command must contain an absolute executable and argv",
    );

  return Object.freeze(value as string[]);
}

export function decodeLinuxChildFrame(line: string): LinuxChildFrame {
  const value = jsonRecord(line);

  if (
    value.type === "ready" &&
    positiveInteger(value.bridgePid) &&
    positiveInteger(value.appPid)
  )
    return { type: "ready", bridgePid: value.bridgePid, appPid: value.appPid };
  if (
    value.type === "output" &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    typeof value.data === "string" &&
    value.data.length <= 48 * 1024 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value.data,
    )
  )
    return { type: "output", stream: value.stream, data: value.data };
  if (value.type === "exit" && validExit(value))
    return {
      type: "exit",
      code: value.code as number | null,
      signal: value.signal as NodeJS.Signals | null,
    };
  if (
    value.type === "error" &&
    typeof value.message === "string" &&
    value.message.length <= 8192
  )
    return { type: "error", message: value.message };
  throw new IsolationProtocolError("invalid namespace child status frame");
}

export function decodeLinuxLauncherFrame(line: string): LinuxLauncherFrame {
  const value = jsonRecord(line);

  if (value.type === "ready" && positiveInteger(value.hostPid))
    return { type: "ready", hostPid: value.hostPid };
  if (
    value.type === "error" &&
    ["capability", "policy", "ownership", "protocol"].includes(
      String(value.category),
    ) &&
    typeof value.message === "string" &&
    value.message.length <= 8192
  )
    return {
      type: "error",
      category: value.category as
        | "capability"
        | "policy"
        | "ownership"
        | "protocol",
      message: value.message,
    };
  if (value.type === "outcome" && record(value.outcome)) {
    const outcome = value.outcome;

    if (outcome.kind === "observed" && validExit(outcome))
      return {
        type: "outcome",
        outcome: {
          kind: "observed",
          code: outcome.code as number | null,
          signal: outcome.signal as NodeJS.Signals | null,
        },
      };
    if (
      outcome.kind === "unobserved" &&
      ["namespace-killed", "launcher-killed", "status-unavailable"].includes(
        String(outcome.reason),
      )
    )
      return {
        type: "outcome",
        outcome: {
          kind: "unobserved",
          reason: outcome.reason as
            | "namespace-killed"
            | "launcher-killed"
            | "status-unavailable",
        },
      };
  }
  throw new IsolationProtocolError("invalid trusted launcher status frame");
}

/** Bounds an incomplete frame as it arrives, before JSON parsing or concatenation. */
export function consumeLinuxFrames(
  pending: string,
  chunk: Buffer,
): Readonly<{ lines: readonly string[]; pending: string }> {
  const parts = chunk.toString("utf8").split("\n");
  const first = parts.shift() ?? "";

  if (Buffer.byteLength(pending) + Buffer.byteLength(first) > FRAME_LIMIT)
    throw new IsolationProtocolError(
      "isolation status stream exceeded its bound",
    );
  const combined = `${pending}${first}`;

  if (parts.length === 0) return { lines: [], pending: combined };
  const tail = parts.pop() ?? "";
  const lines = [combined, ...parts];

  if ([...lines, tail].some((line) => Buffer.byteLength(line) > FRAME_LIMIT))
    throw new IsolationProtocolError(
      "isolation status stream exceeded its bound",
    );

  return { lines, pending: tail };
}

/** Verifies the view before application exec, without host identity or ledger access. */
export function assertLinuxMountedPolicy(policy: LinuxIsolationPolicy): void {
  const status = readFileSync("/proc/self/status", "utf8");

  if (
    !/^NoNewPrivs:\s+1$/mu.test(status) ||
    !["CapEff", "CapPrm", "CapAmb"].every((key) =>
      new RegExp(`^${key}:\\s+0+$`, "mu").test(status),
    )
  )
    throw new IsolationProtocolError(
      "application namespace retained privileges",
    );
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");

      return {
        destination: fields[4]?.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
        flags: fields[5]?.split(","),
      };
    });

  if (!mounts.find((mount) => mount.destination === "/")?.flags?.includes("ro"))
    throw new IsolationProtocolError(
      "application namespace structural root is writable",
    );

  for (const mount of policy.mounts) {
    const info = statSync(mount.destination);
    const mounted = mounts.find(
      (entry) => entry.destination === mount.destination,
    );

    if (
      info.dev !== mount.device ||
      info.ino !== mount.inode ||
      !mounted ||
      !mounted.flags?.includes(mount.access === "read-only" ? "ro" : "rw")
    )
      throw new IsolationProtocolError(
        "application mount identity/access differs from frozen policy",
      );
  }
}
