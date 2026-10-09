import type { Invocation, RootRecord } from "./process-invocation";

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";

import {
  invocationRecords,
  InvocationOwnershipError,
} from "./process-invocation";

export class IsolationPolicyError extends Error {
  readonly name = "IsolationPolicyError";
}

export type LinuxIsolationMount = Readonly<{
  source: string;
  destination: string;
  device: number;
  inode: number;
  access: "read-only" | "writable";
  directory: boolean;
}>;

export type ProtectedIsolationFile = Readonly<{
  path: string;
  device: number;
  inode: number;
}>;

export type LinuxWritableOwner = Readonly<
  Pick<RootRecord, "root" | "device" | "inode">
>;

export type LinuxIsolationSymlink = Readonly<{
  path: string;
  target: string;
  canonicalTarget: string;
  device: number;
  inode: number;
}>;

export type LinuxIsolationPolicy = Readonly<{
  version: 1;
  invocation: Invocation;
  cwd: string;
  mounts: readonly LinuxIsolationMount[];
  deniedRoots: readonly string[];
  protectedFiles: readonly ProtectedIsolationFile[];
  writableOwners: readonly LinuxWritableOwner[];
  symlinks: readonly LinuxIsolationSymlink[];
  environmentKeys: readonly string[];
}>;

export type LinuxIsolationPolicyInput = Readonly<{
  invocation: Invocation;
  cwd: string;
  readOnlyPaths: readonly string[];
  writableRoots: readonly string[];
  deniedRoots: readonly string[];
  protectedFiles?: readonly Readonly<{ path: string; optional?: boolean }>[];
  environmentKeys?: readonly string[];
  readOnlySymlinks?: readonly string[];
}>;

const PRIVATE_HOME = "/home/maister-isolated-web";

export const LINUX_CHILD = fileURLToPath(
  new NodeURL("./linux-isolation-child.mjs", import.meta.url),
);
export const LINUX_READY = fileURLToPath(
  new NodeURL("./linux-isolation-ready.mjs", import.meta.url),
);
export const LINUX_LAUNCHER = fileURLToPath(
  new NodeURL("./linux-isolation-launcher.mjs", import.meta.url),
);
const LINUX_PROTOCOL = fileURLToPath(
  new NodeURL("./linux-isolation-protocol.ts", import.meta.url),
);
const BLOCKED_ENVIRONMENT =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|DOCKER_.*|MAISTER_TEST_PROCESS_.*|MAISTER_TEST_INVOCATION_.*|SSH_.*|GIT_CONFIG.*)$/u;
const REQUIRED_ENVIRONMENT = [
  "PATH",
  "LANG",
  "NODE_ENV",
  "MAISTER_TEST_WORKTREE_INVOCATION_ID",
];
const BROAD_HOST_ROOTS = [
  "/",
  "/etc",
  "/opt",
  "/var",
  "/home",
  "/proc",
  "/dev",
  "/tmp",
];

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function canonicalExisting(candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate !== path.normalize(candidate))
    throw new IsolationPolicyError(
      "isolation input must be an absolute normalized path",
    );

  try {
    return realpathSync(candidate);
  } catch (cause) {
    throw new IsolationPolicyError("required isolation input is unavailable", {
      cause,
    });
  }
}

function mountInput(
  source: string,
  access: LinuxIsolationMount["access"],
): LinuxIsolationMount {
  const canonical = canonicalExisting(source);
  const info = statSync(canonical);

  if (!info.isFile() && !info.isDirectory())
    throw new IsolationPolicyError(
      "isolation bind must be a regular file or directory",
    );
  if (BROAD_HOST_ROOTS.includes(canonical))
    throw new IsolationPolicyError("broad host or authority bind is forbidden");

  return Object.freeze({
    source: canonical,
    destination: source,
    device: info.dev,
    inode: info.ino,
    access,
    directory: info.isDirectory(),
  });
}

function assertPolicyTopology(policy: LinuxIsolationPolicy): void {
  const authorities = [
    ...policy.deniedRoots.map(canonicalExisting),
    canonicalExisting(policy.invocation.directory),
  ];

  for (const mount of policy.mounts) {
    if (
      BROAD_HOST_ROOTS.includes(mount.source) ||
      BROAD_HOST_ROOTS.includes(mount.destination)
    )
      throw new IsolationPolicyError(
        "broad host or authority bind is forbidden",
      );
    if (
      authorities.some(
        (authority) =>
          overlaps(authority, mount.source) ||
          overlaps(authority, mount.destination),
      )
    )
      throw new IsolationPolicyError(
        "allowed isolation bind overlaps private authority",
      );
    if (
      policy.mounts.some(
        (other) =>
          other !== mount &&
          (overlaps(other.destination, mount.destination) ||
            overlaps(other.source, mount.source)),
      )
    )
      throw new IsolationPolicyError(
        "isolation binds overlap or duplicate a destination/source",
      );
  }
  if (
    !policy.mounts.some(
      (mount) =>
        (mount.directory && within(mount.destination, policy.cwd)) ||
        (!mount.directory && path.dirname(mount.destination) === policy.cwd),
    )
  )
    throw new IsolationPolicyError("isolation cwd is outside allowed material");
  for (const link of policy.symlinks) {
    if (
      authorities.some(
        (authority) =>
          overlaps(authority, link.path) ||
          overlaps(authority, link.canonicalTarget),
      ) ||
      !policy.mounts.some(
        (mount) =>
          mount.access === "read-only" &&
          within(mount.destination, link.canonicalTarget),
      ) ||
      policy.mounts.some((mount) => within(mount.destination, link.path))
    )
      throw new IsolationPolicyError(
        "dependency symlink must target approved read-only material outside private authority",
      );
  }
  if (
    new Set(policy.symlinks.map((link) => link.path)).size !==
    policy.symlinks.length
  )
    throw new IsolationPolicyError("duplicate application dependency symlink");
  if (
    policy.environmentKeys.some(
      (key) => !/^[A-Z][A-Z0-9_]*$/u.test(key) || BLOCKED_ENVIRONMENT.test(key),
    )
  )
    throw new IsolationPolicyError(
      "isolation application environment exports forbidden authority",
    );
}

function mountPoints(): readonly string[] {
  return readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      const mountPoint = fields[4];

      if (
        fields.length < 10 ||
        mountPoint === undefined ||
        !line.includes(" - ")
      )
        throw new IsolationPolicyError("invalid host mount inventory");

      return mountPoint.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
    });
}

function assertMounts(policy: LinuxIsolationPolicy): void {
  const points = mountPoints();

  for (const mount of policy.mounts) {
    const currentSource = canonicalExisting(mount.destination);
    const info = statSync(currentSource);

    if (
      currentSource !== mount.source ||
      info.dev !== mount.device ||
      info.ino !== mount.inode
    )
      throw new IsolationPolicyError(
        "isolation bind source was replaced after policy preparation",
      );
    if (
      mount.directory &&
      points.some(
        (point) => point !== mount.source && within(mount.source, point),
      )
    )
      throw new IsolationPolicyError(
        "isolation bind contains an unapproved nested host mount",
      );
  }
  for (const protectedFile of policy.protectedFiles) {
    const info = lstatSync(protectedFile.path);

    if (
      !info.isFile() ||
      info.dev !== protectedFile.device ||
      info.ino !== protectedFile.inode ||
      info.nlink !== 1
    )
      throw new IsolationPolicyError(
        "protected fixture inode was replaced or exported",
      );
    if (
      policy.mounts.some(
        (mount) => mount.device === info.dev && mount.inode === info.ino,
      )
    )
      throw new IsolationPolicyError(
        "private inode is exported through an allowed bind",
      );
  }
  for (const link of policy.symlinks) {
    const info = lstatSync(link.path);

    if (
      !info.isSymbolicLink() ||
      info.dev !== link.device ||
      info.ino !== link.inode ||
      readlinkSync(link.path) !== link.target ||
      canonicalExisting(link.path) !== link.canonicalTarget
    )
      throw new IsolationPolicyError(
        "application dependency symlink changed after policy preparation",
      );
  }
}

function assertOwnedWritable(
  mount: LinuxIsolationMount,
  roots: readonly LinuxWritableOwner[],
  invocation: Invocation,
): void {
  const owner = roots.find((root) => within(root.root, mount.source));

  if (!owner)
    throw new InvocationOwnershipError(
      "writable isolation root has no invocation ownership",
    );
  const info = lstatSync(owner.root);
  const marker = readFileSync(
    path.join(owner.root, ".maister-test-invocation"),
    "utf8",
  );

  if (
    info.isSymbolicLink() ||
    info.dev !== owner.device ||
    info.ino !== owner.inode ||
    marker !== invocation.id
  )
    throw new InvocationOwnershipError(
      "writable isolation root ownership changed",
    );
}

/** Enumerates executable ELF dependencies at the loader's actual destination paths. */
export function linuxRuntimePaths(
  executables: readonly string[],
): readonly string[] {
  if (process.platform !== "linux")
    throw new IsolationPolicyError(
      "Linux runtime closure requires a Linux host",
    );
  const files = new Set<string>();

  for (const executable of executables) {
    canonicalExisting(executable);
    files.add(executable);
    const output = execFileSync("/usr/bin/ldd", [executable], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });

    if (output.includes("not found"))
      throw new IsolationPolicyError(
        "required executable library is unavailable",
      );
    for (const line of output.split("\n")) {
      const match = /(?:=>\s+)?(\/\S+)\s+\(/u.exec(line);

      if (match?.[1]) files.add(match[1]);
    }
  }

  return Object.freeze([...files]);
}

export async function prepareLinuxIsolationPolicy(
  input: LinuxIsolationPolicyInput,
): Promise<LinuxIsolationPolicy> {
  if (process.platform !== "linux")
    throw new IsolationPolicyError(
      "Linux isolation policy requires a Linux host",
    );
  const deniedRoots = input.deniedRoots.map(canonicalExisting);
  const readOnlyPaths = [
    ...input.readOnlyPaths,
    ...[LINUX_CHILD, LINUX_PROTOCOL, LINUX_READY].filter(
      (file) => !input.readOnlyPaths.some((root) => within(root, file)),
    ),
  ];
  const mounts = [
    ...readOnlyPaths.map((source) => mountInput(source, "read-only")),
    ...input.writableRoots.map((source) => mountInput(source, "writable")),
  ];
  const cwd = canonicalExisting(input.cwd);
  const records = await invocationRecords(input.invocation);
  const roots = records.filter(
    (record): record is RootRecord => record.kind === "root",
  );
  const writableOwners = roots
    .filter((root) =>
      mounts.some(
        (mount) =>
          mount.access === "writable" && within(root.root, mount.source),
      ),
    )
    .map(({ root, device, inode }) => Object.freeze({ root, device, inode }));

  const protectedFiles: ProtectedIsolationFile[] = [];

  for (const target of input.protectedFiles ?? []) {
    let info: ReturnType<typeof lstatSync>;

    try {
      info = lstatSync(target.path);
    } catch (error) {
      if (target.optional && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw new IsolationPolicyError(
        "required protected fixture file is unavailable",
        { cause: error },
      );
    }
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !deniedRoots.some((root) => within(root, target.path))
    )
      throw new IsolationPolicyError(
        "protected fixture file must be private, regular and singly linked",
      );
    protectedFiles.push(
      Object.freeze({ path: target.path, device: info.dev, inode: info.ino }),
    );
  }
  const environmentKeys = [
    ...new Set([...REQUIRED_ENVIRONMENT, ...(input.environmentKeys ?? [])]),
  ];
  const symlinks = (input.readOnlySymlinks ?? []).map(
    (candidate): LinuxIsolationSymlink => {
      if (
        !path.isAbsolute(candidate) ||
        candidate !== path.normalize(candidate)
      )
        throw new IsolationPolicyError(
          "dependency link must have an absolute normalized destination",
        );
      const info = lstatSync(candidate);
      const canonicalTarget = canonicalExisting(candidate);

      if (!info.isSymbolicLink())
        throw new IsolationPolicyError(
          "dependency symlink must target approved read-only material outside private authority",
        );

      return Object.freeze({
        path: candidate,
        target: readlinkSync(candidate),
        canonicalTarget,
        device: info.dev,
        inode: info.ino,
      });
    },
  );

  const policy: LinuxIsolationPolicy = Object.freeze({
    version: 1,
    invocation: Object.freeze({ ...input.invocation }),
    cwd,
    mounts: Object.freeze(mounts),
    deniedRoots: Object.freeze(deniedRoots),
    protectedFiles: Object.freeze(protectedFiles),
    writableOwners: Object.freeze(writableOwners),
    symlinks: Object.freeze(symlinks),
    environmentKeys: Object.freeze(environmentKeys),
  });

  revalidateLinuxIsolationPolicy(policy);

  return policy;
}

export function revalidateLinuxIsolationPolicy(
  policy: LinuxIsolationPolicy,
): void {
  assertPolicyTopology(policy);
  assertMounts(policy);
  for (const mount of policy.mounts.filter(
    (entry) => entry.access === "writable",
  ))
    assertOwnedWritable(mount, policy.writableOwners, policy.invocation);
}

export function linuxSandboxArgs(policy: LinuxIsolationPolicy): string[] {
  revalidateLinuxIsolationPolicy(policy);

  return [
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--disable-userns",
    "--assert-userns-disabled",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--tmpfs",
    PRIVATE_HOME,
    ...policy.mounts.flatMap((mount) => [
      mount.access === "read-only" ? "--ro-bind" : "--bind",
      mount.source,
      mount.destination,
    ]),
    ...policy.symlinks.flatMap((link) => ["--symlink", link.target, link.path]),
    "--remount-ro",
    "/",
    "--chdir",
    policy.cwd,
  ];
}

export function linuxApplicationEnvironment(
  policy: LinuxIsolationPolicy,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      policy.environmentKeys.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]!]],
      ),
    ),
    MAISTER_TEST_WORKTREE_INVOCATION_ID: policy.invocation.id,
    HOME: PRIVATE_HOME,
  };
}

export function linuxOuterEnvironment(
  policy: LinuxIsolationPolicy,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const keys = [
    ...policy.environmentKeys,
    "LOG_LEVEL",
    "HOME",
    "MAISTER_TEST_PROCESS_LEDGER",
    "MAISTER_TEST_PROCESS_PARENT",
    "MAISTER_TEST_PROCESS_OWNER",
    "MAISTER_TEST_CASE_NAME",
  ];

  return {
    ...Object.fromEntries(
      keys.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]!]],
      ),
    ),
    NODE_ENV: environment.NODE_ENV,
    MAISTER_TEST_WORKTREE_INVOCATION_ID: policy.invocation.id,
  };
}
